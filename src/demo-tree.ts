// The demo leaf set: 300 leaves of (recipient locking bytecode, cumulative earned).
//
// Ten leaves pay demo recipients whose keys we hold (derived from a secret seed), spread over the tree so the
// claims exercise different proof paths, including the last leaf (index 299), whose path runs through the zero-hash
// padding. The other 290 leaves are synthetic P2PKH locks whose hash has no known key, so nobody can spend what they
// would receive, and the demo never claims them: no unsolicited tokens or dust go to real people's addresses.
import { createHash } from 'node:crypto';
import { secp256k1, hash160 } from '@bitauth/libauth';
import { MerkleTree, type Entry } from './merkle.ts';

export const LEAF_COUNT = 300;
export const DEMO_INDEXES = [0, 1, 42, 99, 150, 151, 200, 255, 256, 299];

const sha256 = (...parts: (string | Uint8Array)[]) => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
};
const p2pkh = (pkh: Uint8Array) => Uint8Array.from([0x76, 0xa9, 0x14, ...pkh, 0x88, 0xac]);

/** The private key of demo recipient `i` (0..9), derived from the secret seed. */
export function demoKey(seed: Uint8Array, i: number): Uint8Array {
  for (let attempt = 0; ; attempt++) {
    const k = sha256('foldclaim-demo-recipient', seed, Uint8Array.of(i, attempt));
    if (secp256k1.validatePrivateKey(k)) return k;
  }
}

export function demoLock(seed: Uint8Array, i: number): Uint8Array {
  const pub = secp256k1.derivePublicKeyCompressed(demoKey(seed, i));
  if (typeof pub === 'string') throw new Error(pub);
  return p2pkh(hash160(pub));
}

/** Cumulative earned per epoch. Epoch 2 tops up every leaf, so a repeat claim pays only the difference. */
function cumulative(index: number, epoch: number): bigint {
  const base = 1_000n + BigInt((index * 7919) % 50_000);
  return epoch === 1 ? base : base + 500n * BigInt(epoch - 1) + BigInt(index % 13) * 10n;
}

export function demoEntries(seed: Uint8Array, epoch: number): Entry[] {
  const entries: Entry[] = [];
  for (let index = 0; index < LEAF_COUNT; index++) {
    const d = DEMO_INDEXES.indexOf(index);
    const lockingBytecode = d >= 0 ? demoLock(seed, d) : p2pkh(sha256('foldclaim-synthetic-leaf', String(index)).slice(0, 20));
    entries.push({ lockingBytecode, cumulative: cumulative(index, epoch) });
  }
  return entries;
}

export const demoTree = (seed: Uint8Array, epoch: number) => new MerkleTree(demoEntries(seed, epoch));
