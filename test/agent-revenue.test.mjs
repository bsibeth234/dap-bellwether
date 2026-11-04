/**
 * Use when descriptions, a Bazaar listing on every price, and one analytics data point per answered call.
 *
 * Spec, from Brendan's brief of 4 November 2026, written before these tests and before the code:
 *   1. Every MCP tool description opens with "Use when", then the job, then the price, in under 300
 *      characters and with no dash. The three data tools are free for 50 calls per caller each UTC day,
 *      then $0.01 USDC on Base per call via x402; list_coverage is always free. One module holds the lines
 *      (src/descriptions.js); the tool list, the price list and the OpenAPI file read it. Detail cut from a
 *      description lives in the input schema.
 *   2. The 402 of each priced API endpoint describes it with a Use when line that says
 *      "$0.01 USDC on Base per call via x402".
 *   3. Every priced API route (/api/search, /api/recent, /api/change) carries a Bazaar listing: a GET
 *      example call the endpoint answers with 402, never 400; an input schema of its query parameters as
 *      strings, field by field, required listed, enums kept, integers as a digit pattern, refusing any other
 *      parameter; and an example answer with a small schema it validates against.
 *   4. Every metered MCP tool's price carries example arguments its input schema accepts and an example
 *      answer.
 *   5. Every example is the code's own answer, written by scripts/bazaar-examples.mjs, which says where it
 *      came from and when; each is cut to its first record and is under 4000 characters of JSON.
 *   6. A listing is the same whatever the caller asked, so it carries nothing of the caller's.
 *   7. One Workers Analytics Engine data point per answered call on the API and on MCP tools/call, in the
 *      layout every DAP surface writes (src/agent-events.js, surface bellwether): the tool, the outcome
 *      (paid, licensed, free, challenged, refused, error), a one way hash of the paying wallet, its network,
 *      the rail, the amount paid, the status, and 1.
 *   8. A data point never holds the wallet address, the query or the licence key. Fuzzed.
 *   9. Without the binding nothing is written and nothing fails, and a write that throws never touches an
 *      answer.
 *  10. wrangler.toml binds AGENT_CALLS to dap_agent_calls, and the privacy statement says what a data point
 *      holds, word for word on the page and in the README.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';

import { TestD1 } from './d1-shim.mjs';
import { SOURCE, FEED } from './fixtures/test-regulator.mjs';
import worker from '../src/index.js';
import { handleApi, parseParams } from '../src/api.js';
import { handleMcp } from '../src/payments.js';
import { TOOLS } from '../src/tools.js';
import { API_ENDPOINTS, DEFAULT_FREE_CALLS_PER_DAY, METERED_TOOLS } from '../src/pricing.js';
import { describe as describeTool, describeApi } from '../src/descriptions.js';
import { OUTCOMES, payerHash, writeAgentCall } from '../src/agent-events.js';
import { openApiDocument } from '../src/openapi.js';
import { PRIVACY } from '../src/landing.js';
import { runIngest } from '../src/ingest.js';
import { issueSql, newLicence } from '../scripts/licence-sql.mjs';
import { decodeHeader, encodeHeader } from '../src/x402/codec.ts';
import EXAMPLES from '../src/bazaar-examples.json' with { type: 'json' };

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const NOW = Date.UTC(2026, 10, 4, 15, 0, 0);
const ORIGIN = 'https://bellwether.dap.solutions';
const PAY_TO = '0x' + '7a'.repeat(20);
// Mixed case, as a checksummed wallet is written: the hash must not depend on it.
const PAYER = '0x' + 'Ab12'.repeat(10);
const ALLOWANCE_KEY = 'k'.repeat(64);
const MCP_PRICE = 'Free for 50 calls per caller each UTC day, then $0.01 USDC on Base per call via x402.';
const API_PRICE = '$0.01 USDC on Base per call via x402';
const DASH = /[\u2010-\u2015-]/;
const ANALYTICS_SENTENCE =
  'Each answered call also adds one record to Cloudflare Workers Analytics Engine: the tool, the outcome, the amount paid, the time and, for a paid call, a one way hash of the paying wallet. It never holds the query, the network address, the wallet address or the licence key.';

async function seededDb() {
  const db = new TestD1();
  db.licences = new TestD1('licences.sql');
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(FEED, { status: 200 });
  try {
    await runIngest(db, { sources: [SOURCE] });
  } finally {
    globalThis.fetch = original;
  }
  return db;
}

/** An Analytics Engine dataset that keeps what it is sent. */
function analytics() {
  const points = [];
  return { points, writeDataPoint: (point) => points.push(point) };
}

function paidSettings(db, extra = {}) {
  return {
    DB: db,
    LICENCES: db.licences,
    X402_PAY_TO: PAY_TO,
    X402_NETWORKS: 'eip155:84532',
    ALLOWANCE_KEY,
    FREE_CALLS_PER_DAY: '2',
    AGENT_CALLS: analytics(),
    ...extra,
  };
}

function fakeFacilitator() {
  const seen = { verify: [], settle: [] };
  return {
    seen,
    async verify(payload) {
      seen.verify.push(payload);
      return { isValid: true, payer: payload.payload.authorization.from };
    },
    async settle(payload, requirements) {
      seen.settle.push(payload);
      return { success: true, transaction: '0x' + 'cd'.repeat(32), network: requirements.network, payer: payload.payload.authorization.from, amount: requirements.amount };
    },
    async supported() {
      return { kinds: [] };
    },
  };
}

function context() {
  return {
    jobs: [],
    waitUntil(promise) {
      this.jobs.push(promise);
    },
  };
}

async function get(env, path, { headers = {}, facilitator = fakeFacilitator() } = {}) {
  const ctx = context();
  const request = new Request(`${ORIGIN}${path}`, { headers: { 'CF-Connecting-IP': '203.0.113.7', ...headers } });
  const response = await handleApi(request, env, ctx, { facilitator, now: () => NOW });
  await Promise.all(ctx.jobs);
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { response, json };
}

function authorization(accepted, { nonce, from, validFor = 120 }) {
  const nowS = Math.floor(NOW / 1000);
  return {
    x402Version: 2,
    accepted,
    payload: {
      signature: '0x' + 'ab'.repeat(65),
      authorization: { from, to: accepted.payTo, value: accepted.amount, validAfter: String(nowS - 10), validBefore: String(nowS + validFor), nonce: '0x' + nonce.repeat(32) },
    },
  };
}

/** A signed-looking payment for the first offer of an API 402. */
function paymentHeader(response, { nonce = '22', from = PAYER, validFor } = {}) {
  const accepted = decodeHeader(response.headers.get('PAYMENT-REQUIRED')).accepts[0];
  return encodeHeader(authorization(accepted, { nonce, from, validFor }));
}

/** The same, for an MCP payment required result. */
function mcpPayment(result, { nonce = '22', from = PAYER, validFor } = {}) {
  return authorization(result.structuredContent.accepts[0], { nonce, from, validFor });
}

let nextId = 1;
async function mcp(env, name, args, { headers = {}, payment, ip = '203.0.113.9', facilitator = fakeFacilitator() } = {}) {
  const params = { name, arguments: args, ...(payment ? { _meta: { 'x402/payment': payment } } : {}) };
  const ctx = context();
  const response = await handleMcp(
    new Request(`${ORIGIN}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params }),
    }),
    env,
    ctx,
    { facilitator, now: () => NOW }
  );
  await Promise.all(ctx.jobs);
  const text = await response.text();
  return { response, json: text ? JSON.parse(text) : null };
}

async function issue(db) {
  const licence = newLicence();
  await db.licences.prepare(issueSql({ id: licence.id, licensee: 'Example Pension Plan', keyHash: licence.keyHash, createdAt: new Date(NOW).toISOString() })).run();
  return licence;
}

const rows = (dataset) => dataset.points.map((p) => [...p.blobs, ...p.doubles]);
const hashOf = (wallet) => createHash('sha256').update(`dap-payer-v1|${wallet.toLowerCase()}`).digest('hex').slice(0, 32);

// ---------------------------------------------------------------- descriptions

test('every tool description opens with Use when, then the job, then the price, under 300 characters, with no dash', () => {
  assert.deepEqual(TOOLS.map((t) => t.name).sort(), [...METERED_TOOLS, 'list_coverage'].sort());
  for (const tool of TOOLS) {
    const text = tool.description;
    assert.equal(text, describeTool(tool.name), `${tool.name} reads its line from descriptions.js`);
    assert.ok(text.startsWith('Use when '), `${tool.name} opens with Use when`);
    assert.ok(text.length < 300, `${tool.name} is ${text.length} characters`);
    assert.doesNotMatch(text, DASH, `${tool.name} has no dash`);
    assert.ok(text.split(/(?<=\.) /).length >= 3, `${tool.name}: when, then the job, then the price`);
    if (METERED_TOOLS.includes(tool.name)) assert.ok(text.endsWith(` ${MCP_PRICE}`), `${tool.name} ends with its price`);
    else assert.ok(text.endsWith(' Always free.'), `${tool.name} says it is always free`);
  }
});

test('the allowance a description names is the one the service applies', () => {
  const toml = readFileSync(join(root, 'wrangler.toml'), 'utf8');
  const setting = Number(/^FREE_CALLS_PER_DAY = "(\d+)"$/m.exec(toml)[1]);
  assert.equal(setting, DEFAULT_FREE_CALLS_PER_DAY);
  for (const name of METERED_TOOLS) assert.ok(describeTool(name).includes(`Free for ${setting} calls per caller each UTC day`), name);
});

test('the detail cut from a description is in the input schema, field by field', () => {
  for (const tool of TOOLS) {
    for (const [key, p] of Object.entries(tool.inputSchema.properties)) {
      assert.ok(p.description && p.description.length > 12, `${tool.name}.${key} says what it takes`);
    }
  }
  const field = (tool, key) => TOOLS.find((t) => t.name === tool).inputSchema.properties[key].description;
  assert.match(field('get_regulatory_change', 'id'), /from a search or recent result/);
  assert.match(field('search_regulatory_changes', 'since'), /UTC/);
  assert.match(field('search_regulatory_changes', 'until'), /UTC/);
  assert.match(field('recent_regulatory_changes', 'days'), /this week/);
});

test('each priced API endpoint describes itself in its 402 with a Use when line and the price, as the OpenAPI file does', async () => {
  const env = paidSettings(await seededDb());
  const doc = openApiDocument();
  for (const endpoint of API_ENDPOINTS) {
    const { response } = await get(env, `${endpoint.path}?${new URLSearchParams(EXAMPLES.api[endpoint.name].query)}`);
    assert.equal(response.status, 402, endpoint.path);
    const { description } = decodeHeader(response.headers.get('PAYMENT-REQUIRED')).resource;
    assert.equal(description, describeApi(endpoint.tool), `${endpoint.path} reads its line from descriptions.js`);
    assert.ok(description.startsWith('Use when '), endpoint.path);
    assert.ok(description.includes(API_PRICE), endpoint.path);
    assert.ok(description.length < 300, `${endpoint.path} is ${description.length} characters`);
    assert.doesNotMatch(description, DASH, endpoint.path);
    assert.ok(doc.paths[endpoint.path].get.description.startsWith(description), `${endpoint.path} in the OpenAPI file`);
  }
});

// ---------------------------------------------------------------- Bazaar listings

test('every priced API route carries a Bazaar listing whose example its own schema accepts, as the facilitator checks', async () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const env = paidSettings(await seededDb());
  assert.deepEqual(API_ENDPOINTS.map((e) => e.path), ['/api/search', '/api/recent', '/api/change']);
  for (const endpoint of API_ENDPOINTS) {
    const example = EXAMPLES.api[endpoint.name];
    assert.ok(example, `${endpoint.path} has an example`);
    assert.equal(parseParams(endpoint, new URLSearchParams(example.query)).error, undefined, `${endpoint.path} takes its own example call`);
    // The Bazaar probes a route with its own example call and expects the price, not a refusal.
    const { response } = await get(env, `${endpoint.path}?${new URLSearchParams(example.query)}`);
    assert.equal(response.status, 402, `${endpoint.path} answers its own example with the price`);
    const header = response.headers.get('PAYMENT-REQUIRED');
    // Node's HTTP parser refuses response headers over 16 KiB in total by default, so the price leaves room.
    assert.ok(header.length < 12000, `${endpoint.path}: the PAYMENT-REQUIRED header is ${header.length} characters`);
    const bazaar = decodeHeader(header).extensions.bazaar;
    assert.ok(ajv.validate(bazaar.schema, bazaar.info), `${endpoint.path}: ${ajv.errorsText()}`);
    assert.ok(ajv.validate(bazaar.schema.properties.input, bazaar.info.input), `${endpoint.path} input: ${ajv.errorsText()}`);
    assert.deepEqual(bazaar.info.input, { type: 'http', method: 'GET', queryParams: example.query });
    assert.deepEqual(bazaar.info.output, { type: 'json', example: example.answer });
    const answerSchema = bazaar.schema.properties.output.properties.example;
    assert.ok(ajv.validate(answerSchema, example.answer), `${endpoint.path} answer: ${ajv.errorsText()}`);
    assert.equal(ajv.validate(answerSchema, {}), false, `${endpoint.path}: the answer schema is not empty`);

    // Field by field, from the tool's own input schema.
    const tool = TOOLS.find((t) => t.name === endpoint.tool);
    const declared = bazaar.schema.properties.input.properties.queryParams;
    assert.equal(declared.additionalProperties, false, `${endpoint.path} declares its parameters`);
    assert.deepEqual(Object.keys(declared.properties).sort(), Object.keys(tool.inputSchema.properties).sort());
    assert.deepEqual(declared.required || [], tool.inputSchema.required || [], `${endpoint.path} lists what is required`);
    const withParam = (extra) => ({ ...bazaar.info, input: { ...bazaar.info.input, queryParams: { ...bazaar.info.input.queryParams, ...extra } } });
    for (const [key, p] of Object.entries(tool.inputSchema.properties)) {
      const q = declared.properties[key];
      assert.equal(q.type, 'string', `${endpoint.path} ${key} travels as a string`);
      assert.ok(q.description, `${endpoint.path} ${key} is described`);
      if (p.enum) {
        assert.deepEqual(q.enum, p.enum, `${endpoint.path} ${key} keeps its values`);
        assert.equal(ajv.validate(bazaar.schema, withParam({ [key]: 'XX' })), false, `${endpoint.path} refuses a ${key} outside its values`);
      }
      if (p.type === 'integer') {
        assert.ok(new RegExp(q.pattern, 'u').test('25'), `${endpoint.path} ${key} takes digits`);
        assert.equal(ajv.validate(bazaar.schema, withParam({ [key]: 'ten' })), false, `${endpoint.path} ${key} is a digit pattern`);
      }
    }
    if (endpoint.name === 'change') assert.equal(ajv.validate(bazaar.schema, withParam({ id: 'nothex' })), false, 'an id is 32 hexadecimal characters');
    // The check is real: an unknown parameter is refused.
    assert.equal(ajv.validate(bazaar.schema, withParam({ nope: 'x' })), false, `${endpoint.path} refuses an unknown parameter`);
  }
});

test('every metered MCP tool carries a Bazaar listing with example arguments its input schema accepts, and an example answer', async () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  // No allowance, so the first call to each tool is priced, as the Bazaar's probe is.
  const env = paidSettings(await seededDb(), { FREE_CALLS_PER_DAY: '0' });
  for (const name of METERED_TOOLS) {
    const tool = TOOLS.find((t) => t.name === name);
    const example = EXAMPLES.tools[name];
    assert.ok(example, `${name} has an example`);
    assert.ok(ajv.validate(tool.inputSchema, example.arguments), `${name} takes its example arguments: ${ajv.errorsText()}`);
    const { json } = await mcp(env, name, example.arguments);
    assert.equal(json.result.isError, true, `${name} answers its example with the price`);
    const required = json.result.structuredContent;
    assert.equal(required.accepts[0].amount, '10000');
    assert.equal(required.resource.description, tool.description, `${name} is priced with its own line`);
    const bazaar = required.extensions.bazaar;
    assert.ok(ajv.validate(bazaar.schema, bazaar.info), `${name}: ${ajv.errorsText()}`);
    assert.equal(bazaar.info.input.toolName, name);
    assert.deepEqual(bazaar.info.input.example, example.arguments);
    assert.deepEqual(bazaar.info.output, { type: 'json', example: example.answer });
    const answerSchema = bazaar.schema.properties.output.properties.example;
    assert.equal(ajv.validate(answerSchema, {}), false, `${name}: the answer schema is not empty`);
    const broken = { ...bazaar.info, input: { ...bazaar.info.input, example: { ...example.arguments, nope: 1 } } };
    assert.equal(ajv.validate(bazaar.schema, broken), false, `${name} refuses an argument the tool does not take`);
  }
  const coverage = await mcp(env, 'list_coverage', {});
  assert.equal(coverage.json.result.isError, undefined, 'list_coverage stays free');
});

test('every example is the code\'s own answer to its own call, cut to its first record, under 4000 characters', async () => {
  const db = await seededDb();
  const env = { DB: db }; // the paid tier off, as the script runs the API
  const { results } = await db.prepare('SELECT id FROM changes').all();
  const fresh = async (endpoint, query) => (await get(env, `${endpoint.path}?${new URLSearchParams(query)}`)).json;
  const keys = (o) => Object.keys(o).filter((k) => k !== 'source_notice');
  // A record as the API writes one: the fixture's, whatever day this runs.
  const sample = (await fresh(API_ENDPOINTS[0], { query: 'capital' })).records[0];
  for (const endpoint of API_ENDPOINTS) {
    const { query, answer } = EXAMPLES.api[endpoint.name];
    assert.ok(JSON.stringify(EXAMPLES.api[endpoint.name]).length < 4000, `${endpoint.path} example is small`);
    const now = await fresh(endpoint, endpoint.name === 'change' ? { id: results[0].id } : query);
    assert.deepEqual(Object.keys(answer), Object.keys(now), `${endpoint.path} answers in the code's shape`);
    assert.equal(answer.notice, now.notice);
    if (endpoint.name === 'change') {
      assert.equal(answer.record.id, query.id, 'the record is the one the example asks for');
      assert.deepEqual(keys(answer.record), keys(now.record));
      assert.equal(answer.revisions.length, 1, 'cut to its first revision');
      assert.deepEqual(Object.keys(answer.revisions[0]), Object.keys(now.revisions[0]));
    } else {
      assert.equal(answer.records.length, 1, `${endpoint.path} cut to its first record`);
      assert.ok(Number.isInteger(answer.count) && answer.count >= 1, `${endpoint.path} found something`);
      assert.deepEqual(keys(answer.records[0]), keys(sample));
      assert.equal(answer.coverage_note, now.coverage_note);
    }
  }
  // The MCP examples ask the same questions as the API examples, and answer as the tools do.
  const id = EXAMPLES.api.change.query.id;
  assert.equal(EXAMPLES.api.search.answer.records[0].id, id, 'the change example is the first record the search example found');
  for (const [name, endpoint] of [['search_regulatory_changes', 'search'], ['recent_regulatory_changes', 'recent'], ['get_regulatory_change', 'change']]) {
    const { arguments: args, answer } = EXAMPLES.tools[name];
    assert.ok(JSON.stringify(EXAMPLES.tools[name]).length < 4000, `${name} example is small`);
    assert.deepEqual(Object.fromEntries(Object.entries(args).map(([k, v]) => [k, String(v)])), EXAMPLES.api[endpoint].query, `${name} asks what /api/${endpoint} asks`);
    assert.deepEqual(Object.keys(answer), ['content']);
    assert.equal(answer.content.length, 1);
    assert.equal(answer.content[0].type, 'text');
    const text = answer.content[0].text;
    assert.equal(text.match(/^id: [0-9a-f]{32}$/gm).length, 1, `${name} cut to its first record`);
    if (name === 'get_regulatory_change') {
      assert.ok(text.includes(`id: ${id}`));
      assert.match(text, /\nFirst seen: \d{4}-\d{2}-\d{2}T/);
    } else {
      assert.match(text, /^\d+ record\(s\)/);
    }
  }
});

test('the examples file says where the examples came from and when, and that nothing in it is typed by hand', () => {
  assert.match(EXAMPLES.about, /scripts\/bazaar-examples\.mjs/);
  assert.match(EXAMPLES.about, /never edited by hand/);
  assert.ok(EXAMPLES.source && EXAMPLES.source.length > 20, 'names its source');
  assert.match(EXAMPLES.generated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(EXAMPLES.about.includes(EXAMPLES.generated_at.slice(0, 10)), 'the date is in the account');
  assert.ok(EXAMPLES.about.includes(EXAMPLES.source), 'the source is in the account');
});

test('a listing is the same whatever the caller asked, so it carries nothing of theirs', async () => {
  const env = paidSettings(await seededDb(), { FREE_CALLS_PER_DAY: '0' });
  const marker = 'zebracrossing';
  const listing = async (path) => decodeHeader((await get(env, path)).response.headers.get('PAYMENT-REQUIRED')).extensions;
  const plain = await listing('/api/search?query=capital&limit=5');
  const odd = await listing(`/api/search?query=${marker}&jurisdiction=EU&regulator=ESMA&since=2026-01&limit=3`);
  assert.deepEqual(odd, plain);
  assert.ok(!JSON.stringify(odd).includes(marker));
  assert.deepEqual(await listing(`/api/change?id=${'0'.repeat(32)}`), await listing(`/api/change?id=${'f'.repeat(32)}`));
  assert.deepEqual(await listing('/api/recent?days=3&jurisdiction=UK'), await listing('/api/recent'));

  const first = await mcp(env, 'search_regulatory_changes', { query: 'capital' });
  const second = await mcp(env, 'search_regulatory_changes', { query: marker, jurisdiction: 'UK', limit: 3 });
  const extensions = second.json.result.structuredContent.extensions;
  assert.deepEqual(extensions, first.json.result.structuredContent.extensions);
  assert.ok(!JSON.stringify(second.json).includes(marker), 'nothing the caller asked comes back before payment');
});

// ---------------------------------------------------------------- analytics

test('one data point per answered API call: challenged, paid, refused, licensed, free; the payer only as a hash', async () => {
  const db = await seededDb();
  const env = paidSettings(db);
  const first = await get(env, '/api/search?query=capital');
  const paid = await get(env, '/api/search?query=capital', { headers: { 'PAYMENT-SIGNATURE': paymentHeader(first.response) } });
  assert.equal(paid.response.status, 200);
  const missing = `/api/change?id=${'0'.repeat(32)}`;
  const m = await get(env, missing);
  assert.equal((await get(env, missing, { headers: { 'PAYMENT-SIGNATURE': paymentHeader(m.response, { nonce: '33' }) } })).response.status, 404);
  const long = await get(env, '/api/recent', { headers: { 'PAYMENT-SIGNATURE': paymentHeader(m.response, { nonce: '44', validFor: 10 * 86400 }) } });
  assert.equal(long.response.status, 402);
  const licence = await issue(db);
  assert.equal((await get(env, '/api/recent?days=365', { headers: { Authorization: `Bearer ${licence.key}` } })).response.status, 200);
  assert.equal((await get(env, '/api/search?limit=0')).response.status, 400);
  assert.equal((await get({ DB: db, AGENT_CALLS: env.AGENT_CALLS }, '/api/recent?days=365')).response.status, 200);
  assert.deepEqual(rows(env.AGENT_CALLS), [
    ['bellwether', 'search', 'challenged', '', '', 'api', 0, 402, 1],
    ['bellwether', 'search', 'paid', hashOf(PAYER), 'eip155:84532', 'api', 10000, 200, 1],
    ['bellwether', 'change', 'challenged', '', '', 'api', 0, 402, 1],
    ['bellwether', 'change', 'refused', '', '', 'api', 0, 404, 1],
    ['bellwether', 'recent', 'challenged', '', '', 'api', 0, 402, 1],
    ['bellwether', 'recent', 'licensed', '', '', 'api', 0, 200, 1],
    ['bellwether', 'search', 'refused', '', '', 'api', 0, 400, 1],
    ['bellwether', 'recent', 'free', '', '', 'api', 0, 200, 1],
  ]);
  for (const point of env.AGENT_CALLS.points) assert.deepEqual(point.indexes, ['bellwether']);
});

test('one data point per answered tools/call: free within the allowance, challenged past it, paid, refused, licensed', async () => {
  const db = await seededDb();
  const env = paidSettings(db);
  await mcp(env, 'search_regulatory_changes', { query: 'capital' });
  await mcp(env, 'list_coverage', {});
  await mcp(env, 'get_regulatory_change', { id: 'missing' });
  await mcp(env, 'recent_regulatory_changes', {});
  const challenge = (await mcp(env, 'search_regulatory_changes', { query: 'capital' })).json.result;
  const paid = await mcp(env, 'search_regulatory_changes', { query: 'capital' }, { payment: mcpPayment(challenge) });
  assert.match(paid.json.result.content[0].text, /capital adequacy/);
  const again = (await mcp(env, 'get_regulatory_change', { id: 'missing' })).json.result;
  await mcp(env, 'get_regulatory_change', { id: 'missing' }, { payment: mcpPayment(again, { nonce: '33' }) });
  await mcp(env, 'recent_regulatory_changes', {}, { payment: mcpPayment(again, { nonce: '44', validFor: 10 * 86400 }) });
  const licence = await issue(db);
  await mcp(env, 'search_regulatory_changes', { query: 'capital' }, { headers: { Authorization: `Bearer ${licence.key}` } });
  await mcp({ DB: db, AGENT_CALLS: env.AGENT_CALLS }, 'search_regulatory_changes', { query: 'capital' });
  await mcp({ DB: db, AGENT_CALLS: env.AGENT_CALLS }, 'get_regulatory_change', { id: 'missing' });
  assert.deepEqual(rows(env.AGENT_CALLS), [
    ['bellwether', 'search_regulatory_changes', 'free', '', '', 'mcp', 0, 200, 1],
    ['bellwether', 'list_coverage', 'free', '', '', 'mcp', 0, 200, 1],
    ['bellwether', 'get_regulatory_change', 'refused', '', '', 'mcp', 0, 200, 1],
    ['bellwether', 'recent_regulatory_changes', 'free', '', '', 'mcp', 0, 200, 1],
    ['bellwether', 'search_regulatory_changes', 'challenged', '', '', 'mcp', 0, 200, 1],
    ['bellwether', 'search_regulatory_changes', 'paid', hashOf(PAYER), 'eip155:84532', 'mcp', 10000, 200, 1],
    ['bellwether', 'get_regulatory_change', 'challenged', '', '', 'mcp', 0, 200, 1],
    ['bellwether', 'get_regulatory_change', 'refused', '', '', 'mcp', 0, 200, 1],
    ['bellwether', 'recent_regulatory_changes', 'challenged', '', '', 'mcp', 0, 200, 1],
    ['bellwether', 'search_regulatory_changes', 'licensed', '', '', 'mcp', 0, 200, 1],
    ['bellwether', 'search_regulatory_changes', 'free', '', '', 'mcp', 0, 200, 1],
    ['bellwether', 'get_regulatory_change', 'refused', '', '', 'mcp', 0, 200, 1],
  ]);
});

test('a free batch writes one data point per answered call in it', async () => {
  const db = await seededDb();
  const env = { DB: db, AGENT_CALLS: analytics() };
  const ctx = context();
  const response = await handleMcp(
    new Request(`${ORIGIN}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_coverage', arguments: {} } },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_regulatory_changes', arguments: { query: 'capital' } } },
        { jsonrpc: '2.0', id: 3, method: 'tools/list' },
      ]),
    }),
    env,
    ctx,
    { now: () => NOW }
  );
  await Promise.all(ctx.jobs);
  assert.equal((await response.json()).length, 3);
  assert.deepEqual(rows(env.AGENT_CALLS), [
    ['bellwether', 'list_coverage', 'free', '', '', 'mcp', 0, 200, 1],
    ['bellwether', 'search_regulatory_changes', 'free', '', '', 'mcp', 0, 200, 1],
  ]);
});

test('fuzz: no data point ever holds a wallet address, a query or a licence key', async () => {
  let seed = 4112026;
  const rand = () => ((seed = (seed * 16807) % 2147483647), seed / 2147483647);
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  const hex = (n) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(rand() * 16)]).join('');
  const db = await seededDb();
  const env = paidSettings(db, { FREE_CALLS_PER_DAY: '1' });
  const licence = await issue(db);
  const secrets = [licence.key, licence.id, licence.keyHash];
  const wallets = [];
  const asked = [];
  const paidBy = new Set();
  for (let i = 0; i < 150; i += 1) {
    const wallet = `0x${hex(40)}`.replace(/[a-f]/g, (c) => (rand() < 0.5 ? c.toUpperCase() : c));
    wallets.push(wallet);
    const marker = `zq${hex(12)}`;
    const nonce = (i + 16).toString(16).padStart(2, '0');
    const mode = pick(['unpaid', 'paid', 'licensed', 'bad', 'free']);
    const headers = mode === 'licensed' ? { Authorization: `Bearer ${licence.key}` } : {};
    if (rand() < 0.5) {
      const endpoint = pick(API_ENDPOINTS);
      const query =
        endpoint.name === 'search' ? { query: marker, ...(rand() < 0.5 ? { jurisdiction: pick(['CA', 'US', 'UK', 'EU']) } : {}) }
        : endpoint.name === 'change' ? { id: hex(32) }
        : { days: String(1 + Math.floor(rand() * 365)) };
      if (mode === 'bad') query.nope = marker;
      asked.push(...Object.values(query).filter((v) => v.length >= 8));
      const path = `${endpoint.path}?${new URLSearchParams(query)}`;
      if (mode === 'free') {
        await get({ DB: db, LICENCES: db.licences, AGENT_CALLS: env.AGENT_CALLS }, path);
        continue;
      }
      const first = await get(env, path, { headers });
      if (mode === 'paid' && first.response.status === 402) {
        const r = await get(env, path, { headers: { 'PAYMENT-SIGNATURE': paymentHeader(first.response, { nonce, from: wallet }) } });
        if (r.response.status === 200) paidBy.add(hashOf(wallet));
      }
    } else {
      const name = pick(['search_regulatory_changes', 'get_regulatory_change', 'recent_regulatory_changes', 'list_coverage']);
      const args = name === 'search_regulatory_changes' ? { query: marker } : name === 'get_regulatory_change' ? { id: marker } : name === 'recent_regulatory_changes' ? { days: 1 + Math.floor(rand() * 365) } : {};
      if (mode === 'bad') args.nope = marker;
      asked.push(marker);
      const ip = `198.51.100.${1 + Math.floor(rand() * 6)}`;
      const target = mode === 'free' ? { DB: db, AGENT_CALLS: env.AGENT_CALLS } : env;
      const first = await mcp(target, name, args, { headers, ip });
      const result = first.json && first.json.result;
      if (mode === 'paid' && result && result.isError && result.structuredContent && result.structuredContent.accepts) {
        const r = await mcp(env, name, args, { payment: mcpPayment(result, { nonce, from: wallet }), ip });
        if (r.json.result && r.json.result._meta) paidBy.add(hashOf(wallet));
      }
    }
  }
  const points = env.AGENT_CALLS.points;
  assert.ok(points.length >= 150, `${points.length} data points`);
  const written = JSON.stringify(points).toLowerCase();
  for (const wallet of wallets) assert.ok(!written.includes(wallet.slice(2).toLowerCase()), 'never a wallet address');
  for (const value of asked) assert.ok(!written.includes(value.toLowerCase()), `never the query ${value}`);
  for (const secret of secrets) assert.ok(!written.includes(secret.toLowerCase()), 'never the licence key or its id');
  const names = new Set([...API_ENDPOINTS.map((e) => e.name), ...TOOLS.map((t) => t.name)]);
  for (const p of points) {
    assert.deepEqual(p.indexes, ['bellwether']);
    assert.equal(p.blobs.length, 6);
    assert.equal(p.doubles.length, 3);
    assert.equal(p.blobs[0], 'bellwether');
    assert.ok(names.has(p.blobs[1]), `tool ${p.blobs[1]}`);
    assert.ok(OUTCOMES.includes(p.blobs[2]), `outcome ${p.blobs[2]}`);
    assert.ok(['api', 'mcp'].includes(p.blobs[5]));
    assert.equal(p.doubles[2], 1);
    if (p.blobs[2] === 'paid') {
      assert.ok(paidBy.has(p.blobs[3]), 'a paid point carries the hash of the wallet that paid');
      assert.equal(p.doubles[0], 10000);
    } else {
      assert.deepEqual([p.blobs[3], p.blobs[4], p.doubles[0]], ['', '', 0], `no payer and no revenue on a ${p.blobs[2]} call`);
    }
  }
  assert.ok(paidBy.size > 5, 'the fuzz paid');
  assert.ok(points.some((p) => p.blobs[2] === 'licensed') && points.some((p) => p.blobs[2] === 'challenged') && points.some((p) => p.blobs[2] === 'refused') && points.some((p) => p.blobs[2] === 'free'));
});

test('without the binding nothing is written and nothing fails, and a write that throws never touches an answer', async () => {
  const db = await seededDb();
  const licence = await issue(db);
  const datasets = [undefined, {}, { writeDataPoint() { throw new Error('dataset full'); } }];
  for (const [i, AGENT_CALLS] of datasets.entries()) {
    const env = paidSettings(db, { AGENT_CALLS });
    const first = await get(env, '/api/search?query=capital');
    assert.equal(first.response.status, 402);
    const paid = await get(env, '/api/search?query=capital', { headers: { 'PAYMENT-SIGNATURE': paymentHeader(first.response, { nonce: `5${i}` }) } });
    assert.equal(paid.response.status, 200);
    assert.equal(paid.json.records[0].title, 'Consultation on capital adequacy');
    const licensed = await get(env, '/api/search?query=capital', { headers: { Authorization: `Bearer ${licence.key}` } });
    assert.equal(licensed.json.count, 1);
    const free = await get({ DB: db, AGENT_CALLS }, '/api/recent?days=365');
    assert.equal(free.json.count, 1);
    const tool = await mcp({ DB: db, AGENT_CALLS }, 'search_regulatory_changes', { query: 'capital' });
    assert.match(tool.json.result.content[0].text, /capital adequacy/);
    const metered = await mcp(env, 'search_regulatory_changes', { query: 'capital' }, { ip: `192.0.2.${200 + i}` });
    assert.match(metered.json.result.content[0].text, /capital adequacy/);
    const challenge = (await mcp(paidSettings(db, { AGENT_CALLS, FREE_CALLS_PER_DAY: '0' }), 'search_regulatory_changes', { query: 'capital' })).json.result;
    const bought = await mcp(env, 'search_regulatory_changes', { query: 'capital' }, { payment: mcpPayment(challenge, { nonce: `6${i}` }) });
    assert.match(bought.json.result.content[0].text, /capital adequacy/);
    assert.equal(bought.json.result._meta['x402/payment-response'].success, true);
  }
  const call = { tool: 'search', outcome: 'paid', rail: 'api', status: 200 };
  assert.equal(writeAgentCall(undefined, call), false);
  assert.equal(writeAgentCall({ writeDataPoint() { throw new Error('full'); } }, call), false);
  assert.equal(writeAgentCall(analytics(), { ...call, outcome: 'stolen' }), false, 'only the six outcomes');
  assert.equal(writeAgentCall(analytics(), call), true);
});

test('the payer is a one way hash of the lowercased wallet, the same on every DAP surface', () => {
  assert.equal(payerHash(PAYER), hashOf(PAYER));
  assert.equal(payerHash(PAYER.toLowerCase()), hashOf(PAYER));
  assert.match(payerHash(PAYER), /^[0-9a-f]{32}$/);
  assert.equal(payerHash('0x' + '1'.repeat(39)), '');
  assert.equal(payerHash('not a wallet'), '');
  assert.equal(payerHash(undefined), '');
});

// ---------------------------------------------------------------- settings and documents

test('wrangler.toml binds AGENT_CALLS to the dataset every DAP surface writes, dap_agent_calls', () => {
  const toml = readFileSync(join(root, 'wrangler.toml'), 'utf8');
  assert.match(toml, /^\[\[analytics_engine_datasets\]\]\nbinding = "AGENT_CALLS"\ndataset = "dap_agent_calls"$/m);
});

test('the privacy statement says what a data point holds and never holds, on the page and in the README', async () => {
  const stored = PRIVACY.rows.find(([term]) => term === 'What is stored')[1];
  assert.ok(stored.includes(ANALYTICS_SENTENCE), 'in the statement');
  assert.ok(readFileSync(join(root, 'README.md'), 'utf8').includes(ANALYTICS_SENTENCE), 'in the README');
  const page = await (await worker.fetch(new Request(`${ORIGIN}/`), { DB: new TestD1() }, context())).text();
  assert.ok(page.includes(ANALYTICS_SENTENCE), 'on the page');
});

test('no file this change adds carries a dash where a dash is barred, or the barred word', () => {
  const barred = new RegExp(`\\b${'G'}${'0'}\\b`);
  for (const file of [
    'src/descriptions.js',
    'src/agent-events.js',
    'src/bazaar-examples.json',
    'scripts/bazaar-examples.mjs',
    'scripts/mutants/run.mjs',
    'test/agent-revenue.test.mjs',
    'test/fixtures/test-regulator.mjs',
  ]) {
    const text = readFileSync(join(root, file), 'utf8');
    assert.doesNotMatch(text, /[\u2013\u2014]/, file);
    assert.doesNotMatch(text, barred, file);
  }
});
