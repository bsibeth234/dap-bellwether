import test from 'node:test';
import assert from 'node:assert/strict';

import { TestD1 } from './d1-shim.mjs';
import { runIngest } from '../src/ingest.js';
import { getChange, searchChanges, getSourceHealth } from '../src/db.js';

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

function feed(items) {
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>${items
    .map(
      (i) => `<item>
        <title>${i.title}</title>
        <link>${i.link}</link>
        <description>${i.description}</description>
        <pubDate>${i.pubDate}</pubDate>
        <guid>${i.guid}</guid>
      </item>`
    )
    .join('')}</channel></rss>`;
}

const BASE_ITEM = {
  title: 'Consultation on capital adequacy',
  link: 'https://example.test/news/car',
  description: 'A 90 day consultation opens today.',
  pubDate: 'Tue, 21 Jul 2026 14:00:00 GMT',
  guid: 'car-2026',
};

/** Replace global fetch with a canned response for the duration of a test. */
function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = original;
  };
}

function ok(body) {
  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/xml' } });
}

test('first ingest inserts records', async () => {
  const db = new TestD1();
  const restore = stubFetch(async () => ok(feed([BASE_ITEM])));
  try {
    const summary = await runIngest(db, { sources: [SOURCE] });
    assert.equal(summary.ok, 1);
    assert.equal(summary.failed, 0);
    assert.equal(summary.inserted, 1);

    const rows = await searchChanges(db, { limit: 10 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, 'Consultation on capital adequacy');
    assert.equal(rows[0].jurisdiction, 'CA');
    assert.equal(rows[0].revision, 1);
  } finally {
    restore();
  }
});

test('re-ingesting identical content produces no revision', async () => {
  const db = new TestD1();
  const restore = stubFetch(async () => ok(feed([BASE_ITEM])));
  try {
    await runIngest(db, { sources: [SOURCE] });
    const second = await runIngest(db, { sources: [SOURCE] });

    assert.equal(second.inserted, 0);
    assert.equal(second.revised, 0);
    assert.equal(second.unchanged, 1);

    const rows = await searchChanges(db, { limit: 10 });
    assert.equal(rows.length, 1, 'must not duplicate the record');
    assert.equal(rows[0].revision, 1);
  } finally {
    restore();
  }
});

test('amended content is detected and the prior state is retained', async () => {
  // This is the whole reason the store exists. A pass-through feed reader
  // cannot answer "was this changed after publication", because it never held
  // the earlier version.
  const db = new TestD1();

  let restore = stubFetch(async () => ok(feed([BASE_ITEM])));
  await runIngest(db, { sources: [SOURCE] });
  restore();

  const amended = { ...BASE_ITEM, description: 'The consultation period has been extended to 120 days.' };
  restore = stubFetch(async () => ok(feed([amended])));
  try {
    const summary = await runIngest(db, { sources: [SOURCE] });
    assert.equal(summary.revised, 1);
    assert.equal(summary.inserted, 0);

    const rows = await searchChanges(db, { limit: 10 });
    assert.equal(rows.length, 1, 'an amendment updates the record, it does not create a second one');
    assert.equal(rows[0].revision, 2);

    const full = await getChange(db, rows[0].id);
    assert.equal(full.revisions.length, 2);
    assert.match(full.revisions[0].summary, /90 day consultation/, 'original text must survive');
    assert.match(full.revisions[1].summary, /extended to 120 days/);
  } finally {
    restore();
  }
});

test('a republished date alone does not manufacture a revision', async () => {
  const db = new TestD1();

  let restore = stubFetch(async () => ok(feed([BASE_ITEM])));
  await runIngest(db, { sources: [SOURCE] });
  restore();

  const republished = { ...BASE_ITEM, pubDate: 'Wed, 22 Jul 2026 09:00:00 GMT' };
  restore = stubFetch(async () => ok(feed([republished])));
  try {
    const summary = await runIngest(db, { sources: [SOURCE] });
    assert.equal(summary.revised, 0, 'date churn must not count as a change');
    assert.equal(summary.unchanged, 1);
  } finally {
    restore();
  }
});

test('one failing source does not abort the run and is recorded', async () => {
  const db = new TestD1();
  const good = { ...SOURCE, id: 'good-src', feedUrl: 'https://good.test/feed.xml' };
  const bad = { ...SOURCE, id: 'bad-src', regulator: 'BADREG', feedUrl: 'https://bad.test/feed.xml' };

  const restore = stubFetch(async (url) => {
    if (String(url).includes('bad.test')) return new Response('gone', { status: 404, statusText: 'Not Found' });
    return ok(feed([BASE_ITEM]));
  });

  try {
    const summary = await runIngest(db, { sources: [bad, good] });
    assert.equal(summary.attempted, 2);
    assert.equal(summary.ok, 1);
    assert.equal(summary.failed, 1);
    assert.equal(summary.inserted, 1, 'the healthy source still ingested');

    const health = await getSourceHealth(db);
    assert.equal(health['bad-src'].consecutive_failures, 1);
    assert.match(health['bad-src'].last_error, /404/);
    assert.equal(health['good-src'].consecutive_failures, 0);
    assert.ok(health['good-src'].last_ok_at);
  } finally {
    restore();
  }
});

test('an HTML error page served with a 200 is treated as a failure', async () => {
  // Regulators do this. Without it, coverage would silently go stale while
  // reporting healthy.
  const db = new TestD1();
  const restore = stubFetch(async () => ok('<html><body>Page moved</body></html>'));
  try {
    const summary = await runIngest(db, { sources: [SOURCE] });
    assert.equal(summary.failed, 1);
    assert.equal(summary.inserted, 0);
    const health = await getSourceHealth(db);
    assert.match(health[SOURCE.id].last_error, /unrecognised feed format/);
  } finally {
    restore();
  }
});

test('search filters by jurisdiction, regulator and keyword', async () => {
  const db = new TestD1();
  const ca = { ...SOURCE, id: 'ca-src', jurisdiction: 'CA', regulator: 'OSFI' };
  const us = { ...SOURCE, id: 'us-src', jurisdiction: 'US', regulator: 'SEC' };

  const restore = stubFetch(async (url) => {
    if (String(url).includes('us')) {
      return ok(feed([{ ...BASE_ITEM, guid: 'sec-1', title: 'Proposed rule on custody', link: 'https://sec.test/1' }]));
    }
    return ok(feed([BASE_ITEM]));
  });

  try {
    await runIngest(db, { sources: [{ ...ca, feedUrl: 'https://ca.test/f.xml' }, { ...us, feedUrl: 'https://us.test/f.xml' }] });

    assert.equal((await searchChanges(db, { limit: 50 })).length, 2);
    assert.equal((await searchChanges(db, { jurisdiction: 'US', limit: 50 })).length, 1);
    assert.equal((await searchChanges(db, { regulator: 'osfi', limit: 50 })).length, 1, 'regulator match is case insensitive');
    assert.equal((await searchChanges(db, { query: 'custody', limit: 50 })).length, 1);
    assert.equal((await searchChanges(db, { query: 'nothing here', limit: 50 })).length, 0);
  } finally {
    restore();
  }
});

test('a dated record outranks an undated one collected more recently', async () => {
  // ESMA ships no date element, so its records fall back to collection time,
  // which is newer than every real publication date in the store. Before the
  // ordering was split, a live search for "market" came back five undated
  // records deep with nothing we knew the date of. They must stay findable
  // and stop outranking.
  const db = new TestD1();

  const dated = { ...SOURCE, id: 'dated-src', regulator: 'DATEDREG', feedUrl: 'https://dated.test/f.xml' };
  const undated = { ...SOURCE, id: 'undated-src', regulator: 'UNDATEDREG', feedUrl: 'https://undated.test/f.xml' };

  // No pubDate element at all, exactly as ESMA publishes.
  const undatedFeed = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
    <item>
      <title>Market statement with no date element</title>
      <link>https://undated.test/1</link>
      <description>This item carries no date element.</description>
      <guid>undated-1</guid>
    </item>
  </channel></rss>`;

  const restore = stubFetch(async (url) =>
    String(url).includes('undated.test')
      ? ok(undatedFeed)
      : ok(feed([{ ...BASE_ITEM, guid: 'dated-1', title: 'Market statement with a real date' }]))
  );

  try {
    // Ingested second, so the undated record is the more recently collected of
    // the two and would win on the coalesced value alone.
    await runIngest(db, { sources: [dated] });
    await runIngest(db, { sources: [undated] });

    const rows = await searchChanges(db, { query: 'market statement', limit: 10 });
    assert.equal(rows.length, 2, 'both records stay findable by keyword');

    assert.equal(rows[0].regulator, 'DATEDREG', 'a known publication date must rank first');
    assert.ok(rows[0].published_at, 'the top record is the one with a real date');
    assert.equal(rows[1].regulator, 'UNDATEDREG');
    assert.equal(rows[1].published_at, null);

    // Without this the test would pass on insertion order and prove nothing:
    // the undated record genuinely carries the newer effective date.
    assert.ok(
      rows[1].first_seen_at > rows[0].published_at,
      'the undated record must have the newer fallback date, or this asserts nothing'
    );
  } finally {
    restore();
  }
});

test('LIKE wildcards in a user query are escaped, not executed', async () => {
  const db = new TestD1();
  const restore = stubFetch(async () =>
    ok(feed([{ ...BASE_ITEM, guid: 'pct', title: 'Threshold raised to 50% of assets', link: 'https://x.test/1' }]))
  );
  try {
    await runIngest(db, { sources: [SOURCE] });
    assert.equal((await searchChanges(db, { query: '50%', limit: 10 })).length, 1);
    // If % were passed through as a wildcard, "5%f" would match. It must not.
    assert.equal((await searchChanges(db, { query: '5%f', limit: 10 })).length, 0);
  } finally {
    restore();
  }
});
