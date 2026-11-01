/**
 * Licences: the institutional rail.
 *
 * A bank or a pension plan does not pay per call in USDC. It signs a licence
 * with DAP, receives a key for its agents, and is invoiced for what it used.
 * The key is sent as `Authorization: Bearer <key>` or `X-API-Key: <key>` on
 * /mcp and on the JSON API, from the licensee's own servers and agents (the
 * browser preflight does not allow these headers, by design). A valid key
 * answers without the free allowance and without x402; every answered call to
 * a data tool or data endpoint is counted for that licence and day before the
 * answer is released, which is what the invoice reads.
 *
 * An Authorization or X-API-Key header that mentions dapk_ is treated as a
 * licence attempt. Any other Authorization header is ignored, so a client that sends an unrelated token
 * keeps the free and pay per call rails exactly as before. A DAP key that is
 * unknown, revoked or sent in the wrong shape is refused with 401 rather than
 * quietly answered under another rail: a licensee whose key stops working
 * must find out at once, not be charged in USDC or cut to 50 a day.
 *
 * The key itself is never stored. The licence row holds a SHA-256 of it; keys
 * are 256 random bits, so an unkeyed hash is enough to make a leaked table
 * useless. Licences are revoked by stamping revoked_at, never deleted, so a
 * usage report can always name the licence it counted.
 */

import { sha256 } from './db.js';

/** dapk_ then 32 random bytes as unpadded base64url. */
export const KEY_PATTERN = /^dapk_[A-Za-z0-9_-]{43}$/;

/** Licence ids, as shown on usage reports and invoices. */
export const LICENCE_ID_PATTERN = /^lic_[0-9a-f]{8}$/;

/**
 * The DAP key a request carries.
 *
 * Two headers are read: Authorization and X-API-Key. A DAP key is accepted
 * in exactly two shapes, `Authorization: Bearer <key>` or `X-API-Key: <key>`.
 * Either header mentioning dapk_ (in any case) in another shape, or the two
 * headers carrying different keys, is malformed and refused: a key sent
 * slightly wrong must fail loudly, never slip through to the free or paid
 * rails. A header that does not mention dapk_ is not ours, and is ignored, as
 * is a key sent in any other header.
 *
 * @returns {{ status: 'none' } | { status: 'malformed' } | { status: 'key', key: string }}
 */
export function presentedKey(request) {
  const auth = request.headers.get('Authorization');
  const apiKey = request.headers.get('X-API-Key');
  const keys = [];
  if (auth !== null && /dapk_/i.test(auth)) {
    const bearer = /^\s*Bearer[ \t]+(dapk_[^\s,]+)\s*$/i.exec(auth);
    if (!bearer) return { status: 'malformed' };
    keys.push(bearer[1]);
  }
  if (apiKey !== null && /dapk_/i.test(apiKey)) {
    const value = apiKey.trim();
    if (!/^dapk_[^\s,]+$/.test(value)) return { status: 'malformed' };
    keys.push(value);
  }
  if (keys.length === 0) return { status: 'none' };
  if (keys.length === 2 && keys[0] !== keys[1]) return { status: 'malformed' };
  return { status: 'key', key: keys[0] };
}

/**
 * Reads the licence a request presents.
 *
 * @returns {Promise<
 *   { status: 'none' } |
 *   { status: 'invalid' } |
 *   { status: 'unavailable' } |
 *   { status: 'valid', licence: { id: string, licensee: string } }
 * >}
 */
export async function readLicence(request, env) {
  const presented = presentedKey(request);
  if (presented.status === 'none') return { status: 'none' };
  if (presented.status === 'malformed' || !KEY_PATTERN.test(presented.key)) return { status: 'invalid' };
  try {
    const row = await env.DB.prepare(
      'SELECT id, licensee FROM licences WHERE key_hash = ? AND revoked_at IS NULL'
    )
      .bind(await sha256(presented.key))
      .first();
    if (!row) return { status: 'invalid' };
    return { status: 'valid', licence: { id: row.id, licensee: row.licensee } };
  } catch (err) {
    console.error(`Bellwether licence check failed: ${err && err.message ? err.message : String(err)}`);
    return { status: 'unavailable' };
  }
}

/** Adds one to a licence's count for the day and endpoint. */
export async function recordLicenceUsage(db, day, licenceId, endpoint) {
  await db
    .prepare(
      'INSERT INTO licence_usage_daily (day, licence_id, endpoint, calls) VALUES (?, ?, ?, 1) ' +
        'ON CONFLICT (day, licence_id, endpoint) DO UPDATE SET calls = calls + 1'
    )
    .bind(day, licenceId, endpoint)
    .run();
}

/**
 * Counts one answered call for the invoice, before the answer is released.
 * Returns false if the count could not be written, in which case the caller
 * withholds the answer: a licensed answer is never given without being counted.
 */
export async function countLicensedCall(db, day, licenceId, endpoint) {
  try {
    await recordLicenceUsage(db, day, licenceId, endpoint);
    return true;
  } catch (err) {
    console.error(`Bellwether licence usage count failed: ${err && err.message ? err.message : String(err)}`);
    return false;
  }
}

const CONTACT = 'bsibeth@dap.solutions';

/** The 401 for a DAP key that is unknown or revoked. RFC 6750 shape. */
export function licenceRefused({ jsonRpc = false } = {}) {
  const message = `The DAP licence key was not recognized or has been revoked. Contact ${CONTACT}.`;
  const body = jsonRpc
    ? { jsonrpc: '2.0', id: null, error: { code: -32001, message } }
    : { error: 'invalid_licence', message };
  return new Response(JSON.stringify(body), {
    status: 401,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'WWW-Authenticate': 'Bearer realm="DAP Bellwether", error="invalid_token"',
    },
  });
}

/** The 503 when the licence store cannot be read. Nothing ran, nothing was counted. */
export function licenceUnavailable({ jsonRpc = false } = {}) {
  const message = 'The licence check is unavailable. Retry shortly.';
  const body = jsonRpc
    ? { jsonrpc: '2.0', id: null, error: { code: -32603, message } }
    : { error: 'licence_check_unavailable', message };
  return new Response(JSON.stringify(body), {
    status: 503,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Retry-After': '2' },
  });
}
