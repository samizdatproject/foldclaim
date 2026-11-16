// Claim tool for any leaf of a published epoch (the user-facing counterpart of the demo steps).
//
//   node --experimental-transform-types --no-warnings scripts/claim.ts <mainnet|chipnet> <tree-epochN.json> <address> [--payer <wif-file>] [--dry-run]
//
// It finds the leaf for <address> in the epoch file (the static proof file the operator publishes), checks the
// proof against the root locally, and sends the claim. The tokens always go to the leaf's own address. The payer
// only pays the fee: the user's own key (--payer), or a relayer's. Without --payer it uses the operator key as the
// relayer. --dry-run stops after the local checks and prints what it would send.
import { readFileSync } from 'node:fs';
import { binToHex, hexToBin, cashAddressToLockingBytecode } from '@bitauth/libauth';
import { Signer } from '@solidcash/solidcash';
import { ElectrumNetworkProvider } from '@solidcash/solidcash/network/electrum';
import { StatefulContract, getDataNftLockingBytecode } from '@solidcash/solidcash/stateful';
import { rootFromProof } from '../src/merkle.ts';

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const dryRun = args.includes('--dry-run') && Boolean(args.splice(args.indexOf('--dry-run'), 1));
const payerFile = flag('--payer');
const [network, treeFile, address] = args;
if ((network !== 'mainnet' && network !== 'chipnet') || !treeFile || !address) {
  console.error('usage: claim.ts <mainnet|chipnet> <tree-epochN.json> <address> [--payer <wif-file>] [--dry-run]');
  process.exit(2);
}

const lock = cashAddressToLockingBytecode(address.includes(':') ? address : `${network === 'mainnet' ? 'bitcoincash' : 'bchtest'}:${address}`);
if (typeof lock === 'string') throw new Error(`not a valid address: ${lock}`);
const lockHex = binToHex(lock.bytecode);

const tree = JSON.parse(readFileSync(treeFile, 'utf8'));
const leaf = tree.leaves.find((l: any) => l.lockingBytecode === lockHex);
if (!leaf) { console.error(`no leaf for ${address} in epoch ${tree.epoch}`); process.exit(1); }
const proofBytes = hexToBin(leaf.proof);
const siblings = Array.from({ length: proofBytes.length / 32 }, (_, k) => proofBytes.slice(k * 32, k * 32 + 32));
const entry = { lockingBytecode: lock.bytecode, cumulative: BigInt(leaf.cumulative) };
const root = binToHex(rootFromProof(entry, { index: leaf.index, siblings, proofBytes }));
if (root !== tree.root) throw new Error('proof does not match the epoch root; the file is corrupt');
console.log(`leaf ${leaf.index} of epoch ${tree.epoch}: cumulative ${leaf.cumulative}, proof depth ${siblings.length}, root ${root}`);

const dir = new URL(`../deployments/${network}/`, import.meta.url);
const state = JSON.parse(readFileSync(new URL('state.json', dir), 'utf8'));
const artifact = (name: string) => JSON.parse(readFileSync(new URL(`${name}.artifact.json`, dir), 'utf8'));
const provider = new ElectrumNetworkProvider(network);
const secret = (path: string) => readFileSync(path, 'utf8').trim();
const payer = new Signer(secret(payerFile ?? new URL(`../secrets/${network}-operator.wif`, import.meta.url).pathname), provider) as any;
// The registry's operator key is a public constructor argument (it is committed to in the registry's lock).
const operatorPub = hexToBin(JSON.parse(readFileSync(new URL('public.json', dir), 'utf8')).operatorPublicKey);

const registryData = getDataNftLockingBytecode(state.steps.registry.categoryId, hexToBin(state.steps.registry.lockingBytecode));
const pool = StatefulContract.from(artifact('FoldClaimPool'), [hexToBin(state.steps.token.category), registryData], {
  provider,
  externalContracts: { IRootRegistry: { artifact: artifact('RootRegistry'), categoryId: state.steps.registry.categoryId, constructorArgs: [operatorPub] } },
} as any, state.steps.pool.categoryId) as any;

const poolState = await pool.getState();
if (binToHex(poolState.root) !== tree.root) {
  console.error(`the pool is at epoch ${poolState.epoch} with another root; this file is for epoch ${tree.epoch}`);
  process.exit(1);
}
if (dryRun) { console.log(`dry run: would claim for ${address}, fee paid by ${payer.getAddress()}`); process.exit(0); }
try {
  const result = await pool.connect(payer).call
    .claim(hexToBin(state.steps.token.category), lock.bytecode, entry.cumulative, proofBytes, BigInt(leaf.index)).send();
  console.log(`claimed: ${result.txid}`);
  process.exit(0);
} catch (e: any) {
  const message = String(e?.message ?? e);
  console.error(/nothing to claim/i.test(message) ? 'nothing to claim: this cumulative amount was already paid' : `claim failed: ${message}`);
  process.exit(1);
}
