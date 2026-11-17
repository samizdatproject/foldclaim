// Browser (WebCrypto) port of src/merkle.ts, byte for byte:
//   leaf = sha256(0x00 || lockingBytecode || uint64le(cumulative))
//   node = sha256(0x01 || left || right)
// The index bits choose left or right, exactly as rootFromProof in src/merkle.ts and the pool contract.

export function hexToBytes(hex) {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new Error('not hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}

export async function sha256(data) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

/** OP_NUM2BIN(value, 8) for a non-negative value: 8-byte little-endian. */
export function uint64le(value) {
  if (value < 0n || value >= 1n << 63n) throw new Error('amount out of range');
  const out = new Uint8Array(8);
  let v = value;
  for (let i = 0; i < 8; i++) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}

export function leafHash(lockingBytecode, cumulative) {
  return sha256(concat(Uint8Array.of(0x00), lockingBytecode, uint64le(cumulative)));
}

export function nodeHash(left, right) {
  return sha256(concat(Uint8Array.of(0x01), left, right));
}

/** Recompute a root from a leaf and its concatenated 32-byte siblings, as the contract does. */
export async function rootFromProof(lockingBytecode, cumulative, index, proofBytes) {
  if (proofBytes.length % 32 !== 0) throw new Error('proof length is not a multiple of 32');
  let node = await leafHash(lockingBytecode, cumulative);
  let position = index;
  for (let k = 0; k < proofBytes.length; k += 32) {
    const sibling = proofBytes.slice(k, k + 32);
    node = position % 2 === 0 ? await nodeHash(node, sibling) : await nodeHash(sibling, node);
    position = Math.floor(position / 2);
  }
  if (position !== 0) throw new Error('index out of range');
  return node;
}
