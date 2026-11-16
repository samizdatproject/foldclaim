// Merkle tree of (recipient locking bytecode, cumulative earned), matching FoldClaimPool.scash:
//   leaf = sha256(0x00 || lockingBytecode || uint64le(cumulative))
//   node = sha256(0x01 || left || right)
// The 0x00/0x01 prefixes keep a leaf from ever being read as an inner node. Odd levels are padded with an
// all-zero hash, which has no known preimage, so a padding slot can never be claimed.
import { createHash } from 'node:crypto';

export type Entry = { lockingBytecode: Uint8Array; cumulative: bigint };
export type Proof = { index: number; siblings: Uint8Array[]; proofBytes: Uint8Array };

const ZERO = new Uint8Array(32);

export function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(data).digest());
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}

/** OP_NUM2BIN(value, 8) for a non-negative value: 8-byte little-endian. */
export function uint64le(value: bigint): Uint8Array {
  if (value < 0n || value >= 1n << 63n) throw new Error('amount out of range');
  const out = new Uint8Array(8);
  let v = value;
  for (let i = 0; i < 8; i++) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}

export function leafHash(entry: Entry): Uint8Array {
  return sha256(concat(Uint8Array.of(0x00), entry.lockingBytecode, uint64le(entry.cumulative)));
}

export function nodeHash(left: Uint8Array, right: Uint8Array): Uint8Array {
  return sha256(concat(Uint8Array.of(0x01), left, right));
}

export class MerkleTree {
  readonly levels: Uint8Array[][];

  constructor(readonly entries: Entry[]) {
    if (entries.length === 0) throw new Error('no entries');
    const seen = new Set<string>();
    for (const e of entries) {
      const key = Buffer.from(e.lockingBytecode).toString('hex');
      if (seen.has(key)) throw new Error(`duplicate recipient ${key}`);
      seen.add(key);
    }
    let level = entries.map(leafHash);
    this.levels = [level];
    while (level.length > 1) {
      const next: Uint8Array[] = [];
      for (let i = 0; i < level.length; i += 2) next.push(nodeHash(level[i], level[i + 1] ?? ZERO));
      level = next;
      this.levels.push(level);
    }
  }

  get root(): Uint8Array { return this.levels[this.levels.length - 1][0]; }
  get depth(): number { return this.levels.length - 1; }

  proof(index: number): Proof {
    const siblings: Uint8Array[] = [];
    let position = index;
    for (let d = 0; d < this.depth; d++) {
      siblings.push(this.levels[d][position ^ 1] ?? ZERO);
      position >>= 1;
    }
    return { index, siblings, proofBytes: concat(...siblings) };
  }
}

/** Recompute a root from a leaf and its proof, exactly as the contract does. */
export function rootFromProof(entry: Entry, proof: Proof): Uint8Array {
  let node = leafHash(entry);
  let position = proof.index;
  for (const sibling of proof.siblings) {
    node = position % 2 === 0 ? nodeHash(node, sibling) : nodeHash(sibling, node);
    position = Math.floor(position / 2);
  }
  if (position !== 0) throw new Error('index out of range');
  return node;
}
