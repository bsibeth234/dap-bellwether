import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TestD1 } from './d1-shim.mjs';
import worker from '../src/index.js';
import { llmsTxt } from '../src/llms.js';
import { openApiDocument } from '../src/openapi.js';
import { METERED_TOOLS, PRICE, pricingFor } from '../src/pricing.js';
import { TOOLS } from '../src/tools.js';
import { usdcFor } from '../src/x402/networks.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const toml = readFileSync(join(root, 'wrangler.toml'), 'utf8');
const SERVER = JSON.parse(readFileSync(join(root, 'server.json'), 'utf8'));
const ORIGIN = 'https://bellwether.dap.solutions';

/** A [vars] value from wrangler.toml: the settings production runs on. */
function tomlVar(name) {
  const match = new RegExp(`^${name} = "([^"]*)"$`, 'm').exec(toml);
  assert.ok(match, `wrangler.toml sets ${name}`);
  return match[1];
}

/** The production settings: the vars in wrangler.toml, and stand ins for the secrets that switch the tier on. */
function productionSettings(extra = {}) {
  return {
    DB: new TestD1(),
    X402_PAY_TO: '0x' + '7a'.repeat(20),
    X402_NETWORKS: tomlVar('X402_NETWORKS'),
    FREE_CALLS_PER_DAY: tomlVar('FREE_CALLS_PER_DAY'),
    ALLOWANCE_KEY: 'k'.repeat(64),
    CDP_API_KEY_ID: 'test-key-id',
    CDP_API_KEY_SECRET: 's'.repeat(88),
    ...extra,
  };
}

function context() {
  return { waitUntil() {}, passThroughOnException() {} };
}

/** Every dollar amount in a text. */
const dollars = (text) => [...text.matchAll(/\$\d+(?:\.\d+)?/g)].map((m) => m[0]);
/** Every allowance in a text: "free for N calls". */
const allowances = (text) => [...text.matchAll(/free for (\d+) calls/gi)].map((m) => Number(m[1]));

test('every price and allowance in llms.txt is the one in the config', () => {
  const env = productionSettings();
  const pricing = pricingFor(env);
  assert.equal(pricing.status, 'on', 'the production settings switch the tier on');
  const text = llmsTxt(env);

  const amounts = dollars(text);
  assert.ok(amounts.length >= 4, 'the MCP price and each priced API route are stated');
  for (const amount of amounts) assert.equal(amount, PRICE, `${amount} is the configured price`);

  const stated = allowances(text);
  assert.ok(stated.length >= 1, 'the allowance is stated');
  for (const n of stated) assert.equal(n, Number(tomlVar('FREE_CALLS_PER_DAY')), `${n} is FREE_CALLS_PER_DAY`);

  // The network named is the one configured, and the price agrees with the OpenAPI document.
  const network = usdcFor(tomlVar('X402_NETWORKS').split(',')[0].trim()).label;
  assert.match(text, new RegExp(`USDC on ${network}, paid with x402`));
  for (const item of Object.values(openApiDocument().paths)) {
    const info = item.get['x-payment-info'];
    if (info) assert.equal(`$${info.price.amount}`, PRICE);
  }
});

test('llms.txt follows the config: a changed allowance or network changes the file, nothing is fixed in it', () => {
  const text = llmsTxt(productionSettings({ FREE_CALLS_PER_DAY: '7', X402_NETWORKS: 'eip155:84532' }));
  assert.deepEqual([...new Set(allowances(text))], [7]);
  assert.match(text, /USDC on Base Sepolia/);
  assert.ok(!/\b50\b/.test(text), 'no allowance left over from wrangler.toml');
});

test('with the paid tier off, llms.txt states no price and no allowance, because none is charged', () => {
  for (const env of [{}, { X402_PAY_TO: '0x' + '7a'.repeat(20) }]) {
    assert.notEqual(pricingFor(env).status, 'on');
    const text = llmsTxt(env);
    assert.deepEqual(dollars(text), []);
    assert.deepEqual(allowances(text), []);
    assert.match(text, /Payments are off right now\. Every tool and every API route is free\./);
  }
});

test('llms.txt names every MCP tool and every API route, each paid or free as the service has it', () => {
  const env = productionSettings();
  const text = llmsTxt(env);
  const lines = text.split('\n');

  for (const tool of TOOLS) {
    const line = lines.find((l) => l.startsWith(`- ${tool.name}: `));
    assert.ok(line, `${tool.name} has a line`);
    if (METERED_TOOLS.includes(tool.name)) assert.match(line, /Free for \d+ calls per caller each UTC day, then \$/);
    else assert.match(line, /Always free\.$/);
  }
  assert.ok(lines.includes(`All ${TOOLS.length} MCP tools are read-only.`));
  assert.ok(TOOLS.every((t) => t.annotations && t.annotations.readOnlyHint === true), 'every tool is read-only');

  for (const [path, item] of Object.entries(openApiDocument().paths)) {
    const line = lines.find((l) => l.startsWith(`- GET ${ORIGIN}${path}: `));
    assert.ok(line, `${path} has a line`);
    if (item.get['x-payment-info']) assert.match(line, /Paid: \$[\d.]+ per call from the first call\./);
    else assert.match(line, /Free\.$/);
  }
  assert.match(text, /There is no free allowance on \/api\./);
});

test('llms.txt says what the service is, how to connect, how to pay without a wallet, and whose terms apply', () => {
  const text = llmsTxt(productionSettings());
  const doc = openApiDocument();
  const remote = SERVER.remotes.find((r) => r.type === 'streamable-http');
  for (const expected of [
    'Public regulatory change feed from Dartmouth Advisory Partners.',
    'Canada, the United States, the United Kingdom and the European Union',
    'It is not legal or compliance advice.',
    'It is not a full archive.',
    `MCP, streamable HTTP: ${remote.url}`,
    `MCP Registry name: ${SERVER.name}`,
    `OpenAPI 3.1: ${ORIGIN}/openapi.json`,
    'list_coverage is always free',
    'A call that fails or is refused is never charged.',
    'a DAP licence key instead of a wallet',
    'one invoice',
    `Terms: ${doc.info.termsOfService}`,
    `Source: ${SERVER.repository.url}`,
    `Operator: ${doc.info.contact.name}, https://dap.solutions`,
  ]) {
    assert.ok(text.includes(expected), `states: ${expected}`);
  }
  assert.equal(SERVER.name, 'solutions.dap/bellwether');
  assert.equal(doc.info.termsOfService, 'https://dap.solutions/terms/api/');
});

test('llms.txt is plain and short: no en or em dash, no internal names, no line over 300 characters', () => {
  for (const env of [productionSettings(), {}]) {
    const text = llmsTxt(env);
    assert.ok(!/[\u2013\u2014]/.test(text), 'no en or em dash');
    assert.ok(!/\bG0\b/.test(text));
    assert.ok(text.startsWith('# DAP Bellwether\n'));
    for (const line of text.split('\n')) assert.ok(line.length <= 300, `short line: ${line.slice(0, 60)}`);
  }
});

test('GET /llms.txt answers 200 text/plain with the generated text, on the custom domain and the fallback', async () => {
  const env = productionSettings();
  for (const origin of [ORIGIN, 'https://dap-bellwether.dap-solutions.workers.dev']) {
    const response = await worker.fetch(new Request(`${origin}/llms.txt`), env, context());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.match(response.headers.get('link') || '', /<https:\/\/dap\.solutions\/terms\/api\/>; rel="terms-of-service"/);
    assert.equal(await response.text(), llmsTxt(env));
  }
});

test('the landing page, the README and the API 404 point to /llms.txt where they point to /openapi.json', async () => {
  const page = await (await worker.fetch(new Request(`${ORIGIN}/`), productionSettings(), context())).text();
  assert.match(page, /href="\/openapi\.json"/);
  assert.match(page, /href="\/llms\.txt"/);
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  assert.ok(readme.includes('https://bellwether.dap.solutions/llms.txt'));
  const missing = await worker.fetch(new Request(`${ORIGIN}/api/nothing`), productionSettings(), context());
  assert.equal(missing.status, 404);
  assert.match((await missing.json()).message, /openapi\.json.*llms\.txt/);
});
