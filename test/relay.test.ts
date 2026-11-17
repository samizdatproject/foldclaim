/* eslint-disable @typescript-eslint/no-explicit-any */
// The demo relayer (relay/server.ts) against a real deployment directory on the production-limit mock: the
// registry, token and pool are deployed with the same steps as mainnet (src/steps.ts) into a temp DEPLOY_DIR, so
// the relay reads the real artifacts, state.json, public.json and tree-epoch1.json (10 demo + 290 synthetic leaves).
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { binToHex, encodePrivateKeyWif, lockingBytecodeToCashAddress } from '@bitauth/libauth';
import { Signer } from '@solidcash/solidcash';
import { MockNetworkProvider } from '@solidcash/solidcash/network/mock';
import * as steps from '../src/steps.ts';
import { DEMO_INDEXES, demoLock } from '../src/demo-tree.ts';
import { createRelay, clientKey, type RelayConfig } from '../relay/server.ts';

const ORIGIN = 'https://samizdatproject.github.io';
const addr = (bytecode: Uint8Array, tokenSupport: boolean, prefix = 'bitcoincash') => {
  const r = lockingBytecodeToCashAddress({ prefix, bytecode, tokenSupport } as any);
  return typeof r === 'string' ? r : (r as any).address as string;
};

let provider: any;
let dir: string;
let seed: Uint8Array;
let tree: any;
let state: any;
let unsynced: { status: number; body: any };
const servers: Server[] = [];
const relays: { close(): void }[] = [];
// An 11th allowlisted address that has no leaf in the tree (for 'no leaf').
const leaflessDemo = Uint8Array.from([0x76, 0xa9, 0x14, ...randomBytes(20), 0x88, 0xac]);
const logs: string[] = [];

/** A relayer key in a temp WIF file, funded with `sats` (0: unfunded). */
async function relayerKey(sats: bigint) {
  const key = randomBytes(32);
  const file = join(dir, `relayer-${binToHex(key.subarray(0, 4))}.wif`);
  writeFileSync(file, encodePrivateKeyWif(key, 'mainnet') + '\n', { mode: 0o600 });
  if (sats > 0n) await provider.seedUtxo(new Signer(binToHex(key), provider).getAddress(), { txid: binToHex(randomBytes(32)), vout: 0, satoshis: sats } as any);
  return file;
}

type Extra = { now?: () => number; provider?: any; timeoutMs?: number; maxPending?: number; maxTrackedClients?: number };
async function startRelay(overrides: Partial<RelayConfig> & { relayerWifFile: string }, extra: Extra = {}) {
  const config: RelayConfig = {
    network: 'mainnet', deployDir: dir, port: 0, host: '127.0.0.1', allowedOrigin: ORIGIN,
    dailyCap: 12, perIpPerHour: 100, trustProxy: false, ...overrides,
  };
  const relay = createRelay(config, { provider, log: (l) => logs.push(l), ...extra });
  relays.push(relay);
  const server = createServer((req, res) => { void relay.handler(req, res); });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = async (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const r = await fetch(base + path, init);
    const text = await r.text();
    return { status: r.status, headers: r.headers, body: text ? JSON.parse(text) : null };
  };
  const claim = (address: string, headers: Record<string, string> = {}) =>
    call('/claim', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ address }) });
  return { relay, base, call, claim };
}

const demoAddress = (d: number) => addr(demoLock(seed, d), true);
const leafOf = (d: number) => tree.leaves[DEMO_INDEXES[d]];
const tokensAt = async (lock: Uint8Array) => {
  const utxos = await provider.getUtxosForLockingBytecode(lock);
  return utxos.filter((u: any) => u.token?.category === state.steps.token.category).reduce((n: bigint, u: any) => n + u.token.amount, 0n);
};

beforeAll(async () => {
  provider = new MockNetworkProvider({ profile: 'production' });
  const operator = new Signer(binToHex(randomBytes(32)), provider) as any;
  await provider.seedUtxo(operator.getAddress(), { txid: binToHex(randomBytes(32)), vout: 0, satoshis: 200_000n } as any);
  seed = randomBytes(32);
  dir = mkdtempSync(join(tmpdir(), 'foldclaim-relay-'));
  const ctx = { provider, operator, dir, seed, log: () => {} };
  await steps.deployRegistry(ctx);
  await steps.propose(ctx, 1);
  await steps.mintToken(ctx);
  await steps.deployPool(ctx);
  writeFileSync(join(dir, 'public.json'), JSON.stringify({
    network: 'mainnet',
    operatorPublicKey: binToHex(operator.publicKey),
    operatorAddress: addr(operator.getLockingBytecode(), false),
    demoRecipients: [
      ...DEMO_INDEXES.map((leafIndex, d) => ({ demo: d, leafIndex, address: addr(demoLock(seed, d), true), cashAddress: addr(demoLock(seed, d), false) })),
      { demo: 10, leafIndex: -1, address: addr(leaflessDemo, true), cashAddress: addr(leaflessDemo, false) },
    ],
  }));

  // Before the root is active and synced, the relay refuses clearly.
  const early = await startRelay({ relayerWifFile: await relayerKey(100_000n) });
  unsynced = await early.claim(demoAddress(0));

  await provider.mine(steps.ROOT_DELAY);
  for (let extra = 0; ; extra++) {
    try { await steps.activate(ctx, 1); break; } catch (e) { if (extra >= 30) throw e; await provider.mine(1); }
  }
  await steps.sync(ctx, 1);
  tree = JSON.parse(readFileSync(join(dir, 'tree-epoch1.json'), 'utf8'));
  state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
}, 600_000);

afterAll(() => { for (const s of servers) s.close(); for (const r of relays) r.close(); });

describe('relay', () => {
  it('refuses claims while the pool has no synced root', () => {
    expect(unsynced).toMatchObject({ status: 503, body: { error: 'pool not synced yet' } });
  });

  it('serves /health and /status', async () => {
    const r = await startRelay({ relayerWifFile: await relayerKey(50_000n) });
    expect((await r.call('/health')).body).toEqual({ ok: true });
    const s = await r.call('/status');
    expect(s.status).toBe(200);
    expect(s.body.pool).toEqual({ epoch: 1, root: tree.root });
    expect(s.body.registry).toMatchObject({ activeEpoch: 1, activeRoot: tree.root, pendingEpoch: 1 });
    expect(s.body.relayer.address).toBe(r.relay.relayer.address);
    expect(s.body.relayer.address).toMatch(/^bitcoincash:q/);
    expect(s.body.relayer.tokenAddress).toMatch(/^bitcoincash:z/);
    expect(s.body.relayer.balance).toBe(50_000);
    expect(s.body.claimsLeftToday).toBe(12);
  });

  it('relays a demo recipient claim: tokens land at the leaf address; a repeat has nothing to claim', async () => {
    const r = await startRelay({ relayerWifFile: await relayerKey(100_000n) });
    const lock = demoLock(seed, 0);
    expect(await tokensAt(lock)).toBe(0n);
    // plain q… form without the prefix, upper case: normalized to the same lock
    const plain = addr(lock, false).replace('bitcoincash:', '').toUpperCase();
    const ok = await r.claim(plain);
    expect(ok.status).toBe(200);
    expect(ok.body.txid).toMatch(/^[0-9a-f]{64}$/);
    expect(ok.body).toMatchObject({ epoch: 1, leafIndex: DEMO_INDEXES[0], cumulative: leafOf(0).cumulative });
    expect(await tokensAt(lock)).toBe(BigInt(leafOf(0).cumulative));
    expect((await r.call('/status')).body.claimsLeftToday).toBe(11);

    const again = await r.claim(demoAddress(0));
    expect(again).toMatchObject({ status: 409, body: { error: 'nothing to claim' } });
    expect(await tokensAt(lock)).toBe(BigInt(leafOf(0).cumulative));

    // the paid leaf is remembered for this root: answered 409 without queuing a claim
    const queued = r.relay.stats().queued;
    expect(await r.claim(demoAddress(0))).toMatchObject({ status: 409, body: { error: 'nothing to claim' } });
    expect(r.relay.stats().queued).toBe(queued);

    // a fresh relay learns "nothing to claim" from the contract once, then answers from the cache
    const fresh = await startRelay({ relayerWifFile: await relayerKey(100_000n) });
    expect((await fresh.claim(demoAddress(0))).status).toBe(409);
    expect(fresh.relay.stats().queued).toBe(1);
    expect((await fresh.claim(demoAddress(0))).status).toBe(409);
    expect(fresh.relay.stats().queued).toBe(1);
  }, 300_000);

  it('checks the allowlist before any Electrum read', async () => {
    let calls = 0;
    const counting = new Proxy(provider, {
      get(target, key) {
        const v = Reflect.get(target, key, target);
        return typeof v === 'function' ? (...args: any[]) => { calls++; return v.apply(target, args); } : v;
      },
    });
    const r = await startRelay({ relayerWifFile: await relayerKey(0n), perIpPerHour: 1 }, { provider: counting });
    calls = 0;
    const synthetic = addr(Uint8Array.from(Buffer.from(tree.leaves[2].lockingBytecode, 'hex')), true);
    for (let i = 0; i < 5; i++) expect((await r.claim(synthetic)).body.error).toBe('not a demo recipient');
    expect(calls).toBe(0);
    expect(r.relay.stats().trackedClients).toBe(0); // and refused before the rate limiter
    // a demo recipient does reach the chain
    expect((await r.claim(demoAddress(7))).body.error).toBe('relayer out of funds');
    expect(calls).toBeGreaterThan(0);
  });

  it('bounds the claim queue and times out a hung claim without blocking the next', async () => {
    let gateOn = true;
    let release!: () => void;
    const gate = new Promise<void>((ok) => { release = ok; });
    const key = await relayerKey(100_000n);
    let relayerLock = '';
    const gated = new Proxy(provider, {
      get(target, k) {
        const v = Reflect.get(target, k, target);
        if (typeof v !== 'function') return v;
        if (k !== 'getUtxosForLockingBytecode') return v.bind(target);
        return async (...args: any[]) => {
          if (gateOn && binToHex(args[0]) === relayerLock) await gate;
          return v.apply(target, args);
        };
      },
    });
    const r = await startRelay({ relayerWifFile: key }, { provider: gated, maxPending: 1, timeoutMs: 1_500 });
    const decoded = (await import('@bitauth/libauth')).cashAddressToLockingBytecode(r.relay.relayer.address) as any;
    relayerLock = binToHex(decoded.bytecode);
    const hung = r.claim(demoAddress(5));                       // waits on the relayer balance read
    await new Promise((ok) => setTimeout(ok, 300));
    expect(r.relay.stats().pending).toBe(1);
    expect(await r.claim(demoAddress(6))).toMatchObject({ status: 503, body: { error: 'busy, try again shortly' } });
    expect((await hung).status).toBe(504);
    expect(r.relay.stats().pending).toBe(0);
    gateOn = false;
    release();                                                    // the given-up claim must not broadcast now
    const next = await r.claim(demoAddress(5));
    expect(next.status).toBe(200);
    expect(await tokensAt(demoLock(seed, 5))).toBe(BigInt(leafOf(5).cumulative));
  }, 300_000);

  it('refuses non-demo leaves, unknown and invalid addresses', async () => {
    const r = await startRelay({ relayerWifFile: await relayerKey(100_000n) });
    const synthetic = tree.leaves[2];
    const syntheticAddress = addr(Uint8Array.from(Buffer.from(synthetic.lockingBytecode, 'hex')), true);
    expect(await r.claim(syntheticAddress)).toMatchObject({ status: 403, body: { error: 'not a demo recipient' } });
    expect(await tokensAt(Uint8Array.from(Buffer.from(synthetic.lockingBytecode, 'hex')))).toBe(0n);
    const unknown = addr(Uint8Array.from([0x76, 0xa9, 0x14, ...randomBytes(20), 0x88, 0xac]), true);
    expect(await r.claim(unknown)).toMatchObject({ status: 403, body: { error: 'not a demo recipient' } });
    expect(await r.claim(addr(leaflessDemo, false))).toMatchObject({ status: 404, body: { error: 'no leaf' } });
    expect(await r.claim('bitcoincash:qzzzz')).toMatchObject({ status: 400, body: { error: 'invalid address' } });
    expect(await r.claim(addr(demoLock(seed, 3), false, 'bchtest'))).toMatchObject({ status: 400, body: { error: 'wrong network' } });
    expect(await r.claim('x'.repeat(200))).toMatchObject({ status: 400, body: { error: 'invalid address' } });
    const notString = await r.call('/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: 42 }) });
    expect(notString).toMatchObject({ status: 400, body: { error: 'invalid address' } });
  });

  it('rate-limits per client; X-Forwarded-For only with TRUST_PROXY, last hop, and only if it is an IP', async () => {
    // an unfunded relayer: every allowed request ends at 'relayer out of funds', nothing is sent
    const OUT = 'relayer out of funds';
    const r = await startRelay({ relayerWifFile: await relayerKey(0n), perIpPerHour: 2 });
    expect((await r.claim(demoAddress(7), { 'x-forwarded-for': '1.1.1.1' })).body.error).toBe(OUT);
    expect((await r.claim(demoAddress(7), { 'x-forwarded-for': '2.2.2.2' })).body.error).toBe(OUT);
    expect(await r.claim(demoAddress(7), { 'x-forwarded-for': '3.3.3.3' })).toMatchObject({ status: 429, body: { error: 'rate limited' } });

    let t = Date.now();
    const p = await startRelay({ relayerWifFile: await relayerKey(0n), perIpPerHour: 2, trustProxy: true }, { now: () => t });
    expect((await p.claim(demoAddress(7), { 'x-forwarded-for': '9.9.9.9, 10.0.0.1' })).body.error).toBe(OUT);
    expect((await p.claim(demoAddress(7), { 'x-forwarded-for': '8.8.8.8, 10.0.0.1' })).body.error).toBe(OUT);
    // a spoofed first hop does not help: the proxy's last hop is the client
    expect((await p.claim(demoAddress(7), { 'x-forwarded-for': '7.7.7.7, 10.0.0.1' })).body.error).toBe('rate limited');
    expect((await p.claim(demoAddress(7), { 'x-forwarded-for': '10.0.0.2' })).body.error).toBe(OUT);
    t += 3_600_001; // an hour later the window has passed
    expect((await p.claim(demoAddress(7), { 'x-forwarded-for': '10.0.0.1' })).body.error).toBe(OUT);
  });

  it('falls back to the socket address when the last hop is not an IP; keys IPv6 by /64', async () => {
    const OUT = 'relayer out of funds';
    const p = await startRelay({ relayerWifFile: await relayerKey(0n), perIpPerHour: 1, trustProxy: true });
    expect((await p.claim(demoAddress(7), { 'x-forwarded-for': 'not-an-ip' })).body.error).toBe(OUT);       // counted for 127.0.0.1
    expect((await p.claim(demoAddress(7), { 'x-forwarded-for': '1.2.3.4, unknown' })).body.error).toBe('rate limited');
    expect((await p.claim(demoAddress(7))).body.error).toBe('rate limited');                                // no header: 127.0.0.1
    expect((await p.claim(demoAddress(7), { 'x-forwarded-for': '2001:db8:1:2::1' })).body.error).toBe(OUT);
    expect((await p.claim(demoAddress(7), { 'x-forwarded-for': '2001:db8:1:2:ffff::9' })).body.error).toBe('rate limited');
    expect((await p.claim(demoAddress(7), { 'x-forwarded-for': '2001:db8:1:3::1' })).body.error).toBe(OUT);
    expect(clientKey('2001:db8:1:2:ffff::9')).toBe('2001:db8:1:2::/64');
    expect(clientKey('2001:0db8:0001:0002::')).toBe('2001:db8:1:2::/64');
    expect(clientKey('::1')).toBe('0:0:0:0::/64');
    expect(clientKey('::ffff:1.2.3.4')).toBe('1.2.3.4');
    expect(clientKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(clientKey('5.6.7.8')).toBe('5.6.7.8');
  });

  it('caps the rate-limit map, dropping the least recently seen client', async () => {
    const OUT = 'relayer out of funds';
    const p = await startRelay({ relayerWifFile: await relayerKey(0n), perIpPerHour: 1, trustProxy: true }, { maxTrackedClients: 2 });
    const from = (ip: string) => p.claim(demoAddress(7), { 'x-forwarded-for': ip }).then((x) => x.body.error);
    expect(await from('1.0.0.1')).toBe(OUT);
    expect(await from('1.0.0.1')).toBe('rate limited');
    expect(await from('1.0.0.2')).toBe(OUT);
    expect(await from('1.0.0.3')).toBe(OUT);       // full: 1.0.0.1, the least recently seen, is dropped
    expect(p.relay.stats().trackedClients).toBe(2);
    expect(await from('1.0.0.3')).toBe('rate limited');
    expect(await from('1.0.0.1')).toBe(OUT);       // forgotten, so allowed again
    expect(p.relay.stats().trackedClients).toBe(2);
  });

  it('stops at the daily cap and resets the next UTC day', async () => {
    let t = Date.parse('2026-11-17T12:00:00Z');
    const r = await startRelay({ relayerWifFile: await relayerKey(100_000n), dailyCap: 1 }, { now: () => t });
    expect((await r.claim(demoAddress(1))).status).toBe(200);
    expect(await r.claim(demoAddress(2))).toMatchObject({ status: 429, body: { error: 'daily cap' } });
    expect(await tokensAt(demoLock(seed, 2))).toBe(0n);
    expect((await r.call('/status')).body.claimsLeftToday).toBe(0);
    t += 24 * 3_600_000;
    const next = await r.claim(demoAddress(2));
    expect(next.status).toBe(200);
    expect(await tokensAt(demoLock(seed, 2))).toBe(BigInt(leafOf(2).cumulative));
  }, 300_000);

  it('refuses when the relayer cannot pay the fee', async () => {
    const r = await startRelay({ relayerWifFile: await relayerKey(5_000n) });
    expect(await r.claim(demoAddress(3))).toMatchObject({ status: 503, body: { error: 'relayer out of funds' } });
    expect(await tokensAt(demoLock(seed, 3))).toBe(0n);
  });

  it('accepts JSON only, with a small body limit', async () => {
    const r = await startRelay({ relayerWifFile: await relayerKey(0n) });
    const post = (body: string, type = 'application/json') => r.call('/claim', { method: 'POST', headers: { 'content-type': type }, body });
    expect(await post('{"address":')).toMatchObject({ status: 400, body: { error: 'bad json' } });
    expect(await post('[1,2]')).toMatchObject({ status: 400 });
    expect(await post('null')).toMatchObject({ status: 400 });
    expect(await post('address=x', 'application/x-www-form-urlencoded')).toMatchObject({ status: 415 });
    expect(await post(JSON.stringify({ address: 'q'.repeat(2000) }))).toMatchObject({ status: 413, body: { error: 'body too large' } });
    // without a Content-Length (chunked), the limit still holds
    const chunked = await new Promise<{ status: number; body: any }>((ok, fail) => {
      const req = request(`${r.base}/claim`, { method: 'POST', headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => ok({ status: res.statusCode!, body: JSON.parse(text) }));
      });
      req.on('error', fail);
      for (let i = 0; i < 4; i++) req.write('x'.repeat(400));
      req.end();
    });
    expect(chunked).toEqual({ status: 413, body: { error: 'body too large' } });
    expect(await r.call('/claim')).toMatchObject({ status: 405, body: { error: 'method not allowed' } });
    expect(await r.call('/nope')).toMatchObject({ status: 404, body: { error: 'not found' } });
    // error bodies carry only the error text, never a stack
    for (const res of [await post('{'), await r.call('/nope')]) expect(Object.keys(res.body)).toEqual(['error']);
  });

  it('answers CORS preflight for the allowed origin only', async () => {
    const r = await startRelay({ relayerWifFile: await relayerKey(0n) });
    const pre = await r.call('/claim', { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(pre.headers.get('access-control-allow-methods')).toContain('POST');
    expect(pre.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('content-type');
    const evil = await r.call('/claim', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    expect(evil.status).toBe(403);
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
    const health = await r.call('/health', { headers: { origin: ORIGIN } });
    expect(health.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    const evilPost = await r.claim(demoAddress(4), { origin: 'https://evil.example' });
    expect(evilPost).toMatchObject({ status: 403, body: { error: 'origin not allowed' } });
  });

  it('logs one line per request', () => {
    expect(logs.length).toBeGreaterThan(20);
    expect(logs.every((l) => /^\d{4}-\d\d-\d\dT\S+ \S+ [A-Z]+ \/\S* \d{3} \d+ms/.test(l))).toBe(true);
    expect(logs.join('\n')).not.toMatch(/at .*\.ts:\d+/);
  });
});
