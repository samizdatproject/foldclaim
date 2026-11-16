/* eslint-disable @typescript-eslint/no-explicit-any */
import { writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hexToBin, decodeTransactionBch } from '@bitauth/libauth';
import { compileFile } from '@solidcash/solidc';
import { SignatureTemplate } from '@solidcash/solidcash';
import { MockNetworkProvider } from '@solidcash/solidcash/network/mock';
import { StatefulContract, getDataNftLockingBytecode } from '@solidcash/solidcash/stateful';
import { rootFromProof, concat, type Entry, type Proof } from '../src/merkle.js';
import { withRelativeLock } from '../src/relative-lock.js';

const ASSET = 'f01dca5ef01dca5ef01dca5ef01dca5ef01dca5ef01dca5ef01dca5ef01dca5e';
const ROOT_DELAY = 144;
const registryArtifact = compileFile(new URL('../contracts/RootRegistry.scash', import.meta.url)) as any;
const poolArtifact = compileFile(new URL('../contracts/FoldClaimPool.scash', import.meta.url)) as any;

async function setup() {
  const provider = new MockNetworkProvider({ profile: 'production' });
  const [operator, bob, carol] = await provider.getSigners(3, { fundingUtxos: 40, genesisFundingUtxos: 3 });
  const genesisCoins = (await operator.getUtxos()).filter((u: any) => u.vout === 0 && !u.token && u.satoshis >= 200_000n);
  const { contract: registryContract } = await StatefulContract.deploy(registryArtifact, [operator.publicKey], {
    provider, fundingUtxo: genesisCoins[0], funder: operator.unlockP2PKH(), changeAddress: operator.getAddress(),
  } as any);
  const registry = registryContract as any;
  const tokenCoin = { txid: 'c'.repeat(64), vout: 0, satoshis: 1_200n, token: { category: ASSET, amount: 1_000_000_000n } };
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
  return { provider, operator, bob, carol, registry, pool };
}
type Ctx = Awaited<ReturnType<typeof setup>>;
const outcome = (p: Promise<unknown>) => p.then(() => 'accepted', (e: any) => String(e?.message ?? e));

async function publishRoot(ctx: Ctx, root: Uint8Array, epoch: bigint) {
  const sig = new SignatureTemplate(ctx.operator.privateKey);
  await ctx.registry.connect(ctx.operator).call.proposeRoot(sig, root, epoch).send();
  await ctx.provider.mine(ROOT_DELAY);
  for (let extra = 0; ; extra++) {
    const r = await outcome(withRelativeLock(ctx.registry.categoryId, ROOT_DELAY,
      () => ctx.registry.connect(ctx.operator).call.activateRoot().send()));
    if (r === 'accepted') break;
    if (extra >= 6) throw new Error(`activation still refused: ${r}`);
    await ctx.provider.mine(1);
  }
  await ctx.pool.connect(ctx.operator).call.syncRoot().send();
}

/** One real leaf at `index` plus a synthetic random sibling path of `depth`; root computed like the contract. */
function synthetic(entry: Entry, depth: number, index: number) {
  const siblings = Array.from({ length: depth }, () => new Uint8Array(randomBytes(32)));
  const proof: Proof = { index, siblings, proofBytes: concat(...siblings) };
  return { proof, root: rootFromProof(entry, proof) };
}

function claimTx(ctx: Ctx, entry: Entry, proof: Proof) {
  return ctx.pool.connect(ctx.operator).call.claim(
    hexToBin(ASSET), entry.lockingBytecode, entry.cumulative, proof.proofBytes, BigInt(proof.index),
  ).send();
}

function txStats(hex: string) {
  const bin = hexToBin(hex);
  const tx = decodeTransactionBch(bin);
  if (typeof tx === 'string') return { txBytes: bin.length, unlockingBytes: undefined as number | undefined };
  // the claim input is the one with the largest unlocking bytecode (contract code + proof)
  return { txBytes: bin.length, unlockingBytes: Math.max(...tx.inputs.map((i) => i.unlockingBytecode.length)) };
}

const results: any[] = [];
describe('proof depth vs production VM limits', () => {
  for (const depth of [9, 12, 16, 20, 24]) {
    it(`depth ${depth}`, { timeout: 900_000 }, async () => {
      const ctx = await setup();
      const maxIndex = 2 ** depth - 1;
      const randIndex = Math.floor(Math.random() * (2 ** depth - 2)) + 1; // mixed bits, < 2^depth - 1
      const bobLeaf: Entry = { lockingBytecode: ctx.bob.getLockingBytecode(), cumulative: 5_000n };
      const carolLeaf: Entry = { lockingBytecode: ctx.carol.getLockingBytecode(), cumulative: 7_000n };

      const a = synthetic(bobLeaf, depth, maxIndex);
      await publishRoot(ctx, a.root, 1n);
      const acc = await outcome(claimTx(ctx, bobLeaf, a.proof).then((tx: any) => { results.push({ hex: tx.hex }); return tx; }));
      const hex = results.pop().hex as string | undefined;
      const stats = hex ? txStats(hex) : { txBytes: 0, unlockingBytes: undefined };

      // second claim under a new root with a random index, other recipient
      const b = synthetic(carolLeaf, depth, randIndex);
      await publishRoot(ctx, b.root, 2n);
      let randStats: any = { accepted: 'not run' };
      const r2 = await claimTx(ctx, carolLeaf, b.proof).then((tx: any) => ({ accepted: true, ...txStats(tx.hex) }), (e: any) => ({ accepted: false, error: String(e?.message ?? e) }));
      randStats = r2;

      results.push({
        depth, maxLeaves: 2 ** depth, ...stats, accepted: acc === 'accepted', error: acc === 'accepted' ? undefined : acc,
        feeSatsAt1SatPerByte: stats.txBytes, randomIndex: randIndex, randomIndexClaim: randStats,
      });
      mkdirSync('reports', { recursive: true });
      writeFileSync('reports/depth-analysis.json', JSON.stringify(results.filter((r) => r.depth), null, 2));
      expect(acc).toBe('accepted');
      expect(randStats.accepted).toBe(true);
    });
  }

  it('refuses depth 25 (proof too deep)', { timeout: 900_000 }, async () => {
    const ctx = await setup();
    const leaf: Entry = { lockingBytecode: ctx.bob.getLockingBytecode(), cumulative: 5_000n };
    const s = synthetic(leaf, 25, 2 ** 25 - 1);
    await publishRoot(ctx, s.root, 1n);
    expect(await outcome(claimTx(ctx, leaf, s.proof))).toMatch(/proof too deep/);
  });
});
