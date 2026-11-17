// Build the static FoldClaim page: copy the public deployment data into web/data/ (whitelisted fields only) and
// bundle web/src/main.js and web/src/live.js (the SolidCash SDK, loaded lazily) into web/dist/.
//   node web/build.mjs        (or: npm run web:build)
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';

const root = new URL('../', import.meta.url);
const src = new URL('deployments/mainnet/', root);
const web = new URL('web/', root);
const data = new URL('data/', web);
const read = (name) => JSON.parse(readFileSync(new URL(name, src), 'utf8'));
const write = (name, value) => writeFileSync(new URL(name, data), JSON.stringify(value));
const git = (...args) => { try { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim(); } catch { return ''; } };

rmSync(data, { recursive: true, force: true });
rmSync(new URL('dist/', web), { recursive: true, force: true });
mkdirSync(data, { recursive: true });

// state.json: keep only public on-chain facts (it also holds local paths, which must not be published).
const STEP_KEYS = ['categoryId', 'lockingBytecode', 'category', 'root', 'epoch', 'txid', 'height'];
const state = read('state.json');
const steps = Object.fromEntries(Object.entries(state.steps ?? {}).map(([name, step]) =>
  [name, Object.fromEntries(STEP_KEYS.filter((k) => step?.[k] !== undefined).map((k) => [k, step[k]]))]));
const txs = Object.fromEntries(Object.entries(state.txs ?? {}).filter(([, t]) => t?.txid).map(([name, t]) => [name, { txid: t.txid }]));
write('state.json', { steps, txs });

const pub = read('public.json');
write('public.json', {
  network: pub.network,
  operatorPublicKey: pub.operatorPublicKey,
  operatorAddress: pub.operatorAddress,
  demoRecipients: (pub.demoRecipients ?? []).map(({ demo, leafIndex, address, cashAddress }) => ({ demo, leafIndex, address, cashAddress })),
});

const epochs = readdirSync(src).map((f) => /^tree-epoch(\d+)\.json$/.exec(f)).filter(Boolean).map((m) => Number(m[1])).sort((a, b) => a - b);
if (epochs.length === 0) throw new Error('no tree-epoch*.json in deployments/mainnet');
for (const n of epochs) {
  const t = read(`tree-epoch${n}.json`);
  write(`tree-epoch${n}.json`, {
    epoch: t.epoch, root: t.root, depth: t.depth,
    leaves: t.leaves.map(({ index, lockingBytecode, cumulative, proof }) => ({ index, lockingBytecode, cumulative, proof })),
  });
}
for (const name of ['FoldClaimPool', 'RootRegistry']) write(`${name}.artifact.json`, read(`${name}.artifact.json`));

// Only the files this page publishes count (the live process also writes a log there).
const copied = ['state.json', 'public.json', 'FoldClaimPool.artifact.json', 'RootRegistry.artifact.json', ...epochs.map((n) => `tree-epoch${n}.json`)];
const dirty = git('status', '--porcelain', '--', ...copied.map((f) => `deployments/mainnet/${f}`)) !== '';
write('meta.json', { commit: git('rev-parse', '--short', 'HEAD') || 'unknown', dirty, builtAt: new Date().toISOString(), epochs });

// Two bundles: the page (small, one file) and the SolidCash SDK reader (large, fetched with import() after the page
// renders). The SDK bundle must keep code splitting: inlined into one file, libauth's top-level await deadlocks.
const common = { bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, legalComments: 'none', metafile: true, logLevel: 'warning' };
const outputs = {};
for (const options of [
  { entryPoints: [new URL('src/main.js', web).pathname], outfile: new URL('dist/main.js', web).pathname },
  { entryPoints: [new URL('src/live.js', web).pathname], outdir: new URL('dist/sdk/', web).pathname, splitting: true, chunkNames: 'chunks/[name]-[hash]' },
]) Object.assign(outputs, (await build({ ...common, ...options })).metafile.outputs);
const sdkBytes = Object.entries(outputs).filter(([f]) => f.includes('/sdk/')).reduce((n, [, o]) => n + o.bytes, 0);
console.log(`web/dist/main.js  ${(outputs[Object.keys(outputs).find((f) => f.endsWith('dist/main.js'))].bytes / 1024).toFixed(1)} KB`);
console.log(`web/dist/sdk/     ${(sdkBytes / 1024).toFixed(1)} KB in ${Object.keys(outputs).filter((f) => f.includes('/sdk/')).length} files (lazy)`);
console.log(`data: epochs ${epochs.join(', ')}, commit ${git('rev-parse', '--short', 'HEAD')}${dirty ? ' (deployments/mainnet has uncommitted changes)' : ''}`);
