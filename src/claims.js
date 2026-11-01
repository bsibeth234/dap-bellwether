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
 * Only a keyed hash of the gate's claim key is stored, with its expiry. The
 * claim key names the network, the asset, the payer's wallet and the
 * authorization's nonce, all of which become public on chain once the transfer
 * settles. A plain hash could be matched to that transfer by anyone holding
 * the table; a keyed one cannot without the service's key. Nothing about the
 * query is in it.
 */

const keys = new Map();

async function keyedHash(secret, text) {
  let key = keys.get(secret);
  if (!key) {
    key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
    ]);
    keys.clear();
    keys.set(secret, key);
  }
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`claim|${text}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A replay guard for the vendored gate (src/x402/replay.ts), kept in D1.
 *
 * @param {() => object} getDb  returns the D1 binding
 * @param {string} secret       the service's hashing key
 * @param {() => number} now    epoch milliseconds
 */
export function d1ReplayGuard(getDb, secret, now = Date.now) {
  return {
    async claim(key, expiresAt) {
      const row = await getDb()
        .prepare(
          'INSERT INTO payment_claims (claim, expires_at) VALUES (?, ?) ' +
            'ON CONFLICT (claim) DO UPDATE SET expires_at = excluded.expires_at ' +
            'WHERE payment_claims.expires_at <= ? RETURNING claim'
        )
        .bind(await keyedHash(secret, key), Math.floor(expiresAt), Math.floor(now()))
        .first();
      return row !== null;
    },
    // A release that fails leaves the claim to lapse on its own, within about
    // an hour (payments.js caps how long a payment may stay valid). It never
    // throws: the gate's own answer, such as the settlement retry advice, must
    // reach the caller unchanged.
    async release(key) {
      try {
        await getDb()
          .prepare('DELETE FROM payment_claims WHERE claim = ?')
          .bind(await keyedHash(secret, key))
          .run();
      } catch (err) {
        console.error(`Bellwether payment claim release failed: ${err && err.message ? err.message : String(err)}`);
      }
    },
  };
}

/** Deletes every claim that has expired. Run by the cron. */
export async function purgePaymentClaims(db, nowMs) {
  const result = await db.prepare('DELETE FROM payment_claims WHERE expires_at <= ?').bind(Math.floor(nowMs)).run();
  return (result && result.meta && result.meta.changes) || 0;
}
