/**
 * DAP Bellwether source registry.
 *
 * Every entry is configuration, not code. Adding a regulator is a one line
 * change here plus a redeploy. Nothing downstream needs to know the shape of
 * any individual regulator's feed.
 *
 * Verification state:
 * Every entry here was pulled against the live web on 2026-07-24. Eight of the
 * original thirteen endpoints failed. Five were corrected and are recorded
 * below with what they were; three regulators publish no usable feed at all
 * and are disabled with the reason on the entry. A disabled source never
 * appears in the connector's coverage, so a user is never shown a
 * jurisdiction we are not actually watching.
 *
 * Re-run `npm run verify:sources` after any change here. Feeds rot: two of
 * the five that passed the first sweep passed for the wrong reason, one
 * frozen since 2023 and one carrying no parseable dates, so the gate now
 * checks freshness and dates rather than just that a document arrives.
 *
 * Fields:
 *   id           stable slug, used in record ids, never reuse or rename
 *   regulator    short name shown to users
 *   jurisdiction ISO-ish code: CA, US, UK, EU
 *   name         what this specific feed carries
 *   feedUrl      the RSS or Atom endpoint
 *   homepage     human landing page, shown when a record has no direct link
 *   category     rules | enforcement | guidance | news
 *   enabled      false takes it out of ingest and out of coverage
 *   verified     set true only after a live pull has parsed successfully
 *   sparse       optional, true when an empty window is normal rather than
 *                broken, so verification warns instead of failing
 *   maxAgeDays   optional, override the staleness threshold for this feed
 *   linkOnly     optional, true when the source's terms bar commercial reuse of
 *                its text: answers carry title, date and link, never the summary
 *   sourceNotice optional, a line the source's terms require beside its material
 */

export const SOURCES = [
  // ---------------------------------------------------------------- Canada
  {
    id: 'ca-osfi-news',
    regulator: 'OSFI',
    jurisdiction: 'CA',
    // OSFI publishes one site-wide feed and no news-only feed, so this carries
    // bulletins, announcements and actuarial reports together. Named for what
    // it actually is, because coverage claims have to survive being checked.
    name: 'Site-wide publications',
    // Was /en/rss/news.xml, which 404s. This is the only feed OSFI serves.
    feedUrl: 'https://www.osfi-bsif.gc.ca/en/rss.xml',
    homepage: 'https://www.osfi-bsif.gc.ca/en/news',
    category: 'news',
    enabled: true,
    verified: true,
    // OSFI terms: commercial redistribution needs prior written permission.
    linkOnly: true,
  },
  {
    id: 'ca-osc-news',
    regulator: 'OSC',
    jurisdiction: 'CA',
    name: 'News and notices',
    // Was /en/rss/news.xml, which 404s, and osc.ca returns 403 to anything
    // that is not a browser. This Feedburner address is what the OSC's own
    // RSS page publishes.
    //
    // THIRD PARTY DEPENDENCY, REPLACE WHEN POSSIBLE: Feedburner is a Google
    // property sitting between us and the regulator. It can be retired
    // without the OSC deciding anything. Check periodically for a feed served
    // from osc.ca directly and move to it when one exists.
    feedUrl: 'https://feeds.feedburner.com/rss_osc_headlines_en',
    homepage: 'https://www.osc.ca/en/news-events',
    category: 'news',
    enabled: true,
    verified: true,
    // Held to title, date and link until the OSC's terms have been read.
    linkOnly: true,
  },
  {
    id: 'ca-ciro-bulletins',
    regulator: 'CIRO',
    jurisdiction: 'CA',
    name: 'Bulletins and notices',
    feedUrl: 'https://www.ciro.ca/rss/bulletins.xml',
    homepage: 'https://www.ciro.ca/newsroom',
    category: 'guidance',
    // Disabled 2026-07-24: ciro.ca returns 403 to every request including the
    // site root, under our user agent and a browser one alike, so there is
    // nothing to collect from any address. Worth retrying from the deployed
    // Worker in case the block is by IP rather than by client.
    enabled: false,
    verified: false,
  },

  // ------------------------------------------------------------ United States
  {
    id: 'us-sec-press',
    regulator: 'SEC',
    jurisdiction: 'US',
    name: 'Press releases',
    feedUrl: 'https://www.sec.gov/news/pressreleases.rss',
    homepage: 'https://www.sec.gov/news/pressreleases',
    category: 'news',
    enabled: true,
    verified: true,
  },
  // The SEC retired its own rules feeds. Its RSS index at /about/secrss now
  // lists press, speeches, statements, testimony and enforcement only, and
  // points at the Federal Register for rulemaking. The two entries below use
  // the Federal Register filtered by SEC as the issuing agency, which is the
  // authoritative record of a rule anyway.
  //
  // The old /rss/rules/proposed.xml still answers 200 and still parses, which
  // is exactly why it was dangerous: it has been frozen since 2023-07-26 and
  // would have shipped as live coverage.
  {
    id: 'us-sec-proposed-rules',
    regulator: 'SEC',
    jurisdiction: 'US',
    name: 'Proposed rules, via the Federal Register',
    feedUrl:
      'https://www.federalregister.gov/api/v1/documents.rss?conditions%5Bagencies%5D%5B%5D=securities-and-exchange-commission&conditions%5Btype%5D%5B%5D=PRORULE',
    homepage: 'https://www.sec.gov/rules-regulations/rulemaking-activity',
    category: 'rules',
    enabled: true,
    verified: true,
    // Rolling 30 day window on the Federal Register side. A quiet month is a
    // real state, not a fault.
    sparse: true,
  },
  {
    id: 'us-sec-final-rules',
    regulator: 'SEC',
    jurisdiction: 'US',
    name: 'Final rules, via the Federal Register',
    feedUrl:
      'https://www.federalregister.gov/api/v1/documents.rss?conditions%5Bagencies%5D%5B%5D=securities-and-exchange-commission&conditions%5Btype%5D%5B%5D=RULE',
    homepage: 'https://www.sec.gov/rules-regulations/rulemaking-activity',
    category: 'rules',
    enabled: true,
    verified: true,
    sparse: true,
  },
  {
    id: 'us-finra-notices',
    regulator: 'FINRA',
    jurisdiction: 'US',
    name: 'Regulatory notices',
    // Was /rss/notices.xml, which 404s.
    feedUrl: 'https://www.finra.org/rules-guidance/notices/rss',
    homepage: 'https://www.finra.org/rules-guidance/notices',
    category: 'guidance',
    // Paused 2 November 2026. FINRA's terms allow non-commercial use only and
    // bar building a database or using robots, so collection stops until FINRA
    // gives written permission. Records already held answer with title, date
    // and link only.
    enabled: false,
    verified: true,
    linkOnly: true,
  },
  {
    id: 'us-cftc-press',
    regulator: 'CFTC',
    jurisdiction: 'US',
    name: 'Press releases',
    feedUrl: 'https://www.cftc.gov/RSS/RSSGP/rssgp.xml',
    homepage: 'https://www.cftc.gov/PressRoom/PressReleases',
    category: 'news',
    enabled: true,
    verified: true,
  },

  // ---------------------------------------------------------- United Kingdom
  // With TPR disabled the FCA is the whole of the UK. If this feed breaks,
  // the jurisdiction goes dark, so it is the one to watch in list_coverage.
  {
    id: 'uk-fca-news',
    regulator: 'FCA',
    jurisdiction: 'UK',
    name: 'News and publications',
    // Endpoint was always correct. It passed the first sweep while producing
    // no usable dates at all: FCA stamps items "Thursday, July 23, 2026 -
    // 12:05", which Date.parse refuses. Handled in feedparser toIso now.
    feedUrl: 'https://www.fca.org.uk/news/rss.xml',
    homepage: 'https://www.fca.org.uk/news',
    category: 'news',
    enabled: true,
    verified: true,
    // FCA legal terms, clause 3.3: no reproduction in a retrieval system or
    // service without prior written permission.
    linkOnly: true,
  },
  {
    id: 'uk-tpr-news',
    regulator: 'TPR',
    jurisdiction: 'UK',
    name: 'Press releases and guidance',
    feedUrl: 'https://www.thepensionsregulator.gov.uk/en/media-hub/rss',
    homepage: 'https://www.thepensionsregulator.gov.uk/en/media-hub',
    category: 'guidance',
    // Disabled 2026-07-24: TPR publishes no RSS. The media hub declares no
    // feed, the site root declares no alternate feed link, and no address
    // pattern resolves. There is nothing here to point at.
    enabled: false,
    verified: false,
  },

  // ------------------------------------------------------- European Union
  {
    id: 'eu-esma-news',
    regulator: 'ESMA',
    jurisdiction: 'EU',
    name: 'News and press releases',
    // Endpoint was always correct. It failed the first sweep on our side, not
    // ESMA's: the XML parser's default entity expansion ceiling rejected a
    // valid document. Raised in feedparser now.
    feedUrl: 'https://www.esma.europa.eu/rss.xml',
    homepage: 'https://www.esma.europa.eu/press-news',
    category: 'news',
    // ESMA's legal notice: when its material is part of something sold, buyers
    // must be told it is free from ESMA.
    sourceNotice: 'This material is available free of charge on the ESMA website.',
    enabled: true,
    verified: true,
    // ESMA ships items with title, link and description and no date element
    // of any kind. Not a parser gap: there is nothing in the document to read.
    // The only other feed ESMA serves, /press-news/esma-news/rss.xml, answers
    // 200 and is empty.
    //
    // Kept enabled because the content is real and losing it would leave the
    // EU resting on the EBA alone. The cost is that these records sort and
    // filter by when we collected them, through COALESCE(published_at,
    // first_seen_at), so on first ingest the whole backfill looks like it
    // arrived today.
    //
    // Resolved by disclosing the fallback rather than dropping the source.
    // formatChange renders these as "first collected YYYY-MM-DD, publication
    // date not provided by source" instead of a bare date, and searchChanges
    // orders dated records above undated ones, so a collection timestamp
    // cannot outrank a real publication date. The flag stays set so the
    // exception is reported on every verification run rather than the
    // freshness floor being lowered for every source.
    datesUnavailable: true,
  },
  {
    id: 'eu-eiopa-news',
    regulator: 'EIOPA',
    jurisdiction: 'EU',
    name: 'News and publications',
    feedUrl: 'https://www.eiopa.europa.eu/rss.xml',
    homepage: 'https://www.eiopa.europa.eu/media/news_en',
    category: 'news',
    // Disabled 2026-07-24: EIOPA publishes no RSS. Nothing is declared on the
    // homepage, the media page or the Commission newsroom, and every address
    // pattern 404s, including the one its sibling ESMA serves.
    enabled: false,
    verified: false,
  },
  {
    id: 'eu-eba-news',
    regulator: 'EBA',
    jurisdiction: 'EU',
    name: 'News and press',
    feedUrl: 'https://www.eba.europa.eu/rss.xml',
    homepage: 'https://www.eba.europa.eu/publications-and-media',
    category: 'news',
    enabled: true,
    verified: true,
  },
];

/** Jurisdiction codes to display names, used in tool output. */
export const JURISDICTIONS = {
  CA: 'Canada',
  US: 'United States',
  UK: 'United Kingdom',
  EU: 'European Union',
};

/** @returns {typeof SOURCES} sources eligible for ingest */
export function enabledSources() {
  return SOURCES.filter((s) => s.enabled);
}

/** @returns {object|undefined} */
export function sourceById(id) {
  return SOURCES.find((s) => s.id === id);
}

/**
 * A record as it may be served. A linkOnly source loses its summary, on the
 * record and on every revision. Stored text stays stored; it is not served.
 * A source's required notice travels with the record.
 */
export function servable(row) {
  if (!row) return row;
  const source = sourceById(row.source_id);
  if (!source) return row;
  const out = { ...row };
  if (source.linkOnly) {
    out.summary = null;
    if (Array.isArray(row.revisions)) out.revisions = row.revisions.map((r) => ({ ...r, summary: null }));
  }
  if (source.sourceNotice) out.source_notice = source.sourceNotice;
  return out;
}

/** Sources whose stored text must not be searched, so a match cannot reveal it. */
export function linkOnlySourceIds() {
  return SOURCES.filter((s) => s.linkOnly).map((s) => s.id);
}
