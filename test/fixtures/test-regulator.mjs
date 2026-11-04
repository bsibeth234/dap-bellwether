/**
 * The test regulator: one source and its one item, which the API, MCP and payment tests ingest into the
 * test D1 shim, and which scripts/bazaar-examples.mjs ingests the same way to build the example answers in
 * src/bazaar-examples.json. It is not a real regulator: example.test is a reserved name.
 */

export const SOURCE = {
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

export const FEED = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
  <item>
    <title>Consultation on capital adequacy</title>
    <link>https://example.test/news/car</link>
    <description>A 90 day consultation opens today.</description>
    <pubDate>Tue, 21 Jul 2026 14:00:00 GMT</pubDate>
    <guid>car-2026</guid>
  </item>
</channel></rss>`;
