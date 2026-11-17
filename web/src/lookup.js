// Address → leaf lookup and local proof check. Shared by the page and the node test (web/test/lookup.test.mjs).
import { cashAddressToLockingBytecode, lockingBytecodeToCashAddress } from '@bitauth/libauth';
import { bytesToHex, hexToBytes, rootFromProof } from './merkle.js';

/**
 * Parse a mainnet CashAddress (plain q… or token-aware z…, with or without the bitcoincash: prefix).
 * Returns { lockingBytecode, lockHex, plain, tokenAware } or { error }.
 */
export function parseAddress(input) {
  let text = String(input ?? '').trim();
  if (text === '') return { error: 'Enter an address.' };
  // CashAddr is all lower or all upper case; accept the upper-case form too.
  if (text === text.toUpperCase()) text = text.toLowerCase();
  if (!text.includes(':')) text = `bitcoincash:${text}`;
  if (!text.startsWith('bitcoincash:')) return { error: 'Only mainnet addresses (bitcoincash:…) are in this pool.' };
  const decoded = cashAddressToLockingBytecode(text);
  if (typeof decoded === 'string') return { error: `Not a valid address: ${decoded}` };
  const encode = (tokenSupport) => {
    const r = lockingBytecodeToCashAddress({ prefix: 'bitcoincash', bytecode: decoded.bytecode, tokenSupport });
    return typeof r === 'string' ? r : r.address;
  };
  return { lockingBytecode: decoded.bytecode, lockHex: bytesToHex(decoded.bytecode), plain: encode(false), tokenAware: encode(true) };
}

export function findLeaf(tree, lockHex) {
  return tree.leaves.find((l) => l.lockingBytecode === lockHex) ?? null;
}

/** Recompute the root from the leaf and its proof; returns { ok, computedRoot, depth }. */
export async function checkLeaf(tree, leaf) {
  const proofBytes = hexToBytes(leaf.proof);
  const computed = bytesToHex(await rootFromProof(hexToBytes(leaf.lockingBytecode), BigInt(leaf.cumulative), leaf.index, proofBytes));
  return { ok: computed === tree.root, computedRoot: computed, depth: proofBytes.length / 32 };
}
