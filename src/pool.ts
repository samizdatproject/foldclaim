// Re-attach a deployed RootRegistry and FoldClaimPool from a deployments/<network>/ directory and send claims.
// Shared by scripts/claim.ts and relay/server.ts. Read-only on the directory: it uses the artifacts kept beside
// state.json (never recompiles) and the operator public key from public.json (a public constructor argument).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { binToHex, hexToBin } from '@bitauth/libauth';
import { StatefulContract, getDataNftLockingBytecode } from '@solidcash/solidcash/stateful';
import { rootFromProof } from './merkle.ts';

export type TreeFile = {
  epoch: number;
  root: string;
  depth: number;
  leaves: { index: number; lockingBytecode: string; cumulative: string; proof: string }[];
};
/** A leaf whose proof was checked against its epoch root. */
export type Leaf = { index: number; lockingBytecode: Uint8Array; cumulative: bigint; proofBytes: Uint8Array };
export type ClaimResult = { status: 'claimed'; txid: string; hex: string } | { status: 'nothing-to-claim' };

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

export function attachDeployment(dir: string, provider: any) {
  const state = readJson(join(dir, 'state.json'));
  const publicInfo = readJson(join(dir, 'public.json'));
  const artifact = (name: string) => readJson(join(dir, `${name}.artifact.json`));
  for (const step of ['registry', 'token', 'pool']) if (!state.steps?.[step]) throw new Error(`state.json has no ${step} step`);
  const registryArtifact = artifact('RootRegistry');
  const operatorPub = hexToBin(publicInfo.operatorPublicKey);
  const tokenCategory = hexToBin(state.steps.token.category);
  const registry = StatefulContract.from(registryArtifact, [operatorPub], { provider } as any, state.steps.registry.categoryId) as any;
  const registryData = getDataNftLockingBytecode(state.steps.registry.categoryId, hexToBin(state.steps.registry.lockingBytecode));
  const pool = StatefulContract.from(artifact('FoldClaimPool'), [tokenCategory, registryData], {
    provider,
    externalContracts: { IRootRegistry: { artifact: registryArtifact, categoryId: state.steps.registry.categoryId, constructorArgs: [operatorPub] } },
  } as any, state.steps.pool.categoryId) as any;
  return { state, publicInfo, registry, pool, tokenCategory };
}

// Parsed epoch files, keyed by path and checked against the file's mtime and size, so a lookup re-reads a file only
// when it changed; `byRoot` remembers which file holds a root, so a hit costs one stat.
const parsedFiles = new Map<string, { mtimeMs: number; size: number; tree: TreeFile | null }>();
const byRoot = new Map<string, string>();

function parsedTree(path: string): TreeFile | null {
  let st;
  try { st = statSync(path); } catch { parsedFiles.delete(path); return null; }
  const hit = parsedFiles.get(path);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.tree;
  let tree: TreeFile | null = null;
  try { tree = readJson(path) as TreeFile; } catch { /* being written, or not ours: retried when it changes */ }
  parsedFiles.set(path, { mtimeMs: st.mtimeMs, size: st.size, tree });
  return tree;
}

/** The tree-epoch<N>.json in `dir` whose root is `root` (hex), or null. Unreadable files are skipped. */
export function findTreeFile(dir: string, root: string): TreeFile | null {
  const key = `${dir}\0${root}`;
  const known = byRoot.get(key);
  const cached = known ? parsedTree(known) : null;
  if (cached?.root === root) return cached;
  for (const name of readdirSync(dir).filter((f) => /^tree-epoch\d+\.json$/.test(f))) {
    const tree = parsedTree(join(dir, name));
    if (tree?.root === root) { byRoot.set(key, join(dir, name)); return tree; }
  }
  byRoot.delete(key);
  return null;
}

/** The leaf for `lockingBytecode` in `tree`, its proof checked against the tree root; null if there is none. */
export function findLeaf(tree: TreeFile, lockingBytecode: Uint8Array): Leaf | null {
  const lockHex = binToHex(lockingBytecode);
  const leaf = tree.leaves.find((l) => l.lockingBytecode === lockHex);
  if (!leaf) return null;
  const proofBytes = hexToBin(leaf.proof);
  const siblings = Array.from({ length: proofBytes.length / 32 }, (_, k) => proofBytes.slice(k * 32, k * 32 + 32));
  const entry = { lockingBytecode, cumulative: BigInt(leaf.cumulative) };
  if (binToHex(rootFromProof(entry, { index: leaf.index, siblings, proofBytes })) !== tree.root) {
    throw new Error('proof does not match the epoch root; the file is corrupt');
  }
  return { index: leaf.index, lockingBytecode, cumulative: entry.cumulative, proofBytes };
}

/** Send a claim for `leaf`, fee paid by `payer`. The tokens go to the leaf's own lock; a paid leaf is a typed result. */
export async function claimLeaf(pool: any, payer: any, tokenCategory: Uint8Array, leaf: Leaf): Promise<ClaimResult> {
  try {
    const result = await pool.connect(payer).call
      .claim(tokenCategory, leaf.lockingBytecode, leaf.cumulative, leaf.proofBytes, BigInt(leaf.index)).send();
    return { status: 'claimed', txid: result.txid, hex: result.hex ?? '' };
  } catch (e: any) {
    if (/nothing to claim/i.test(String(e?.message ?? e))) return { status: 'nothing-to-claim' };
    throw e;
  }
}
