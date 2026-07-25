/**
 * Feed parsing and normalisation.
 *
 * Regulators publish RSS 2.0, RSS 1.0 (RDF) and Atom, inconsistently, and some
 * of them change format without notice. Everything downstream of this file
 * sees one record shape and never has to care which dialect arrived.
 */

import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  parseTagValue: false,
  // Keep everything as strings. Dates and ids that look numeric must not be
  // coerced, because a guid like 20260714 silently becoming a number breaks
  // record identity between runs.
  parseAttributeValue: false,
  // The library defaults to 1000 total entity expansions as a guard against
  // expansion bombs. Regulators put escaped HTML inside description elements,
  // so an ordinary feed blows past 1000 on volume alone: ESMA failed on a
  // valid 50KB document at 1002. The guard is kept, because these responses
  // are still remote input, but the ceiling is raised to something feed
  // shaped rather than something that rejects real regulators.
  processEntities: {
    enabled: true,
    maxTotalExpansions: 100000,
    maxExpandedLength: 5000000,
    maxEntityCount: 10000,
  },
});

/**
 * @typedef {object} FeedItem
 * @property {string} guid    stable identifier within the source
 * @property {string} title
 * @property {string|null} url
 * @property {string} summary
 * @property {string|null} publishedAt  ISO 8601, or null when unparseable
 */

/** Coerce fast-xml-parser output (string, object, or array) to a string. */
function text(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return text(value[0]);
  if (typeof value === 'object') {
    if ('#text' in value) return text(value['#text']);
    return '';
  }
  return '';
}

/** Always return an array, whether the parser gave one, none, or many. */
function list(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Strip tags and collapse whitespace. Summaries arrive as escaped HTML. */
export function stripHtml(input) {
  return String(input || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Truncate on a word boundary so summaries stay readable in a chat response. */
export function truncate(input, max = 600) {
  const s = String(input || '');
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + '...';
}

/**
 * Second chance for date strings a reader finds unambiguous but Date.parse
 * rejects.
 *
 * FCA publishes "Thursday, July 23, 2026 - 12:05". The separator in front of
 * the time is the only reason that fails, and the cost of failing is that
 * every UK record lands with no date at all, which quietly breaks recency
 * search for the jurisdiction while still looking like a healthy feed.
 *
 * Only the separator is rewritten, and only after Date.parse has already
 * refused the original, so nothing that parses today changes shape.
 *
 * The time carries no zone, so it reads as UTC in the Worker while FCA means
 * London time. That is up to an hour out in summer. For a feed whose unit of
 * meaning is the day that is within tolerance, and it beats null.
 */
function retryDate(raw) {
  return raw.replace(/(\d{4})\s+-\s+(\d{1,2}:\d{2})/, '$1 $2');
}

/**
 * Parse a date into ISO 8601. Returns null rather than guessing, because a
 * wrong date is worse than a missing one when the whole product is "what
 * changed and when".
 */
export function toIso(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  let ms = Date.parse(raw);
  if (Number.isNaN(ms)) ms = Date.parse(retryDate(raw));
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

/** Pull the usable href out of an Atom link, which may be an array of rels. */
function atomLink(entry) {
  const links = list(entry.link);
  const candidates = links
    .map((l) => (typeof l === 'string' ? { href: l, rel: 'alternate' } : { href: l['@_href'], rel: l['@_rel'] || 'alternate' }))
    .filter((l) => l.href);
  const alternate = candidates.find((l) => l.rel === 'alternate');
  return (alternate || candidates[0] || {}).href || null;
}

function parseRssItem(item) {
  const link = text(item.link) || null;
  const guid = text(item.guid) || link || text(item.title);
  const summary = stripHtml(text(item.description) || text(item['content:encoded']));
  return {
    guid,
    title: stripHtml(text(item.title)),
    url: link,
    summary: truncate(summary),
    publishedAt: toIso(text(item.pubDate) || text(item['dc:date'])),
  };
}

function parseAtomEntry(entry) {
  const link = atomLink(entry);
  const guid = text(entry.id) || link || text(entry.title);
  const summary = stripHtml(text(entry.summary) || text(entry.content));
  return {
    guid,
    title: stripHtml(text(entry.title)),
    url: link,
    summary: truncate(summary),
    publishedAt: toIso(text(entry.updated) || text(entry.published)),
  };
}

/**
 * Parse a feed document into normalised items.
 *
 * @param {string} xml raw feed body
 * @returns {FeedItem[]}
 * @throws {Error} when the document is not a feed we recognise
 */
export function parseFeed(xml) {
  if (!xml || !xml.trim()) throw new Error('empty feed body');

  let doc;
  try {
    doc = parser.parse(xml);
  } catch (err) {
    throw new Error(`XML parse failed: ${err.message}`);
  }

  // RSS 2.0
  if (doc.rss && doc.rss.channel) {
    const items = list(doc.rss.channel.item);
    return items.map(parseRssItem).filter((i) => i.guid && i.title);
  }

  // RSS 1.0 / RDF, where items are siblings of channel rather than children
  if (doc['rdf:RDF']) {
    const items = list(doc['rdf:RDF'].item);
    return items
      .map((item) => {
        const normalised = parseRssItem(item);
        if (!normalised.guid) normalised.guid = text(item['@_rdf:about']);
        return normalised;
      })
      .filter((i) => i.guid && i.title);
  }

  // Atom
  if (doc.feed) {
    const entries = list(doc.feed.entry);
    return entries.map(parseAtomEntry).filter((i) => i.guid && i.title);
  }

  throw new Error('unrecognised feed format: expected rss, rdf:RDF or feed root');
}
