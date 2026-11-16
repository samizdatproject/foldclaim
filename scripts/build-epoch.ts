// Build an epoch's leaves from two Folding@home daily user summary files, or verify a published epoch file.
//
//   node --experimental-transform-types --no-warnings scripts/build-epoch.ts \
//     --prev <prev_summary.txt> --curr <curr_summary.txt> --budget <n> [--prev-epoch <epochN.json>] --epoch <n> --out <dir>
//   node --experimental-transform-types --no-warnings scripts/build-epoch.ts \
//     --verify <epochN.json> --prev <prev_summary.txt> --curr <curr_summary.txt> [--budget <n>] [--prev-epoch <epochN.json>]
//
// --verify recomputes the root from the summary files (and the previous epoch file) alone, never from the leaves in
// the file under test, and prints MATCH or MISMATCH; the exit code is 0 only on MATCH.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { binToHex, lockingBytecodeToCashAddress } from '@bitauth/libauth';
import { MerkleTree } from '../src/merkle.ts';
import { allocate, nextCumulative, parseDailySummary, snapshotHash, toEntries, type LockMap } from '../src/snapshot.ts';

type EpochFile = {
  epoch: number;
  root: string;
  depth: number;
  snapshotHashes: { prev: string; curr: string };
  budget: string;
  leaves: { index: number; address: string; lockingBytecode: string; cumulative: string; proof: string }[];
};

const fail = (message: string): never => {
  console.error(`error: ${message}`);
  process.exit(2);
};

const { values: args } = parseArgs({
  options: {
    prev: { type: 'string' },
    curr: { type: 'string' },
    budget: { type: 'string' },
    'prev-epoch': { type: 'string' },
    epoch: { type: 'string' },
    out: { type: 'string' },
    verify: { type: 'string' },
  },
  strict: true,
});

const readEpoch = (path: string): EpochFile => JSON.parse(readFileSync(path, 'utf8'));
const toInt = (s: string, what: string): bigint => (/^\d+$/.test(s) ? BigInt(s) : fail(`${what} must be a non-negative integer`));

function build(prevPath: string, currPath: string, budget: bigint, epoch: number, prevEpochPath?: string): EpochFile {
  const prevBytes = readFileSync(prevPath);
  const currBytes = readFileSync(currPath);
  let prevCumulative: LockMap = new Map();
  if (prevEpochPath) {
    const prior = readEpoch(prevEpochPath);
    if (prior.epoch + 1 !== epoch) fail(`--prev-epoch is epoch ${prior.epoch}, expected ${epoch - 1}`);
    // Epochs chain: this epoch's starting snapshot must be the one the previous epoch ended on.
    if (prior.snapshotHashes?.curr && prior.snapshotHashes.curr !== snapshotHash(prevBytes)) {
      fail(`--prev is not the snapshot epoch ${prior.epoch} ended on (expected sha256 ${prior.snapshotHashes.curr})`);
    }
    prevCumulative = new Map(prior.leaves.map((l) => [l.lockingBytecode, BigInt(l.cumulative)]));
  }
  const allocation = allocate(parseDailySummary(prevBytes.toString('utf8')), parseDailySummary(currBytes.toString('utf8')), budget);
  if (allocation.size === 0 && budget > 0n) fail('no address earned points between the two snapshots');
  const entries = toEntries(nextCumulative(prevCumulative, allocation));
  if (entries.length === 0) fail('no leaves');
  const tree = new MerkleTree(entries);
  return {
    epoch,
    root: binToHex(tree.root),
    depth: tree.depth,
    snapshotHashes: { prev: snapshotHash(prevBytes), curr: snapshotHash(currBytes) },
    budget: budget.toString(),
    leaves: entries.map((e, index) => {
      const address = lockingBytecodeToCashAddress({ bytecode: e.lockingBytecode, tokenSupport: true });
      if (typeof address === 'string') throw new Error(address);
      return {
        index,
        address: address.address,
        lockingBytecode: binToHex(e.lockingBytecode),
        cumulative: e.cumulative.toString(),
        proof: binToHex(tree.proof(index).proofBytes),
      };
    }),
  };
}

const prev = args.prev ?? fail('--prev is required');
const curr = args.curr ?? fail('--curr is required');

if (args.verify) {
  const claimed = readEpoch(args.verify);
  const budget = toInt(args.budget ?? claimed.budget, '--budget');
  const epoch = args.epoch ? Number(toInt(args.epoch, '--epoch')) : claimed.epoch;
  const ours = build(prev, curr, budget, epoch, args['prev-epoch']);
  for (const side of ['prev', 'curr'] as const) {
    if (claimed.snapshotHashes?.[side] !== ours.snapshotHashes[side]) {
      console.log(`note: ${side} snapshot hash differs (file ${claimed.snapshotHashes?.[side]}, ours ${ours.snapshotHashes[side]})`);
    }
  }
  if (claimed.budget !== ours.budget) console.log(`note: budget differs (file ${claimed.budget}, ours ${ours.budget})`);
  const match = claimed.root === ours.root;
  console.log(`${match ? 'MATCH' : 'MISMATCH'} epoch ${epoch} root ${ours.root}${match ? '' : ` (file ${claimed.root})`}`);
  process.exit(match ? 0 : 1);
}

const budget = toInt(args.budget ?? fail('--budget is required'), '--budget');
const epoch = Number(toInt(args.epoch ?? fail('--epoch is required'), '--epoch'));
const out = args.out ?? fail('--out is required');
const body = build(prev, curr, budget, epoch, args['prev-epoch']);
mkdirSync(out, { recursive: true });
const file = join(out, `epoch${epoch}.json`);
writeFileSync(file, JSON.stringify(body, null, 1) + '\n');
console.log(`epoch ${epoch}: ${body.leaves.length} leaves, depth ${body.depth}, root ${body.root} -> ${file}`);
