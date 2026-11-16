// Folding@home snapshot -> epoch leaves.
//
// FoldingCash links a Folding@home username of the form `{name}_{bchaddress}`. Each distribution splits a token
// budget over the points earned between two of Stanford's daily user summary files, and adds each share to the
// recipient's cumulative earned, which becomes a leaf of the epoch's Merkle tree (src/merkle.ts). Everything here is
// a pure function of the public files, the budget and the previous epoch, so anyone can recompute a proposed root.
import { createHash } from 'node:crypto';
import { binToHex, decodeCashAddress, hexToBin } from '@bitauth/libauth';
import type { Entry } from './merkle.ts';

export type SummaryRow = { name: string; credit: bigint; team: string };
/** Keyed by locking bytecode hex. */
export type LockMap = Map<string, bigint>;

const CREDIT_HEADERS = ['newcredit', 'credit', 'score', 'points'];

/**
 * Parse daily_user_summary.txt: tab-separated, a date/time line, a header line (`name newcredit sum(total) team`),
 * then one row per (user, team). Columns are located by header name; without a header the standard order is assumed.
 * Blank lines, `#` comments, lines before the header and rows whose credit is not a non-negative integer are skipped.
 */
export function parseDailySummary(text: string): SummaryRow[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const headerAt = lines.findIndex((l) => l.split('\t').some((f) => f.trim().toLowerCase() === 'name'));
  let cols = { name: 0, credit: 1, team: 3 };
  if (headerAt >= 0) {
    const fields = lines[headerAt].split('\t').map((f) => f.trim().toLowerCase());
    const credit = fields.findIndex((f) => CREDIT_HEADERS.includes(f));
    if (credit < 0) throw new Error(`no credit column in header: ${lines[headerAt]}`);
    cols = { name: fields.indexOf('name'), credit, team: fields.indexOf('team') };
  }
  const rows: SummaryRow[] = [];
  for (const line of lines.slice(headerAt + 1)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const fields = line.split('\t');
    const name = fields[cols.name]?.trim();
    const credit = fields[cols.credit]?.trim();
    if (!name || !credit || !/^\d+$/.test(credit)) continue;
    rows.push({ name, credit: BigInt(credit), team: cols.team >= 0 ? (fields[cols.team]?.trim() ?? '') : '' });
  }
  return rows;
}

/**
 * The locking bytecode of the mainnet CashAddress after the last `_` of a F@H name, or null. The token-aware and plain
 * forms of an address give the same bytecode: P2PKH 76a914<20>88ac, P2SH20 a914<20>87, P2SH32 aa20<32>87.
 */
export function extractAddress(name: string): Uint8Array | null {
  const at = name.lastIndexOf('_');
  if (at < 0) return null;
  const part = name.slice(at + 1).trim();
  if (part === '') return null;
  const decoded = decodeCashAddress(part.includes(':') ? part : `bitcoincash:${part}`);
  if (typeof decoded === 'string' || decoded.prefix !== 'bitcoincash') return null;
  const { payload, type } = decoded;
  if (type === 'p2pkh' || type === 'p2pkhWithTokens') {
    return payload.length === 20 ? Uint8Array.from([0x76, 0xa9, 0x14, ...payload, 0x88, 0xac]) : null;
  }
  if (payload.length === 20) return Uint8Array.from([0xa9, 0x14, ...payload, 0x87]);
  if (payload.length === 32) return Uint8Array.from([0xaa, 0x20, ...payload, 0x87]);
  return null;
}

/** Total credit per locking bytecode: every row (name, team) pointing at one address is summed. */
export function creditByLock(rows: SummaryRow[]): LockMap {
  const out: LockMap = new Map();
  for (const row of rows) {
    const lock = extractAddress(row.name);
    if (!lock) continue;
    const key = binToHex(lock);
    out.set(key, (out.get(key) ?? 0n) + row.credit);
  }
  return out;
}

const byHex = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Split `budget` over the points each address earned between two snapshots (current credit minus previous, both
 * summed per address; absent = 0, negative = 0). Floor of the proportional share, then the remainder one unit each
 * by largest fractional remainder, ties by locking bytecode hex ascending, so the shares sum to `budget` exactly.
 * Addresses with no points are left out; if nobody earned points the result is empty.
 */
export function allocate(prev: SummaryRow[], curr: SummaryRow[], budget: bigint): LockMap {
  if (budget < 0n) throw new Error('negative budget');
  const before = creditByLock(prev);
  const points: [string, bigint][] = [];
  for (const [key, credit] of creditByLock(curr)) {
    const earned = credit - (before.get(key) ?? 0n);
    if (earned > 0n) points.push([key, earned]);
  }
  const total = points.reduce((n, [, p]) => n + p, 0n);
  if (total === 0n) return new Map();

  const shares = points.map(([key, p]) => ({ key, share: (budget * p) / total, rem: (budget * p) % total }));
  let left = budget - shares.reduce((n, s) => n + s.share, 0n);
  const order = [...shares].sort((a, b) => (a.rem > b.rem ? -1 : a.rem < b.rem ? 1 : byHex(a.key, b.key)));
  for (const s of order) {
    if (left === 0n) break;
    s.share += 1n;
    left -= 1n;
  }
  return new Map(shares.sort((a, b) => byHex(a.key, b.key)).map((s) => [s.key, s.share]));
}

/** Previous cumulative plus this epoch's allocation. Every previous recipient is kept; nothing ever decreases. */
export function nextCumulative(prevCumulative: LockMap, allocation: LockMap): LockMap {
  const out: LockMap = new Map(prevCumulative);
  for (const [key, amount] of allocation) {
    if (amount < 0n) throw new Error(`negative allocation for ${key}`);
    out.set(key, (out.get(key) ?? 0n) + amount);
  }
  return new Map([...out].sort(([a], [b]) => byHex(a, b)));
}

/** Leaves for MerkleTree, sorted by locking bytecode hex, without zero cumulatives. */
export function toEntries(cumulative: LockMap): Entry[] {
  return [...cumulative]
    .filter(([, c]) => c > 0n)
    .sort(([a], [b]) => byHex(a, b))
    .map(([key, c]) => ({ lockingBytecode: hexToBin(key), cumulative: c }));
}

/** sha256 hex of the raw summary file, published with each epoch. Pass the file's bytes; a string is hashed as UTF-8. */
export function snapshotHash(text: string | Uint8Array): string {
  return createHash('sha256').update(text).digest('hex');
}
