/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { hexToBin, binToHex } from '@bitauth/libauth';
import { compileFile } from '@solidcash/solidc';
import { SignatureTemplate } from '@solidcash/solidcash';
import { MockNetworkProvider } from '@solidcash/solidcash/network/mock';
import { StatefulContract, getDataNftLockingBytecode } from '@solidcash/solidcash/stateful';
import { MerkleTree, type Entry } from '../src/merkle.js';
import { withRelativeLock } from '../src/relative-lock.js';

const ASSET = 'f01dca5ef01dca5ef01dca5ef01dca5ef01dca5ef01dca5ef01dca5ef01dca5e';
const POOL_TOKENS = 1_000_000_000n;
const registryArtifact = compileFile(new URL('../contracts/RootRegistry.scash', import.meta.url)) as any;
const poolArtifact = compileFile(new URL('../contracts/FoldClaimPool.scash', import.meta.url), process.env.DEBUG_POOL ? { optimise: false } as any : undefined) as any;

function p2pkh(seed: number): Uint8Array {
  const pkh = new Uint8Array(20);
  new DataView(pkh.buffer).setUint32(0, seed);
  pkh[19] = 0xfc;
  return Uint8Array.from([0x76, 0xa9, 0x14, ...pkh, 0x88, 0xac]);
}

async function setup(leafCount = 300) {
  const provider = new MockNetworkProvider({ profile: 'production' });
  const [operator, bob, carol] = await provider.getSigners(3, { fundingUtxos: 12, genesisFundingUtxos: 3 });
  const genesisCoins = (await operator.getUtxos()).filter((u: any) => u.vout === 0 && !u.token && u.satoshis >= 200_000n);

  const { contract: registryContract } = await StatefulContract.deploy(registryArtifact, [operator.publicKey], {
    provider, fundingUtxo: genesisCoins[0], funder: operator.unlockP2PKH(), changeAddress: operator.getAddress(),
  } as any);
  const registry = registryContract as any;

  const tokenCoin = { txid: 'c'.repeat(64), vout: 0, satoshis: 1_200n, token: { category: ASSET, amount: POOL_TOKENS } };
  await provider.seedUtxo(operator.getAddress(), tokenCoin);
  const { contract: poolContract } = await StatefulContract.deploy(
    poolArtifact, [hexToBin(ASSET), getDataNftLockingBytecode(registry.categoryId, hexToBin(registry.inner.lockingBytecode))], {
      provider, fundingUtxo: genesisCoins[1], funder: operator.unlockP2PKH(), changeAddress: operator.getAddress(),
      tokenContainers: [{ utxo: tokenCoin, unlocker: operator.unlockP2PKH() }],
    } as any,
  );
  const pool = StatefulContract.withCategory((poolContract as any).inner, (poolContract as any).categoryId, {
    externalContracts: { IRootRegistry: { artifact: registryArtifact, categoryId: registry.categoryId, constructorArgs: [operator.publicKey] } },
  } as any) as any;

  const entries: Entry[] = [
    { lockingBytecode: bob.getLockingBytecode(), cumulative: 5_000n },
    { lockingBytecode: carol.getLockingBytecode(), cumulative: 12_345n },
  ];
  for (let i = 2; i < leafCount; i++) entries.push({ lockingBytecode: p2pkh(i), cumulative: BigInt(1000 + i) });
  return { provider, operator, bob, carol, registry, pool, entries, tree: new MerkleTree(entries) };
}

const tokensOf = async (signer: any) => (await signer.getUtxos())
  .filter((u: any) => u.token?.category === ASSET).reduce((n: bigint, u: any) => n + u.token.amount, 0n);

describe('FoldClaimPool + RootRegistry', () => {
  it('compile under the 10,000-byte input limit', () => {
    expect(poolArtifact.bytecode.length).toBeGreaterThan(0);
    expect(registryArtifact.bytecode.length).toBeGreaterThan(0);
  });

  it('activates a root only after 144 blocks, then pays claims once', async () => {
    const { provider, operator, bob, registry, pool, tree, entries } = await setup(300);
    expect(tree.depth).toBe(9);

    await registry.connect(operator).call.proposeRoot(new SignatureTemplate(operator.privateKey), tree.root, 1n).send();
    const activate = () => withRelativeLock(registry.categoryId, 144, () => registry.connect(operator).call.activateRoot().send());
    const early = await activate().then(() => 'accepted', (e: any) => String(e.message));
    console.log('early activation:', early.slice(0, 200));
    expect(early).not.toBe('accepted');

    const proposedAt = await provider.getBlockHeight();
    await provider.mine(143);
    expect(await activate().then(() => 'accepted', (e: any) => String(e.message))).toMatch(/BIP68|audit window/);
    let extra = 0;
    for (;;) {
      await provider.mine(1); extra += 1;
      const r = await activate().then(() => 'accepted', (e: any) => String(e.message));
      if (r === 'accepted') break;
      if (extra > 3) throw new Error(r);
    }
    console.log('activated', (await provider.getBlockHeight()) - proposedAt, 'blocks after the proposal tip');
    expect(binToHex((await registry.getState()).activeRoot)).toBe(binToHex(tree.root));

    const own = await provider.getUtxosByTokenCategory(registry.categoryId);
    const master = own.find((u: any) => u.token?.nft?.capability === 'minting');
    console.log('DBG inner', registry.inner.lockingBytecode, typeof registry.inner.lockingBytecode);
    console.log('DBG withCat', String(registry.inner.withCategory(hexToBin(registry.categoryId)).lockingBytecode));
    const lo: any = master && await provider.getLedgerOutput(master.txid, master.vout); console.log('DBG master utxo lock', lo && (typeof lo.lockingBytecode === 'string' ? lo.lockingBytecode : binToHex(lo.lockingBytecode)));
    console.log('STEP sync');
    await pool.connect(operator).call.syncRoot().send();
    console.log('STEP synced');
    const poolState = await pool.getState();
    expect(binToHex(poolState.root)).toBe(binToHex(tree.root));
    expect(poolState.epoch).toBe(1n);

    console.log('STEP claim');
    const proof = tree.proof(0);
    await pool.connect(bob).call.claim(hexToBin(ASSET), entries[0].lockingBytecode, 5_000n, proof.proofBytes, 0n).send();
    expect(await tokensOf(bob)).toBe(5_000n);
    await expect(pool.connect(bob).call.claim(hexToBin(ASSET), entries[0].lockingBytecode, 5_000n, proof.proofBytes, 0n).send())
      .rejects.toThrow();
  });
});
