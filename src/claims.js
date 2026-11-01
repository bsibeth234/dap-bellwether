/**
 * Payment claims: one payment buys one answer, across every Worker instance.
 *
 * The gate claims each payment authorization from verification until it
 * settles or expires. An in-memory claim covers one instance only, so two
 * instances could each accept the same signed payment while its transfer is
 * still pending. Held in D1 instead, the claim is shared, which is what lets
 * the gate release an answer as soon as the facilitator reports the transfer
 * sent (settlement_pending) rather than leaving a payer charged with no answer.
 *
 * Only a SHA-256 of the gate's claim key is stored, with its expiry. The key
 * names the network, the asset, the payer's wallet and the authorization's
 * nonce; the hash keeps none of them readable, and nothing about the query.
 */

async function sha256hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A replay guard for the vendored gate (src/x402/replay.ts), kept in D1.
 *
 * @param {() => object} getDb  returns the D1 binding
 * @param {() => number} now    epoch milliseconds
 */
export function d1ReplayGuard(getDb, now = Date.now) {
  return {
    async claim(key, expiresAt) {
      const row = await getDb()
        .prepare(
          'INSERT INTO payment_claims (claim, expires_at) VALUES (?, ?) ' +
            'ON CONFLICT (claim) DO UPDATE SET expires_at = excluded.expires_at ' +
            'WHERE payment_claims.expires_at <= ? RETURNING claim'
        )
        .bind(await sha256hex(key), Math.floor(expiresAt), Math.floor(now()))
        .first();
      return row !== null;
    },
    async release(key) {
      await getDb()
        .prepare('DELETE FROM payment_claims WHERE claim = ?')
        .bind(await sha256hex(key))
        .run();
    },
  };
}

/** Deletes every claim that has expired. Run by the cron. */
export async function purgePaymentClaims(db, nowMs) {
  const result = await db.prepare('DELETE FROM payment_claims WHERE expires_at <= ?').bind(Math.floor(nowMs)).run();
  return (result && result.meta && result.meta.changes) || 0;
}
