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

-- The free daily allowance. One row per caller per UTC day, while the paid
-- tier is on. caller is a keyed one-way hash of the network address, bound to
-- the day, so it cannot be reversed without the key and no two days link. The
-- address itself and the query are never written. Rows from a day that has
-- ended are deleted by the next scheduled run.
CREATE TABLE IF NOT EXISTS allowance_counts (
  day    TEXT NOT NULL,                  -- YYYY-MM-DD, UTC
  caller TEXT NOT NULL,                  -- keyed hash, see src/payments.js
  calls  INTEGER NOT NULL,
  PRIMARY KEY (day, caller)
) WITHOUT ROWID;

-- What the tools are actually used for: a daily total per tool and outcome,
-- with no caller attached. tool is an MCP tool name, or api:search,
-- api:recent or api:change for the JSON API. outcome is unmetered,
-- allowance, challenged, paid, licensed or not_charged.
CREATE TABLE IF NOT EXISTS tool_usage_daily (
  day     TEXT NOT NULL,                 -- YYYY-MM-DD, UTC
  tool    TEXT NOT NULL,
  outcome TEXT NOT NULL,
  calls   INTEGER NOT NULL,
  PRIMARY KEY (day, tool, outcome)
) WITHOUT ROWID;

-- Payment claims, while the paid tier is on. One row per paid call, held from
-- verification until the payment authorization expires (at most a day), so
-- one signed payment cannot buy two answers on two Worker instances. claim is
-- a SHA-256 of the gate's claim key; no wallet, nonce or query is readable.
CREATE TABLE IF NOT EXISTS payment_claims (
  claim      TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL            -- epoch milliseconds
) WITHOUT ROWID;

-- Licences: the institutional rail (src/licences.js). One row per licence
-- issued to an institution. The key itself is never stored, only a SHA-256 of
-- it. A licence is revoked by stamping revoked_at; rows are never deleted, so
-- every usage count can always name its licence.
CREATE TABLE IF NOT EXISTS licences (
  id         TEXT PRIMARY KEY,             -- lic_ and 8 hex characters, shown on usage reports
  licensee   TEXT NOT NULL,                -- the institution, as written on its licence
  key_hash   TEXT NOT NULL UNIQUE,         -- SHA-256 hex of the dapk_ key
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  note       TEXT
);

-- What each licence used, per UTC day and endpoint, for the invoice. Answered
-- calls to data tools and data endpoints only. No query, no address. Kept
-- for as long as invoices and audits need it.
CREATE TABLE IF NOT EXISTS licence_usage_daily (
  day        TEXT NOT NULL,                -- YYYY-MM-DD, UTC
  licence_id TEXT NOT NULL,
  endpoint   TEXT NOT NULL,                -- an MCP tool name, or api:search, api:recent, api:change
  calls      INTEGER NOT NULL,
  PRIMARY KEY (day, licence_id, endpoint)
) WITHOUT ROWID;
