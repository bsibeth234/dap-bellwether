-- DAP Bellwether schema (Cloudflare D1 / SQLite)
-- Apply with:
--   npx wrangler d1 execute bellwether --file=./schema.sql --remote

CREATE TABLE IF NOT EXISTS changes (
  id            TEXT PRIMARY KEY,        -- stable across runs, derived from source + guid
  source_id     TEXT NOT NULL,
  regulator     TEXT NOT NULL,
  jurisdiction  TEXT NOT NULL,           -- CA | US | UK | EU
  category      TEXT NOT NULL,           -- rules | enforcement | guidance | news
  guid          TEXT NOT NULL,           -- the feed's own identifier, kept for tracing
  title         TEXT NOT NULL,
  url           TEXT,
  summary       TEXT,
  published_at  TEXT,                    -- ISO 8601, nullable when the feed omits it
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  revision      INTEGER NOT NULL DEFAULT 1
);

-- Query paths the tools actually use: recency, jurisdiction, regulator.
CREATE INDEX IF NOT EXISTS idx_changes_published  ON changes (published_at DESC);
CREATE INDEX IF NOT EXISTS idx_changes_first_seen ON changes (first_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_changes_juris      ON changes (jurisdiction, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_changes_regulator  ON changes (regulator, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_changes_source     ON changes (source_id);

-- Prior state. This table is the difference between detecting change and
-- displaying a list. Never truncated.
CREATE TABLE IF NOT EXISTS change_revisions (
  change_id    TEXT NOT NULL,
  revision     INTEGER NOT NULL,
  observed_at  TEXT NOT NULL,
  title        TEXT,
  summary      TEXT,
  url          TEXT,
  content_hash TEXT NOT NULL,
  PRIMARY KEY (change_id, revision)
);

CREATE TABLE IF NOT EXISTS source_health (
  source_id            TEXT PRIMARY KEY,
  last_ok_at           TEXT,
  last_error           TEXT,
  last_error_at        TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_item_count      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ingest_runs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at        TEXT NOT NULL,
  finished_at       TEXT NOT NULL,
  sources_attempted INTEGER NOT NULL,
  sources_ok        INTEGER NOT NULL,
  sources_failed    INTEGER NOT NULL,
  inserted          INTEGER NOT NULL,
  revised           INTEGER NOT NULL,
  unchanged         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ingest_runs_started ON ingest_runs (started_at DESC);
