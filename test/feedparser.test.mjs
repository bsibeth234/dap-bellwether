import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseFeed, stripHtml, truncate, toIso } from '../src/feedparser.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, 'fixtures', name), 'utf8');

test('parses RSS 2.0 into normalised items', () => {
  const items = parseFeed(fixture('rss2.xml'));
  assert.equal(items.length, 2);

  const [first] = items;
  assert.equal(first.title, 'Consultation on draft Liquidity Adequacy Requirements');
  assert.equal(first.url, 'https://example.gov/news/liquidity-consultation');
  assert.equal(first.publishedAt, '2026-07-21T14:00:00.000Z');
  assert.match(first.summary, /90-day consultation on liquidity/);
  assert.doesNotMatch(first.summary, /</, 'HTML must be stripped from summaries');
});

test('keeps numeric looking guids as strings so record identity is stable', () => {
  const items = parseFeed(fixture('rss2.xml'));
  // A guid of 20260721 coerced to a number would still stringify the same
  // here, but the type must be string for hashing to be deterministic across
  // parser versions.
  assert.equal(typeof items[0].guid, 'string');
  assert.equal(items[0].guid, '20260721');
});

test('parses Atom and prefers the alternate link over self', () => {
  const items = parseFeed(fixture('atom.xml'));
  assert.equal(items.length, 2);
  assert.equal(items[0].url, 'https://example.eu/publications/crypto-guidelines');
  assert.equal(items[0].guid, 'urn:uuid:9c1f2a44-0000-4000-8000-abcdefabcdef');
  assert.equal(items[0].publishedAt, '2026-07-22T11:00:00.000Z');
});

test('parses Atom entries with a single unlabelled link', () => {
  const items = parseFeed(fixture('atom.xml'));
  assert.equal(items[1].url, 'https://example.eu/publications/sustainability-cp');
  assert.equal(items[1].publishedAt, '2026-07-19T08:00:00.000Z');
  assert.match(items[1].summary, /Comments close 30 September 2026/);
});

test('parses RSS 1.0 RDF, where items sit outside the channel', () => {
  const items = parseFeed(fixture('rdf.xml'));
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Policy statement on operational resilience');
  assert.equal(items[0].publishedAt, '2026-07-20T00:00:00.000Z');
});

test('rejects a non-feed document rather than silently returning nothing', () => {
  // This is the realistic failure: a regulator retires a feed and serves an
  // HTML error page with a 200. Returning zero items would look like "no news"
  // forever. It has to raise so source health records the failure.
  assert.throws(() => parseFeed(fixture('notafeed.xml')), /unrecognised feed format/);
});

test('rejects an empty body', () => {
  assert.throws(() => parseFeed(''), /empty feed body/);
});

test('stripHtml removes scripts, tags and entities', () => {
  assert.equal(stripHtml('<p>Hello&nbsp;&amp; welcome</p>'), 'Hello & welcome');
  assert.equal(stripHtml('<script>alert(1)</script>text'), 'text');
});

test('truncate breaks on a word boundary', () => {
  const long = 'word '.repeat(200).trim();
  const out = truncate(long, 50);
  assert.ok(out.length <= 54, `expected short output, got ${out.length}`);
  assert.ok(out.endsWith('...'));
  assert.doesNotMatch(out, /wor\.\.\./, 'should not cut mid word');
});

test('toIso returns null rather than guessing at an unparseable date', () => {
  assert.equal(toIso('not a date'), null);
  assert.equal(toIso(''), null);
  assert.equal(toIso('Tue, 21 Jul 2026 14:00:00 GMT'), '2026-07-21T14:00:00.000Z');
});
