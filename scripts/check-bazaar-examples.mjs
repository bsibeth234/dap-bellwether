#!/usr/bin/env node
/**
 * Refuses a deploy whose Bazaar listings would show the made-up test regulator. src/bazaar-examples.json
 * is built from real publications only on a machine that can reach the regulators' feeds:
 *
 *   npm run build:bazaar -- --feeds && npm test
 *
 * Run by `npm run deploy` before wrangler, so an example a person never published cannot reach a public
 * listing (no invented facts).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const text = readFileSync(join(here, '..', 'src', 'bazaar-examples.json'), 'utf8');
if (/TESTREG|example\.test|test regulator/i.test(text)) {
  console.error('Stopped: the Bazaar examples come from the test regulator, not real publications.');
  console.error('Run on a machine that reaches the feeds: npm run build:bazaar -- --feeds && npm test, then deploy again.');
  process.exit(1);
}
console.log('Bazaar examples are built from real publications.');
