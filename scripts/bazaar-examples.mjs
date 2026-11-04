#!/usr/bin/env node
/**
 * Writes src/bazaar-examples.json: the example call and the example answer each priced API route and each
 * metered MCP tool shows in its x402 Bazaar listing (src/pricing.js). Every answer is the code's own:
 * records are collected by the real ingest (src/ingest.js) into the test D1 shim (test/d1-shim.mjs), the
 * real API handler (src/api.js, paid tier off) and the real tools (src/tools.js) answer the example calls,
 * and each answer is cut to its first record so the listing in every 402 header stays small. Nothing in
 * the file is written by hand, and the file says where its records came from and when it was written.
 *
 *   npm run build:bazaar               the test regulator the tests use (test/fixtures/test-regulator.mjs)
 *   npm run build:bazaar -- --feeds    every enabled regulator's live feed, as the cron collects them
 *
 * The first runs anywhere. The second needs the network to reach every regulator, as
 * npm run verify:sources does, and lists real publications. Run npm test afterwards: the tests hold every
 * example to its listing's schema and to the shape of the code's answer.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestD1 } from '../test/d1-shim.mjs';
import { SOURCE, FEED } from '../test/fixtures/test-regulator.mjs';
import { runIngest } from '../src/ingest.js';
import { handleApi } from '../src/api.js';
import { callTool } from '../src/tools.js';

const here = dirname(fileURLToPath(import.meta.url));
const MAX_EXAMPLE = 4000;

// The example calls: what the Bazaar sends to check each listing is priced, and what an agent reads.
const SEARCH = { query: 'capital', limit: 5 };
const RECENT = { days: 365, limit: 5 };

const db = new TestD1();
let source;
if (process.argv.includes('--feeds')) {
  const run = await runIngest(db);
  if (run.ok === 0) throw new Error(`No feed could be collected: ${run.perSource.map((s) => `${s.source} (${s.error})`).join(', ')}`);
  const failed = run.perSource.filter((s) => !s.ok).map((s) => s.source);
  source = `the live feeds of ${run.ok} of ${run.attempted} enabled sources in src/sources.js${failed.length ? ` (not collected: ${failed.join(', ')})` : ''}, collected by src/ingest.js from ${run.startedAt}`;
} else {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(FEED, { status: 200 });
  try {
    await runIngest(db, { sources: [SOURCE] });
  } finally {
    globalThis.fetch = realFetch;
  }
  source = `the test regulator the tests ingest (test/fixtures/test-regulator.mjs: ${SOURCE.regulator}, a made up source at example.test, not a real regulator)`;
}
const env = { DB: db };

const asQuery = (args) => Object.fromEntries(Object.entries(args).map(([k, v]) => [k, String(v)]));

/** The API's answer to a call, with the paid tier off, as JSON. */
async function api(path, query) {
  const response = await handleApi(new Request(`https://bellwether.dap.solutions${path}?${new URLSearchParams(query)}`), env, { waitUntil() {} });
  const body = await response.json();
  if (response.status !== 200) throw new Error(`${path} refused its own example call: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

/** The answer with each list of records or revisions cut to its first one. */
function cut(value) {
  if (Array.isArray(value)) return value.some((v) => v && typeof v === 'object') ? value.slice(0, 1).map(cut) : value;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cut(v)]));
  return value;
}

/** A tool's answer, a list cut after its first record: the header line, then that record, which ends with its id. */
async function tool(name, args) {
  const result = await callTool(name, args, env);
  if (result.isError) throw new Error(`${name} refused its own example call: ${result.content[0].text}`);
  const text = result.content[0].text;
  const parts = text.split('\n\n');
  const end = parts.findIndex((part, i) => i > 0 && /^id: [0-9a-f]{32}$/m.test(part));
  const kept = name === 'get_regulatory_change' || end < 0 ? text : parts.slice(0, end + 1).join('\n\n');
  return { ...result, content: [{ ...result.content[0], text: kept }] };
}

const found = await api('/api/search', asQuery(SEARCH));
if (!found.records.length) throw new Error(`/api/search found nothing for ${JSON.stringify(SEARCH)} in ${source}; choose a call that finds a record.`);
// The change example is the first record the search example found.
const CALLS = {
  search: ['search_regulatory_changes', SEARCH],
  recent: ['recent_regulatory_changes', RECENT],
  change: ['get_regulatory_change', { id: found.records[0].id }],
};

const generatedAt = new Date().toISOString();
const out = {
  about: `Example calls and answers for the x402 Bazaar listings of the priced API routes and the metered MCP tools. Each answer is the code's own answer to its call, run on ${generatedAt.slice(0, 10)} over ${source}, then cut to its first record. Written by scripts/bazaar-examples.mjs; never edited by hand.`,
  source,
  generated_at: generatedAt,
  api: {},
  tools: {},
};
for (const [name, [toolName, args]] of Object.entries(CALLS)) {
  const query = asQuery(args);
  const answer = await api(`/api/${name}`, query);
  if (answer.records && answer.records.length === 0) throw new Error(`/api/${name} found nothing for ${JSON.stringify(query)}; choose a call that finds a record.`);
  out.api[name] = { query, answer: cut(answer) };
  out.tools[toolName] = { arguments: args, answer: await tool(toolName, args) };
}
for (const group of ['api', 'tools']) {
  for (const [name, entry] of Object.entries(out[group])) {
    const size = JSON.stringify(entry).length;
    if (size >= MAX_EXAMPLE) throw new Error(`${group}.${name}: the example is ${size} characters; a listing rides in every 402 header, keep it under ${MAX_EXAMPLE}.`);
  }
}

writeFileSync(join(here, '..', 'src', 'bazaar-examples.json'), `${JSON.stringify(out, null, 2)}\n`);
console.log(`Wrote ${Object.keys(out.api).length} API examples and ${Object.keys(out.tools).length} tool examples from ${source}.`);
