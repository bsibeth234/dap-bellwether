-- DAP licences: the institutional rail (src/licences.js).
--
-- This is its own D1 database, dap-licences, bound as LICENCES by two
-- Workers: DAP Bellwether (this repo) and the Compute Market Tracker agent
-- (dap-solutions-site, workers/compute-agent). It holds only licences and
-- their counts, so the compute agent can read and count licences without any
-- access to Bellwether's records, and Bellwether without any access to the
-- tracker's. Apply with: npm run db:migrate:licences
--
-- A change to these tables is a change to both services: copy this file to
-- workers/compute-agent/test/fixtures/licences.sql in dap-solutions-site too.

-- One row per licence issued to an institution. The key itself is never
-- stored, only a SHA-256 of it. A licence is revoked by stamping revoked_at;
-- rows are never deleted, so every usage count can always name its licence.
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
-- for as long as invoices and audits need it. Bellwether counts its MCP tool
-- names and api:search, api:recent, api:change; the Compute Market Tracker
-- counts under names starting compute:.
CREATE TABLE IF NOT EXISTS licence_usage_daily (
  day        TEXT NOT NULL,                -- YYYY-MM-DD, UTC
  licence_id TEXT NOT NULL,
  endpoint   TEXT NOT NULL,
  calls      INTEGER NOT NULL,
  PRIMARY KEY (day, licence_id, endpoint)
) WITHOUT ROWID;
