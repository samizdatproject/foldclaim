// Snapshot -> epoch leaves: parsing Stanford's daily user summary, address extraction, allocation, cumulative roots,
// and the scripts/build-epoch.ts CLI (build and --verify). All inputs are the synthetic files in test/fixtures/.
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { binToHex, hexToBin, cashAddressToLockingBytecode } from '@bitauth/libauth';
import { MerkleTree, rootFromProof } from '../src/merkle.js';
import {
  allocate, creditByLock, extractAddress, nextCumulative, parseDailySummary, snapshotHash, toEntries, type LockMap,
} from '../src/snapshot.js';

const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url).pathname;
const read = (name: string) => readFileSync(fixture(name), 'utf8');
const prevRows = parseDailySummary(read('summary-prev.txt'));
const currRows = parseDailySummary(read('summary-curr.txt'));
const nextRows = parseDailySummary(read('summary-next.txt'));

const ADDR = {
  alice: 'bitcoincash:qrh7xndr76r6f948txcrssgftg4za7g90vqy3zca67',
  aliceZ: 'bitcoincash:zrh7xndr76r6f948txcrssgftg4za7g90v8wzukm9d',
  bobQ: 'bitcoincash:qrnlw63d49ht8cg4wlsll2qw4f93pag56vt4gxh3ma',
  bobZ: 'bitcoincash:zrnlw63d49ht8cg4wlsll2qw4f93pag56vvlmcehyw',
  carolBare: 'qzzqua0jcwm295nwrc7sewtsutvcnncrhc90w52u7a',
  daveQ: 'bitcoincash:qp83eead72qu3zdpg3dgk2radr7paer33vlj2r52ma',
  daveZ: 'bitcoincash:zp83eead72qu3zdpg3dgk2radr7paer33vccea6vyw',
  erinP: 'bitcoincash:pqnl0ex4cewsxkynuvryxwj63x403rnwlsjvuxthar',
  frankP: 'bitcoincash:p00d0v0c22jx9hlg9ypzuegkqeryanj9g2f0axvxlen6r6uzga4h26qyvk9w0',
  frankR: 'bitcoincash:r00d0v0c22jx9hlg9ypzuegkqeryanj9g2f0axvxlen6r6uzga4h2gncd0yhy',
  grace: 'bitcoincash:qrk65h6rprm7y680yctxq4j3mqcfpnnjvv8fv7cgpc',
  heidi: 'bitcoincash:qr046fqtxdv5p92vgn0jj0d6sm3lkl0etsdkkd93y6',
};
const lockHex = (name: string) => {
  const lock = extractAddress(name);
  if (!lock) throw new Error(`no address in ${name}`);
  return binToHex(lock);
};
const L = Object.fromEntries(Object.entries(ADDR).map(([k, a]) => [k, lockHex(`x_${a}`)])) as Record<keyof typeof ADDR, string>;
const sum = (m: LockMap) => [...m.values()].reduce((n, v) => n + v, 0n);

describe('parseDailySummary', () => {
  it('reads rows by header name, skipping the date line, comments and blank lines', () => {
    expect(prevRows).toHaveLength(12);
    expect(currRows).toHaveLength(14);
    expect(nextRows).toHaveLength(14); // CRLF line endings
    expect(prevRows[0]).toEqual({ name: `alice_${ADDR.alice}`, credit: 1000n, team: '1' });
    // summary-curr.txt has its columns in another order (team, name, sum(total), newcredit)
    expect(currRows[0]).toEqual({ name: `alice_${ADDR.alice}`, credit: 1600n, team: '1' });
    expect(nextRows.find((r) => r.name.startsWith('frank_'))).toEqual({ name: `frank_${ADDR.frankR}`, credit: 700n, team: '4' });
  });

  it('keeps large credits exact and keeps duplicate names as separate rows', () => {
    expect(currRows.find((r) => r.name === 'Anonymous')?.credit).toBe(98765432109876999999n);
    expect(currRows.filter((r) => r.name === `heidi_${ADDR.heidi}`).map((r) => r.credit)).toEqual([80n, 30n]);
  });

  it('falls back to the standard column order without a header and skips malformed rows', () => {
    const text = 'Sun Nov 15 03:00:01 UTC 2026\nu1_x\t12\t3\t9\n# note\nu2_x\tnot-a-number\t1\t9\nu3_x\t-5\t1\t9\n\nu4_x\t7\t1\t9\n';
    expect(parseDailySummary(text)).toEqual([
      { name: 'u1_x', credit: 12n, team: '9' },
      { name: 'u4_x', credit: 7n, team: '9' },
    ]);
  });
});

describe('extractAddress', () => {
  it('returns P2PKH, P2SH20 and P2SH32 locking bytecode', () => {
    expect(L.alice).toMatch(/^76a914[0-9a-f]{40}88ac$/);
    expect(L.erinP).toMatch(/^a914[0-9a-f]{40}87$/);
    expect(L.frankP).toMatch(/^aa20[0-9a-f]{64}87$/);
  });

  it('maps token-aware and plain forms of one key to the same bytecode', () => {
    expect(L.aliceZ).toBe(L.alice);
    expect(L.bobZ).toBe(L.bobQ);
    expect(L.daveZ).toBe(L.daveQ);
    expect(L.frankR).toBe(L.frankP);
  });

  it('accepts an address without the bitcoincash: prefix, uses the part after the last underscore', () => {
    expect(lockHex(`carol_${ADDR.carolBare}`)).toBe(lockHex(`carol_bitcoincash:${ADDR.carolBare}`));
    expect(lockHex(`dave_rig1_${ADDR.daveQ}`)).toBe(L.daveQ);
    expect(lockHex(`x_${ADDR.alice.toUpperCase()}`)).toBe(L.alice);
    expect(lockHex(`x_${ADDR.carolBare.toUpperCase()}`)).toBe(L.carolBare);
  });

  it('returns null for names without a valid mainnet address', () => {
    for (const name of [
      'Anonymous',
      'folding_fan_42',
      'alice_',
      `${ADDR.alice}`, // no underscore before the address
      'mallory_bitcoincash:qrh7xndr76r6f948txcrssgftg4za7g90vqy3zca68', // bad checksum
      'tester_bchtest:qrawgl6nhs2qh4t3fxj5rkyck8mux44ywu5hruaezq', // testnet
      `x_${ADDR.alice.replace('bitcoincash:', 'bchtest:')}`, // checksum is bound to the prefix
    ]) expect(extractAddress(name), name).toBeNull();
  });
});

describe('allocate', () => {
  const alloc = allocate(prevRows, currRows, 1000n);

  it('splits the budget by points earned per address and sums to the budget exactly', () => {
    // points: alice 600, bob 900, carol 300, dave 400+150, erin 400 (absent before), heidi 30+20 over two rows
    // = 2800. Floors sum to 997; the 3 left go to erin and heidi (remainder 2400/2800) and to dave over bob (both
    // 1200/2800, dave's lock hex sorts first).
    expect(Object.fromEntries(alloc)).toEqual({
      [L.alice]: 214n, [L.bobQ]: 321n, [L.carolBare]: 107n, [L.daveQ]: 197n, [L.erinP]: 143n, [L.heidi]: 18n,
    });
    expect(L.daveQ < L.bobQ).toBe(true);
    expect(sum(alloc)).toBe(1000n);
  });

  it('gives nothing to addresses with zero or negative points or no valid address', () => {
    expect(alloc.has(L.frankP)).toBe(false); // credit unchanged
    expect(alloc.has(L.grace)).toBe(false); // credit went down
    expect(alloc.size).toBe(6);
  });

  it('is deterministic regardless of row order and sums exactly for any budget', () => {
    const shuffled = allocate([...prevRows].reverse(), [...currRows].reverse(), 1000n);
    expect([...shuffled]).toEqual([...alloc]);
    for (const budget of [0n, 1n, 2n, 5n, 7n, 999_999_937n, 21_000_000n * 100_000_000n, (1n << 62n) - 1n]) {
      const a = allocate(prevRows, currRows, budget);
      expect(sum(a), String(budget)).toBe(budget);
      expect(a).toEqual(allocate([...prevRows].reverse(), [...currRows].reverse(), budget));
    }
  });

  it('returns nothing when nobody earned points', () => {
    expect(allocate(currRows, currRows, 1000n).size).toBe(0);
  });

  it('aggregates every name and team row pointing at one address', () => {
    const credit = creditByLock(currRows);
    expect(credit.get(L.daveQ)).toBe(850n);
    expect(credit.get(L.heidi)).toBe(110n);
  });
});

describe('cumulative epochs', () => {
  const e1 = nextCumulative(new Map(), allocate(prevRows, currRows, 1000n));
  const a2 = allocate(currRows, nextRows, 500n);
  const e2 = nextCumulative(e1, a2);

  it('never decreases and keeps every previous recipient', () => {
    expect(sum(a2)).toBe(500n);
    expect(a2.has(L.alice)).toBe(false); // alice earned nothing in epoch 2
    expect(e2.get(L.alice)).toBe(e1.get(L.alice));
    for (const [key, c] of e1) expect(e2.get(key)! >= c, key).toBe(true);
    for (const [key, c] of e2) expect(c).toBe((e1.get(key) ?? 0n) + (a2.get(key) ?? 0n));
    expect(e2.has(L.frankP)).toBe(true); // first earned in epoch 2
    expect(sum(e2)).toBe(1500n);
  });

  it('builds sorted entries without zero cumulatives', () => {
    const zero = `76a914${'00'.repeat(20)}88ac`;
    const entries = toEntries(new Map([[zero, 0n], ...e2]));
    const keys = entries.map((e) => binToHex(e.lockingBytecode));
    expect(keys).toEqual([...keys].sort());
    expect(keys).not.toContain(zero);
    expect(entries).toHaveLength(e2.size);
  });

  it('recomputes the same root from the same inputs', () => {
    const rootOf = (p: typeof prevRows, c: typeof currRows) =>
      binToHex(new MerkleTree(toEntries(nextCumulative(new Map(), allocate(p, c, 1000n)))).root);
    expect(rootOf([...prevRows].reverse(), [...currRows].reverse())).toBe(rootOf(prevRows, currRows));
    expect(rootOf(prevRows, nextRows)).not.toBe(rootOf(prevRows, currRows));
  });
});

describe('snapshotHash', () => {
  it('is the sha256 of the raw file bytes', () => {
    const bytes = readFileSync(fixture('summary-next.txt'));
    expect(snapshotHash(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(snapshotHash(bytes.toString('utf8'))).toBe(snapshotHash(bytes));
  });
});

describe('scripts/build-epoch.ts', () => {
  const script = new URL('../scripts/build-epoch.ts', import.meta.url).pathname;
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ['--experimental-transform-types', '--no-warnings', script, ...args], { encoding: 'utf8' });
  const out = mkdtempSync(join(tmpdir(), 'foldclaim-epoch-'));
  const P = fixture('summary-prev.txt'), C = fixture('summary-curr.txt'), N = fixture('summary-next.txt');
  const e1Path = join(out, 'epoch1.json'), e2Path = join(out, 'epoch2.json');
  type Leaf = { index: number; address: string; lockingBytecode: string; cumulative: string; proof: string };

  const checkProofs = (path: string) => {
    const file = JSON.parse(readFileSync(path, 'utf8'));
    expect(file.leaves.length).toBeGreaterThan(0);
    for (const leaf of file.leaves as Leaf[]) {
      const proofBytes = hexToBin(leaf.proof);
      expect(proofBytes.length).toBe(32 * file.depth);
      const siblings = Array.from({ length: file.depth }, (_, i) => proofBytes.slice(32 * i, 32 * i + 32));
      const entry = { lockingBytecode: hexToBin(leaf.lockingBytecode), cumulative: BigInt(leaf.cumulative) };
      expect(binToHex(rootFromProof(entry, { index: leaf.index, siblings, proofBytes }))).toBe(file.root);
      const decoded = cashAddressToLockingBytecode(leaf.address);
      if (typeof decoded === 'string') throw new Error(decoded);
      expect(decoded.tokenSupport).toBe(true);
      expect(binToHex(decoded.bytecode)).toBe(leaf.lockingBytecode);
    }
    return file;
  };

  it('writes epoch 1 whose proofs all verify and whose root matches the library', () => {
    const r = run('--prev', P, '--curr', C, '--budget', '1000', '--epoch', '1', '--out', out);
    expect(r.status, r.stderr).toBe(0);
    const file = checkProofs(e1Path);
    expect(file.epoch).toBe(1);
    expect(file.budget).toBe('1000');
    expect(file.snapshotHashes).toEqual({ prev: snapshotHash(readFileSync(P)), curr: snapshotHash(readFileSync(C)) });
    const expected = new MerkleTree(toEntries(nextCumulative(new Map(), allocate(prevRows, currRows, 1000n))));
    expect(file.root).toBe(binToHex(expected.root));
    expect(file.depth).toBe(expected.depth);
    expect((file.leaves as Leaf[]).reduce((n, l) => n + BigInt(l.cumulative), 0n)).toBe(1000n);
  });

  it('writes epoch 2 on top of epoch 1 without lowering any cumulative', () => {
    const r = run('--prev', C, '--curr', N, '--budget', '500', '--prev-epoch', e1Path, '--epoch', '2', '--out', out);
    expect(r.status, r.stderr).toBe(0);
    const e1 = checkProofs(e1Path), e2 = checkProofs(e2Path);
    const c2 = new Map((e2.leaves as Leaf[]).map((l) => [l.lockingBytecode, BigInt(l.cumulative)]));
    for (const l of e1.leaves as Leaf[]) expect(c2.get(l.lockingBytecode)! >= BigInt(l.cumulative)).toBe(true);
    expect([...c2.values()].reduce((n, v) => n + v, 0n)).toBe(1500n);
  });

  it('refuses a --prev-epoch that is not the previous epoch', () => {
    const r = run('--prev', C, '--curr', N, '--budget', '500', '--prev-epoch', e1Path, '--epoch', '3', '--out', out);
    expect(r.status).not.toBe(0);
  });

  it('refuses an epoch that does not start from the snapshot the previous epoch ended on', () => {
    const r = run('--prev', P, '--curr', N, '--budget', '500', '--prev-epoch', e1Path, '--epoch', '2', '--out', out);
    expect(r.status).toBe(2);
    expect(r.stderr + r.stdout).toMatch(/not the snapshot epoch 1 ended on/);
  });

  it('--verify prints MATCH for an honest file and MISMATCH otherwise', () => {
    let r = run('--verify', e1Path, '--prev', P, '--curr', C);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^MATCH epoch 1 /m);

    r = run('--verify', e2Path, '--prev', C, '--curr', N, '--prev-epoch', e1Path);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^MATCH epoch 2 /m);

    r = run('--verify', e1Path, '--prev', P, '--curr', C, '--budget', '1001');
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/^MISMATCH/m);

    r = run('--verify', e1Path, '--prev', P, '--curr', N); // wrong snapshot
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/^MISMATCH/m);

    // A proposer who inflates one leaf and recomputes the file's own root is still caught: the root is recomputed
    // from the summary files, not from the leaves.
    const forged = JSON.parse(readFileSync(e1Path, 'utf8'));
    forged.leaves[0].cumulative = String(BigInt(forged.leaves[0].cumulative) + 1000n);
    forged.root = binToHex(new MerkleTree((forged.leaves as Leaf[]).map((l) => ({
      lockingBytecode: hexToBin(l.lockingBytecode), cumulative: BigInt(l.cumulative),
    }))).root);
    const forgedPath = join(out, 'forged-epoch1.json');
    writeFileSync(forgedPath, JSON.stringify(forged));
    r = run('--verify', forgedPath, '--prev', P, '--curr', C);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/^MISMATCH/m);
  });
});
