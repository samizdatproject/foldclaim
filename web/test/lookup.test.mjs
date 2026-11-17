// Headless check of the page's lookup and hashing modules against the shipped data, cross-checked with src/merkle.ts.
//   npm run web:test   (run npm run web:build first so web/data/ exists)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseAddress, findLeaf, checkLeaf } from '../src/lookup.js';
import { leafHash, bytesToHex, hexToBytes } from '../src/merkle.js';
import * as reference from '../../src/merkle.ts';

const data = (name) => JSON.parse(readFileSync(new URL(`../data/${name}`, import.meta.url), 'utf8'));
const tree = data('tree-epoch1.json');
const pub = data('public.json');

test('every leaf proof checks against the root, and matches src/merkle.ts', async () => {
  const entries = tree.leaves.map((l) => ({ lockingBytecode: hexToBytes(l.lockingBytecode), cumulative: BigInt(l.cumulative) }));
  const ref = new reference.MerkleTree(entries);
  assert.equal(Buffer.from(ref.root).toString('hex'), tree.root);
  assert.equal(ref.depth, tree.depth);
  for (const [i, leaf] of tree.leaves.entries()) {
    assert.equal(leaf.index, i);
    assert.equal(bytesToHex(await leafHash(entries[i].lockingBytecode, entries[i].cumulative)), Buffer.from(reference.leafHash(entries[i])).toString('hex'));
    assert.equal(Buffer.from(ref.proof(i).proofBytes).toString('hex'), leaf.proof);
    const check = await checkLeaf(tree, leaf);
    assert.ok(check.ok, `leaf ${i}`);
    assert.equal(check.depth, tree.depth);
  }
});

test('demo recipient 0 resolves from every address form to leaf 0', async () => {
  const d = pub.demoRecipients[0];
  const forms = [d.address, d.cashAddress, d.address.replace('bitcoincash:', ''), d.cashAddress.replace('bitcoincash:', ''), d.address.toUpperCase(), `  ${d.address}  `];
  const locks = new Set(forms.map((f) => parseAddress(f).lockHex));
  assert.equal(locks.size, 1);
  const parsed = parseAddress(forms[2]);
  assert.equal(parsed.tokenAware, d.address);
  assert.equal(parsed.plain, d.cashAddress);
  const leaf = findLeaf(tree, parsed.lockHex);
  assert.equal(leaf.index, 0);
  assert.equal(leaf.cumulative, '1000');
  const check = await checkLeaf(tree, leaf);
  assert.ok(check.ok);
  assert.equal(check.depth, 9);
});

test('all demo recipients are at their published leaf index', () => {
  for (const d of pub.demoRecipients) assert.equal(findLeaf(tree, parseAddress(d.address).lockHex)?.index, d.leafIndex, `demo ${d.demo}`);
});

test('an unknown address has no leaf; invalid and non-mainnet input is rejected', () => {
  const unknown = parseAddress(pub.operatorAddress);
  assert.ok(!unknown.error);
  assert.equal(findLeaf(tree, unknown.lockHex), null);
  assert.ok(parseAddress('').error);
  assert.ok(parseAddress('bitcoincash:qzzzz').error);
  assert.ok(parseAddress('bchtest:qpvlc85v2zy2mk0y2zpkmg04m2kmkyta4uv7ae7rdt').error);
  const d = pub.demoRecipients[0].address;
  assert.ok(parseAddress(d.slice(0, -1) + (d.endsWith('c') ? 'd' : 'c')).error, 'bad checksum');
});

test('a tampered leaf fails the local check', async () => {
  const leaf = tree.leaves[299];
  assert.ok((await checkLeaf(tree, leaf)).ok);
  assert.equal((await checkLeaf(tree, { ...leaf, cumulative: String(BigInt(leaf.cumulative) + 1n) })).ok, false);
  await assert.rejects(checkLeaf(tree, { ...leaf, index: leaf.index + 512 }), /index out of range/);
});
