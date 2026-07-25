import test from 'node:test';
import assert from 'node:assert/strict';

import { TestD1 } from './d1-shim.mjs';
import { handleMcpRequest, isAllowedOrigin } from '../src/mcp.js';
import { TOOLS } from '../src/tools.js';
import { runIngest } from '../src/ingest.js';

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

async function seededEnv() {
  const db = new TestD1();
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(FEED, { status: 200 });
  try {
    await runIngest(db, { sources: [SOURCE] });
  } finally {
    globalThis.fetch = original;
  }
  return { DB: db };
}

function rpc(body, { origin, method = 'POST' } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (origin) headers.Origin = origin;
  return new Request('https://bellwether.test/mcp', {
    method,
    headers,
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });
}

async function call(env, body, opts) {
  const response = await handleMcpRequest(rpc(body, opts), env);
  return { response, json: response.status === 202 ? null : await response.json() };
}

test('initialize returns capabilities and server info', async () => {
  const env = await seededEnv();
  const { json } = await call(env, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
  });

  assert.equal(json.result.protocolVersion, '2025-06-18');
  assert.deepEqual(json.result.capabilities.tools, { listChanged: false });
  assert.equal(json.result.serverInfo.name, 'DAP Bellwether');
  assert.match(json.result.instructions, /not legal or compliance advice/);
});

test('an unsupported protocol version negotiates down rather than failing', async () => {
  const env = await seededEnv();
  const { json } = await call(env, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '1999-01-01' },
  });
  assert.equal(json.result.protocolVersion, '2025-06-18');
});

test('every tool carries the annotations the Connectors Directory requires', () => {
  // A submission is rejected outright for a tool missing a title or the
  // applicable read-only hint, so this is a release gate, not a style check.
  assert.ok(TOOLS.length > 0);
  for (const tool of TOOLS) {
    assert.ok(tool.name, 'tool needs a name');
    assert.ok(tool.title, `${tool.name} needs a top level title`);
    assert.ok(tool.description && tool.description.length > 40, `${tool.name} needs a usable description`);
    assert.ok(tool.annotations, `${tool.name} needs annotations`);
    assert.ok(tool.annotations.title, `${tool.name} needs annotations.title`);
    assert.equal(tool.annotations.readOnlyHint, true, `${tool.name} must declare readOnlyHint`);
    assert.equal(tool.annotations.openWorldHint, false, `${tool.name} reads our own store`);
    assert.equal(tool.inputSchema.type, 'object');
  }
});

test('tools/list returns the full surface', async () => {
  const env = await seededEnv();
  const { json } = await call(env, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = json.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'get_regulatory_change',
    'list_coverage',
    'recent_regulatory_changes',
    'search_regulatory_changes',
  ]);
});

test('search returns seeded records', async () => {
  const env = await seededEnv();
  const { json } = await call(env, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'search_regulatory_changes', arguments: { query: 'capital' } },
  });
  assert.equal(json.result.isError, undefined);
  assert.match(json.result.content[0].text, /Consultation on capital adequacy/);
  assert.match(json.result.content[0].text, /TESTREG \(CA\)/);
});

test('an empty search explains the coverage window instead of implying nothing exists', async () => {
  const env = await seededEnv();
  const { json } = await call(env, {
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'search_regulatory_changes', arguments: { query: 'zzzznomatch' } },
  });
  assert.match(json.result.content[0].text, /coverage begins/);
});

// Modelled on ESMA, which ships title, link and description and no date
// element of any kind.
const UNDATED_SOURCE = {
  id: 'test-nodate-news',
  regulator: 'NODATEREG',
  jurisdiction: 'EU',
  name: 'News',
  feedUrl: 'https://example.test/nodate.xml',
  homepage: 'https://example.test/',
  category: 'news',
  enabled: true,
  verified: true,
  datesUnavailable: true,
};

const UNDATED_FEED = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
  <item>
    <title>Statement on settlement discipline</title>
    <link>https://example.test/news/settlement</link>
    <description>This item carries no date element anywhere.</description>
    <guid>settlement-2026</guid>
  </item>
</channel></rss>`;

async function seededUndatedEnv() {
  const db = new TestD1();
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(UNDATED_FEED, { status: 200 });
  try {
    await runIngest(db, { sources: [UNDATED_SOURCE] });
  } finally {
    globalThis.fetch = original;
  }
  return { DB: db };
}

test('an undated record never renders a bare date that reads as a publication date', async () => {
  const env = await seededUndatedEnv();
  const { json } = await call(env, {
    jsonrpc: '2.0',
    id: 14,
    method: 'tools/call',
    params: { name: 'search_regulatory_changes', arguments: { query: 'settlement' } },
  });

  const text = json.result.content[0].text;
  assert.match(text, /Statement on settlement discipline/, 'the record itself must still be returned');

  const header = text.split('\n').find((line) => line.startsWith('NODATEREG'));
  assert.ok(header, 'expected a header line for the record');
  assert.match(header, /publication date not provided by source/);
  assert.doesNotMatch(
    header,
    /\|\s*\d{4}-\d{2}-\d{2}\s*\|/,
    'a collection date must never sit where a publication date belongs'
  );

  // The counterpart, so this is a distinction rather than a blanket
  // suppression: a record that does carry a publication date still shows it.
  const dated = await call(await seededEnv(), {
    jsonrpc: '2.0',
    id: 15,
    method: 'tools/call',
    params: { name: 'search_regulatory_changes', arguments: { query: 'capital' } },
  });
  const datedHeader = dated.json.result.content[0].text
    .split('\n')
    .find((line) => line.startsWith('TESTREG'));
  assert.match(datedHeader, /\|\s*2026-07-21\s*\|/);
});

test('list_coverage reports what is monitored', async () => {
  const env = await seededEnv();
  const { json } = await call(env, {
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'list_coverage', arguments: {} },
  });
  assert.match(json.result.content[0].text, /Monitoring \d+ feeds/);
});

test('get_regulatory_change returns revision history', async () => {
  const env = await seededEnv();
  const search = await call(env, {
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: { name: 'search_regulatory_changes', arguments: { query: 'capital' } },
  });
  const id = search.json.result.content[0].text.match(/id: ([a-f0-9]{32})/)[1];

  const { json } = await call(env, {
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: { name: 'get_regulatory_change', arguments: { id } },
  });
  assert.match(json.result.content[0].text, /No amendments observed/);
});

test('an unknown id is an error result, not a crash', async () => {
  const env = await seededEnv();
  const { json } = await call(env, {
    jsonrpc: '2.0',
    id: 8,
    method: 'tools/call',
    params: { name: 'get_regulatory_change', arguments: { id: 'deadbeef' } },
  });
  assert.equal(json.result.isError, true);
});

test('an unknown tool is rejected as invalid params', async () => {
  const env = await seededEnv();
  const { json } = await call(env, {
    jsonrpc: '2.0',
    id: 9,
    method: 'tools/call',
    params: { name: 'drop_everything', arguments: {} },
  });
  assert.equal(json.error.code, -32602);
});

test('an unknown method returns method not found', async () => {
  const env = await seededEnv();
  const { json } = await call(env, { jsonrpc: '2.0', id: 10, method: 'nonsense/method' });
  assert.equal(json.error.code, -32601);
});

test('a notification gets 202 with no body', async () => {
  const env = await seededEnv();
  const response = await handleMcpRequest(
    rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    env
  );
  assert.equal(response.status, 202);
});

test('malformed JSON returns a parse error', async () => {
  const env = await seededEnv();
  const request = new Request('https://bellwether.test/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not json',
  });
  const response = await handleMcpRequest(request, env);
  const json = await response.json();
  assert.equal(response.status, 400);
  assert.equal(json.error.code, -32700);
});

test('batched requests return an array of responses', async () => {
  const env = await seededEnv();
  const { json } = await call(env, [
    { jsonrpc: '2.0', id: 11, method: 'ping' },
    { jsonrpc: '2.0', id: 12, method: 'tools/list' },
  ]);
  assert.ok(Array.isArray(json));
  assert.equal(json.length, 2);
});

test('origin validation allows Anthropic surfaces and absence, refuses others', () => {
  assert.equal(isAllowedOrigin(null), true, 'server to server callers send no Origin');
  assert.equal(isAllowedOrigin('https://claude.ai'), true);
  assert.equal(isAllowedOrigin('https://app.claude.com'), true);
  assert.equal(isAllowedOrigin('http://localhost:8787'), true);
  assert.equal(isAllowedOrigin('https://evil.example'), false);
  assert.equal(isAllowedOrigin('https://claude.ai.evil.example'), false, 'suffix attack must fail');
});

test('a disallowed origin is refused at the transport', async () => {
  const env = await seededEnv();
  const response = await handleMcpRequest(
    rpc({ jsonrpc: '2.0', id: 13, method: 'tools/list' }, { origin: 'https://evil.example' }),
    env
  );
  assert.equal(response.status, 403);
});

test('GET is refused with a usable message', async () => {
  const env = await seededEnv();
  const response = await handleMcpRequest(rpc(null, { method: 'GET' }), env);
  assert.equal(response.status, 405);
});
