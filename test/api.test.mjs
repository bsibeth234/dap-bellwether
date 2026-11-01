import test from 'node:test';
import assert from 'node:assert/strict';

import { TestD1 } from './d1-shim.mjs';
import worker from '../src/index.js';
import { handleApi, pricedByGate, resolveEndpoint, parseParams } from '../src/api.js';
import { handleMcp } from '../src/payments.js';
import { dateBound } from '../src/tools.js';
import { pricingFor, API_ENDPOINTS } from '../src/pricing.js';
import { openApiDocument } from '../src/openapi.js';
import { runIngest } from '../src/ingest.js';
import { canonicalPath } from '../src/x402/path.ts';
import { decodeHeader, encodeHeader } from '../src/x402/codec.ts';
import { issueSql, newLicence, revokeSql, usageSql, listSql } from '../scripts/licence-sql.mjs';

const NOW = Date.UTC(2026, 10, 1, 15, 0, 0);
const PAY_TO = '0x' + '7a'.repeat(20);
const ALLOWANCE_KEY = 'k'.repeat(64);
const ORIGIN = 'https://bellwether.dap.solutions';

const SOURCE = {
  id: 'test-reg-news',
  regulator: 'TESTREG',
  jurisdiction: 'CA',
  name: 'News',
  feedUrl: 'https://example.test/feed.xml',
  homepage: 'https://example.test/',
  category: 'news',
  enabled: true,
  verified: true,
};

const FEED = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
  <item>
    <title>Consultation on capital adequacy</title>
    <link>https://example.test/news/car</link>
    <description>A 90 day consultation opens today.</description>
    <pubDate>Tue, 21 Jul 2026 14:00:00 GMT</pubDate>
    <guid>car-2026</guid>
  </item>
</channel></rss>`;

async function seededDb() {
  const db = new TestD1();
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(FEED, { status: 200 });
  try {
    await runIngest(db, { sources: [SOURCE] });
  } finally {
    globalThis.fetch = original;
  }
  return db;
}

function paidSettings(db, extra = {}) {
  return { DB: db, X402_PAY_TO: PAY_TO, X402_NETWORKS: 'eip155:84532', ALLOWANCE_KEY, FREE_CALLS_PER_DAY: '2', ...extra };
}

function fakeFacilitator({ valid = true, settles = true } = {}) {
  const seen = { verify: [], settle: [] };
  return {
    seen,
    async verify(payload, requirements) {
      seen.verify.push({ payload, requirements });
      return valid ? { isValid: true, payer: payload.payload.authorization.from } : { isValid: false, invalidReason: 'insufficient_funds' };
    },
    async settle(payload, requirements) {
      seen.settle.push({ payload, requirements });
      return settles
        ? { success: true, transaction: '0x' + 'cd'.repeat(32), network: requirements.network, payer: payload.payload.authorization.from, amount: requirements.amount }
        : { success: false, errorReason: 'unexpected_settle_error', transaction: '', network: requirements.network };
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

async function get(env, path, { headers = {}, method = 'GET', facilitator = fakeFacilitator() } = {}) {
  const ctx = context();
  const request = new Request(`${ORIGIN}${path}`, { method, headers: { 'CF-Connecting-IP': '203.0.113.7', ...headers } });
  const response = await handleApi(request, env, ctx, { facilitator, now: () => NOW });
  await Promise.all(ctx.jobs);
  const text = method === 'HEAD' ? '' : await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { response, json, facilitator };
}

/** A signed-looking payment for the first offer of a 402. The fake facilitator decides validity. */
function paymentHeader(response, { nonce = '22', validFor = 120 } = {}) {
  const challenge = decodeHeader(response.headers.get('PAYMENT-REQUIRED'));
  const accepted = challenge.accepts[0];
  const nowS = Math.floor(NOW / 1000);
  return encodeHeader({
    x402Version: 2,
    accepted,
    payload: {
      signature: '0x' + 'ab'.repeat(65),
      authorization: {
        from: '0x' + '11'.repeat(20),
        to: accepted.payTo,
        value: accepted.amount,
        validAfter: String(nowS - 10),
        validBefore: String(nowS + validFor),
        nonce: '0x' + nonce.repeat(32),
      },
    },
  });
}

async function usage(db) {
  const { results } = await db.prepare('SELECT tool, outcome, calls FROM tool_usage_daily ORDER BY tool, outcome').all();
  return results.map((r) => `${r.tool} ${r.outcome} ${r.calls}`);
}

async function licenceUsage(db) {
  const { results } = await db.prepare('SELECT day, licence_id, endpoint, calls FROM licence_usage_daily ORDER BY endpoint').all();
  return results;
}

async function issue(db, licensee = 'Example Pension Plan') {
  const licence = newLicence();
  await db.prepare(issueSql({ id: licence.id, licensee, keyHash: licence.keyHash, createdAt: new Date(NOW).toISOString() })).run();
  return licence;
}

const CHANGE_ID_PATTERN = /^[0-9a-f]{32}$/;

// ---------------------------------------------------------------- routing and price

test('every priced endpoint the router resolves is on the gate price list, in every spelling', async () => {
  const pricing = pricingFor(paidSettings(new TestD1()), { facilitator: fakeFacilitator(), now: () => NOW });
  assert.equal(pricing.status, 'on');
  const spellings = [
    '/api/search',
    '/API/Search',
    '/api//search/',
    '/api/./search',
    '/api/%73earch',
    '/api/recent',
    '/api/change',
    '/API/Change/',
    '/api/search/../recent',
  ];
  for (const path of spellings) {
    const canonical = canonicalPath(path);
    const endpoint = resolveEndpoint(canonical);
    assert.ok(endpoint, `${path} resolves`);
    assert.notEqual(endpoint.name, 'coverage');
    assert.ok(pricedByGate(pricing.gate.routes, canonical), `${path} is priced by the gate`);
  }
  assert.equal(pricedByGate(pricing.gate.routes, '/api/coverage'), false);
  assert.equal(pricedByGate(pricing.gate.routes, '/api/searching'), false);
  assert.equal(resolveEndpoint('/api/searching'), null);
});

test('with the paid tier on, the first call is priced: 402 with the price and the Bazaar listing', async () => {
  const db = await seededDb();
  const { response, json, facilitator } = await get(paidSettings(db), '/api/search?query=capital&limit=5');
  assert.equal(response.status, 402);
  const challenge = decodeHeader(response.headers.get('PAYMENT-REQUIRED'));
  assert.equal(challenge.x402Version, 2);
  assert.equal(challenge.accepts[0].amount, '10000');
  assert.equal(challenge.accepts[0].payTo.toLowerCase(), PAY_TO);
  assert.equal(challenge.resource.url, `${ORIGIN}/api/search`);
  assert.equal(challenge.resource.serviceName, 'DAP Bellwether');
  const bazaar = challenge.extensions.bazaar;
  assert.equal(bazaar.info.input.method, 'GET');
  assert.deepEqual(bazaar.info.input.queryParams, { query: 'capital', limit: '5' });
  assert.ok(json.accepts, 'the body repeats the price');
  assert.match(response.headers.get('link') || '', /openapi\.json>; rel="describedby"/);
  assert.equal(facilitator.seen.verify.length, 0);
  assert.deepEqual(await usage(db), ['api:search challenged 1']);
});

test('every spelling of a priced path is priced through the Worker, never answered free', async () => {
  const db = await seededDb();
  const env = paidSettings(db, { X402_FACILITATOR_URL: 'https://x402.org/facilitator' });
  for (const path of ['/API/Search', '/api//search/', '/api/./search', '/api/%73earch', '/Api/Recent']) {
    const response = await worker.fetch(new Request(`${ORIGIN}${path}`, { headers: { 'CF-Connecting-IP': '203.0.113.9' } }), env, context());
    assert.equal(response.status, 402, path);
    const body = await response.json();
    assert.equal(body.records, undefined, `${path} carries no records`);
  }
});

test('a bad request is refused before any payment is asked for, and never charged', async () => {
  const db = await seededDb();
  const env = paidSettings(db);
  const bad = [
    '/api/search?jurisdictions=CA',
    '/api/search?limit=0',
    '/api/search?limit=101',
    '/api/search?jurisdiction=XX',
    '/api/search?since=yesterday',
    '/api/search?query=a&query=b',
    '/api/search?category=memes',
    '/api/recent?days=0',
    '/api/recent?query=capital',
    '/api/change?id=nothex',
    '/api/change',
    '/api/change?id=0123456789abcdef0123456789abcdef&x=1',
    '/api/search?since=2026-02-30',
    '/api/search?until=2026-13-01',
  ];
  for (const path of bad) {
    const { response, json, facilitator } = await get(env, path);
    assert.equal(response.status, 400, path);
    assert.equal(json.error, 'invalid_request');
    assert.equal(response.headers.get('PAYMENT-REQUIRED'), null, `${path} asks for no payment`);
    assert.equal(facilitator.seen.verify.length, 0);
  }
  assert.deepEqual(await usage(db), []);
});

test('a paid call is verified, answered as JSON, settled, and the facilitator never sees the query', async () => {
  const db = await seededDb();
  const env = paidSettings(db);
  const first = await get(env, '/api/search?query=adequacy');
  const facilitator = fakeFacilitator();
  const { response, json } = await get(env, '/api/search?query=adequacy', {
    headers: { 'PAYMENT-SIGNATURE': paymentHeader(first.response) },
    facilitator,
  });
  assert.equal(response.status, 200);
  assert.equal(json.count, 1);
  const [record] = json.records;
  assert.match(record.id, CHANGE_ID_PATTERN);
  assert.equal(record.title, 'Consultation on capital adequacy');
  assert.equal(record.jurisdiction, 'CA');
  assert.equal(record.published_at, '2026-07-21T14:00:00.000Z');
  assert.match(json.notice, /not legal or compliance advice/);
  const receipt = decodeHeader(response.headers.get('PAYMENT-RESPONSE'));
  assert.equal(receipt.success, true);
  assert.equal(facilitator.seen.verify.length, 1);
  assert.equal(facilitator.seen.settle.length, 1);
  assert.ok(!JSON.stringify(facilitator.seen.verify[0].payload).includes('adequacy'), 'the query never goes to the facilitator');
  assert.equal(facilitator.seen.verify[0].payload.resource.url, `${ORIGIN}/api/search`, 'the resource carries no query string');
  assert.match(response.headers.get('access-control-expose-headers') || '', /PAYMENT-RESPONSE/i);
  assert.deepEqual(await usage(db), ['api:search challenged 1', 'api:search paid 1']);
});

test('one payment buys one answer: the same payment again is refused', async () => {
  const db = await seededDb();
  const env = paidSettings(db);
  const first = await get(env, '/api/recent');
  const header = paymentHeader(first.response, { nonce: '33' });
  const paid = await get(env, '/api/recent', { headers: { 'PAYMENT-SIGNATURE': header } });
  assert.equal(paid.response.status, 200);
  const again = await get(env, '/api/recent', { headers: { 'PAYMENT-SIGNATURE': header } });
  assert.equal(again.response.status, 402);
  assert.equal(again.json.error, 'invalid_transaction_state');
});

test('a payment the facilitator refuses gets the price again, and nothing runs', async () => {
  const db = await seededDb();
  const env = paidSettings(db);
  const first = await get(env, '/api/search?query=capital');
  const facilitator = fakeFacilitator({ valid: false });
  const { response, json } = await get(env, '/api/search?query=capital', {
    headers: { 'PAYMENT-SIGNATURE': paymentHeader(first.response, { nonce: '44' }) },
    facilitator,
  });
  assert.equal(response.status, 402);
  assert.equal(json.records, undefined);
  assert.equal(facilitator.seen.settle.length, 0);
});

test('a record that does not exist answers 404 and is never charged', async () => {
  const db = await seededDb();
  const env = paidSettings(db);
  const path = '/api/change?id=0123456789abcdef0123456789abcdef';
  const first = await get(env, path);
  assert.equal(first.response.status, 402);
  const facilitator = fakeFacilitator();
  const { response } = await get(env, path, { headers: { 'PAYMENT-SIGNATURE': paymentHeader(first.response, { nonce: '55' }) }, facilitator });
  assert.equal(response.status, 404);
  assert.equal(facilitator.seen.settle.length, 0, 'a failed call never settles');
});

test('a record is answered in full with its revisions once paid', async () => {
  const db = await seededDb();
  const env = paidSettings(db);
  const { results } = await db.prepare('SELECT id FROM changes').all();
  const path = `/api/change?id=${results[0].id}`;
  const first = await get(env, path);
  const { response, json } = await get(env, path, { headers: { 'PAYMENT-SIGNATURE': paymentHeader(first.response, { nonce: '66' }) } });
  assert.equal(response.status, 200);
  assert.equal(json.record.id, results[0].id);
  assert.equal(json.revisions.length, 1);
});

test('a payment valid for more than an hour is refused before anything runs', async () => {
  const db = await seededDb();
  const env = paidSettings(db);
  const first = await get(env, '/api/search?query=capital');
  const facilitator = fakeFacilitator();
  const { response } = await get(env, '/api/search?query=capital', {
    headers: { 'PAYMENT-SIGNATURE': paymentHeader(first.response, { nonce: '77', validFor: 2 * 3600 }) },
    facilitator,
  });
  assert.equal(response.status, 402);
  const challenge = decodeHeader(response.headers.get('PAYMENT-REQUIRED'));
  assert.equal(challenge.error, 'invalid_exact_evm_payload_authorization_valid_before');
  assert.equal(facilitator.seen.verify.length, 0);
});

test('HEAD answers the price, OPTIONS the preflight, other methods 405, all without running', async () => {
  const db = await seededDb();
  const env = paidSettings(db);
  const head = await get(env, '/api/search', { method: 'HEAD' });
  assert.equal(head.response.status, 402);
  assert.ok(head.response.headers.get('PAYMENT-REQUIRED'));
  const preflight = await get(env, '/api/search', { method: 'OPTIONS' });
  assert.equal(preflight.response.status, 204);
  const post = await get(env, '/api/search', { method: 'POST' });
  assert.equal(post.response.status, 405);
});

test('coverage is free, and an unknown path is 404', async () => {
  const db = await seededDb();
  const env = paidSettings(db);
  const { response, json } = await get(env, '/api/coverage');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('PAYMENT-REQUIRED'), null);
  assert.equal(json.records, 1);
  assert.ok(json.feeds.length > 0);
  assert.ok(Array.isArray(json.not_monitored));
  const missing = await get(env, '/api/nothing');
  assert.equal(missing.response.status, 404);
});

test('with the paid tier off, the API answers free and counts usage only', async () => {
  const db = await seededDb();
  const { response, json } = await get({ DB: db }, '/api/search?query=capital');
  assert.equal(response.status, 200);
  assert.equal(json.count, 1);
  assert.deepEqual(await usage(db), ['api:search unmetered 1']);
});

// ---------------------------------------------------------------- licences

test('a licence key answers without payment and is counted for the invoice', async () => {
  const db = await seededDb();
  const env = paidSettings(db);
  const licence = await issue(db);
  const facilitator = fakeFacilitator();
  const bearer = await get(env, '/api/search?query=capital', { headers: { Authorization: `Bearer ${licence.key}` }, facilitator });
  assert.equal(bearer.response.status, 200);
  assert.equal(bearer.json.count, 1);
  assert.equal(bearer.response.headers.get('PAYMENT-REQUIRED'), null);
  const header = await get(env, '/api/recent', { headers: { 'X-API-Key': licence.key }, facilitator });
  assert.equal(header.response.status, 200);
  assert.equal(facilitator.seen.verify.length, 0, 'no x402 under a licence');
  const rows = await licenceUsage(db);
  assert.deepEqual(
    rows.map((r) => `${r.day} ${r.licence_id} ${r.endpoint} ${r.calls}`),
    [`2026-11-01 ${licence.id} api:recent 1`, `2026-11-01 ${licence.id} api:search 1`]
  );
  assert.deepEqual(await usage(db), ['api:recent licensed 1', 'api:search licensed 1']);
});

test('a licensed call that fails is not counted', async () => {
  const db = await seededDb();
  const env = paidSettings(db);
  const licence = await issue(db);
  const auth = { Authorization: `Bearer ${licence.key}` };
  assert.equal((await get(env, '/api/change?id=0123456789abcdef0123456789abcdef', { headers: auth })).response.status, 404);
  assert.equal((await get(env, '/api/search?limit=0', { headers: auth })).response.status, 400);
  assert.deepEqual(await licenceUsage(db), []);
});

test('an unknown, malformed or revoked DAP key is refused with 401, never answered under another rail', async () => {
  const db = await seededDb();
  const env = paidSettings(db);
  const licence = await issue(db);
  const unknown = newLicence();
  for (const key of [unknown.key, 'dapk_short', `${licence.key}x`]) {
    const { response, json } = await get(env, '/api/search?query=capital', { headers: { Authorization: `Bearer ${key}` } });
    assert.equal(response.status, 401, key.slice(0, 12));
    assert.equal(json.error, 'invalid_licence');
    assert.match(response.headers.get('WWW-Authenticate'), /error="invalid_token"/);
  }
  await db.prepare(revokeSql({ id: licence.id, revokedAt: new Date(NOW).toISOString() })).run();
  const revoked = await get(env, '/api/search?query=capital', { headers: { Authorization: `Bearer ${licence.key}` } });
  assert.equal(revoked.response.status, 401);
  assert.deepEqual(await licenceUsage(db), []);
});

test('an Authorization header that is not a DAP key is ignored: the price applies as usual', async () => {
  const db = await seededDb();
  const env = paidSettings(db);
  const { response } = await get(env, '/api/search?query=capital', { headers: { Authorization: 'Bearer some-other-token' } });
  assert.equal(response.status, 402);
});

test('a licence key on /mcp answers past the allowance, counts per licence, and strips any payment', async () => {
  const db = await seededDb();
  const env = paidSettings(db);
  const licence = await issue(db);
  const facilitator = fakeFacilitator();
  let id = 1;
  const call = async (meta) => {
    const ctx = context();
    const body = { jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name: 'search_regulatory_changes', arguments: { query: 'capital' }, ...(meta ? { _meta: meta } : {}) } };
    const response = await handleMcp(
      new Request(`${ORIGIN}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.7', Authorization: `Bearer ${licence.key}` },
        body: JSON.stringify(body),
      }),
      env,
      ctx,
      { facilitator, now: () => NOW }
    );
    await Promise.all(ctx.jobs);
    return { response, json: await response.json() };
  };
  for (let i = 0; i < 5; i += 1) {
    const { json } = await call();
    assert.equal(json.result.isError, undefined, `call ${i + 1} answered`);
    assert.match(json.result.content[0].text, /capital adequacy/);
  }
  const withPayment = await call({ 'x402/payment': { x402Version: 2 } });
  assert.equal(withPayment.json.result.isError, undefined);
  assert.equal(facilitator.seen.verify.length, 0, 'no payment is read under a licence');
  const { results } = await db.prepare('SELECT COUNT(*) AS n FROM allowance_counts').all();
  assert.equal(results[0].n, 0, 'a licensed caller uses no allowance');
  const rows = await licenceUsage(db);
  assert.deepEqual(rows.map((r) => `${r.endpoint} ${r.calls}`), ['search_regulatory_changes 6']);
});

test('an unknown DAP key on /mcp gets 401 as JSON-RPC', async () => {
  const db = await seededDb();
  const response = await handleMcp(
    new Request(`${ORIGIN}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${newLicence().key}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }),
    paidSettings(db),
    context(),
    { facilitator: fakeFacilitator(), now: () => NOW }
  );
  assert.equal(response.status, 401);
  const json = await response.json();
  assert.equal(json.jsonrpc, '2.0');
  assert.match(json.error.message, /not recognized or has been revoked/);
});

test('a licensed batch carrying a data call is refused, so every count is one answer', async () => {
  const db = await seededDb();
  const licence = await issue(db);
  const response = await handleMcp(
    new Request(`${ORIGIN}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${licence.key}` },
      body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_regulatory_changes', arguments: {} } }]),
    }),
    paidSettings(db),
    context(),
    { facilitator: fakeFacilitator(), now: () => NOW }
  );
  assert.equal(response.status, 400);
});

// ---------------------------------------------------------------- licence admin SQL

test('licence SQL quotes names, refuses anything outside its patterns, and bills by month', async () => {
  const db = new TestD1();
  const a = newLicence();
  assert.match(a.key, /^dapk_[A-Za-z0-9_-]{43}$/);
  assert.match(a.id, /^lic_[0-9a-f]{8}$/);
  await db.prepare(issueSql({ id: a.id, licensee: "O'Brien & Co. (Canada)", keyHash: a.keyHash, createdAt: '2026-11-01T00:00:00.000Z', note: 'Master licence 2026-11' })).run();
  const listed = (await db.prepare(listSql()).all()).results;
  assert.equal(listed[0].licensee, "O'Brien & Co. (Canada)");
  for (const bad of ['', 'x', "Robert'); DROP TABLE licences;--", 'Pension\u2013Plan', 'a'.repeat(81), 'Plan\nTwo']) {
    assert.throws(() => issueSql({ id: a.id, licensee: bad, keyHash: a.keyHash, createdAt: '2026-11-01T00:00:00.000Z' }), undefined, JSON.stringify(bad));
  }
  assert.throws(() => revokeSql({ id: "lic_1'; --", revokedAt: '2026-11-01T00:00:00.000Z' }));
  assert.throws(() => usageSql({ month: "2026-11' OR 1=1" }));
  await db.prepare("INSERT INTO licence_usage_daily (day, licence_id, endpoint, calls) VALUES ('2026-11-03', ?, 'api:search', 4), ('2026-12-01', ?, 'api:search', 9)").bind(a.id, a.id).run();
  const bill = (await db.prepare(usageSql({ month: '2026-11' })).all()).results;
  assert.deepEqual(bill.map((r) => `${r.licensee} ${r.endpoint} ${r.calls}`), ["O'Brien & Co. (Canada) api:search 4"]);
});

// ---------------------------------------------------------------- OpenAPI

test('the OpenAPI document matches the router, and is served', async () => {
  const doc = openApiDocument();
  assert.equal(doc.openapi, '3.1.0');
  const paths = Object.keys(doc.paths);
  assert.deepEqual(paths.sort(), ['/api/change', '/api/coverage', '/api/recent', '/api/search']);
  for (const path of paths) assert.ok(resolveEndpoint(canonicalPath(path)), `${path} is routed`);
  for (const endpoint of API_ENDPOINTS) assert.ok(doc.paths[endpoint.path], `${endpoint.path} is documented`);
  // Every documented query parameter is one the router accepts.
  for (const [path, item] of Object.entries(doc.paths)) {
    const endpoint = resolveEndpoint(canonicalPath(path));
    const sample = (p) =>
      p.schema.enum ? p.schema.enum[0] : p.schema.type === 'integer' ? '5' : p.name === 'since' || p.name === 'until' ? '2026-10-01' : p.name === 'id' ? '0123456789abcdef0123456789abcdef' : 'capital';
    const all = new URLSearchParams();
    for (const p of item.get.parameters || []) {
      if (p.in !== 'query') continue;
      all.set(p.name, sample(p));
      if (p.required) continue;
      const one = new URLSearchParams(endpoint.name === 'change' ? { id: '0123456789abcdef0123456789abcdef' } : {});
      one.set(p.name, sample(p));
      assert.ok(!parseParams(endpoint, one).error, `${path} accepts ${p.name}`);
    }
    assert.ok(!parseParams(endpoint, all).error, `${path} accepts all its documented parameters together`);
  }
  const text = JSON.stringify(doc);
  assert.ok(!/[\u2013\u2014]/.test(text), 'no en or em dash');
  const served = await worker.fetch(new Request(`${ORIGIN}/openapi.json`), { DB: new TestD1() }, context());
  assert.equal(served.status, 200);
  assert.match(served.headers.get('content-type'), /application\/json/);
  assert.equal((await served.json()).info.title, 'DAP Bellwether API');
});

test('/health says whether the licence tables are in place', async () => {
  const ready = await worker.fetch(new Request(`${ORIGIN}/health`), { DB: new TestD1() }, context());
  assert.deepEqual((await ready.json()).licences, { status: 'ready' });
});

// ---------------------------------------------------------------- review round 1

async function mcpCall(env, body, headers = {}, facilitator = fakeFacilitator()) {
  const ctx = context();
  const response = await handleMcp(
    new Request(`${ORIGIN}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.7', ...headers },
      body: JSON.stringify(body),
    }),
    env,
    ctx,
    { facilitator, now: () => NOW }
  );
  await Promise.all(ctx.jobs);
  const text = await response.text();
  return { response, json: text ? JSON.parse(text) : null };
}

test('since and until compare as times: a date covers its whole UTC day, offsets are honoured', async () => {
  const db = await seededDb(); // one record, published 2026-07-21T14:00:00.000Z
  const env = { DB: db };
  const count = async (q) => (await get(env, `/api/search?${q}`)).json.count;
  assert.equal(await count('until=2026-07-21'), 1, 'until a date includes that day');
  assert.equal(await count('since=2026-07-21'), 1, 'since a date starts that day');
  assert.equal(await count('since=2026-07-22'), 0);
  assert.equal(await count('until=2026-07-20'), 0);
  assert.equal(await count('since=2026-07-21T14:00:00Z'), 1, 'an exact instant is included');
  assert.equal(await count('since=2026-07-21T15:00:00%2B02:00'), 1, '15:00 at +02:00 is 13:00 UTC');
  assert.equal(await count('since=2026-07-21T14:00:01Z'), 0);
  assert.equal(await count('until=2026-07-21T14:00'), 1, 'a time without a zone is UTC');
  // The connector applies the same rule.
  const r = await mcpCall(env, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_regulatory_changes', arguments: { until: '2026-07-21' } } });
  assert.match(r.json.result.content[0].text, /capital adequacy/);
  const bad = await mcpCall(env, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_regulatory_changes', arguments: { since: 'yesterday' } } });
  assert.equal(bad.json.result.isError, true);
});

test('the record id never reaches the payment facilitator', async () => {
  const db = await seededDb();
  const env = paidSettings(db);
  const { results } = await db.prepare('SELECT id FROM changes').all();
  const path = `/api/change?id=${results[0].id}`;
  const first = await get(env, path);
  const facilitator = fakeFacilitator();
  const paid = await get(env, path, { headers: { 'PAYMENT-SIGNATURE': paymentHeader(first.response, { nonce: '88' }) }, facilitator });
  assert.equal(paid.response.status, 200);
  const sent = JSON.stringify([facilitator.seen.verify, facilitator.seen.settle]);
  assert.ok(!sent.includes(results[0].id), 'no record id in anything sent to the facilitator');
  assert.equal(facilitator.seen.verify[0].payload.resource.url, `${ORIGIN}/api/change`);
});

test('a DAP key in any other shape, or two different keys, is refused, never answered under another rail', async () => {
  const db = await seededDb();
  const env = paidSettings(db);
  const good = await issue(db);
  const other = await issue(db, 'Second Bank');
  const shapes = [
    { Authorization: good.key },
    { Authorization: `Token ${good.key}` },
    { Authorization: `Bearer ${good.key} x` },
    { Authorization: `Bearer ${good.key}, Bearer ${other.key}` },
    { 'X-API-Key': `Bearer ${good.key}` },
    { Authorization: `Bearer ${good.key}`, 'X-API-Key': other.key },
  ];
  for (const headers of shapes) {
    const api = await get(env, '/api/search?query=capital', { headers });
    assert.equal(api.response.status, 401, JSON.stringify(Object.keys(headers)));
    const mcp = await mcpCall(env, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_regulatory_changes', arguments: {} } }, headers);
    assert.equal(mcp.response.status, 401);
  }
  // The same key in both headers is fine.
  const both = await get(env, '/api/search?query=capital', { headers: { Authorization: `Bearer ${good.key}`, 'X-API-Key': good.key } });
  assert.equal(both.response.status, 200);
  assert.deepEqual((await licenceUsage(db)).map((r) => `${r.licence_id} ${r.calls}`), [`${good.id} 1`]);
});

test('a revoked key on /mcp gets 401', async () => {
  const db = await seededDb();
  const env = paidSettings(db);
  const licence = await issue(db);
  await db.prepare(revokeSql({ id: licence.id, revokedAt: new Date(NOW).toISOString() })).run();
  const r = await mcpCall(env, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_regulatory_changes', arguments: {} } }, { Authorization: `Bearer ${licence.key}` });
  assert.equal(r.response.status, 401);
});

test('a licensed MCP call that fails, and a licensed notification, are not counted', async () => {
  const db = await seededDb();
  const env = paidSettings(db);
  const licence = await issue(db);
  const auth = { Authorization: `Bearer ${licence.key}` };
  const failed = await mcpCall(env, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_regulatory_change', arguments: { id: 'missing' } } }, auth);
  assert.equal(failed.json.result.isError, true);
  await mcpCall(env, { jsonrpc: '2.0', method: 'tools/call', params: { name: 'search_regulatory_changes', arguments: {} } }, auth);
  assert.deepEqual(await licenceUsage(db), []);
});

test('with the paid tier off, a licence still answers, is counted, and may batch like anyone', async () => {
  const db = await seededDb();
  const env = { DB: db };
  const licence = await issue(db);
  const auth = { Authorization: `Bearer ${licence.key}` };
  const api = await get(env, '/api/recent', { headers: auth });
  assert.equal(api.response.status, 200);
  const batch = await mcpCall(
    env,
    [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_regulatory_changes', arguments: {} } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_regulatory_changes', arguments: { query: 'capital' } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_regulatory_change', arguments: { id: 'missing' } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_coverage', arguments: {} } },
    ],
    auth
  );
  assert.equal(batch.response.status, 200);
  assert.equal(batch.json.length, 4);
  assert.deepEqual(
    (await licenceUsage(db)).map((r) => `${r.endpoint} ${r.calls}`),
    ['api:recent 1', 'search_regulatory_changes 2'],
    'each answered data call in a batch is counted; the failed one and list_coverage are not'
  );
});

test('a licence key with a payment header on /api is answered under the licence, never settled', async () => {
  const db = await seededDb();
  const env = paidSettings(db);
  const licence = await issue(db);
  const first = await get(env, '/api/search?query=capital');
  const facilitator = fakeFacilitator();
  const r = await get(env, '/api/search?query=capital', {
    headers: { Authorization: `Bearer ${licence.key}`, 'PAYMENT-SIGNATURE': paymentHeader(first.response, { nonce: '99' }) },
    facilitator,
  });
  assert.equal(r.response.status, 200);
  assert.equal(r.response.headers.get('PAYMENT-RESPONSE'), null);
  assert.equal(facilitator.seen.verify.length + facilitator.seen.settle.length, 0);
});

test('with the licence tables missing, a key gets 503 and everyone else is unaffected', async () => {
  const db = await seededDb();
  db.db.exec('DROP TABLE licences');
  const env = paidSettings(db);
  const keyed = await get(env, '/api/search?query=capital', { headers: { Authorization: `Bearer ${newLicence().key}` } });
  assert.equal(keyed.response.status, 503);
  assert.equal(keyed.json.error, 'licence_check_unavailable');
  assert.equal((await get(env, '/api/search?query=capital')).response.status, 402);
  const health = await worker.fetch(new Request(`${ORIGIN}/health`), { DB: db }, context());
  assert.deepEqual((await health.json()).licences, { status: 'missing' });
});

test('a licensed answer that cannot be counted is withheld', async () => {
  const db = await seededDb();
  const env = paidSettings(db);
  const licence = await issue(db);
  db.db.exec('DROP TABLE licence_usage_daily');
  const api = await get(env, '/api/search?query=capital', { headers: { Authorization: `Bearer ${licence.key}` } });
  assert.equal(api.response.status, 503);
  assert.equal(api.json.records, undefined);
  const mcp = await mcpCall(env, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_regulatory_changes', arguments: {} } }, { Authorization: `Bearer ${licence.key}` });
  assert.equal(mcp.response.status, 503);
  assert.equal(mcp.json.result, undefined);
});

test('a store failure while answering is a 503 that charges and counts nothing', async () => {
  const db = await seededDb();
  const env = paidSettings(db);
  const licence = await issue(db);
  const { results } = await db.prepare('SELECT id FROM changes').all();
  db.db.exec('DROP TABLE change_revisions');
  const path = `/api/change?id=${results[0].id}`;
  const licensed = await get(env, path, { headers: { Authorization: `Bearer ${licence.key}` } });
  assert.equal(licensed.response.status, 503);
  assert.equal(licensed.json.error, 'service_unavailable');
  const first = await get(env, path);
  const facilitator = fakeFacilitator();
  const paid = await get(env, path, { headers: { 'PAYMENT-SIGNATURE': paymentHeader(first.response, { nonce: 'aa' }) }, facilitator });
  assert.equal(paid.response.status, 503);
  assert.equal(facilitator.seen.settle.length, 0);
  assert.deepEqual(await licenceUsage(db), []);
});

test('the usage report leaves out the self test licence', async () => {
  const db = new TestD1();
  const real = newLicence();
  const self = newLicence();
  await db.prepare(issueSql({ id: real.id, licensee: 'Example Pension Plan', keyHash: real.keyHash, createdAt: '2026-11-01T00:00:00.000Z' })).run();
  await db.prepare(issueSql({ id: self.id, licensee: 'DAP licence self test', keyHash: self.keyHash, createdAt: '2026-11-01T00:00:00.000Z' })).run();
  await db.prepare("INSERT INTO licence_usage_daily (day, licence_id, endpoint, calls) VALUES ('2026-11-02', ?, 'api:search', 3), ('2026-11-02', ?, 'api:search', 2)").bind(real.id, self.id).run();
  const bill = (await db.prepare(usageSql({ month: '2026-11' })).all()).results;
  assert.deepEqual(bill.map((r) => `${r.licensee} ${r.calls}`), ['Example Pension Plan 3']);
});

// ---------------------------------------------------------------- review round 2

test('dateBound reads the forms people and models send, and refuses impossible ones', () => {
  const cases = [
    ['2026-07-21', 'since', '2026-07-21T00:00:00.000Z'],
    ['2026-07-21', 'until', '2026-07-21T23:59:59.999Z'],
    ['2026-07', 'since', '2026-07-01T00:00:00.000Z'],
    ['2026-07', 'until', '2026-07-31T23:59:59.999Z'],
    ['2026-02', 'until', '2026-02-28T23:59:59.999Z'],
    ['2026', 'until', '2026-12-31T23:59:59.999Z'],
    ['2026-07-21T14:00:00Z', 'since', '2026-07-21T14:00:00.000Z'],
    ['2026-07-21 14:00:00', 'since', '2026-07-21T14:00:00.000Z'],
    ['2026-07-21T14:00', 'since', '2026-07-21T14:00:00.000Z'],
    ['2026-07-21T15:00:00+02:00', 'since', '2026-07-21T13:00:00.000Z'],
    ['2026-07-21T15:00:00+0200', 'since', '2026-07-21T13:00:00.000Z'],
    ['2026-07-21T14:00:00+0000', 'since', '2026-07-21T14:00:00.000Z'],
    ['2026-07-21T09:00:00-05:00', 'since', '2026-07-21T14:00:00.000Z'],
    ['2026-07-21T14:00:00.5Z', 'since', '2026-07-21T14:00:00.500Z'],
    [' 2026-07-21 ', 'since', '2026-07-21T00:00:00.000Z'],
  ];
  for (const [input, edge, want] of cases) assert.equal(dateBound(input, edge), want, `${input} ${edge}`);
  for (const bad of ['2026-02-30', '2026-13', '2026-07-21T25:00', '2026-07-21T14:60', 'yesterday', '20261001', '', '2026-07-21T14:00:00+2400']) {
    assert.equal(dateBound(bad, 'since'), null, JSON.stringify(bad));
  }
  assert.equal(dateBound(20261001, 'since'), null);
});

test('the connector answers the space separated form models send', async () => {
  const db = await seededDb();
  const r = await mcpCall({ DB: db }, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_regulatory_changes', arguments: { since: '2026-07-21 00:00:00', until: '2026-07' } } });
  assert.match(r.json.result.content[0].text, /capital adequacy/);
});

test('a DAP key with an upper case prefix is a licence attempt and is refused', async () => {
  const db = await seededDb();
  const env = paidSettings(db);
  const licence = await issue(db);
  const shouted = `DAPK_${licence.key.slice(5)}`;
  for (const headers of [{ Authorization: `Bearer ${shouted}` }, { 'X-API-Key': shouted }]) {
    assert.equal((await get(env, '/api/search?query=capital', { headers })).response.status, 401);
    const mcp = await mcpCall(env, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_regulatory_changes', arguments: {} } }, headers);
    assert.equal(mcp.response.status, 401);
  }
});
