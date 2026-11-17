// Minimal read-only Electrum (Fulcrum) JSON-RPC client over WSS: tip height and token-aware UTXO listings.
import { bytesToHex, sha256 } from './merkle.js';

export const SERVERS = ['wss://bch.imaginary.cash:50004', 'wss://bch.loping.net:50004'];
const CONNECT_MS = 8000;
const REQUEST_MS = 15000;

function open(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { ws.close(); reject(new Error(`${url}: connect timeout`)); }, CONNECT_MS);
    ws.onopen = () => { clearTimeout(timer); resolve(ws); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error(`${url}: connection failed`)); };
  });
}

export class Fulcrum {
  constructor(servers = SERVERS) { this.servers = servers; this.ready = null; this.id = 0; this.pending = new Map(); }

  connect() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const errors = [];
      for (const url of this.servers) {
        let ws;
        try {
          ws = await open(url);
          ws.onmessage = (e) => {
            const msg = JSON.parse(e.data);
            const p = this.pending.get(msg.id);
            if (!p) return;
            this.pending.delete(msg.id);
            clearTimeout(p.timer);
            msg.error ? p.reject(new Error(msg.error.message ?? 'server error')) : p.resolve(msg.result);
          };
          ws.onclose = () => {
            this.ready = null;
            for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('connection closed')); }
            this.pending.clear();
          };
          this.ws = ws;
          this.url = url;
          await this.request('server.version', 'foldclaim-web', '1.5');
          return this;
        } catch (e) {
          errors.push(e.message);
          if (ws) { ws.onclose = null; ws.close(); }
          for (const p of this.pending.values()) clearTimeout(p.timer);
          this.pending.clear();
        }
      }
      this.ready = null;
      throw new Error(`no Electrum server reachable (${errors.join('; ')})`);
    })();
    return this.ready;
  }

  request(method, ...params) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method}: timeout`)); }, REQUEST_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  async call(method, ...params) { await this.connect(); return this.request(method, ...params); }

  async tipHeight() { return (await this.call('blockchain.headers.get_tip')).height; }

  /** Unspent outputs of a locking bytecode, with CashToken data. */
  async listUnspent(lockingBytecode) {
    const scripthash = bytesToHex((await sha256(lockingBytecode)).reverse());
    return this.call('blockchain.scripthash.listunspent', scripthash, 'include_tokens');
  }
}
