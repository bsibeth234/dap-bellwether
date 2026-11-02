/**
 * Data access for DAP Bellwether.
 *
 * The store is the product. A pass-through to regulator feeds can only show a
 * list; holding prior state is what lets us say a document actually changed,
 * and what a classification layer will later enrich rather than replace.
 */

import { linkOnlySourceIds, servable } from './sources.js';

/** SHA-256 hex. Available in Workers and in Node 20+ without a polyfill. */
export async function sha256(input) {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Stable record id. Derived from source and the feed's own guid so that the
 * same document keeps the same id across every run, which is what makes
 * revision history possible.
 */
export async function changeId(sourceId, guid) {
  return (await sha256(`${sourceId}\u0000${guid}`)).slice(0, 32);
}

/**
 * Content hash. Only the fields whose movement constitutes a change. The
 * published date is deliberately excluded: several regulators rewrite it on
 * unrelated republication, which would produce a revision with no substance.
 */
export async function contentHash({ title, summary, url }) {
  return sha256(`${title || ''}\u0000${summary || ''}\u0000${url || ''}`);
}

/**
 * Insert a record, or record a new revision when its content moved.
 * @returns {Promise<'inserted'|'revised'|'unchanged'>}
 */
export async function upsertChange(db, source, item, now) {
  const id = await changeId(source.id, item.guid);
  const hash = await contentHash(item);

  const existing = await db
    .prepare('SELECT id, content_hash, revision FROM changes WHERE id = ?')
    .bind(id)
    .first();

  if (!existing) {
    await db.batch([
      db
        .prepare(
          `INSERT INTO changes
             (id, source_id, regulator, jurisdiction, category, guid, title, url,
              summary, published_at, first_seen_at, last_seen_at, content_hash, revision)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
        )
        .bind(
          id,
          source.id,
          source.regulator,
          source.jurisdiction,
          source.category,
          item.guid,
          item.title,
          item.url,
          item.summary,
          item.publishedAt,
          now,
          now,
          hash
        ),
      db
        .prepare(
          `INSERT INTO change_revisions
             (change_id, revision, observed_at, title, summary, url, content_hash)
           VALUES (?, 1, ?, ?, ?, ?, ?)`
        )
        .bind(id, now, item.title, item.summary, item.url, hash),
    ]);
    return 'inserted';
  }

  if (existing.content_hash === hash) {
    await db.prepare('UPDATE changes SET last_seen_at = ? WHERE id = ?').bind(now, id).run();
    return 'unchanged';
  }

  const nextRevision = existing.revision + 1;
  await db.batch([
    db
      .prepare(
        `UPDATE changes
            SET title = ?, url = ?, summary = ?, published_at = ?,
                last_seen_at = ?, content_hash = ?, revision = ?
          WHERE id = ?`
      )
      .bind(item.title, item.url, item.summary, item.publishedAt, now, hash, nextRevision, id),
    db
      .prepare(
        `INSERT INTO change_revisions
           (change_id, revision, observed_at, title, summary, url, content_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(id, nextRevision, now, item.title, item.summary, item.url, hash),
  ]);
  return 'revised';
}

/** Record the outcome of pulling one source, so coverage can be honest. */
export async function recordSourceHealth(db, source, { ok, error, itemCount, now }) {
  if (ok) {
    await db
      .prepare(
        `INSERT INTO source_health
           (source_id, last_ok_at, last_error, last_error_at, consecutive_failures, last_item_count)
         VALUES (?, ?, NULL, NULL, 0, ?)
         ON CONFLICT(source_id) DO UPDATE SET
           last_ok_at = excluded.last_ok_at,
           last_error = NULL,
           last_error_at = NULL,
           consecutive_failures = 0,
           last_item_count = excluded.last_item_count`
      )
      .bind(source.id, now, itemCount)
      .run();
    return;
  }

  await db
    .prepare(
      `INSERT INTO source_health
         (source_id, last_ok_at, last_error, last_error_at, consecutive_failures, last_item_count)
       VALUES (?, NULL, ?, ?, 1, 0)
       ON CONFLICT(source_id) DO UPDATE SET
         last_error = excluded.last_error,
         last_error_at = excluded.last_error_at,
         consecutive_failures = source_health.consecutive_failures + 1`
    )
    .bind(source.id, String(error).slice(0, 500), now)
    .run();
}

export async function getSourceHealth(db) {
  const { results } = await db.prepare('SELECT * FROM source_health').all();
  return Object.fromEntries((results || []).map((r) => [r.source_id, r]));
}

const CHANGE_COLUMNS = `id, source_id, regulator, jurisdiction, category, title, url,
                        summary, published_at, first_seen_at, last_seen_at, revision`;

/**
 * Search stored changes.
 *
 * Keyword matching is LIKE over title and summary rather than FTS5. At the
 * volumes these feeds produce, a few tens of thousands of rows, LIKE with the
 * jurisdiction and date indexes is comfortably fast, and it avoids the trigger
 * machinery FTS5 needs to stay in sync through revisions. Revisit if the
 * corpus grows an order of magnitude.
 */
export async function searchChanges(db, { query, jurisdiction, regulator, category, since, until, limit }) {
  const where = [];
  const binds = [];

  if (query) {
    // The ESCAPE clause is required: without it SQLite treats the backslash as
    // a literal, so a user searching for "50%" would still get wildcard
    // behaviour rather than a search for the string.
    // A linkOnly source is matched on its title alone.
    const held = linkOnlySourceIds();
    where.push(
      `(title LIKE ? ESCAPE '\\' OR (summary LIKE ? ESCAPE '\\' AND source_id NOT IN (${held.map(() => '?').join(', ')})))`
    );
    const like = `%${query.replace(/[%_\\]/g, (m) => '\\' + m)}%`;
    binds.push(like, like, ...held);
  }
  if (jurisdiction) {
    where.push('jurisdiction = ?');
    binds.push(jurisdiction.toUpperCase());
  }
  if (regulator) {
    where.push('UPPER(regulator) = ?');
    binds.push(regulator.toUpperCase());
  }
  if (category) {
    where.push('category = ?');
    binds.push(category);
  }
  if (since) {
    where.push('COALESCE(published_at, first_seen_at) >= ?');
    binds.push(since);
  }
  if (until) {
    where.push('COALESCE(published_at, first_seen_at) <= ?');
    binds.push(until);
  }

  // Dated records rank above undated ones, and only then by date.
  //
  // Sources that publish no date fall back to collection time so they stay
  // searchable, but that fallback is today's timestamp, which is newer than
  // every real publication date in the store. Ordering on the coalesced value
  // alone therefore floats undated material to the top of every result: a live
  // search for "market" came back five undated records deep with nothing we
  // knew the date of. The split keeps them findable without letting a
  // collection timestamp outrank a publication date.
  //
  // The date is not recovered from summary text. Those summaries carry comment
  // deadlines alongside publication dates, and a pattern that cannot tell them
  // apart would eventually stamp a record with the wrong one. A missing date
  // beats a wrong date.
  const sql = `SELECT ${CHANGE_COLUMNS} FROM changes
               ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY published_at IS NULL, COALESCE(published_at, first_seen_at) DESC
               LIMIT ?`;

  const { results } = await db
    .prepare(sql)
    .bind(...binds, Math.min(Math.max(limit || 20, 1), 100))
    .all();
  return (results || []).map(servable);
}

export async function getChange(db, id) {
  const record = await db
    .prepare(`SELECT ${CHANGE_COLUMNS}, guid, content_hash FROM changes WHERE id = ?`)
    .bind(id)
    .first();
  if (!record) return null;

  const { results } = await db
    .prepare(
      `SELECT revision, observed_at, title, summary, url
         FROM change_revisions WHERE change_id = ? ORDER BY revision ASC`
    )
    .bind(id)
    .all();

  return servable({ ...record, revisions: results || [] });
}

export async function countChanges(db) {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM changes').first();
  return row ? row.n : 0;
}

export async function lastIngestRun(db) {
  return db.prepare('SELECT * FROM ingest_runs ORDER BY started_at DESC LIMIT 1').first();
}

export async function recordIngestRun(db, run) {
  await db
    .prepare(
      `INSERT INTO ingest_runs
         (started_at, finished_at, sources_attempted, sources_ok, sources_failed,
          inserted, revised, unchanged)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      run.startedAt,
      run.finishedAt,
      run.attempted,
      run.ok,
      run.failed,
      run.inserted,
      run.revised,
      run.unchanged
    )
    .run();
}
