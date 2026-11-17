// FoldClaim demo relayer: submits claims for the demo recipients and pays the fee from its own key.
//
//   NETWORK=mainnet RELAYER_WIF_FILE=secrets/mainnet-relayer.wif \
//     node --experimental-transform-types --no-warnings relay/server.ts
//   npm run relay:build && node dist/relay.mjs     (the deployed form: a bundle for Node 20+, packages external)
//
// GET /health, GET /status, POST /claim {"address": "..."}. The tokens always go to the leaf's own address (the
// contract enforces it); the relayer only pays the fee. Only addresses listed in public.json demoRecipients are
// relayed, so visitors cannot spend the relayer's coins on the synthetic leaves. Claims run one at a time (they all
// spend the pool's master UTXO), at most 5 waiting, each bounded by a 90 s timeout. Limits are in memory and reset on
// restart. Order per claim: parse, demo allowlist (no I/O), per-client rate limit, pool root, epoch file, leaf.
//
// Env: NETWORK (mainnet|chipnet), DEPLOY_DIR (default deployments/<network>), RELAYER_WIF_FILE (required),
// PORT (8792), HOST (127.0.0.1), ALLOWED_ORIGIN (https://samizdatproject.github.io), DAILY_CAP (12),
// PER_IP_PER_HOUR (3; every demo-recipient POST /claim counts, refused ones too; IPv6 by /64), TRUST_PROXY (set, and not 0/false/no,
// to read the client address from X-Forwarded-For, last hop).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, realpathSync } from 'node:fs';
import { isIP, isIPv4, isIPv6 } from 'node:net';
import { fileURLToPath } from 'node:url';
import { binToHex, cashAddressToLockingBytecode, lockingBytecodeToCashAddress } from '@bitauth/libauth';
import { Signer } from '@solidcash/solidcash';
import { attachDeployment, findTreeFile, findLeaf, claimLeaf } from '../src/pool.ts';

export type RelayConfig = {
  network: 'mainnet' | 'chipnet';
  deployDir: string;
  relayerWifFile: string;
  port: number;
  host: string;
  allowedOrigin: string;
  dailyCap: number;
  perIpPerHour: number;
  trustProxy: boolean;
};
type Options = {
  provider: any;
  now?: () => number;
  log?: (line: string) => void;
  timeoutMs?: number; // per provider call and per queued claim
  maxPending?: number; // claims waiting or running
  maxTrackedClients?: number; // entries in the per-client rate-limit map
};

const MAX_BODY_BYTES = 1024;
const MAX_ADDRESS_LENGTH = 128;
const MIN_RELAYER_SATS = 12_000n; // one claim costs about 8,000-9,000 sats (reports/rehearsal.json)
const STATUS_CACHE_MS = 5_000;
const HOUR_MS = 3_600_000;
const PURGE_MS = 600_000;
const ZERO_ROOT = '0'.repeat(64);

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const network = env.NETWORK ?? 'mainnet';
  if (network !== 'mainnet' && network !== 'chipnet') throw new Error('NETWORK must be mainnet or chipnet');
  if (!env.RELAYER_WIF_FILE) throw new Error('RELAYER_WIF_FILE is required');
  const int = (name: string, fallback: number) => {
    const n = Number(env[name] ?? fallback);
    if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
    return n;
  };
  return {
    network,
    deployDir: env.DEPLOY_DIR ?? `deployments/${network}`,
    relayerWifFile: env.RELAYER_WIF_FILE,
    port: int('PORT', 8792),
    host: env.HOST ?? '127.0.0.1',
    allowedOrigin: env.ALLOWED_ORIGIN ?? 'https://samizdatproject.github.io',
    dailyCap: int('DAILY_CAP', 12),
    perIpPerHour: int('PER_IP_PER_HOUR', 3),
    trustProxy: Boolean(env.TRUST_PROXY) && !['0', 'false', 'no'].includes(env.TRUST_PROXY!.toLowerCase()),
  };
}

/** The rate-limit key: an IPv4 address (IPv4-mapped IPv6 unwrapped), or an IPv6 address's /64 prefix. */
export function clientKey(ip: string): string {
  const addr = ip.replace(/%.*$/, '');
  if (/^::ffff:/i.test(addr) && isIPv4(addr.slice(7))) return addr.slice(7);
  if (!isIPv6(addr)) return addr;
  const [head, tail] = addr.split('::');
  const h = head ? head.split(':') : [];
  const t = tail === undefined ? [] : tail ? tail.split(':') : [];
  const groups = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export function createRelay(config: RelayConfig, opts: Options) {
  const { provider, now = Date.now, log = console.log, timeoutMs = 90_000, maxPending = 5, maxTrackedClients = 10_000 } = opts;
  const prefix = config.network === 'mainnet' ? 'bitcoincash' : 'bchtest';
  const { publicInfo, registry, pool, tokenCategory } = attachDeployment(config.deployDir, provider);
  const payer = new Signer(readFileSync(config.relayerWifFile, 'utf8').trim(), provider) as any;
  const encode = (bytecode: Uint8Array, tokenSupport: boolean) => {
    const r = lockingBytecodeToCashAddress({ prefix, bytecode, tokenSupport } as any);
    return typeof r === 'string' ? r : (r as any).address as string;
  };
  const relayer = { address: encode(payer.getLockingBytecode(), false), tokenAddress: encode(payer.getLockingBytecode(), true) };

  // The allowlist, by locking bytecode (a q… and a z… address of the same key are the same recipient).
  const demoLocks = new Set<string>((publicInfo.demoRecipients ?? []).map((d: any) => {
    const decoded = cashAddressToLockingBytecode(d.address);
    if (typeof decoded === 'string') throw new Error(`public.json: bad demo address ${d.address}`);
    return binToHex(decoded.bytecode);
  }));

  /** Reject after `ms` so a hung provider call cannot hold a request (or the claim queue) forever. */
  const withTimeout = <T>(p: Promise<T>, what: string, ms = timeoutMs): Promise<T> => {
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([p, new Promise<never>((_, fail) => { timer = setTimeout(() => fail(new HttpError(504, `${what} timed out`)), ms); })])
      .finally(() => clearTimeout(timer));
  };

  // --- per-client limit: in memory, LRU-ordered, size-capped, purged periodically; IPv6 clients keyed by /64 ---
  const hits = new Map<string, number[]>();
  const purge = () => { const t = now(); for (const [k, v] of hits) if (v[v.length - 1] <= t - HOUR_MS) hits.delete(k); };
  const purgeTimer = setInterval(purge, PURGE_MS);
  purgeTimer.unref();
  function rateLimited(key: string): boolean {
    const t = now();
    const recent = (hits.get(key) ?? []).filter((at) => at > t - HOUR_MS);
    hits.delete(key); // re-inserted below, so the map's first key is the least recently seen client
    const limited = recent.length >= config.perIpPerHour;
    if (!limited) recent.push(t);
    if (hits.size >= maxTrackedClients) hits.delete(hits.keys().next().value!);
    hits.set(key, recent);
    return limited;
  }
  let day = '';
  let claimsToday = 0;
  const claimsLeft = () => {
    const today = new Date(now()).toISOString().slice(0, 10);
    if (today !== day) { day = today; claimsToday = 0; }
    return Math.max(0, config.dailyCap - claimsToday);
  };

  // Leaves already paid (or answered "nothing to claim") under the current root: answered without queuing.
  let settledRoot = '';
  const settled = new Set<string>();
  const settle = (root: string, index: number) => { if (root === settledRoot) settled.add(`${root}:${index}`); };

  // One claim at a time, at most `maxPending` waiting or running, each bounded by `timeoutMs`. A failed or timed-out
  // claim does not block the next; a timed-out one is flagged so it does not START a claim after it was given up. A
  // claim already inside the SDK when the timeout fires may still broadcast (the visitor sees 504 while it lands; a
  // concurrent next claim then fails on the conflict, which costs no fee).
  let queue: Promise<unknown> = Promise.resolve();
  let pending = 0;
  let queued = 0;
  const serial = <T>(fn: (expired: () => boolean) => Promise<T>): Promise<T> => {
    if (pending >= maxPending) throw new HttpError(503, 'busy, try again shortly');
    pending++;
    queued++;
    const run = queue.then(() => {
      let expired = false;
      return withTimeout(fn(() => expired), 'claim').catch((e) => { expired = true; throw e; });
    });
    queue = run.catch(() => undefined).finally(() => { pending--; });
    return run;
  };

  async function relayerBalance(): Promise<bigint> {
    const utxos = await withTimeout(provider.getUtxosForLockingBytecode(payer.getLockingBytecode()), 'balance') as any[];
    return utxos.filter((u: any) => !u.token).reduce((n: bigint, u: any) => n + BigInt(u.satoshis), 0n);
  }

  // /status: one shared in-flight read; its result, success or failure, is cached for STATUS_CACHE_MS.
  let statusCache: { at: number; body?: object; failed?: boolean } | null = null;
  let statusInFlight: Promise<void> | null = null;
  async function status() {
    if (!statusCache || now() - statusCache.at >= STATUS_CACHE_MS) {
      statusInFlight ??= (async () => {
        try {
          const [p, r, balance] = await Promise.all([withTimeout(pool.getState(), 'pool read'), withTimeout(registry.getState(), 'registry read'), relayerBalance()]) as any[];
          statusCache = { at: now(), body: {
            network: config.network,
            pool: { epoch: Number(p.epoch), root: binToHex(p.root) },
            registry: { activeEpoch: Number(r.activeEpoch), activeRoot: binToHex(r.activeRoot), pendingEpoch: Number(r.pendingEpoch) },
            relayer: { ...relayer, balance: Number(balance) },
            dailyCap: config.dailyCap,
          } };
        } catch (e: any) {
          log(`status read failed: ${String(e?.message ?? e).slice(0, 200)}`);
          statusCache = { at: now(), failed: true };
        } finally { statusInFlight = null; }
      })();
      await statusInFlight;
    }
    if (statusCache!.failed) throw new HttpError(503, 'status unavailable');
    return { ...statusCache!.body, claimsLeftToday: claimsLeft() };
  }

  function parseAddress(input: unknown): Uint8Array {
    if (typeof input !== 'string' || input.length === 0 || input.length > MAX_ADDRESS_LENGTH) throw new HttpError(400, 'invalid address');
    let text = input.trim();
    if (text === text.toUpperCase()) text = text.toLowerCase(); // CashAddr is all lower or all upper case
    if (!text.includes(':')) text = `${prefix}:${text}`;
    if (!text.startsWith(`${prefix}:`)) throw new HttpError(400, 'wrong network');
    const decoded = cashAddressToLockingBytecode(text);
    if (typeof decoded === 'string') throw new HttpError(400, 'invalid address');
    return decoded.bytecode;
  }

  async function claim(body: unknown, client: string) {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, 'expected {"address": "..."}');
    const lock = parseAddress((body as any).address);
    // Order matters: the allowlist needs no I/O, so nobody else gets an Electrum read or a disk lookup.
    if (!demoLocks.has(binToHex(lock))) throw new HttpError(403, 'not a demo recipient');
    if (rateLimited(client)) throw new HttpError(429, 'rate limited');
    let root: string;
    try { root = binToHex((await withTimeout(pool.getState(), 'pool read') as any).root); } catch (e: any) {
      throw Object.assign(new HttpError(503, 'chain unavailable'), { detail: String(e?.message ?? e) });
    }
    if (root === ZERO_ROOT) throw new HttpError(503, 'pool not synced yet');
    if (root !== settledRoot) { settledRoot = root; settled.clear(); }
    const tree = findTreeFile(config.deployDir, root);
    if (!tree) throw new HttpError(503, 'no epoch file for the current root');
    const leaf = findLeaf(tree, lock); // checks the proof against the root
    if (!leaf) throw new HttpError(404, 'no leaf');
    if (settled.has(`${root}:${leaf.index}`)) throw new HttpError(409, 'nothing to claim');
    return serial(async (expired) => {
      if (settled.has(`${root}:${leaf.index}`)) throw new HttpError(409, 'nothing to claim');
      if (claimsLeft() === 0) throw new HttpError(429, 'daily cap');
      if (await relayerBalance() < MIN_RELAYER_SATS) throw new HttpError(503, 'relayer out of funds');
      if (expired()) throw new HttpError(504, 'claim timed out');
      claimsToday++; // counted before sending: a claim that times out may still have been broadcast
      let result;
      try { result = await claimLeaf(pool, payer, tokenCategory, leaf); } catch (e: any) {
        claimsToday--;
        const detail = String(e?.message ?? e);
        // the SDK's funding error ("Signer has N available plain UTXO(s) but 2 funder(s) needed ... Fund the signer")
        const unfunded = /available plain UTXO|fund the signer|insufficient/i.test(detail);
        throw Object.assign(new HttpError(unfunded ? 503 : 502, unfunded ? 'relayer out of funds' : 'claim failed'), { detail });
      }
      settle(root, leaf.index);
      if (result.status === 'nothing-to-claim') { claimsToday--; throw new HttpError(409, 'nothing to claim'); }
      statusCache = null;
      return { txid: result.txid, epoch: tree.epoch, leafIndex: leaf.index, cumulative: leaf.cumulative.toString() };
    });
  }

  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((ok, fail) => {
      if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) { req.resume(); return fail(new HttpError(413, 'body too large')); }
      const chunks: Buffer[] = [];
      let size = 0;
      let failed = false;
      req.on('data', (c: Buffer) => {
        if (failed) return;
        size += c.length;
        if (size > MAX_BODY_BYTES) { failed = true; fail(new HttpError(413, 'body too large')); return; }
        chunks.push(c);
      });
      req.on('end', () => { if (!failed) ok(Buffer.concat(chunks).toString('utf8')); });
      req.on('error', (e) => { failed = true; fail(e); });
    });
  }

  /** The client address: X-Forwarded-For's last hop only behind a trusted proxy and only if it is an IP. */
  function clientIp(req: IncomingMessage): string {
    const forwarded = req.headers['x-forwarded-for'];
    const last = typeof forwarded === 'string' ? forwarded.split(',').pop()!.trim() : '';
    if (config.trustProxy && isIP(last)) return last;
    return req.socket.remoteAddress ?? 'unknown';
  }

  return {
    relayer,
    stats: () => ({ pending, queued, trackedClients: hits.size }),
    close: () => clearInterval(purgeTimer),
    async handler(req: IncomingMessage, res: ServerResponse) {
      const started = now();
      const ip = clientIp(req);
      const path = (req.url ?? '/').split('?')[0];
      const origin = req.headers.origin;
      let note = '';
      const send = (status: number, body: unknown, extra: Record<string, string> = {}) => {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra,
        };
        if (origin === config.allowedOrigin) Object.assign(headers, { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' });
        if (status === 413) headers.Connection = 'close';
        res.writeHead(status, headers).end(status === 204 ? undefined : JSON.stringify(body));
        log(`${new Date(started).toISOString()} ${ip} ${req.method} ${path.slice(0, 64)} ${status} ${now() - started}ms${note ? ' ' + note : ''}`);
      };
      try {
        if (origin !== undefined && origin !== config.allowedOrigin) throw new HttpError(403, 'origin not allowed');
        if (req.method === 'OPTIONS') {
          return send(204, null, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' });
        }
        if (path === '/health' && req.method === 'GET') return send(200, { ok: true });
        if (path === '/status' && req.method === 'GET') return send(200, await status());
        if (path === '/claim' && req.method === 'POST') {
          if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'content-type must be application/json');
          const raw = await readBody(req);
          let body: unknown;
          try { body = JSON.parse(raw); } catch { throw new HttpError(400, 'bad json'); }
          const result = await claim(body, clientKey(ip));
          note = `claimed leaf ${result.leafIndex} ${result.txid}`;
          return send(200, result);
        }
        if (['/health', '/status', '/claim'].includes(path)) throw new HttpError(405, 'method not allowed');
        throw new HttpError(404, 'not found');
      } catch (e: any) {
        if (e instanceof HttpError) {
          note = e.message + ((e as any).detail ? `: ${String((e as any).detail).slice(0, 200)}` : '');
          return send(e.status, { error: e.message });
        }
        note = `internal: ${String(e?.message ?? e).slice(0, 200)}`;
        return send(500, { error: 'internal error' });
      }
    },
  };
}

async function main() {
  const config = configFromEnv();
  const { ElectrumNetworkProvider } = await import('@solidcash/solidcash/network/electrum');
  const provider = new ElectrumNetworkProvider(config.network);
  const relay = createRelay(config, { provider });
  const server = createServer((req, res) => { void relay.handler(req, res); });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.listen(config.port, config.host, () => {
    console.log(`foldclaim relay (${config.network}) on ${config.host}:${config.port}, relayer ${relay.relayer.address}`);
  });
  const stop = () => { relay.close(); server.close(); void provider.disconnect().finally(() => process.exit(0)); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await main();
