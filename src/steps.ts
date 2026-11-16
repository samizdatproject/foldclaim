// The FoldClaim deployment and demo as resumable steps. The same code runs on the production-limit mock (the
// rehearsal test) and on a real network (scripts/run.ts). Every step writes what it did to a state file before the
// next one starts, and refuses to run twice, so a crash never loses a contract's category or repeats a broadcast.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { binToHex, hexToBin } from '@bitauth/libauth';
import { compileFile } from '@solidcash/solidc';
import { SignatureTemplate, TransactionBuilder } from '@solidcash/solidcash';
import { StatefulContract, getDataNftLockingBytecode } from '@solidcash/solidcash/stateful';
import { withRelativeLock } from './relative-lock.ts';
import { demoTree, DEMO_INDEXES } from './demo-tree.ts';
import type { MerkleTree } from './merkle.ts';

export const ROOT_DELAY = 144;
export const POOL_TOKENS = 1_000_000_000n;
const FEE_RATE = 1.1; // sat/byte for the plain transactions; the relay minimum is 1
const TOKEN_OUTPUT_SATS = 1_200n;

export type Ctx = {
  provider: any;
  operator: any; // a Signer that holds the operator key and pays every fee
  dir: string; // where state.json, the artifacts and the proof files live
  seed: Uint8Array; // the demo recipients' secret seed
  log?: (line: string) => void;
};

type Tx = { txid: string; bytes: number; spent: string };
type State = {
  operator: string;
  steps: Record<string, any>;
  txs: Record<string, Tx>;
};

const statePath = (ctx: Ctx) => join(ctx.dir, 'state.json');
function load(ctx: Ctx): State {
  if (!existsSync(statePath(ctx))) return { operator: ctx.operator.getAddress(), steps: {}, txs: {} };
  const s = JSON.parse(readFileSync(statePath(ctx), 'utf8')) as State;
  if (s.operator !== ctx.operator.getAddress()) throw new Error(`state belongs to ${s.operator}, not this operator`);
  return s;
}
function save(ctx: Ctx, s: State) {
  mkdirSync(ctx.dir, { recursive: true });
  writeFileSync(statePath(ctx), JSON.stringify(s, null, 2) + '\n');
}
const say = (ctx: Ctx, line: string) => (ctx.log ?? console.log)(line);

// --- artifacts: compiled once at deploy time and kept beside the state, so later runs use exactly those bytes ---
function artifact(ctx: Ctx, name: 'RootRegistry' | 'FoldClaimPool') {
  const path = join(ctx.dir, `${name}.artifact.json`);
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
  const a = compileFile(new URL(`../contracts/${name}.scash`, import.meta.url)) as any;
  mkdirSync(ctx.dir, { recursive: true });
  writeFileSync(path, JSON.stringify(a, null, 2) + '\n');
  return JSON.parse(readFileSync(path, 'utf8'));
}

// --- operator balance, for the cost of each step ---
async function balance(ctx: Ctx): Promise<bigint> {
  const utxos = await ctx.provider.getUtxosForLockingBytecode(ctx.operator.getLockingBytecode());
  return utxos.reduce((n: bigint, u: any) => n + BigInt(u.satoshis), 0n);
}
async function recordTx(ctx: Ctx, s: State, label: string, result: any, before: bigint) {
  const hex: string = result.hex ?? '';
  s.txs[label] = { txid: result.txid, bytes: hex.length / 2, spent: '?' };
  save(ctx, s); // the broadcast is on record before anything else can fail
  const spent = before - (await balance(ctx));
  s.txs[label].spent = spent.toString();
  save(ctx, s);
  say(ctx, `${label}: ${result.txid}  (${hex.length / 2} bytes, operator spent ${spent} sats)`);
}

/** A plain operator coin at output 0 (a CashTokens genesis input), made by a self-send when there is none. */
async function genesisCoin(ctx: Ctx, s: State, label: string, sats: bigint) {
  const utxos = await ctx.provider.getUtxosForLockingBytecode(ctx.operator.getLockingBytecode());
  const plain = utxos.filter((u: any) => !u.token);
  const ready = plain.find((u: any) => u.vout === 0 && BigInt(u.satoshis) >= sats && BigInt(u.satoshis) <= sats * 3n);
  if (ready) return ready;
  const source = plain.sort((a: any, b: any) => Number(BigInt(b.satoshis) - BigInt(a.satoshis)))[0];
  if (!source || BigInt(source.satoshis) < sats + 2_000n) throw new Error('not enough BCH for a genesis coin');
  const before = await balance(ctx);
  const result = await new TransactionBuilder({ provider: ctx.provider })
    .addInput(source, ctx.operator.unlockP2PKH())
    .addOutput({ to: ctx.operator.getLockingBytecode(), amount: sats })
    .addBchChangeOutputIfNeeded({ to: ctx.operator.getLockingBytecode(), feeRate: FEE_RATE })
    .send();
  await recordTx(ctx, s, `${label}-coin`, result, before);
  return { txid: result.txid, vout: 0, satoshis: sats };
}

// --- contracts, re-attached from the state ---
function registry(ctx: Ctx, s: State) {
  const r = s.steps.registry ?? (() => { throw new Error('run the registry step first'); })();
  return StatefulContract.from(artifact(ctx, 'RootRegistry'), [ctx.operator.publicKey], { provider: ctx.provider } as any, r.categoryId) as any;
}
function registryData(ctx: Ctx, s: State) {
  return getDataNftLockingBytecode(s.steps.registry.categoryId, hexToBin(s.steps.registry.lockingBytecode));
}
function pool(ctx: Ctx, s: State) {
  const p = s.steps.pool ?? (() => { throw new Error('run the pool step first'); })();
  return StatefulContract.from(artifact(ctx, 'FoldClaimPool'), [hexToBin(s.steps.token.category), registryData(ctx, s)], {
    provider: ctx.provider,
    externalContracts: {
      IRootRegistry: { artifact: artifact(ctx, 'RootRegistry'), categoryId: s.steps.registry.categoryId, constructorArgs: [ctx.operator.publicKey] },
    },
  } as any, p.categoryId) as any;
}

/** Write the tree's leaves and every proof to a static file: the proof-serving endpoint can be this file. */
function writeTree(ctx: Ctx, tree: MerkleTree, epoch: number) {
  const file = join(ctx.dir, `tree-epoch${epoch}.json`);
  const body = {
    epoch,
    root: binToHex(tree.root),
    depth: tree.depth,
    leaves: tree.entries.map((e, index) => ({
      index,
      lockingBytecode: binToHex(e.lockingBytecode),
      cumulative: e.cumulative.toString(),
      proof: binToHex(tree.proof(index).proofBytes),
    })),
  };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(body, null, 1) + '\n');
  return file;
}

// --- the steps ---
export async function deployRegistry(ctx: Ctx) {
  const s = load(ctx);
  if (s.steps.registry) throw new Error('registry already deployed');
  const coin = await genesisCoin(ctx, s, 'registry', 20_000n);
  const before = await balance(ctx);
  const { tx, categoryId, contract } = await StatefulContract.deploy(artifact(ctx, 'RootRegistry'), [ctx.operator.publicKey], {
    provider: ctx.provider, fundingUtxo: coin, funder: ctx.operator.unlockP2PKH(), changeAddress: ctx.operator.getAddress(),
  } as any);
  s.steps.registry = { categoryId, lockingBytecode: (contract as any).inner.lockingBytecode };
  save(ctx, s);
  await recordTx(ctx, s, 'registry-deploy', tx, before);
}

export async function propose(ctx: Ctx, epoch: number) {
  const s = load(ctx);
  const key = `propose${epoch}`;
  if (s.steps[key]) throw new Error(`epoch ${epoch} already proposed`);
  const tree = demoTree(ctx.seed, epoch);
  const file = writeTree(ctx, tree, epoch);
  const r = registry(ctx, s);
  // A proposal restarts the 144-block audit window, so never send one that is already pending on-chain.
  const onChain = await r.getState();
  if (BigInt(onChain.pendingEpoch) === BigInt(epoch) && binToHex(onChain.pendingRoot) === binToHex(tree.root)) {
    s.steps[key] = { root: binToHex(tree.root), treeFile: file, recovered: true };
    save(ctx, s);
    say(ctx, `${key}: already pending on-chain; recorded without sending again`);
    return;
  }
  const before = await balance(ctx);
  const result = await r.connect(ctx.operator).call
    .proposeRoot(new SignatureTemplate(ctx.operator.privateKey), tree.root, BigInt(epoch)).send();
  s.steps[key] = { root: binToHex(tree.root), treeFile: file, txid: result.txid };
  save(ctx, s);
  s.steps[key].height = await ctx.provider.getBlockHeight();
  save(ctx, s);
  await recordTx(ctx, s, key, result, before);
}

export async function mintToken(ctx: Ctx) {
  const s = load(ctx);
  if (s.steps.token) throw new Error('token already minted');
  const coin = await genesisCoin(ctx, s, 'token', 5_000n);
  const before = await balance(ctx);
  const result = await new TransactionBuilder({ provider: ctx.provider })
    .addInput(coin, ctx.operator.unlockP2PKH())
    .addOutput({ to: ctx.operator.getLockingBytecode(), amount: TOKEN_OUTPUT_SATS, token: { category: coin.txid, amount: POOL_TOKENS } })
    .addBchChangeOutputIfNeeded({ to: ctx.operator.getLockingBytecode(), feeRate: FEE_RATE })
    .send();
  s.steps.token = { category: coin.txid };
  save(ctx, s);
  await recordTx(ctx, s, 'token-genesis', result, before);
}

export async function deployPool(ctx: Ctx) {
  const s = load(ctx);
  if (s.steps.pool) throw new Error('pool already deployed');
  if (!s.steps.token) throw new Error('run the token step first');
  const utxos = await ctx.provider.getUtxosForLockingBytecode(ctx.operator.getLockingBytecode());
  const tokenCoin = utxos.find((u: any) => u.token?.category === s.steps.token.category && !u.token.nft);
  if (!tokenCoin) throw new Error('token coin not found');
  const coin = await genesisCoin(ctx, s, 'pool', 20_000n);
  const before = await balance(ctx);
  const { tx, categoryId } = await StatefulContract.deploy(artifact(ctx, 'FoldClaimPool'), [hexToBin(s.steps.token.category), registryData(ctx, s)], {
    provider: ctx.provider, fundingUtxo: coin, funder: ctx.operator.unlockP2PKH(), changeAddress: ctx.operator.getAddress(),
    tokenContainers: [{ utxo: tokenCoin, unlocker: ctx.operator.unlockP2PKH() }],
  } as any);
  s.steps.pool = { categoryId };
  save(ctx, s);
  await recordTx(ctx, s, 'pool-deploy', tx, before);
}

/** Activate the pending root. Refused (and nothing is spent) until the audit window has passed. */
export async function activate(ctx: Ctx, epoch: number) {
  const s = load(ctx);
  const key = `activate${epoch}`;
  if (s.steps[key]) throw new Error(`epoch ${epoch} already active`);
  if (!s.steps[`propose${epoch}`]) throw new Error(`epoch ${epoch} not proposed`);
  const r = registry(ctx, s);
  const onChain = await r.getState();
  if (BigInt(onChain.pendingEpoch) !== BigInt(epoch)) throw new Error(`on-chain pending epoch is ${onChain.pendingEpoch}, not ${epoch}`);
  if (BigInt(onChain.activeEpoch) === BigInt(epoch)) throw new Error(`epoch ${epoch} is already active on-chain`);
  const before = await balance(ctx);
  const result = await withRelativeLock(s.steps.registry.categoryId, ROOT_DELAY, () => r.connect(ctx.operator).call.activateRoot().send());
  s.steps[key] = { height: await ctx.provider.getBlockHeight() };
  save(ctx, s);
  await recordTx(ctx, s, key, result, before);
}

export async function sync(ctx: Ctx, epoch: number) {
  const s = load(ctx);
  const key = `sync${epoch}`;
  if (s.steps[key]) throw new Error(`pool already synced to epoch ${epoch}`);
  const before = await balance(ctx);
  const result = await pool(ctx, s).connect(ctx.operator).call.syncRoot().send();
  s.steps[key] = { height: await ctx.provider.getBlockHeight() };
  save(ctx, s);
  await recordTx(ctx, s, key, result, before);
}

/** Claim for demo recipients `which` (0..9) at `epoch`, relayed by the operator; tokens go to each leaf's own lock. */
export async function claim(ctx: Ctx, epoch: number, which: number[]) {
  const s = load(ctx);
  if (!s.steps[`sync${epoch}`]) throw new Error(`pool not synced to epoch ${epoch}`);
  const tree = demoTree(ctx.seed, epoch);
  if (binToHex(tree.root) !== s.steps[`propose${epoch}`].root) throw new Error('demo tree does not match the proposed root');
  const p = pool(ctx, s);
  for (const d of which) {
    const key = `claim${epoch}-${d}`;
    if (s.steps[key]) { say(ctx, `${key}: already done`); continue; }
    const index = DEMO_INDEXES[d];
    const e = tree.entries[index];
    const before = await balance(ctx);
    let result: any;
    try {
      result = await p.connect(ctx.operator).call
        .claim(hexToBin(s.steps.token.category), e.lockingBytecode, e.cumulative, tree.proof(index).proofBytes, BigInt(index)).send();
    } catch (err: any) {
      if (!/nothing to claim/i.test(String(err?.message ?? err))) throw err;
      s.steps[key] = { index, cumulative: e.cumulative.toString(), recovered: true };
      save(ctx, s);
      say(ctx, `${key}: already paid on-chain`);
      continue;
    }
    s.steps[key] = { index, cumulative: e.cumulative.toString(), txid: result.txid };
    save(ctx, s);
    await recordTx(ctx, s, key, result, before);
  }
}

export async function status(ctx: Ctx) {
  const s = load(ctx);
  const height = await ctx.provider.getBlockHeight();
  say(ctx, `operator ${s.operator}  balance ${await balance(ctx)} sats  height ${height}`);
  for (const [k, v] of Object.entries(s.steps)) say(ctx, `  ${k}: ${JSON.stringify(v)}`);
  for (const e of [1, 2]) {
    const p = s.steps[`propose${e}`];
    if (p && !s.steps[`activate${e}`]) say(ctx, `  epoch ${e}: proposed at ${p.height}; activation possible from about ${p.height + ROOT_DELAY + 2}`);
  }
  return s;
}
