import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TestD1 } from './d1-shim.mjs';
import worker from '../src/index.js';
import { PRICE } from '../src/pricing.js';
import { encodeHeader, decodeHeader } from '../src/x402/codec.ts';
import { EXPECTED, PAID_ROUTE, challengeMatches, checkLive, checkOnce, report } from '../scripts/live-check.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://bellwether.dap.solutions';

/** The production settings: wrangler.toml's vars, the recorded wallet, stand ins for the other secrets. */
function production(extra = {}) {
  return {
    DB: new TestD1(),
    X402_PAY_TO: EXPECTED.payTo,
    X402_NETWORKS: 'eip155:8453',
    FREE_CALLS_PER_DAY: '50',
    ALLOWANCE_KEY: 'k'.repeat(64),
    CDP_API_KEY_ID: 'test-key-id',
    CDP_API_KEY_SECRET: 's'.repeat(88),
    ...extra,
  };
}

/** A fetch that answers from the Worker built from this code, optionally rewriting an answer. */
function workerFetch(env, rewrite = (path, response) => response) {
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  return async (url, init) => {
    const response = await worker.fetch(new Request(url, init), env, ctx);
    return rewrite(new URL(url).pathname, response);
  };
}

/** The 402 for the paid route with its challenge's first option changed. */
async function withOption(response, change) {
  const challenge = decodeHeader(response.headers.get('payment-required'));
  challenge.accepts = challenge.accepts.map((a) => ({ ...a, ...change }));
  const headers = new Headers(response.headers);
  headers.set('PAYMENT-REQUIRED', encodeHeader(challenge));
  return new Response(JSON.stringify(challenge), { status: 402, headers });
}

test('the live check passes against the Worker this code builds, with the production settings', async () => {
  const outcome = await checkLive(ORIGIN, { fetch: workerFetch(production()), attempts: 1, waitMs: 0 });
  assert.equal(outcome.ok, true, report(ORIGIN, outcome));
  assert.deepEqual(outcome.results.map((r) => r.ok), [true, true, true]);
  assert.match(outcome.results[2].detail, /^10000 on eip155:8453 to 0xa590d98bbee97533bd7dfed19c0a89ffeeeb1384$/);
});

test('the expected challenge is the 1 November record, and agrees with the price and network in the config', () => {
  // 10000 atomic units of USDC (6 decimals) is $0.01.
  assert.equal(Number(EXPECTED.amount) / 1e6, Number(PRICE.replace('$', '')));
  const toml = readFileSync(join(root, 'wrangler.toml'), 'utf8');
  assert.equal(/^X402_NETWORKS = "([^"]*)"$/m.exec(toml)[1], EXPECTED.network);
  const record = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
  assert.ok(record.includes(`call 51 priced at ${EXPECTED.amount} atomic USDC on Base to \`${EXPECTED.payTo}\``), 'the payTo is the recorded one');
  assert.equal(PAID_ROUTE, '/api/search');
});

test('the live check fails on any change to what a paying agent is asked', async () => {
  const cases = {
    'another wallet': { payTo: '0x' + '7a'.repeat(20) },
    'another network': { network: 'eip155:84532' },
    'another amount': { amount: '20000' },
  };
  for (const [name, change] of Object.entries(cases)) {
    const fetch = workerFetch(production(), (path, r) => (path === PAID_ROUTE ? withOption(r, change) : r));
    const results = await checkOnce(ORIGIN, { fetch });
    assert.equal(results[2].ok, false, name);
    assert.match(results[2].detail, /expected 10000 on eip155:8453/);
  }
  // The Worker itself, run with another wallet or network, fails the same way.
  for (const extra of [{ X402_PAY_TO: '0x' + '7a'.repeat(20) }, { X402_NETWORKS: 'eip155:84532' }]) {
    const results = await checkOnce(ORIGIN, { fetch: workerFetch(production(extra)) });
    assert.equal(results[2].ok, false, JSON.stringify(extra));
  }
  // A challenge that adds a second option elsewhere is a change too.
  assert.equal(challengeMatches({ accepts: [{ ...EXPECTED }, { ...EXPECTED, network: 'eip155:1' }] }).ok, false);
  assert.equal(challengeMatches({ accepts: [] }).ok, false);
});

test('the live check fails when the paid route answers free, or anything but 402', async () => {
  const results = await checkOnce(ORIGIN, { fetch: workerFetch({ DB: new TestD1() }) });
  assert.equal(results[2].ok, false, 'with the paid tier off the route answers, and that is a failure');
  const noHeader = workerFetch(production(), (path, r) => (path === PAID_ROUTE ? new Response('{}', { status: 402 }) : r));
  assert.match((await checkOnce(ORIGIN, { fetch: noHeader }))[2].detail, /no PAYMENT-REQUIRED header/);
});

test('the live check fails when /llms.txt or /openapi.json is missing or wrong', async () => {
  const broken = {
    '/llms.txt': () => new Response('Not found', { status: 404 }),
    '/openapi.json': () => new Response('oops', { status: 500 }),
  };
  for (const [target, answer] of Object.entries(broken)) {
    const fetch = workerFetch(production(), (path, r) => (path === target ? answer() : r));
    const results = await checkOnce(ORIGIN, { fetch });
    assert.equal(results.find((r) => r.name.startsWith(target)).ok, false, target);
  }
  const html = workerFetch(production(), (path, r) =>
    path === '/llms.txt' ? new Response('# DAP Bellwether', { status: 200, headers: { 'Content-Type': 'text/html' } }) : r
  );
  assert.equal((await checkOnce(ORIGIN, { fetch: html }))[0].ok, false, 'llms.txt must be text/plain');
  const down = async () => {
    throw new Error('connect ECONNREFUSED');
  };
  assert.deepEqual((await checkOnce(ORIGIN, { fetch: down })).map((r) => r.ok), [false, false, false]);
});

test('the live check retries while the edge still serves the previous version, then gives up', async () => {
  let calls = 0;
  const flaky = workerFetch(production(), (path, r) => {
    if (path === '/llms.txt' && calls++ < 2) return new Response('Not found', { status: 404 });
    return r;
  });
  const outcome = await checkLive(ORIGIN, { fetch: flaky, attempts: 5, waitMs: 0 });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.attempts, 3);

  const never = workerFetch(production(), (path, r) => (path === '/llms.txt' ? new Response('', { status: 404 }) : r));
  const failed = await checkLive(ORIGIN, { fetch: never, attempts: 3, waitMs: 0 });
  assert.equal(failed.ok, false);
  assert.equal(failed.attempts, 3);
  const table = report(ORIGIN, failed);
  assert.match(table, /FAIL/);
  assert.ok(!/[\u2013\u2014]/.test(table), 'no en or em dash');
});
