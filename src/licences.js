/**
 * Licences: the institutional rail.
 *
 * A bank or a pension plan does not pay per call in USDC. It signs a licence
 * with DAP, receives a key for its agents, and is invoiced for what it used.
 * The key is sent as `Authorization: Bearer <key>` or `X-API-Key: <key>` on
 * /mcp and on the JSON API. A valid key answers without the free allowance
 * and without x402; every answered call to a data tool or data endpoint adds
 * one to that licence's count for the day, which is what the invoice reads.
 *
 * Only tokens that look like DAP keys (dapk_ and 43 base64url characters) are
 * treated as licence attempts. Any other Authorization header is ignored, so a
 * client that sends an unrelated token keeps the free and pay per call rails
 * exactly as before. A DAP key that is unknown or revoked is refused with 401
 * rather than quietly answered under another rail: a licensee whose key stops
 * working must find out at once, not be charged in USDC or cut to 50 a day.
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
 * The DAP key a request carries, if any. Authorization: Bearer first, then
 * X-API-Key, which is what some agent platforms let an administrator set.
 *
 * @returns {string|null}
 */
export function presentedKey(request) {
  const auth = (request.headers.get('Authorization') || '').trim();
  const bearer = /^Bearer\s+(\S+)$/i.exec(auth);
  if (bearer && bearer[1].startsWith('dapk_')) return bearer[1];
  const header = (request.headers.get('X-API-Key') || '').trim();
  if (header.startsWith('dapk_')) return header;
  return null;
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
  const key = presentedKey(request);
  if (key === null) return { status: 'none' };
  if (!KEY_PATTERN.test(key)) return { status: 'invalid' };
  try {
    const row = await env.DB.prepare(
      'SELECT id, licensee FROM licences WHERE key_hash = ? AND revoked_at IS NULL'
    )
      .bind(await sha256(key))
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
 * Usage is what the invoice reads. It is written through waitUntil, which the
 * runtime runs to completion after the answer goes out, so it never delays or
 * breaks the answer. A failed write is logged.
 */
export function noteLicenceUsage(env, ctx, day, licenceId, endpoint) {
  const job = recordLicenceUsage(env.DB, day, licenceId, endpoint).catch((err) => {
    console.error(`Bellwether licence usage count failed: ${err && err.message ? err.message : String(err)}`);
  });
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(job);
  return job;
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
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': '2' },
  });
}
