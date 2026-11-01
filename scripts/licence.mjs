#!/usr/bin/env node
/**
 * Issue, revoke, list and bill DAP licences for Bellwether. Run on the Mac
 * that is signed in to Cloudflare, from the repo root.
 *
 *   node scripts/licence.mjs issue "Example Pension Plan" [--note "Master licence 2026-11"]
 *   node scripts/licence.mjs revoke lic_1a2b3c4d
 *   node scripts/licence.mjs list
 *   node scripts/licence.mjs usage 2026-11
 *
 * Add --local to work on the local database instead of the live one.
 *
 * issue prints the new key once. It is never stored, only its SHA-256 is, so
 * it cannot be shown again: give it to the licensee over a secure channel,
 * and issue a new one (then revoke the old) if it is lost. revoke never
 * deletes: the licence stays on record, so past usage can still be billed.
 */

import { execFileSync } from 'node:child_process';
import { issueSql, listSql, newLicence, revokeSql, usageSql } from './licence-sql.mjs';

const args = process.argv.slice(2);
const local = args.includes('--local');
const rest = args.filter((a) => a !== '--local');
const [command, ...params] = rest;

function option(name) {
  const at = params.indexOf(name);
  return at === -1 ? undefined : params[at + 1];
}

function d1(sql) {
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'bellwether', local ? '--local' : '--remote', '--json', '--command', sql],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }
  );
  const parsed = JSON.parse(out);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!first || first.success === false) throw new Error(`D1 refused the statement: ${out.slice(0, 300)}`);
  return first.results || [];
}

function table(rows, columns) {
  if (rows.length === 0) {
    console.log('  (none)');
    return;
  }
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  const line = (cells) => '  ' + cells.map((cell, i) => String(cell ?? '').padEnd(widths[i])).join('  ');
  console.log(line(columns));
  for (const row of rows) console.log(line(columns.map((c) => row[c])));
}

function usage() {
  console.error('Usage: node scripts/licence.mjs issue "Licensee" [--note "..."] | revoke lic_xxxxxxxx | list | usage YYYY-MM  [--local]');
  process.exit(1);
}

const target = local ? 'local' : 'live';

try {
  if (command === 'issue') {
    const licensee = params[0];
    if (!licensee || licensee.startsWith('--')) usage();
    const note = option('--note');
    const licence = newLicence();
    d1(issueSql({ id: licence.id, licensee, keyHash: licence.keyHash, createdAt: new Date().toISOString(), note }));
    console.log(`Licence ${licence.id} issued to ${licensee} on the ${target} database.`);
    console.log('');
    console.log('Key, shown once and never stored. Give it to the licensee over a secure channel:');
    console.log('');
    console.log(`  ${licence.key}`);
    console.log('');
    console.log('They send it as "Authorization: Bearer <key>" (or "X-API-Key: <key>") to');
    console.log('  https://bellwether.dap.solutions/mcp  and  https://bellwether.dap.solutions/api/...');
  } else if (command === 'revoke') {
    const id = params[0];
    if (!id) usage();
    d1(revokeSql({ id, revokedAt: new Date().toISOString() }));
    const rows = d1(listSql()).filter((r) => r.id === id);
    if (rows.length === 0) throw new Error(`No licence ${id} on the ${target} database.`);
    console.log(`Licence ${id} (${rows[0].licensee}) revoked at ${rows[0].revoked_at}. Its key now answers 401.`);
  } else if (command === 'list') {
    table(d1(listSql()), ['id', 'licensee', 'created_at', 'revoked_at', 'note']);
  } else if (command === 'usage') {
    const month = params[0];
    if (!month) usage();
    const rows = d1(usageSql({ month }));
    console.log(`Answered calls per licence, ${month} (UTC days), ${target} database:`);
    table(rows, ['licence_id', 'licensee', 'endpoint', 'calls']);
    const totals = new Map();
    for (const r of rows) totals.set(r.licensee, (totals.get(r.licensee) || 0) + Number(r.calls));
    if (totals.size) {
      console.log('');
      console.log('Totals:');
      for (const [licensee, calls] of totals) console.log(`  ${licensee}: ${calls}`);
    }
  } else {
    usage();
  }
} catch (err) {
  console.error(`Stopped: ${err && err.message ? err.message : String(err)}`);
  process.exit(1);
}
