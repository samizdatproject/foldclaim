// FoldClaim status page. Static data comes from web/data/ (copied from deployments/mainnet by web/build.mjs);
// live data comes from public Fulcrum servers over WSS and, lazily, from the SolidCash SDK (./live.js).
import { parseAddress, findLeaf, checkLeaf } from './lookup.js';
import { canRelay, relayClaim } from './relay.js';
import { Fulcrum } from './fulcrum.js';

const ROOT_DELAY = 144;
const SDK_TIMEOUT_MS = 60000;
const ZERO_ROOT = '0'.repeat(64);
const EXPLORER = (txid) => `https://explorer.bitcoinunlimited.info/tx/${txid}`;
const BLOCKCHAIR = (txid) => `https://blockchair.com/bitcoin-cash/transaction/${txid}`;
const DEPLOY_TXS = [
  ['registry-deploy', 'RootRegistry deploy'],
  ['propose1', 'Propose epoch 1'],
  ['token-genesis', 'Test token genesis'],
  ['pool-deploy', 'FoldClaimPool deploy'],
];

/** Every later step in state.json order: activations, syncs, claims, proposals (funding-coin splits are left out). */
function laterTxs(state) {
  const known = new Set(DEPLOY_TXS.map(([k]) => k));
  return Object.keys(state.txs).filter((k) => !known.has(k) && !k.endsWith('-coin')).map((k) => {
    let m;
    if ((m = k.match(/^activate(\d+)$/))) return [k, `Activate epoch ${m[1]}`];
    if ((m = k.match(/^sync(\d+)$/))) return [k, `Sync epoch ${m[1]} into the pool`];
    if ((m = k.match(/^propose(\d+)$/))) return [k, `Propose epoch ${m[1]}`];
    if ((m = k.match(/^claim(\d+)-(\d+)$/))) return [k, `Claim, epoch ${m[1]}, demo ${m[2]}`];
    return [k, k];
  });
}

const $ = (id) => document.getElementById(id);
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}
const short = (hex, n = 8) => (hex && hex.length > 2 * n + 1 ? `${hex.slice(0, n)}…${hex.slice(-n)}` : hex);
const code = (text, full) => el('code', full ? { title: full } : {}, text);
const getJson = async (path) => { const r = await fetch(path); if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`); return r.json(); };
const withTimeout = (promise, ms, what) => Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out`)), ms))]);

const S = { fulcrum: new Fulcrum(), tip: null, masterHeight: null, masterTxid: null, live: null, liveError: null, chainError: null };

/** The committed (state.json) view: what the deploy log says happened. */
function committedView(state) {
  const maxEpoch = (prefix) => Math.max(0, ...Object.keys(state.steps).map((k) => new RegExp(`^${prefix}(\\d+)$`).exec(k)).filter(Boolean).map((m) => Number(m[1])));
  const proposed = maxEpoch('propose');
  const active = maxEpoch('activate');
  const synced = maxEpoch('sync');
  const rootOf = (n) => state.steps[`propose${n}`]?.root ?? ZERO_ROOT;
  return {
    registry: { activeEpoch: String(active), activeRoot: rootOf(active), pendingEpoch: String(Math.max(proposed, active)), pendingRoot: rootOf(Math.max(proposed, active)) },
    pool: { epoch: String(synced), root: rootOf(synced) },
    proposeHeight: state.steps[`propose${proposed}`]?.height ?? null,
    proposeTxid: state.steps[`propose${proposed}`]?.txid ?? null,
  };
}

function renderHeader() {
  const { state, meta } = S;
  $('deploy-txs').replaceChildren(...[...DEPLOY_TXS, ...laterTxs(state)].filter(([k]) => state.txs[k]).map(([k, label]) => {
    const txid = state.txs[k].txid;
    return el('li', {}, el('span', { class: 'label' }, label), ' ',
      el('a', { href: EXPLORER(txid), rel: 'noopener noreferrer', target: '_blank' }, code(short(txid, 10), txid)), ' ',
      el('a', { href: BLOCKCHAIR(txid), rel: 'noopener noreferrer', target: '_blank', class: 'muted' }, 'blockchair'));
  }));
  const cats = [['Registry', state.steps.registry?.categoryId], ['Pool', state.steps.pool?.categoryId], ['Test token', state.steps.token?.category]];
  $('categories').replaceChildren(...cats.filter(([, c]) => c).flatMap(([label, c]) => [el('dt', {}, label), el('dd', {}, el('code', { class: 'wrap' }, c))]));
  $('data-version').textContent = `Data from commit ${meta.commit}${meta.dirty ? ' plus uncommitted changes' : ''}, built ${meta.builtAt.slice(0, 16).replace('T', ' ')} UTC.`;
}

function card(title, rows, note) {
  return el('div', { class: 'card' }, el('h3', {}, title),
    el('dl', {}, rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])), note ? el('p', { class: 'muted small' }, note) : null);
}

function rootCell(root) {
  return root === ZERO_ROOT ? el('span', { class: 'muted' }, 'none (zero)') : code(short(root), root);
}

function renderStatus() {
  const { tree, meta } = S;
  const committed = committedView(S.state);
  const view = S.live ?? committed;
  const isLive = Boolean(S.live);
  const reg = view.registry;
  const pending = Number(reg.pendingEpoch) > Number(reg.activeEpoch);

  // Earliest activation: the registry master UTXO's confirmation height + 144 (OP_CHECKSEQUENCEVERIFY).
  let activation = '—';
  let activationNote = null;
  // Without the SDK, "pending" comes from the snapshot: trust the live master UTXO only if it is still that proposal.
  const masterKnown = S.masterHeight !== null && (isLive || S.masterTxid === committed.proposeTxid);
  if (pending) {
    if (masterKnown && S.masterHeight > 0) {
      const at = S.masterHeight + ROOT_DELAY;
      activation = el('span', {}, el('strong', {}, `block ${at}`));
      activationNote = `Proposal confirmed at ${S.masterHeight} (live).` + (S.tip ? (S.tip >= at - 1 ? ' The window is over: anyone may activate now.' : ` About ${at - S.tip} blocks (≈ ${Math.round((at - S.tip) * 10 / 60)} h) to go.`) : '');
    } else if (masterKnown && S.masterHeight === 0) {
      activation = 'after the proposal confirms + 144 blocks';
    } else if (committed.proposeHeight) {
      activation = el('span', {}, `≈ block ${committed.proposeHeight + ROOT_DELAY}`);
      activationNote = `Approximate: committed proposal height ${committed.proposeHeight} + 144.`
        + (S.masterHeight !== null && !masterKnown ? ' The registry has moved on-chain since this snapshot; rebuild the page data.' : '');
    }
  }

  $('status-cards').replaceChildren(
    card('Pool', [['Epoch', view.pool.epoch], ['Root', rootCell(view.pool.root)]]),
    card('Registry', [['Active epoch', reg.activeEpoch], ['Active root', rootCell(reg.activeRoot)],
      ['Pending epoch', pending ? reg.pendingEpoch : el('span', { class: 'muted' }, 'none')], ['Pending root', pending ? rootCell(reg.pendingRoot) : '—']]),
    card('Audit window', [['Earliest activation', activation], ['Chain tip', S.tip ? String(S.tip) : el('span', { class: 'muted' }, S.chainError ? 'unavailable' : 'loading…')]],
      activationNote ?? (S.chainError && !S.tip ? `Electrum: ${S.chainError}` : null)),
    card(`Epoch file ${tree.epoch}`, [['Root', code(short(tree.root), tree.root)], ['Leaves', String(tree.leaves.length)], ['Depth', String(tree.depth)]]),
  );

  // What a claimer can do right now with the published epoch file.
  let verdict;
  if (view.pool.root === tree.root) verdict = ['ok', `The pool is synced to epoch ${tree.epoch}: claims against this file are accepted.`];
  else if (reg.activeRoot === tree.root) verdict = ['warn', `Epoch ${tree.epoch} is active in the registry but not yet synced into the pool. Anyone can call syncRoot; claims are refused until then.`];
  else if (pending && reg.pendingRoot === tree.root) verdict = ['warn', `Epoch ${tree.epoch} is pending in its 144-block audit window. Claims are refused until it is activated and synced into the pool.`];
  else verdict = ['bad', `The on-chain roots do not match epoch file ${tree.epoch}.`];
  $('status-verdict').className = `verdict ${verdict[0]}`;
  $('status-verdict').textContent = verdict[1];

  const source = $('status-source');
  if (isLive) source.textContent = 'Live: contract state decoded in your browser with the SolidCash SDK from a public Electrum server.';
  else if (S.liveError) source.textContent = `Not live: the SDK read failed (${S.liveError}). Showing the committed state.json as of commit ${meta.commit}${meta.dirty ? ' plus uncommitted changes' : ''}.`;
  else source.textContent = `Showing the committed state.json as of commit ${meta.commit} while the live read loads (SolidCash SDK, about 3.5 MB, loaded on demand)…`;
  source.className = isLive ? 'small live' : 'small muted';
}

async function loadChain(attempt = 1) {
  try {
    S.chainError = null;
    S.tip = await S.fulcrum.tipHeight();
    const reg = S.state.steps.registry;
    const utxos = await S.fulcrum.listUnspent(Uint8Array.from(reg.lockingBytecode.match(/../g), (h) => parseInt(h, 16)));
    const master = utxos.find((u) => u.token_data?.category === reg.categoryId && u.token_data?.nft?.capability === 'minting');
    if (master) { S.masterHeight = master.height; S.masterTxid = master.tx_hash; }
  } catch (e) {
    S.chainError = e.message;
    if (attempt < 3) setTimeout(() => loadChain(attempt + 1), 3000 * attempt);
  }
  renderStatus();
}

async function loadLive() {
  try {
    const [poolArtifact, registryArtifact] = await Promise.all([getJson('data/FoldClaimPool.artifact.json'), getJson('data/RootRegistry.artifact.json')]);
    // A runtime URL keeps the bundler from inlining the SDK: dist/sdk/ is fetched only now.
    const read = import(new URL('./sdk/live.js', import.meta.url).href)
      .then(({ readLiveState }) => readLiveState({ state: S.state, publicInfo: S.pub, poolArtifact, registryArtifact }));
    S.live = await withTimeout(read, SDK_TIMEOUT_MS, 'live read');
  } catch (e) { S.liveError = e?.message ?? String(e); }
  renderStatus();
}

function claimCommand(address) {
  return `node --experimental-transform-types --no-warnings scripts/claim.ts mainnet deployments/mainnet/tree-epoch${S.tree.epoch}.json ${address} --payer <your-wif-file>`;
}

/** The relayed claim (fee paid by the demo relayer); the result shows a txid link or the relay's error text. */
function relayBox(address) {
  const result = el('p', { class: 'small', 'aria-live': 'polite' });
  const button = el('button', { type: 'button', class: 'claim' }, 'Claim now (fee paid by the demo relayer)');
  button.addEventListener('click', async () => {
    button.disabled = true;
    result.className = 'small muted';
    result.textContent = 'Sending the claim…';
    const r = await relayClaim(S.relay.url, address);
    if (r.txid) {
      result.className = 'small good';
      result.replaceChildren('Claimed: ', el('a', { href: EXPLORER(r.txid), rel: 'noopener noreferrer', target: '_blank' }, code(short(r.txid, 10), r.txid)));
      return;
    }
    result.className = 'small badtext';
    result.textContent = `Not claimed: ${r.error}`;
    button.disabled = false;
  });
  return [
    el('h3', {}, 'Claim now'),
    el('p', { class: 'small muted' }, 'For the demo recipients only, a demo relayer submits the claim and pays the fee. The tokens still go to the leaf address; nothing is asked of you.'),
    button,
    result,
  ];
}

function copyButton(text) {
  const button = el('button', { type: 'button', class: 'copy' }, 'Copy');
  button.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(text); button.textContent = 'Copied'; } catch { button.textContent = 'Copy failed'; }
    setTimeout(() => { button.textContent = 'Copy'; }, 1500);
  });
  return button;
}

let lookupSeq = 0;
async function lookup(input) {
  const seq = ++lookupSeq;
  const out = $('lookup-result');
  const parsed = parseAddress(input);
  if (parsed.error) { out.replaceChildren(el('p', { class: 'verdict bad' }, parsed.error)); return; }
  const { tree } = S;
  const leaf = findLeaf(tree, parsed.lockHex);
  const forms = el('dl', {}, el('dt', {}, 'Token-aware'), el('dd', {}, el('code', { class: 'wrap' }, parsed.tokenAware)),
    el('dt', {}, 'Plain'), el('dd', {}, el('code', { class: 'wrap' }, parsed.plain)),
    el('dt', {}, 'Locking bytecode'), el('dd', {}, el('code', { class: 'wrap' }, parsed.lockHex)));
  const held = el('dd', {}, el('span', { class: 'muted' }, 'checking…'));
  const heldBlock = el('dl', {}, el('dt', {}, 'Test tokens held now'), held);

  if (!leaf) {
    out.replaceChildren(el('p', { class: 'verdict warn' }, `No leaf for this address in epoch ${tree.epoch}.`), forms, heldBlock);
  } else {
    const check = await checkLeaf(tree, leaf);
    if (seq !== lookupSeq) return;
    const cmd = claimCommand(parsed.tokenAware);
    const relayed = canRelay({ relay: S.relay, pub: S.pub, tree, leaf, lockHex: parsed.lockHex, livePoolRoot: S.live?.pool.root });
    out.replaceChildren(
      el('p', { class: 'verdict ok' }, `Leaf ${leaf.index} of epoch ${tree.epoch}: cumulative ${leaf.cumulative} test-token units.`),
      forms,
      el('dl', {},
        el('dt', {}, 'Leaf index'), el('dd', {}, String(leaf.index)),
        el('dt', {}, 'Cumulative'), el('dd', {}, leaf.cumulative),
        el('dt', {}, 'Proof depth'), el('dd', {}, String(check.depth)),
        el('dt', {}, 'Local proof check'), el('dd', {}, check.ok
          ? el('span', { class: 'good' }, `matches root ${short(tree.root)}`)
          : el('span', { class: 'badtext' }, `FAILS: computed ${short(check.computedRoot)}, expected ${short(tree.root)}`))),
      heldBlock,
      el('h3', {}, 'Proof'),
      el('pre', { class: 'hex' }, leaf.proof),
      ...(relayed ? relayBox(parsed.tokenAware) : []),
      el('h3', {}, relayed ? 'Or claim yourself' : 'Claim command'),
      el('p', { class: 'small muted' }, 'Run it in a clone of the FoldClaim repository. The WIF file is your own key on your own machine and only pays the fee; the tokens always go to the leaf address. Never paste a key into a web page, including this one.'),
      el('div', { class: 'cmd' }, el('pre', {}, cmd), copyButton(cmd)),
    );
  }

  try {
    const utxos = await S.fulcrum.listUnspent(parsed.lockingBytecode);
    if (seq !== lookupSeq) return;
    const mine = utxos.filter((u) => u.token_data?.category === S.state.steps.token.category);
    const total = mine.reduce((n, u) => n + BigInt(u.token_data.amount ?? '0'), 0n);
    held.replaceChildren(`${total} units in ${mine.length} UTXO${mine.length === 1 ? '' : 's'}`,
      el('span', { class: 'muted small block' }, 'Unspent outputs of the test-token category at this address, read live. Tokens the owner has since moved are not counted, so this can be lower than the amount paid.'));
  } catch (e) {
    if (seq === lookupSeq) held.replaceChildren(el('span', { class: 'muted' }, `unavailable (${e.message})`));
  }
}

function renderDemo() {
  $('demo-list').replaceChildren(...S.pub.demoRecipients.map((d) => el('li', {},
    el('button', { type: 'button', class: 'demo', onclick: () => { $('address').value = d.address; lookup(d.address); } },
      el('span', {}, `Demo ${d.demo} · leaf ${d.leafIndex}`), ' ', code(short(d.address.replace('bitcoincash:', ''), 6), d.address)))));
}

async function main() {
  try {
    S.meta = await getJson('data/meta.json');
    const latest = Math.max(...S.meta.epochs);
    [S.state, S.pub, S.tree] = await Promise.all([getJson('data/state.json'), getJson('data/public.json'), getJson(`data/tree-epoch${latest}.json`)]);
    S.relay = S.meta.relay ? await getJson('data/relay.json').catch(() => null) : null;
  } catch (e) {
    $('status-source').textContent = `Could not load the page data: ${e.message}`;
    return;
  }
  renderHeader();
  renderStatus();
  renderDemo();
  $('lookup-form').addEventListener('submit', (e) => { e.preventDefault(); lookup($('address').value); });
  loadChain();
  loadLive();
}

main();
