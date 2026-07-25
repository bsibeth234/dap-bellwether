/**
 * Scheduled ingest.
 *
 * Runs on a cron trigger, not on user request. The connector never waits on a
 * regulator's website, which means a regulator being down degrades freshness
 * rather than breaking the connector in front of a user.
 */

import { parseFeed } from './feedparser.js';
import { enabledSources } from './sources.js';
import { upsertChange, recordSourceHealth, recordIngestRun } from './db.js';

const FETCH_TIMEOUT_MS = 15000;
const USER_AGENT =
  'DAP-Bellwether/1.0 (+https://dap.solutions/bellwether; regulatory change monitor)';

async function fetchFeed(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
      redirect: 'follow',
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pull every enabled source once.
 *
 * Sources are isolated: one regulator failing never aborts the run, it is
 * recorded and the rest continue. A source that fails is reported through
 * coverage rather than hidden.
 *
 * @returns {Promise<object>} run summary, also written to ingest_runs
 */
export async function runIngest(db, { sources = enabledSources(), now = new Date() } = {}) {
  const startedAt = now.toISOString();
  const summary = {
    startedAt,
    attempted: sources.length,
    ok: 0,
    failed: 0,
    inserted: 0,
    revised: 0,
    unchanged: 0,
    perSource: [],
  };

  for (const source of sources) {
    const stamp = new Date().toISOString();
    try {
      const xml = await fetchFeed(source.feedUrl);
      const items = parseFeed(xml);

      let inserted = 0;
      let revised = 0;
      let unchanged = 0;

      for (const item of items) {
        const outcome = await upsertChange(db, source, item, stamp);
        if (outcome === 'inserted') inserted += 1;
        else if (outcome === 'revised') revised += 1;
        else unchanged += 1;
      }

      await recordSourceHealth(db, source, {
        ok: true,
        itemCount: items.length,
        now: stamp,
      });

      summary.ok += 1;
      summary.inserted += inserted;
      summary.revised += revised;
      summary.unchanged += unchanged;
      summary.perSource.push({
        source: source.id,
        ok: true,
        items: items.length,
        inserted,
        revised,
        unchanged,
      });
    } catch (error) {
      await recordSourceHealth(db, source, {
        ok: false,
        error: error && error.message ? error.message : String(error),
        now: stamp,
      });
      summary.failed += 1;
      summary.perSource.push({
        source: source.id,
        ok: false,
        error: error && error.message ? error.message : String(error),
      });
    }
  }

  summary.finishedAt = new Date().toISOString();
  await recordIngestRun(db, summary);
  return summary;
}
