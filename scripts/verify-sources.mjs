#!/usr/bin/env node
/**
 * Verify every source in the registry against the live web.
 *
 * Run this before the first deploy and after any registry change:
 *   npm run verify:sources
 *
 * This is the gate that turns an assumption into an observation. Regulators
 * move and retire feeds often, so an endpoint written from documentation is a
 * guess until something pulls it.
 *
 * It checks more than "did a document arrive", because the first sweep of this
 * registry proved that is not enough. Two of five passes were false: the SEC
 * proposed rules feed answered 200 and parsed cleanly while frozen since 2023,
 * and the FCA feed returned twenty items with not one parseable date, which
 * would have put the whole UK into the store with no date on any record. Both
 * would have shipped as healthy coverage. So a source has to resolve, parse,
 * carry something recent, and carry dates before it counts as verified.
 *
 * Anything that fails here gets fixed or gets `enabled: false`. A jurisdiction
 * we cannot actually collect must never appear in the connector's coverage.
 */

import { parseFeed } from '../src/feedparser.js';
import { SOURCES } from '../src/sources.js';

const TIMEOUT_MS = 20000;
const USER_AGENT =
  'DAP-Bellwether/1.0 (+https://dap.solutions/bellwether; regulatory change monitor)';

// A feed whose newest item predates this is not being maintained, whatever it
// answers over HTTP. Override per source with maxAgeDays where a slower
// publication rhythm is genuinely normal.
const MAX_AGE_DAYS = 90;

// Records without a date cannot be searched by recency, and recency is most of
// what this connector is for. A feed is allowed a few undated stragglers, not
// a majority.
const MIN_DATED_RATIO = 0.8;

const DAY_MS = 86400000;

async function check(source) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(source.feedUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
      redirect: 'follow',
    });

    if (!response.ok) {
      return { status: 'fail', reason: `HTTP ${response.status} ${response.statusText}`, ms: Date.now() - started };
    }

    const body = await response.text();
    const items = parseFeed(body);

    const base = {
      ms: Date.now() - started,
      items: items.length,
      finalUrl: response.url !== source.feedUrl ? response.url : null,
    };

    if (!items.length) {
      // An empty window is a real state for a feed carrying a rolling slice of
      // a slow publication stream. Say so, rather than either failing a
      // healthy source or waving it through in silence.
      if (source.sparse) {
        return {
          ...base,
          status: 'warn',
          reason: 'no items in the current window, allowed because this source is marked sparse',
        };
      }
      return { ...base, status: 'fail', reason: 'parsed but contained zero items' };
    }

    const dated = items.filter((i) => i.publishedAt).length;
    const linked = items.filter((i) => i.url).length;
    const newest = items
      .map((i) => i.publishedAt)
      .filter(Boolean)
      .sort()
      .pop();

    const detail = {
      ...base,
      dated,
      linked,
      newest: newest ? newest.slice(0, 10) : 'unknown',
      sample: items[0].title.slice(0, 70),
    };

    const ratio = dated / items.length;
    if (ratio < MIN_DATED_RATIO) {
      // A source can carry no dates because the publisher ships none, which is
      // a standing property of the feed rather than a fault to chase. That is
      // waived per source and stays visible on every run, because the records
      // then sort by collection time and anyone reading coverage deserves to
      // know that. The floor is never lowered globally to accommodate it.
      if (source.datesUnavailable) {
        return {
          ...detail,
          status: 'warn',
          reason:
            `${dated} of ${items.length} items carry a parseable date. Waived: this publisher ships no date ` +
            'element, so these records sort and filter by collection time, not publication time.',
        };
      }
      return {
        ...detail,
        status: 'fail',
        reason:
          `only ${dated} of ${items.length} items carry a parseable date ` +
          `(${Math.round(ratio * 100)} percent, floor is ${Math.round(MIN_DATED_RATIO * 100)}). ` +
          'The feed resolves, so check its date format against toIso in src/feedparser.js before blaming the endpoint.',
      };
    }

    const limitDays = source.maxAgeDays || MAX_AGE_DAYS;
    const ageDays = Math.floor((Date.now() - Date.parse(newest)) / DAY_MS);
    if (ageDays > limitDays) {
      return {
        ...detail,
        status: 'fail',
        reason:
          `newest item is ${ageDays} days old (${detail.newest}), past the ${limitDays} day threshold. ` +
          'The endpoint answers but is not being maintained. Find the feed that replaced it.',
      };
    }

    return { ...detail, status: 'pass', ageDays };
  } catch (err) {
    return { status: 'fail', reason: err && err.message ? err.message : String(err), ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

const failures = [];
const warnings = [];
const passes = [];

const active = SOURCES.filter((s) => s.enabled);
const skipped = SOURCES.filter((s) => !s.enabled);

console.log(`Verifying ${active.length} enabled sources against the live web.`);
console.log(
  `Freshness threshold ${MAX_AGE_DAYS} days, dated items floor ${Math.round(MIN_DATED_RATIO * 100)} percent.\n`
);

for (const source of active) {
  const label = `${source.jurisdiction} ${source.regulator} ${source.id}`;
  const result = await check(source);

  if (result.status === 'pass') {
    passes.push({ source, result });
    console.log(`PASS  ${label}`);
    console.log(
      `      ${result.items} items, ${result.dated} dated, ${result.linked} linked, newest ${result.newest} (${result.ageDays}d old), ${result.ms}ms`
    );
    if (result.finalUrl) console.log(`      redirected to ${result.finalUrl}`);
    console.log(`      e.g. "${result.sample}"`);
  } else if (result.status === 'warn') {
    warnings.push({ source, result });
    console.log(`WARN  ${label}`);
    console.log(`      ${result.reason}`);
  } else {
    failures.push({ source, result });
    console.log(`FAIL  ${label}`);
    console.log(`      ${source.feedUrl}`);
    console.log(`      ${result.reason}`);
  }
  console.log('');
}

if (skipped.length) {
  console.log('Disabled, not verified and not in coverage:');
  for (const source of skipped) {
    console.log(`  ${source.id} (${source.regulator}, ${source.jurisdiction})`);
  }
  console.log('');
}

console.log('---');
console.log(
  `${passes.length} passed, ${warnings.length} warned, ${failures.length} failed, ${skipped.length} disabled.`
);

// Coverage is the claim the connector makes, so state plainly what survived,
// and call out any jurisdiction resting on one regulator.
const byJurisdiction = {};
for (const { source } of [...passes, ...warnings]) {
  (byJurisdiction[source.jurisdiction] ||= []).push(source.regulator);
}
console.log('\nCollectable coverage:');
for (const code of Object.keys(byJurisdiction).sort()) {
  const regulators = [...new Set(byJurisdiction[code])];
  const thin = regulators.length === 1 ? '   <- single regulator, this jurisdiction goes dark if it breaks' : '';
  console.log(`  ${code}: ${regulators.join(', ')}${thin}`);
}

if (failures.length) {
  console.log('\nFix or disable before deploying:');
  for (const { source, result } of failures) {
    console.log(`  ${source.id}: ${result.reason}`);
  }
  console.log("\nFor each failure, find the current feed on the regulator's site and update");
  console.log('feedUrl in src/sources.js, or set enabled: false to drop it from coverage.');
  process.exit(1);
}

console.log('\nAll enabled sources verified. Set verified: true in src/sources.js and deploy.');
