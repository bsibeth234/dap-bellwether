/**
 * The SQL behind scripts/licence.mjs, kept pure so the tests can run it
 * against the real schema.
 *
 * wrangler d1 execute takes one SQL string and no bound parameters, so every
 * value is checked against a narrow pattern first and then quoted. A value
 * that fails its pattern is refused, never cleaned up: a licensee name on an
 * invoice must be exactly what Brendan typed.
 */

import { createHash, randomBytes } from 'node:crypto';

export const LICENSEE = /^[A-Za-z0-9][A-Za-z0-9 .,&'()-]{1,79}$/;
export const NOTE = /^[A-Za-z0-9 .,&'()/#:-]{0,200}$/;
export const LICENCE_ID = /^lic_[0-9a-f]{8}$/;
export const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** A single quoted SQL string literal. Only ever called on a value that passed its pattern. */
function quote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** A new key and its licence id. The key is shown once and never stored. */
export function newLicence() {
  const key = `dapk_${randomBytes(32).toString('base64url')}`;
  const id = `lic_${randomBytes(4).toString('hex')}`;
  const keyHash = createHash('sha256').update(key, 'utf8').digest('hex');
  return { key, id, keyHash };
}

export function issueSql({ id, licensee, keyHash, createdAt, note }) {
  if (!LICENCE_ID.test(id)) throw new Error('bad licence id');
  if (!LICENSEE.test(licensee)) {
    throw new Error("Licensee: 2 to 80 characters, letters, digits, spaces and . , & ' ( ) - only.");
  }
  if (!/^[0-9a-f]{64}$/.test(keyHash)) throw new Error('bad key hash');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(createdAt)) throw new Error('bad timestamp');
  if (note !== undefined && note !== null && !NOTE.test(note)) {
    throw new Error("Note: up to 200 characters, letters, digits, spaces and . , & ' ( ) / # : - only.");
  }
  return (
    'INSERT INTO licences (id, licensee, key_hash, created_at, revoked_at, note) VALUES (' +
    [quote(id), quote(licensee), quote(keyHash), quote(createdAt), 'NULL', note ? quote(note) : 'NULL'].join(', ') +
    ');'
  );
}

export function revokeSql({ id, revokedAt }) {
  if (!LICENCE_ID.test(id)) throw new Error('A licence id looks like lic_1a2b3c4d.');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(revokedAt)) throw new Error('bad timestamp');
  return `UPDATE licences SET revoked_at = ${quote(revokedAt)} WHERE id = ${quote(id)} AND revoked_at IS NULL;`;
}

export function listSql() {
  return 'SELECT id, licensee, created_at, revoked_at, note FROM licences ORDER BY created_at;';
}

/** Calls per licence and endpoint for one calendar month (UTC days). */
export function usageSql({ month }) {
  if (!MONTH.test(month)) throw new Error('A month looks like 2026-11.');
  return (
    'SELECT l.id AS licence_id, l.licensee AS licensee, u.endpoint AS endpoint, SUM(u.calls) AS calls ' +
    'FROM licence_usage_daily u JOIN licences l ON l.id = u.licence_id ' +
    `WHERE u.day LIKE ${quote(`${month}-%`)} ` +
    'GROUP BY l.id, l.licensee, u.endpoint ORDER BY l.licensee, u.endpoint;'
  );
}
