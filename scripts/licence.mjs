#!/usr/bin/env node
/**
 * Issue, revoke, list and bill DAP licences for Bellwether. Run on the Mac
 * that is signed in to Cloudflare, from the repo root.
 *
 *   node scripts/licence.mjs issue "Example Pension Plan" [--note "Master licence 2026-11"]
 *   node scripts/licence.mjs revoke lic_1a2b3c4d
 *   node scripts/licence.mjs list
 *   node scripts/licence.mjs usage 2026-11
 *   node scripts/licence.mjs check        live self test across Bellwether and the Compute Market Tracker
 *
 * Add --local to work on the local database instead of the live one
 * (LICENCE_PERSIST_TO names a shared local state folder, for testing two
 * Workers against one licence table).
 *
 * issue prints the new key once. It is never stored, only its SHA-256 is, so
 * it cannot be shown again: give it to the licensee over a secure channel,
 * and issue a new one (then revoke the old) if it is lost. revoke never
 * deletes: the licence stays on record, so past usage can still be billed.
 */

import { execFileSync } from 'node:child_process';
import dns from 'node:dns';
import net from 'node:net';
import { SELF_TEST_LICENSEE, issueSql, listSql, newLicence, revokeSql, usageSql } from './licence-sql.mjs';

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
    [
      'wrangler', 'd1', 'execute', 'bellwether',
      ...(local ? ['--local', ...(process.env.LICENCE_PERSIST_TO ? ['--persist-to', process.env.LICENCE_PERSIST_TO] : [])] : ['--remote']),
      '--json', '--command', sql,
    ],
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
  console.error('Usage: node scripts/licence.mjs issue "Licensee" [--note "..."] | revoke lic_xxxxxxxx | list | usage YYYY-MM | check  [--local]');
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
  } else if (command === 'check') {
    await selfTest();
  } else {
    usage();
  }
} catch (err) {
  console.error(`Stopped: ${err && err.message ? err.message : String(err)}`);
  process.exit(1);
}

/**
 * The live proof of the licence rail, run from this Mac. Issues a licence
 * named "DAP licence self test", calls the API and the MCP endpoint of
 * Bellwether and of the Compute Market Tracker (one licence covers both) with
 * its key, revokes it, and checks the key is then refused everywhere and every
 * call was counted. The key is never printed. The revoked licence and its
 * counted calls stay on record, by design, and the usage report leaves them out.
 */
async function selfTest() {
  // IPv6 from at least one dev machine cannot reach the Worker (CLAUDE.md).
  dns.setDefaultResultOrder('ipv4first');
  net.setDefaultAutoSelectFamily(false);
  // --local checks a wrangler dev Worker on the local database instead.
  const origin = local ? process.env.BELLWETHER_ORIGIN || 'http://127.0.0.1:8787' : 'https://bellwether.dap.solutions';
  const compute = local ? process.env.COMPUTE_ORIGIN || 'http://127.0.0.1:8788' : 'https://dap.solutions';
  const licence = newLicence();
  d1(issueSql({ id: licence.id, licensee: SELF_TEST_LICENSEE, keyHash: licence.keyHash, createdAt: new Date().toISOString(), note: 'scripts/licence.mjs check' }));
  const auth = { Authorization: `Bearer ${licence.key}` };
  const results = [];
  const check = (label, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` (${detail})` : ''}`);
  };
  try {
    const unpaid = await fetch(`${origin}/api/search?query=capital&limit=1`);
    check('without a key, /api/search asks for payment', unpaid.status === 402, `HTTP ${unpaid.status}`);

    const api = await fetch(`${origin}/api/search?query=capital&limit=1`, { headers: auth });
    const apiBody = api.ok ? await api.json() : null;
    check('with the key, /api/search answers without payment', api.status === 200 && apiBody && Array.isArray(apiBody.records), `HTTP ${api.status}`);

    const mcp = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'recent_regulatory_changes', arguments: { days: 7, limit: 1 } } }),
    });
    const mcpText = await mcp.text();
    check('with the key, /mcp answers a data tool', mcp.status === 200 && mcpText.includes('"result"') && !mcpText.includes('"isError":true'), `HTTP ${mcp.status}`);

    const cUnpaid = await fetch(`${compute}/compute/api/contracts?limit=1`);
    check('without a key, the Compute API asks for payment', cUnpaid.status === 402, `HTTP ${cUnpaid.status}`);

    const cApi = await fetch(`${compute}/compute/api/contracts?limit=1`, { headers: auth });
    const cApiBody = cApi.ok ? await cApi.json() : null;
    check('with the same key, the Compute API answers without payment', cApi.status === 200 && cApiBody && Array.isArray(cApiBody.contracts), `HTTP ${cApi.status}`);

    const cMcp = await fetch(`${compute}/compute/mcp`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_compute_contracts', arguments: { limit: 1 } } }),
    });
    const cMcpText = await cMcp.text();
    check('with the same key, the Compute MCP endpoint answers a data tool', cMcp.status === 200 && cMcpText.includes('"result"') && !cMcpText.includes('"isError":true'), `HTTP ${cMcp.status}`);
  } finally {
    d1(revokeSql({ id: licence.id, revokedAt: new Date().toISOString() }));
  }
  const after = await fetch(`${origin}/api/search?query=capital&limit=1`, { headers: auth });
  check('after revoking, Bellwether refuses the key', after.status === 401, `HTTP ${after.status}`);
  const cAfter = await fetch(`${compute}/compute/api/contracts?limit=1`, { headers: auth });
  check('after revoking, the Compute API refuses the key', cAfter.status === 401, `HTTP ${cAfter.status}`);

  // Each licensed answer is counted before it is released, so the counts are already there.
  const counted = d1(
    `SELECT endpoint, calls FROM licence_usage_daily WHERE licence_id = '${licence.id}' ORDER BY endpoint;`
  );
  const total = counted.reduce((n, r) => n + Number(r.calls), 0);
  const computeRows = counted.filter((r) => String(r.endpoint).startsWith('compute:')).length;
  check('all four answered calls were counted for one invoice', total === 4 && computeRows === 2, counted.map((r) => `${r.endpoint} ${r.calls}`).join(', ') || 'none');

  console.log('');
  console.log(results.every(Boolean) ? `All checks passed. Self test licence ${licence.id} is revoked and kept on record.` : 'Some checks failed. Send this output to Claude.');
  if (!results.every(Boolean)) process.exitCode = 1;
}
