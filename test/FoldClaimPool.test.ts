/* eslint-disable @typescript-eslint/no-explicit-any */
import { writeFileSync, mkdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hexToBin, binToHex } from '@bitauth/libauth';
import { compileFile } from '@solidcash/solidc';
import { SignatureTemplate } from '@solidcash/solidcash';
import { MockNetworkProvider } from '@solidcash/solidcash/network/mock';
import { StatefulContract, getDataNftLockingBytecode } from '@solidcash/solidcash/stateful';
import { MerkleTree, rootFromProof, type Entry } from '../src/merkle.js';
import { withRelativeLock } from '../src/relative-lock.js';

const ASSET = 'f01dca5ef01dca5ef01dca5ef01dca5ef01dca5ef01dca5ef01dca5ef01dca5e';
const OTHER = 'abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const POOL_TOKENS = 1_000_000_000n;
const ROOT_DELAY = 144;
const registryArtifact = compileFile(new URL('../contracts/RootRegistry.scash', import.meta.url)) as any;
const poolArtifact = compileFile(new URL('../contracts/FoldClaimPool.scash', import.meta.url)) as any;

/** A synthetic folder's P2PKH locking bytecode (no key needed: claims are permissionless). */
function p2pkh(seed: number): Uint8Array {
  const pkh = new Uint8Array(20);
  new DataView(pkh.buffer).setUint32(0, seed);
  pkh[19] = 0xfc;
  return Uint8Array.from([0x76, 0xa9, 0x14, ...pkh, 0x88, 0xac]);
}

async function setup(leafCount = 300) {
  const provider = new MockNetworkProvider({ profile: 'production' });
  const [operator, bob, carol, mallory] = await provider.getSigners(4, { fundingUtxos: 40, genesisFundingUtxos: 3 });
  const genesisCoins = (await operator.getUtxos()).filter((u: any) => u.vout === 0 && !u.token && u.satoshis >= 200_000n);

  const { contract: registryContract } = await StatefulContract.deploy(registryArtifact, [operator.publicKey], {
    provider, fundingUtxo: genesisCoins[0], funder: operator.unlockP2PKH(), changeAddress: operator.getAddress(),
  } as any);
  const registry = registryContract as any;

  const tokenCoin = { txid: 'c'.repeat(64), vout: 0, satoshis: 1_200n, token: { category: ASSET, amount: POOL_TOKENS } };
  await provider.seedUtxo(operator.getAddress(), tokenCoin);
  const registryData = getDataNftLockingBytecode(registry.categoryId, hexToBin(registry.inner.lockingBytecode));
  const { contract: poolContract } = await StatefulContract.deploy(poolArtifact, [hexToBin(ASSET), registryData], {
    provider, fundingUtxo: genesisCoins[1], funder: operator.unlockP2PKH(), changeAddress: operator.getAddress(),
    tokenContainers: [{ utxo: tokenCoin, unlocker: operator.unlockP2PKH() }],
  } as any);
  const pool = StatefulContract.withCategory((poolContract as any).inner, (poolContract as any).categoryId, {
    externalContracts: {
      IRootRegistry: { artifact: registryArtifact, categoryId: registry.categoryId, constructorArgs: [operator.publicKey] },
    },
  } as any) as any;

  const entries: Entry[] = [
    { lockingBytecode: bob.getLockingBytecode(), cumulative: 5_000n },
    { lockingBytecode: carol.getLockingBytecode(), cumulative: 12_345n },
  ];
  for (let i = 2; i < leafCount; i++) entries.push({ lockingBytecode: p2pkh(i), cumulative: BigInt(1000 + i) });
  return { provider, operator, bob, carol, mallory, registry, pool, entries };
}

type Ctx = Awaited<ReturnType<typeof setup>>;
const outcome = (p: Promise<unknown>) => p.then(() => 'accepted', (e: any) => String(e?.message ?? e));
const sig = (signer: any) => new SignatureTemplate(signer.privateKey);
const tokensOf = async (ctx: Ctx, lockingBytecode: Uint8Array) => {
  const utxos = await ctx.provider.getUtxosForLockingBytecode(lockingBytecode);
  return utxos.filter((u: any) => u.token?.category === ASSET).reduce((n: bigint, u: any) => n + u.token.amount, 0n);
};
const activate = (ctx: Ctx) => withRelativeLock(ctx.registry.categoryId, ROOT_DELAY,
  () => ctx.registry.connect(ctx.operator).call.activateRoot().send());

const publishWaits: number[] = [];
/** Propose, wait out the audit window, activate and sync the pool. */
async function publish(ctx: Ctx, tree: MerkleTree, epoch: bigint) {
  await ctx.registry.connect(ctx.operator).call.proposeRoot(sig(ctx.operator), tree.root, epoch).send();
  const start = await ctx.provider.getBlockHeight();
  await ctx.provider.mine(ROOT_DELAY);
  for (let extra = 0; ; extra++) {
    const r = await outcome(activate(ctx));
    if (r === 'accepted') break;
    if (extra >= 6) throw new Error(`activation still refused: ${r}`);
    await ctx.provider.mine(1);
  }
  publishWaits.push((await ctx.provider.getBlockHeight()) - start);
  await ctx.pool.connect(ctx.operator).call.syncRoot().send();
}

const claim = (ctx: Ctx, by: any, tree: MerkleTree, index: number, overrides: Partial<{ category: string; recipient: Uint8Array; cumulative: bigint; proof: Uint8Array; index: bigint }> = {}) => {
  const e = tree.entries[index];
  const p = tree.proof(index);
  return ctx.pool.connect(by).call.claim(
    hexToBin(overrides.category ?? ASSET),
    overrides.recipient ?? e.lockingBytecode,
    overrides.cumulative ?? e.cumulative,
    overrides.proof ?? p.proofBytes,
    overrides.index ?? BigInt(index),
  ).send();
};

describe('Merkle tree (off-chain)', () => {
  it('builds proofs that recompute the root, depth 9 for 300 leaves', () => {
    const entries = Array.from({ length: 300 }, (_, i) => ({ lockingBytecode: p2pkh(i), cumulative: BigInt(i + 1) }));
    const tree = new MerkleTree(entries);
    expect(tree.depth).toBe(9);
    for (const i of [0, 1, 150, 298, 299]) expect(binToHex(rootFromProof(entries[i], tree.proof(i)))).toBe(binToHex(tree.root));
    expect(() => new MerkleTree([entries[0], entries[0]])).toThrow(/duplicate/);
  });
});

describe('RootRegistry', () => {
  it('activates a proposed root only after the 144-block audit window', async () => {
    const ctx = await setup(8);
    const tree = new MerkleTree(ctx.entries);
    await ctx.registry.connect(ctx.operator).call.proposeRoot(sig(ctx.operator), tree.root, 1n).send();
    expect(await outcome(activate(ctx))).not.toBe('accepted');
    await ctx.provider.mine(ROOT_DELAY - 1);
    expect(await outcome(activate(ctx))).not.toBe('accepted');
    await ctx.provider.mine(3);
    expect(await outcome(activate(ctx))).toBe('accepted');
    const state = await ctx.registry.getState();
    expect(binToHex(state.activeRoot)).toBe(binToHex(tree.root));
    expect(state.activeEpoch).toBe(1n);
  });

  it('accepts proposals only from the operator key, with increasing epochs', async () => {
    const ctx = await setup(8);
    const tree = new MerkleTree(ctx.entries);
    expect(await outcome(ctx.registry.connect(ctx.mallory).call.proposeRoot(sig(ctx.mallory), tree.root, 1n).send()))
      .not.toBe('accepted');
    await publish(ctx, tree, 1n);
    expect(await outcome(ctx.registry.connect(ctx.operator).call.proposeRoot(sig(ctx.operator), tree.root, 1n).send()))
      .not.toBe('accepted');
  });

  it('does not let the pool sync while a root is pending (no one can reset the audit timer)', async () => {
    const ctx = await setup(8);
    const t1 = new MerkleTree(ctx.entries);
    await publish(ctx, t1, 1n);
    const t2 = new MerkleTree(ctx.entries.map((e) => ({ ...e, cumulative: e.cumulative + 1n })));
    await ctx.registry.connect(ctx.operator).call.proposeRoot(sig(ctx.operator), t2.root, 2n).send();
    expect(await outcome(ctx.pool.connect(ctx.mallory).call.syncRoot().send())).not.toBe('accepted');
  });
});

describe('FoldClaimPool claims', () => {
  it('pays a leaf once, to its own address, whoever submits the claim', async () => {
    const ctx = await setup(300);
    const tree = new MerkleTree(ctx.entries);
    await publish(ctx, tree, 1n);

    await claim(ctx, ctx.bob, tree, 0);
    expect(await tokensOf(ctx, ctx.entries[0].lockingBytecode)).toBe(5_000n);
    expect(await outcome(claim(ctx, ctx.bob, tree, 0))).not.toBe('accepted');          // already claimed

    // Bob relays Carol's claim: the tokens still go to Carol.
    await claim(ctx, ctx.bob, tree, 1);
    expect(await tokensOf(ctx, ctx.entries[1].lockingBytecode)).toBe(12_345n);
    expect(await tokensOf(ctx, ctx.entries[0].lockingBytecode)).toBe(5_000n);
  });

  it('refuses forged claims', async () => {
    const ctx = await setup(300);
    const tree = new MerkleTree(ctx.entries);
    await publish(ctx, tree, 1n);
    const mallory = ctx.mallory.getLockingBytecode();
    // Carol's proof, but paid to Mallory.
    expect(await outcome(claim(ctx, ctx.mallory, tree, 1, { recipient: mallory }))).not.toBe('accepted');
    // A larger amount than the leaf says.
    expect(await outcome(claim(ctx, ctx.mallory, tree, 1, { cumulative: 1_000_000n }))).not.toBe('accepted');
    // The right leaf with the wrong index (path).
    expect(await outcome(claim(ctx, ctx.mallory, tree, 1, { index: 3n }))).not.toBe('accepted');
    // An index beyond the tree.
    expect(await outcome(claim(ctx, ctx.mallory, tree, 1, { index: 1n + 512n }))).not.toBe('accepted');
    // A truncated proof.
    expect(await outcome(claim(ctx, ctx.mallory, tree, 1, { proof: tree.proof(1).proofBytes.slice(0, 64) }))).not.toBe('accepted');
    // Another token category.
    expect(await outcome(claim(ctx, ctx.mallory, tree, 1, { category: OTHER }))).not.toBe('accepted');
    expect(await tokensOf(ctx, mallory)).toBe(0n);
    expect(await tokensOf(ctx, ctx.entries[1].lockingBytecode)).toBe(0n);
  });

  it('pays only the difference under a newer cumulative root, and users can skip epochs', async () => {
    const ctx = await setup(300);
    const t1 = new MerkleTree(ctx.entries);
    await publish(ctx, t1, 1n);
    await claim(ctx, ctx.bob, t1, 0);                                                    // Bob takes 5,000 in epoch 1

    const e2 = ctx.entries.map((e, i) => ({ ...e, cumulative: e.cumulative + (i === 0 ? 3_000n : 100n) }));
    const t2 = new MerkleTree(e2);
    await publish(ctx, t2, 2n);
    expect(await outcome(claim(ctx, ctx.bob, t1, 0))).not.toBe('accepted');             // old root no longer valid
    await claim(ctx, ctx.bob, t2, 0);
    expect(await tokensOf(ctx, e2[0].lockingBytecode)).toBe(8_000n);                    // 5,000 + 3,000
    await claim(ctx, ctx.bob, t2, 1);                                                    // Carol skipped epoch 1
    expect(await tokensOf(ctx, e2[1].lockingBytecode)).toBe(12_445n);
  });

  it('measures claim transaction sizes for the cost comparison', async () => {
    const ctx = await setup(300);
    const tree = new MerkleTree(ctx.entries);
    await publish(ctx, tree, 1n);
    const sizes: number[] = [];
    for (let i = 2; i < 12; i++) {
      const tx = await claim(ctx, ctx.bob, tree, i);
      sizes.push(tx.hex.length / 2);
      expect(await tokensOf(ctx, ctx.entries[i].lockingBytecode)).toBe(ctx.entries[i].cumulative);
    }
    const first = await ctx.provider.getUtxosForLockingBytecode(ctx.entries[2].lockingBytecode);
    mkdirSync('reports', { recursive: true });
    writeFileSync('reports/claim-sizes.json', JSON.stringify({ claimTxBytes: sizes, tokenOutputSats: first.map((u: any) => String(u.satoshis)), depth: tree.depth, publishWaits }, null, 2));
  });
});
