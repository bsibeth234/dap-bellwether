import test from 'node:test';
import assert from 'node:assert/strict';

import { TestD1 } from './d1-shim.mjs';
import worker from '../src/index.js';
import { getChange, searchChanges, upsertChange } from '../src/db.js';
import { openApiDocument } from '../src/openapi.js';
import { SOURCES, enabledSources, linkOnlySourceIds, servable, sourceById } from '../src/sources.js';

const NOW = '2026-11-02T00:00:00.000Z';
const item = (guid) => ({ guid, title: 'Capital notice', summary: 'Secret phrase from the regulator', url: 'https://example.test/a', publishedAt: NOW });

test('OSFI, OSC, FCA and FINRA are link only, and FINRA is not collected', () => {
  assert.deepEqual(linkOnlySourceIds().sort(), ['ca-osc-news', 'ca-osfi-news', 'uk-fca-news', 'us-finra-notices']);
  assert.ok(!enabledSources().some((s) => s.id === 'us-finra-notices'));
});

test('a link only source serves no summary, on the record or its revisions', () => {
  const out = servable({ source_id: 'uk-fca-news', summary: 'text', revisions: [{ revision: 1, summary: 'text' }] });
  assert.equal(out.summary, null);
  assert.equal(out.revisions[0].summary, null);
});

test('any other source keeps its summary, and ESMA carries its notice', () => {
  assert.equal(servable({ source_id: 'us-sec-press', summary: 'text' }).summary, 'text');
  const esma = servable({ source_id: 'eu-esma-news', summary: 'text' });
  assert.equal(esma.summary, 'text');
  assert.match(esma.source_notice, /free of charge on the ESMA website/);
});

test('a search cannot reach stored text of a link only source, but can reach its title', async () => {
  const db = new TestD1();
  await upsertChange(db, sourceById('uk-fca-news'), item('fca-1'), NOW);
  await upsertChange(db, sourceById('us-sec-press'), item('sec-1'), NOW);
  const byText = await searchChanges(db, { query: 'Secret phrase', limit: 10 });
  assert.deepEqual(byText.map((r) => r.source_id), ['us-sec-press']);
  const byTitle = await searchChanges(db, { query: 'Capital', limit: 10 });
  assert.equal(byTitle.length, 2);
  const fca = byTitle.find((r) => r.source_id === 'uk-fca-news');
  assert.equal(fca.summary, null);
  const full = await getChange(db, fca.id);
  assert.equal(full.summary, null);
  assert.ok(full.revisions.every((r) => r.summary === null));
});

test('every /mcp and /api answer links the API terms, and the OpenAPI names them', async () => {
  const env = { DB: new TestD1() };
  for (const path of ['/mcp', '/api/coverage']) {
    const res = await worker.fetch(new Request('https://bellwether.dap.solutions' + path), env, { waitUntil() {} });
    assert.match(res.headers.get('Link') || '', /dap\.solutions\/terms\/api\/.*terms-of-service/, path);
  }
  assert.equal(openApiDocument().info.termsOfService, 'https://dap.solutions/terms/api/');
});

test('no source marked link only is unknown', () => {
  assert.ok(linkOnlySourceIds().every((id) => SOURCES.some((s) => s.id === id)));
});
