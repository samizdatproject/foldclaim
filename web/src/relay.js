// The optional demo relayer (relay/server.ts): who may use it, and the POST /claim call. Shared by the page and the
// node test (web/test/lookup.test.mjs).
import { parseAddress } from './lookup.js';

const TXID = /^[0-9a-f]{64}$/;

/** True when `lockHex` is one of the demo recipients listed in public.json (compared by locking bytecode). */
export function isDemoRecipient(pub, lockHex) {
  return (pub.demoRecipients ?? []).some((d) => parseAddress(d.address).lockHex === lockHex);
}

/**
 * Whether to offer the relayed claim: a relay is configured, the address is a demo recipient with a leaf in this
 * epoch file, and the pool is (or may be, while its live root is unknown) at this file's root.
 */
export function canRelay({ relay, pub, tree, leaf, lockHex, livePoolRoot }) {
  return Boolean(relay?.url && leaf && isDemoRecipient(pub, lockHex) && (livePoolRoot == null || livePoolRoot === tree.root));
}

/** POST {url}/claim; resolves to { txid } or { error } (the relay's error text), never throws. */
export async function relayClaim(url, address, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(`${url}/claim`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address }),
      credentials: 'omit', referrerPolicy: 'no-referrer',
    });
  } catch {
    return { error: 'relay unreachable' };
  }
  let body = null;
  try { body = await response.json(); } catch { /* not JSON */ }
  if (response.ok && typeof body?.txid === 'string' && TXID.test(body.txid)) return { txid: body.txid };
  const error = typeof body?.error === 'string' ? body.error.slice(0, 200) : '';
  return { error: error || `HTTP ${response.status}` };
}
