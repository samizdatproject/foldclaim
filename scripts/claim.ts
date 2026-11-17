// Claim tool for any leaf of a published epoch (the user-facing counterpart of the demo steps).
//
//   node --experimental-transform-types --no-warnings scripts/claim.ts <mainnet|chipnet> <tree-epochN.json> <address> [--payer <wif-file>] [--dry-run]
//
// It finds the leaf for <address> in the epoch file (the static proof file the operator publishes), checks the
// proof against the root locally, and sends the claim. The tokens always go to the leaf's own address. The payer
// only pays the fee: the user's own key (--payer), or a relayer's. Without --payer it uses the operator key as the
// relayer. --dry-run stops after the local checks and prints what it would send.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { binToHex, cashAddressToLockingBytecode } from '@bitauth/libauth';
import { Signer } from '@solidcash/solidcash';
import { ElectrumNetworkProvider } from '@solidcash/solidcash/network/electrum';
import { attachDeployment, findLeaf, claimLeaf, type TreeFile } from '../src/pool.ts';

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
const tree = JSON.parse(readFileSync(treeFile, 'utf8')) as TreeFile;
const leaf = findLeaf(tree, lock.bytecode);
if (!leaf) { console.error(`no leaf for ${address} in epoch ${tree.epoch}`); process.exit(1); }
console.log(`leaf ${leaf.index} of epoch ${tree.epoch}: cumulative ${leaf.cumulative}, proof depth ${leaf.proofBytes.length / 32}, root ${tree.root}`);

const provider = new ElectrumNetworkProvider(network);
const secret = (path: string) => readFileSync(path, 'utf8').trim();
const payer = new Signer(secret(payerFile ?? new URL(`../secrets/${network}-operator.wif`, import.meta.url).pathname), provider) as any;
const { pool, tokenCategory } = attachDeployment(fileURLToPath(new URL(`../deployments/${network}/`, import.meta.url)), provider);

const poolState = await pool.getState();
if (binToHex(poolState.root) !== tree.root) {
  console.error(`the pool is at epoch ${poolState.epoch} with another root; this file is for epoch ${tree.epoch}`);
  process.exit(1);
}
if (dryRun) { console.log(`dry run: would claim for ${address}, fee paid by ${payer.getAddress()}`); process.exit(0); }
try {
  const result = await claimLeaf(pool, payer, tokenCategory, leaf);
  if (result.status === 'nothing-to-claim') { console.error('nothing to claim: this cumulative amount was already paid'); process.exit(1); }
  console.log(`claimed: ${result.txid}`);
  process.exit(0);
} catch (e: any) {
  console.error(`claim failed: ${String(e?.message ?? e)}`);
  process.exit(1);
}
