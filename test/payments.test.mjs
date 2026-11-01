import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

import { TestD1 } from './d1-shim.mjs';
import worker from '../src/index.js';
import {
  handleMcp,
  callerAddress,
  callerHash,
  callerScopes,
  classify,
  purgeAllowanceCounts,
  utcDay,
  MAX_BODY_BYTES,
} from '../src/payments.js';
import { pricingFor, METERED_TOOLS } from '../src/pricing.js';
import { PRIVACY } from '../src/landing.js';
import { purgePaymentClaims } from '../src/claims.js';
import { runIngest } from '../src/ingest.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

// 2026-11-01T15:00:00Z. Fixed, so the day, the reset time and the payment
// window are all known.
const NOW = Date.UTC(2026, 10, 1, 15, 0, 0);
const PAY_TO = '0x' + '7a'.repeat(20);
const ALLOWANCE_KEY = 'k'.repeat(64);

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

/** Settings with the paid tier on. Base Sepolia, so nothing here can touch mainnet. */
function paidSettings(db, extra = {}) {
  return {
    DB: db,
    X402_PAY_TO: PAY_TO,
    X402_NETWORKS: 'eip155:84532',
    ALLOWANCE_KEY,
    FREE_CALLS_PER_DAY: '2',
    ...extra,
  };
}

/** A facilitator that records what it was sent and answers as told. */
function fakeFacilitator({ valid = true, settles = true, pending = false } = {}) {
  const seen = { verify: [], settle: [] };
  return {
    seen,
    async verify(payload, requirements) {
      seen.verify.push({ payload, requirements });
      return valid
        ? { isValid: true, payer: payload.payload.authorization.from }
        : { isValid: false, invalidReason: 'insufficient_funds' };
    },
    async settle(payload, requirements) {
      seen.settle.push({ payload, requirements });
      if (pending) {
        return {
          success: false,
          errorReason: 'settlement_pending',
          transaction: '0x' + 'ef'.repeat(32),
          network: requirements.network,
        };
      }
      return settles
        ? {
            success: true,
            transaction: '0x' + 'cd'.repeat(32),
            network: requirements.network,
            payer: payload.payload.authorization.from,
            amount: requirements.amount,
          }
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

function request(body, { ip = '203.0.113.7', origin, raw } = {}) {
  const headers = { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip };
  if (origin) headers.Origin = origin;
  return new Request('https://bellwether.dap.solutions/mcp', {
    method: 'POST',
    headers,
    body: raw !== undefined ? raw : JSON.stringify(body),
  });
}

let nextId = 1;
function toolCall(name, args = {}, meta) {
  return {
    jsonrpc: '2.0',
    id: nextId++,
    method: 'tools/call',
    params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) },
  };
}

async function send(env, body, { facilitator = fakeFacilitator(), ctx = context(), ...opts } = {}) {
  const response = await handleMcp(request(body, opts), env, ctx, { facilitator, now: () => NOW });
  await Promise.all(ctx.jobs);
  const text = await response.text();
  return { response, json: text ? JSON.parse(text) : null };
}

async function usage(db) {
  const { results } = await db
    .prepare('SELECT tool, outcome, calls FROM tool_usage_daily ORDER BY tool, outcome')
    .all();
  return results.map((r) => `${r.tool} ${r.outcome} ${r.calls}`);
}

async function allowanceRows(db) {
  return (await db.prepare('SELECT day, caller, calls FROM allowance_counts ORDER BY caller').all()).results;
}

/** A payment for the first offer in a payment required result. */
function paymentFor(challenge, { nonce = '22' } = {}) {
  const accepted = challenge.result.structuredContent.accepts[0];
  const nowS = Math.floor(NOW / 1000);
  return {
    'x402/payment': {
      x402Version: 2,
      accepted,
      payload: {
        signature: '0x' + 'ab'.repeat(65),
        authorization: {
          from: '0x' + '11'.repeat(20),
          to: accepted.payTo,
          value: accepted.amount,
          validAfter: String(nowS - 10),
          validBefore: String(nowS + 120),
          nonce: '0x' + nonce.repeat(32),
        },
      },
    },
  };
}

// ---------------------------------------------------------------- off

test('with the paid tier off, every call is free and nothing is counted per caller', async () => {
  const db = await seededDb();
  const env = { DB: db };
  for (let i = 0; i < 5; i += 1) {
    const { json } = await send(env, toolCall('search_regulatory_changes', { query: 'capital' }));
    assert.equal(json.result.isError, undefined);
    assert.match(json.result.content[0].text, /capital adequacy/);
  }
  assert.deepEqual(await allowanceRows(db), [], 'no per caller count while the tier is off');
  assert.deepEqual(await usage(db), ['search_regulatory_changes unmetered 5']);
  assert.equal(pricingFor(env).status, 'off');
});

test('with the paid tier off, the instructions, /health and the page all say free', async () => {
  const db = await seededDb();
  const env = { DB: db };

  const init = await send(env, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.doesNotMatch(init.json.result.instructions, /USDC|x402/);

  const health = await (await worker.fetch(new Request('https://bellwether.dap.solutions/health'), env, {})).json();
  assert.deepEqual(health.payments, { status: 'off' });

  const page = await (await worker.fetch(new Request('https://bellwether.dap.solutions/'), env, {})).text();
  assert.match(page, /<h2 id="price-title">Price<\/h2>[\s\S]*?<p>Free\. Every tool, every call\. The paid tier is off\.<\/p>/);
  assert.doesNotMatch(page, /calls a day to the three data tools/);
  assert.doesNotMatch(page, /<p class="one-line">[^<]*Agents pay per call/, 'no price claim while the tier is off');
});

test('a usage count that fails never touches the answer', async () => {
  // A database with no usage table, as before the migration runs.
  const db = await seededDb();
  db.db.exec('DROP TABLE tool_usage_daily');
  const { json } = await send({ DB: db }, toolCall('search_regulatory_changes', { query: 'capital' }));
  assert.match(json.result.content[0].text, /capital adequacy/);
});

// ---------------------------------------------------------------- misconfigured

test('a paid tier with a missing setting stays off, says why, and answers free', async () => {
  const db = await seededDb();
  for (const [missing, pattern] of [
    ['ALLOWANCE_KEY', /ALLOWANCE_KEY/],
    ['X402_NETWORKS', /CDP/], // mainnet by default once networks is left to wrangler.toml
  ]) {
    const env = paidSettings(db, { [missing]: undefined, ...(missing === 'X402_NETWORKS' ? { X402_NETWORKS: 'eip155:8453' } : {}) });
    const state = pricingFor(env);
    assert.equal(state.status, 'misconfigured');
    assert.match(state.reason, pattern);

    for (let i = 0; i < 4; i += 1) {
      const { json } = await send(env, toolCall('search_regulatory_changes', { query: 'capital' }));
      assert.equal(json.result.isError, undefined, 'a bad setting must never cost a light user an answer');
    }
    const health = await (await worker.fetch(new Request('https://bellwether.dap.solutions/health'), env, {})).json();
    assert.equal(health.payments.status, 'misconfigured');
    assert.ok(!JSON.stringify(health).includes(PAY_TO), '/health must not show the wallet');
  }
  assert.deepEqual(await allowanceRows(db), []);
});

test('a free allowance that is not a whole number is a bad setting', async () => {
  const state = pricingFor(paidSettings(null, { FREE_CALLS_PER_DAY: 'fifty' }));
  assert.equal(state.status, 'misconfigured');
  assert.match(state.reason, /FREE_CALLS_PER_DAY/);
});

// ---------------------------------------------------------------- on

test('the allowance is free, then a metered call answers with the price', async () => {
  const db = await seededDb();
  const env = paidSettings(db);

  for (let i = 0; i < 2; i += 1) {
    const { json } = await send(env, toolCall('search_regulatory_changes', { query: 'capital' }));
    assert.equal(json.result.isError, undefined, `call ${i + 1} is within the allowance`);
    assert.match(json.result.content[0].text, /capital adequacy/);
  }

  const { response, json } = await send(env, toolCall('search_regulatory_changes', { query: 'capital' }));
  assert.equal(response.status, 200, 'a payment required result is a JSON-RPC result, not an HTTP error');
  assert.equal(json.result.isError, true);
  const required = json.result.structuredContent;
  assert.equal(required.x402Version, 2);
  assert.equal(required.accepts.length, 1);
  assert.equal(required.accepts[0].amount, '10000', 'one cent in USDC, six decimals');
  assert.equal(required.accepts[0].network, 'eip155:84532');
  assert.equal(required.accepts[0].payTo.toLowerCase(), PAY_TO);
  assert.equal(required.resource.serviceName, 'DAP Bellwether');
  assert.deepEqual(JSON.parse(json.result.content[0].text), required, 'the x402 body comes first and whole');
  assert.match(json.result.content[1].text, /free allowance of 2 calls a day/);
  assert.match(json.result.content[1].text, /\$0\.01 in USDC on Base Sepolia/);
  assert.match(json.result.content[1].text, /resets at 2026-11-02T00:00:00\.000Z/);
  assert.doesNotMatch(json.result.content[1].text, /[\u2013\u2014]/);

  assert.deepEqual(await usage(db), [
    'search_regulatory_changes allowance 2',
    'search_regulatory_changes challenged 1',
  ]);
});

test('every metered tool draws on one allowance, and list_coverage is never counted', async () => {
  const db = await seededDb();
  const env = paidSettings(db);

  for (let i = 0; i < 5; i += 1) {
    const { json } = await send(env, toolCall('list_coverage'));
    assert.equal(json.result.isError, undefined);
  }
  assert.deepEqual(await allowanceRows(db), [], 'list_coverage is not counted per caller');

  await send(env, toolCall('recent_regulatory_changes'));
  const found = (await send(env, toolCall('search_regulatory_changes', { query: 'capital' }))).json;
  const id = /id: (\S+)/.exec(found.result.content[0].text)[1];
  const { json } = await send(env, toolCall('get_regulatory_change', { id }));
  assert.equal(json.result.isError, true, 'the third metered call of any kind is past the allowance');
  assert.equal(json.result.structuredContent.x402Version, 2);
  assert.deepEqual(METERED_TOOLS.slice().sort(), [
    'get_regulatory_change',
    'recent_regulatory_changes',
    'search_regulatory_changes',
  ]);
});

test('protocol messages stay free and uncounted while the tier is on', async () => {
  const db = await seededDb();
  const env = paidSettings(db);
  for (const method of ['initialize', 'tools/list', 'ping']) {
    for (let i = 0; i < 4; i += 1) {
      const { json } = await send(env, { jsonrpc: '2.0', id: 9, method, params: {} });
      assert.ok(json.result, `${method} answers`);
    }
  }
  assert.deepEqual(await allowanceRows(db), []);
});

test('the instructions tell an agent the allowance and the price before it meets them', async () => {
  const db = await seededDb();
  const { json } = await send(paidSettings(db), { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const text = json.result.instructions;
  assert.match(text, /not legal or compliance advice/);
  assert.match(text, /search_regulatory_changes, recent_regulatory_changes and get_regulatory_change are free for 2 calls per caller each UTC day/);
  assert.match(text, /\$0\.01 in USDC on Base Sepolia, paid per call with x402/);
  assert.match(text, /list_coverage is always free/);
  assert.doesNotMatch(text, /[\u2013\u2014]/);
});

test('each address has its own allowance, and an IPv6 /64 is one address', async () => {
  const db = await seededDb();
  const env = paidSettings(db);
  const search = () => toolCall('search_regulatory_changes', { query: 'capital' });

  for (let i = 0; i < 2; i += 1) await send(env, search(), { ip: '198.51.100.1' });
  assert.equal((await send(env, search(), { ip: '198.51.100.1' })).json.result.isError, true);
  assert.equal((await send(env, search(), { ip: '198.51.100.2' })).json.result.isError, undefined, 'another address is untouched');

  await send(env, search(), { ip: '2001:db8:1:2::1' });
  await send(env, search(), { ip: '2001:db8:1:2:aaaa:bbbb:cccc:dddd' });
  const sameSlash64 = await send(env, search(), { ip: '2001:0db8:0001:0002:ffff::9' });
  assert.equal(sameSlash64.json.result.isError, true, 'hosts in one /64 share an allowance');
  const otherSlash64 = await send(env, search(), { ip: '2001:db8:1:3::1' });
  assert.equal(otherSlash64.json.result.isError, undefined);
});

test('the stored caller is a keyed hash bound to the day, never the address', async () => {
  const db = await seededDb();
  const env = paidSettings(db);
  await send(env, toolCall('search_regulatory_changes', { query: 'capital' }), { ip: '192.0.2.44' });

  const rows = await allowanceRows(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].day, '2026-11-01');
  assert.match(rows[0].caller, /^[0-9a-f]{32}$/);
  assert.ok(!rows[0].caller.includes('192'), 'the address is never written');
  const dump = JSON.stringify((await db.prepare('SELECT * FROM tool_usage_daily').all()).results);
  assert.ok(!dump.includes('192.0.2.44') && !dump.includes('capital'), 'usage holds no caller and no query');

  const today = await callerHash(ALLOWANCE_KEY, '2026-11-01', '192.0.2.44');
  const tomorrow = await callerHash(ALLOWANCE_KEY, '2026-11-02', '192.0.2.44');
  const otherKey = await callerHash('x'.repeat(64), '2026-11-01', '192.0.2.44');
  assert.equal(rows[0].caller, today);
  assert.notEqual(today, tomorrow, 'two days of one caller do not link');
  assert.notEqual(today, otherKey, 'without the key the hash cannot be recomputed');
});

test('a paid call is verified, answered, settled, then released with the receipt', async () => {
  const db = await seededDb();
  const env = paidSettings(db);
  for (let i = 0; i < 2; i += 1) await send(env, toolCall('search_regulatory_changes', { query: 'capital' }));
  const challenge = (await send(env, toolCall('search_regulatory_changes', { query: 'capital' }))).json;

  const facilitator = fakeFacilitator();
  const { json } = await send(
    env,
    toolCall('search_regulatory_changes', { query: 'capital' }, paymentFor(challenge)),
    { facilitator }
  );
  assert.equal(json.result.isError, undefined);
  assert.match(json.result.content[0].text, /capital adequacy/);
  const receipt = json.result._meta['x402/payment-response'];
  assert.equal(receipt.success, true);
  assert.equal(receipt.transaction, '0x' + 'cd'.repeat(32));

  assert.equal(facilitator.seen.verify.length, 1);
  assert.equal(facilitator.seen.settle.length, 1);
  const sent = JSON.stringify(facilitator.seen.verify[0].payload);
  assert.ok(!sent.includes('capital'), 'the facilitator never sees the query');
  assert.equal(facilitator.seen.settle[0].requirements.amount, '10000');

  assert.deepEqual(await usage(db), [
    'search_regulatory_changes allowance 2',
    'search_regulatory_changes challenged 1',
    'search_regulatory_changes paid 1',
  ]);
});

test('a paid call that fails is not charged', async () => {
  const db = await seededDb();
  const env = paidSettings(db);
  for (let i = 0; i < 2; i += 1) await send(env, toolCall('search_regulatory_changes', { query: 'capital' }));
  const challenge = (await send(env, toolCall('get_regulatory_change', { id: 'missing' }))).json;

  const facilitator = fakeFacilitator();
  const { json } = await send(
    env,
    toolCall('get_regulatory_change', { id: 'missing' }, paymentFor(challenge, { nonce: '33' })),
    { facilitator }
  );
  assert.equal(json.result.isError, true);
  assert.match(json.result.content[0].text, /No record with id missing/);
  assert.equal(facilitator.seen.settle.length, 0, 'a failed call never settles');
  assert.ok((await usage(db)).includes('get_regulatory_change not_charged 1'));
});

test('a payment the facilitator refuses gets the price again, and the tool never runs', async () => {
  const db = await seededDb();
  const env = paidSettings(db);
  for (let i = 0; i < 2; i += 1) await send(env, toolCall('search_regulatory_changes', { query: 'capital' }));
  const challenge = (await send(env, toolCall('search_regulatory_changes', { query: 'capital' }))).json;

  const facilitator = fakeFacilitator({ valid: false });
  const { json } = await send(
    env,
    toolCall('search_regulatory_changes', { query: 'capital' }, paymentFor(challenge, { nonce: '44' })),
    { facilitator }
  );
  assert.equal(json.result.isError, true);
  assert.equal(json.result.structuredContent.error, 'insufficient_funds');
  assert.ok(!JSON.stringify(json).includes('capital adequacy'), 'no answer without payment');
  assert.equal(facilitator.seen.settle.length, 0);
});

test('a settlement that fails releases no answer', async () => {
  const db = await seededDb();
  const env = paidSettings(db);
  for (let i = 0; i < 2; i += 1) await send(env, toolCall('search_regulatory_changes', { query: 'capital' }));
  const challenge = (await send(env, toolCall('search_regulatory_changes', { query: 'capital' }))).json;

  const { json } = await send(
    env,
    toolCall('search_regulatory_changes', { query: 'capital' }, paymentFor(challenge, { nonce: '55' })),
    { facilitator: fakeFacilitator({ settles: false }) }
  );
  assert.equal(json.result.isError, true);
  assert.ok(!JSON.stringify(json).includes('capital adequacy'));
});

test('a metered call inside a batch is refused while the tier is on; other batches pass', async () => {
  const db = await seededDb();
  const env = paidSettings(db);

  const refused = await send(env, [
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    toolCall('search_regulatory_changes', { query: 'capital' }),
  ]);
  assert.equal(refused.response.status, 400);
  assert.equal(refused.json.error.code, -32600);

  const allowed = await send(env, [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }, toolCall('list_coverage')]);
  assert.equal(allowed.response.status, 200);
  assert.equal(allowed.json.length, 2);
  assert.deepEqual(await allowanceRows(db), []);
});

test('a tool call a lenient reader might still run is refused, not answered free', async () => {
  const db = await seededDb();
  const env = paidSettings(db);
  for (let i = 0; i < 2; i += 1) await send(env, toolCall('search_regulatory_changes', { query: 'capital' }));

  const odd = await send(env, {
    jsonrpc: '2.0',
    id: 7,
    method: 'Tools/Call',
    params: { name: 'search_regulatory_changes', arguments: { query: 'capital' } },
  });
  assert.ok(odd.json.error, 'refused with a JSON-RPC error');
  assert.ok(!JSON.stringify(odd.json).includes('capital adequacy'));

  const folded = await send(env, toolCall('SEARCH_regulatory_changes', { query: 'capital' }));
  assert.ok(!JSON.stringify(folded.json).includes('capital adequacy'), 'a case variant is metered too');
});

test('a count that cannot be kept answers free rather than refusing', async () => {
  const db = await seededDb();
  db.db.exec('DROP TABLE allowance_counts');
  const { json } = await send(paidSettings(db), toolCall('search_regulatory_changes', { query: 'capital' }));
  assert.equal(json.result.isError, undefined);
  assert.match(json.result.content[0].text, /capital adequacy/);
});

test('an oversized body is refused before it is read in full', async () => {
  const db = await seededDb();
  const big = JSON.stringify(toolCall('search_regulatory_changes', { query: 'x'.repeat(MAX_BODY_BYTES) }));
  const { response, json } = await send(paidSettings(db), null, { raw: big });
  assert.equal(response.status, 413);
  assert.equal(json.error.code, -32600);
});

test('a refused origin is refused before anything is counted', async () => {
  const db = await seededDb();
  const response = await handleMcp(
    request(toolCall('search_regulatory_changes', { query: 'capital' }), { origin: 'https://evil.example' }),
    paidSettings(db),
    context(),
    { facilitator: fakeFacilitator(), now: () => NOW }
  );
  assert.equal(response.status, 403);
  assert.deepEqual(await allowanceRows(db), []);
});

test('/health and the page state the price while the tier is on, and nothing secret', async () => {
  const db = await seededDb();
  const env = paidSettings(db);

  const health = await (await worker.fetch(new Request('https://bellwether.dap.solutions/health'), env, {})).json();
  assert.equal(health.payments.status, 'on');
  assert.equal(health.payments.freeCallsPerDay, 2);
  assert.equal(health.payments.price, '$0.01');
  assert.equal(health.payments.network, 'eip155:84532');
  const text = JSON.stringify(health);
  assert.ok(!text.includes(PAY_TO) && !text.includes(ALLOWANCE_KEY), '/health shows no wallet and no key');

  const page = await (await worker.fetch(new Request('https://bellwether.dap.solutions/'), env, {})).text();
  assert.match(page, /Free for people: 2 calls a day from any one address to the three data tools/);
  assert.match(page, /Agents pay per call past that: \$0\.01 in USDC on Base Sepolia/);
  assert.match(page, /<title>DAP Bellwether, a regulatory change feed<\/title>/);
  assert.match(page, /<p class="one-line">Free for people\. Agents pay per call\.<\/p>/);
  assert.doesNotMatch(page, /a free regulatory change feed/i, 'no free claim while agents pay');
  assert.ok(page.includes('<a href="https://dap.solutions/solutions/systems/agent-payments/">DAP Agent Payments</a>'));
  assert.ok(!page.includes(PAY_TO));
});

test('a body no reader agrees on is a parse error, never an answer', async () => {
  // Two byte order marks: one decoder strips the first and JSON.parse refuses
  // the second, while a reader that strips one more would run the call.
  const db = await seededDb();
  const call = JSON.stringify(toolCall('search_regulatory_changes', { query: 'capital' }));
  const raw = new Uint8Array([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, ...new TextEncoder().encode(call)]);
  for (const env of [paidSettings(db), { DB: db }]) {
    const { response, json } = await send(env, null, { raw });
    assert.equal(response.status, 400);
    assert.equal(json.error.code, -32700);
    assert.ok(!JSON.stringify(json).includes('capital adequacy'));
  }
});

test('every /64 in one IPv6 /48 shares a ceiling of ten allowances', async () => {
  const db = await seededDb();
  const env = paidSettings(db);
  const search = () => toolCall('search_regulatory_changes', { query: 'capital' });
  const answered = [];
  for (let block = 0; block < 21; block += 1) {
    const { json } = await send(env, search(), { ip: `2001:db8:ab:${block.toString(16)}::1` });
    answered.push(json.result.isError === undefined);
  }
  assert.deepEqual(answered.slice(0, 20), Array(20).fill(true), 'twenty /64s each get a first call free');
  assert.equal(answered[20], false, 'the /48 ceiling is ten allowances of two');
  const elsewhere = await send(env, search(), { ip: '2001:db8:ac:0::1' });
  assert.equal(elsewhere.json.result.isError, undefined, 'another /48 is untouched');
});

test('callerScopes holds IPv4 to the address and IPv6 to its /64 and its /48', () => {
  const at = (ip) => callerScopes(new Request('https://x.test/', { headers: { 'CF-Connecting-IP': ip } }), 50);
  assert.deepEqual(at('203.0.113.9'), [{ address: '203.0.113.9', limit: 50 }]);
  assert.deepEqual(at('2001:db8:1:2::9'), [
    { address: '2001:0db8:0001:0002::/64', limit: 50 },
    { address: '2001:0db8:0001::/48', limit: 500 },
  ]);
});

test('a call that fails, or a notification, does not use up the allowance', async () => {
  const db = await seededDb();
  const env = paidSettings(db);
  for (let i = 0; i < 3; i += 1) {
    const { json } = await send(env, toolCall('get_regulatory_change', { id: 'missing' }));
    assert.equal(json.result.isError, true);
    assert.match(json.result.content[0].text, /No record with id missing/, 'answered, not priced');
  }
  const note = await send(env, { jsonrpc: '2.0', method: 'tools/call', params: { name: 'search_regulatory_changes', arguments: {} } });
  assert.equal(note.response.status, 202);
  for (let i = 0; i < 2; i += 1) {
    const { json } = await send(env, toolCall('search_regulatory_changes', { query: 'capital' }));
    assert.equal(json.result.isError, undefined, 'the allowance is still whole');
  }
  const { json } = await send(env, toolCall('search_regulatory_changes', { query: 'capital' }));
  assert.equal(json.result.isError, true);
  assert.ok((await usage(db)).includes('get_regulatory_change not_charged 3'));
});

test('a transfer reported sent but not yet confirmed releases the answer', async () => {
  const db = await seededDb();
  const env = paidSettings(db);
  for (let i = 0; i < 2; i += 1) await send(env, toolCall('search_regulatory_changes', { query: 'capital' }));
  const challenge = (await send(env, toolCall('search_regulatory_changes', { query: 'capital' }))).json;

  const { json } = await send(
    env,
    toolCall('search_regulatory_changes', { query: 'capital' }, paymentFor(challenge, { nonce: '66' })),
    { facilitator: fakeFacilitator({ pending: true }) }
  );
  assert.equal(json.result.isError, undefined, 'a payer is never charged with nothing to show for it');
  assert.match(json.result.content[0].text, /capital adequacy/);
  assert.equal(json.result._meta['x402/payment-response'].errorReason, 'settlement_pending');
  assert.ok((await usage(db)).includes('search_regulatory_changes paid 1'));
});

test('one payment buys one answer, across Worker instances', async () => {
  // Each send builds a fresh gate, as a second Worker instance would. The
  // claim is held in D1, so the second presentation is refused.
  const db = await seededDb();
  const env = paidSettings(db);
  for (let i = 0; i < 2; i += 1) await send(env, toolCall('search_regulatory_changes', { query: 'capital' }));
  const challenge = (await send(env, toolCall('search_regulatory_changes', { query: 'capital' }))).json;
  const payment = paymentFor(challenge, { nonce: '77' });

  const first = await send(env, toolCall('search_regulatory_changes', { query: 'capital' }, payment), {
    facilitator: fakeFacilitator({ pending: true }),
  });
  assert.match(first.json.result.content[0].text, /capital adequacy/);

  const facilitator = fakeFacilitator();
  const second = await send(env, toolCall('search_regulatory_changes', { query: 'capital' }, payment), { facilitator });
  assert.equal(second.json.result.isError, true);
  assert.equal(second.json.result.structuredContent.error, 'invalid_transaction_state');
  assert.equal(facilitator.seen.verify.length, 0, 'refused before the facilitator is asked');

  const { results } = await db.prepare('SELECT claim, expires_at FROM payment_claims').all();
  assert.equal(results.length, 1);
  assert.match(results[0].claim, /^[0-9a-f]{64}$/, 'only a hash of the claim is kept');
});

test('a payment whose claim cannot be kept is refused, and nothing runs', async () => {
  const db = await seededDb();
  const env = paidSettings(db);
  for (let i = 0; i < 2; i += 1) await send(env, toolCall('search_regulatory_changes', { query: 'capital' }));
  const challenge = (await send(env, toolCall('search_regulatory_changes', { query: 'capital' }))).json;
  db.db.exec('DROP TABLE payment_claims');

  const facilitator = fakeFacilitator();
  const { response, json } = await send(
    env,
    toolCall('search_regulatory_changes', { query: 'capital' }, paymentFor(challenge, { nonce: '88' })),
    { facilitator }
  );
  assert.equal(response.status, 503);
  assert.equal(json.error.code, -32603);
  assert.ok(!JSON.stringify(json).includes('capital adequacy'));
  assert.equal(facilitator.seen.verify.length + facilitator.seen.settle.length, 0);
});

test('/health reports degraded when the tier is on before its tables exist', async () => {
  const db = await seededDb();
  db.db.exec('DROP TABLE allowance_counts');
  const health = await (await worker.fetch(new Request('https://bellwether.dap.solutions/health'), paidSettings(db), {})).json();
  assert.equal(health.payments.status, 'degraded');
  assert.match(health.payments.reason, /db:migrate/);
});

test('with the tier off, a large body is answered as before', async () => {
  const db = await seededDb();
  const big = JSON.stringify(toolCall('search_regulatory_changes', { query: 'capital', since: '2000-01-01' + ' '.repeat(MAX_BODY_BYTES) }));
  const { response } = await send({ DB: db }, null, { raw: big });
  assert.equal(response.status, 200);
});

test('a caller asked to pay gives its count back, so it cannot lock out its /48', async () => {
  const db = await seededDb();
  const env = paidSettings(db);
  const search = () => toolCall('search_regulatory_changes', { query: 'capital' });
  for (let i = 0; i < 25; i += 1) await send(env, search(), { ip: '2001:db8:99:1::5' });
  const neighbour = await send(env, search(), { ip: '2001:db8:99:2::7' });
  assert.equal(neighbour.json.result.isError, undefined, 'a neighbouring /64 still has its allowance');
  const { results } = await db.prepare('SELECT calls FROM allowance_counts ORDER BY calls DESC').all();
  assert.deepEqual(results.map((r) => r.calls), [3, 2, 1], 'only answered calls are counted');
});

test('a payment that stays valid longer than an hour is refused before anything runs', async () => {
  const db = await seededDb();
  const env = paidSettings(db);
  for (let i = 0; i < 2; i += 1) await send(env, toolCall('search_regulatory_changes', { query: 'capital' }));
  const challenge = (await send(env, toolCall('search_regulatory_changes', { query: 'capital' }))).json;
  const payment = paymentFor(challenge, { nonce: '99' });
  payment['x402/payment'].payload.authorization.validBefore = String(Math.floor(NOW / 1000) + 10 * 86400);

  const facilitator = fakeFacilitator();
  const { json } = await send(env, toolCall('search_regulatory_changes', { query: 'capital' }, payment), { facilitator });
  assert.equal(json.result.isError, true);
  assert.equal(json.result.structuredContent.error, 'invalid_exact_evm_payload_authorization_valid_before');
  assert.deepEqual(JSON.parse(json.result.content[0].text), json.result.structuredContent);
  assert.equal(facilitator.seen.verify.length, 0);
  assert.ok(!JSON.stringify(json).includes('capital adequacy'));
});

test('a claim is a keyed hash, which cannot be matched to the transfer without the key', async () => {
  const db = await seededDb();
  const env = paidSettings(db);
  for (let i = 0; i < 2; i += 1) await send(env, toolCall('search_regulatory_changes', { query: 'capital' }));
  const challenge = (await send(env, toolCall('search_regulatory_changes', { query: 'capital' }))).json;
  const payment = paymentFor(challenge, { nonce: 'aa' });
  await send(env, toolCall('search_regulatory_changes', { query: 'capital' }, payment));

  const auth = payment['x402/payment'].payload.authorization;
  const accepted = payment['x402/payment'].accepted;
  const plain = createHash('sha256')
    .update(`${accepted.network}|${accepted.asset}|${auth.from}|${auth.nonce}`.toLowerCase())
    .digest('hex');
  const { results } = await db.prepare('SELECT claim FROM payment_claims').all();
  assert.equal(results.length, 1);
  assert.notEqual(results[0].claim, plain, 'not a plain hash of what the chain shows');
});

test('a claim that cannot be released leaves the gate its own answer', async () => {
  // The settlement times out, then the release fails: the caller must still
  // get the gate's advice to resend the same payment, not a different error.
  const db = await seededDb();
  const env = paidSettings(db);
  for (let i = 0; i < 2; i += 1) await send(env, toolCall('search_regulatory_changes', { query: 'capital' }));
  const challenge = (await send(env, toolCall('search_regulatory_changes', { query: 'capital' }))).json;

  const { FacilitatorError } = await import('../src/x402/facilitator.ts');
  const facilitator = fakeFacilitator();
  facilitator.settle = async () => {
    db.db.exec('DROP TABLE payment_claims');
    throw new FacilitatorError('settle', 'timed out');
  };
  const { response, json } = await send(
    env,
    toolCall('search_regulatory_changes', { query: 'capital' }, paymentFor(challenge, { nonce: 'bb' })),
    { facilitator }
  );
  assert.equal(response.status, 503);
  assert.match(json.error.message, /Send the same call with the same signed payment/);
  assert.ok(!JSON.stringify(json).includes('capital adequacy'));
});

// ---------------------------------------------------------------- housekeeping

test('the cron deletes counts from days that have ended, and only those', async () => {
  const db = new TestD1();
  for (const [day, caller] of [
    ['2026-10-30', 'a'],
    ['2026-10-31', 'b'],
    ['2026-11-01', 'c'],
  ]) {
    await db.prepare('INSERT INTO allowance_counts (day, caller, calls) VALUES (?, ?, 1)').bind(day, caller).run();
  }
  const removed = await purgeAllowanceCounts(db, NOW);
  assert.equal(removed, 2);
  assert.deepEqual((await allowanceRows(db)).map((r) => r.day), ['2026-11-01']);
});

test('the cron deletes payment claims that have expired, and only those', async () => {
  const db = new TestD1();
  await db.prepare('INSERT INTO payment_claims (claim, expires_at) VALUES (?, ?)').bind('old', NOW - 1).run();
  await db.prepare('INSERT INTO payment_claims (claim, expires_at) VALUES (?, ?)').bind('live', NOW + 60000).run();
  assert.equal(await purgePaymentClaims(db, NOW), 1);
  const { results } = await db.prepare('SELECT claim FROM payment_claims').all();
  assert.deepEqual(results.map((r) => r.claim), ['live']);
});

test('the scheduled run purges counts alongside the ingest', async () => {
  const db = new TestD1();
  await db.prepare('INSERT INTO allowance_counts (day, caller, calls) VALUES (?, ?, 1)').bind('2000-01-01', 'old').run();
  const ctx = context();
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('', { status: 503 });
  try {
    await worker.scheduled({}, { DB: db }, ctx);
    await Promise.all(ctx.jobs);
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(await allowanceRows(db), []);
});

test('callerAddress takes IPv4 whole and IPv6 to its /64', () => {
  const at = (ip) => callerAddress(new Request('https://x.test/', { headers: ip ? { 'CF-Connecting-IP': ip } : {} }));
  assert.equal(at('203.0.113.9'), '203.0.113.9');
  assert.equal(at('2607:fea8:1:2:3:4:5:6'), '2607:fea8:0001:0002::/64');
  assert.equal(at('2607:FEA8:1:2::'), '2607:fea8:0001:0002::/64');
  assert.equal(at('2607:fea8::1'), '2607:fea8:0000:0000::/64');
  assert.equal(at('::ffff:198.51.100.3'), '198.51.100.3', 'an IPv4 mapped address is the IPv4 address');
  assert.equal(at(''), 'unknown');
});

test('classify reads a tool call the way the gate does', () => {
  assert.equal(classify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }).kind, 'other');
  assert.equal(classify(toolCall('list_coverage')).kind, 'free');
  assert.equal(classify(toolCall('search_regulatory_changes')).kind, 'metered');
  assert.equal(classify({ method: 'tools/call', params: [] }).kind, 'malformed');
  assert.equal(classify({ method: 'tools/call', params: { name: 7 } }).kind, 'malformed');
  assert.equal(classify({ method: 'TOOLS/CALL', params: { name: 'list_coverage' } }).kind, 'malformed');
});

test('utcDay is the UTC calendar day', () => {
  assert.equal(utcDay(Date.UTC(2026, 10, 1, 23, 59, 59)), '2026-11-01');
  assert.equal(utcDay(Date.UTC(2026, 10, 2, 0, 0, 0)), '2026-11-02');
});

// ---------------------------------------------------------------- documents

test('the README privacy policy is word for word the page privacy section', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const section = readme.slice(readme.indexOf('## Privacy policy'), readme.indexOf('## Licence'));
  assert.ok(section.includes(PRIVACY.intro), 'the opening line matches');
  const bullets = section
    .split('\n')
    .filter((line) => line.startsWith('- **'))
    .map((line) => {
      const match = /^- \*\*(.+?)\.\*\* (.+)$/.exec(line);
      return [match[1], match[2]];
    });
  assert.deepEqual(bullets, PRIVACY.rows);
});

test('the vendored payment library is unchanged from its recorded hashes', () => {
  const dir = join(root, 'src', 'x402');
  const record = readFileSync(join(dir, 'VENDORED.md'), 'utf8');
  const recorded = new Map(
    [...record.matchAll(/^\| `([^`]+)` \| `([0-9a-f]{64})` \|$/gm)].map((m) => [m[1], m[2]])
  );
  const files = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.ts')) files.push(relative(dir, path));
    }
  };
  walk(dir);
  assert.deepEqual(files.sort(), [...recorded.keys()].sort(), 'every file is recorded, and only those');
  for (const file of files) {
    const hash = createHash('sha256').update(readFileSync(join(dir, file))).digest('hex');
    assert.equal(hash, recorded.get(file), `${file} differs from the copy in dap-foundry`);
  }
});

test('no new file carries an em or en dash', () => {
  for (const file of [
    'src/payments.js',
    'src/pricing.js',
    'src/claims.js',
    'test/payments.test.mjs',
    'src/landing.js',
    'src/mcp.js',
    'src/index.js',
    'schema.sql',
    'wrangler.toml',
    'README.md',
    'src/x402/VENDORED.md',
  ]) {
    assert.doesNotMatch(readFileSync(join(root, file), 'utf8'), /[\u2013\u2014]/, file);
  }
});
