#!/usr/bin/env node
/**
 * The live check the deploy pipeline runs after every production deploy (.github/workflows/deploy.yml):
 *
 *   node scripts/live-check.mjs https://bellwether.dap.solutions
 *
 * Three things, read over plain HTTPS, nothing paid and nothing sent but GETs:
 *   /llms.txt        200, text/plain
 *   /openapi.json    200, an OpenAPI 3.1 document
 *   /api/search      a bare GET, which asks only the price (isPriceProbe in src/api.js): 402, and its
 *                    PAYMENT-REQUIRED challenge asks exactly what it asked on 1 November 2026
 *
 * The challenge expected is the one recorded when the paid tier was switched on (CLAUDE.md, "Paid tier switched
 * on", 1 November 2026): 10000 atomic USDC, on eip155:8453 (Base), to the DAP wallet. It is written here, not
 * read from the code, on purpose: this check exists to catch a deploy that changed what paying agents are asked,
 * and a check that read its expectation from the code being deployed would pass any change. A deliberate price
 * change updates EXPECTED in the same pull request, where a person sees it.
 *
 * Edge propagation: straight after a deploy the edge can still answer from the previous version (CLAUDE.md,
 * licence.mjs check), so the check retries until every part passes or the attempts run out. Exit 0 on a pass,
 * 1 on a failure. The workflow rolls back on 1.
 */

/** What a bare call to a priced route asked for on 1 November 2026. */
export const EXPECTED = Object.freeze({
  amount: '10000',
  network: 'eip155:8453',
  payTo: '0xa590d98bbee97533bd7dfed19c0a89ffeeeb1384',
});

/** The priced route the challenge is read from: listed by the gate, and indexed by the Coinbase Bazaar. */
export const PAID_ROUTE = '/api/search';

/** The x402 challenge in a 402, from its PAYMENT-REQUIRED header (base64 JSON). */
export function readChallenge(response) {
  const raw = response.headers.get('payment-required');
  if (!raw) return { error: 'no PAYMENT-REQUIRED header' };
  try {
    return { challenge: JSON.parse(Buffer.from(raw.trim(), 'base64').toString('utf8')) };
  } catch {
    return { error: 'PAYMENT-REQUIRED is not base64 JSON' };
  }
}

/** Whether a challenge asks exactly what was expected: every option it offers, and at least one. */
export function challengeMatches(challenge, expected = EXPECTED) {
  const accepts = challenge && Array.isArray(challenge.accepts) ? challenge.accepts : [];
  if (accepts.length === 0) return { ok: false, detail: 'the challenge offers no payment option' };
  for (const option of accepts) {
    const got = `${option.amount} on ${option.network} to ${String(option.payTo).toLowerCase()}`;
    if (
      String(option.amount) !== expected.amount ||
      option.network !== expected.network ||
      String(option.payTo).toLowerCase() !== expected.payTo.toLowerCase()
    ) {
      return { ok: false, detail: `asks ${got}, expected ${expected.amount} on ${expected.network} to ${expected.payTo}` };
    }
  }
  const one = accepts[0];
  return { ok: true, detail: `${one.amount} on ${one.network} to ${String(one.payTo).toLowerCase()}` };
}

/**
 * One pass over the three checks.
 *
 * @param {string} origin  for example https://bellwether.dap.solutions
 * @param {{ fetch?: typeof fetch, expected?: typeof EXPECTED }} [options]
 * @returns {Promise<{ name: string, ok: boolean, detail: string }[]>}
 */
export async function checkOnce(origin, options = {}) {
  const get = options.fetch || fetch;
  const expected = options.expected || EXPECTED;
  const base = origin.replace(/\/+$/, '');
  const results = [];
  const attempt = async (name, run) => {
    try {
      results.push({ name, ...(await run()) });
    } catch (err) {
      results.push({ name, ok: false, detail: err && err.message ? err.message : String(err) });
    }
  };

  await attempt('/llms.txt is 200 text/plain', async () => {
    const r = await get(`${base}/llms.txt`, { headers: { 'Cache-Control': 'no-cache' } });
    const type = r.headers.get('content-type') || '';
    const body = await r.text();
    const ok = r.status === 200 && /^text\/plain\b/i.test(type) && body.startsWith('# DAP Bellwether');
    return { ok, detail: `${r.status} ${type || 'no content type'}` };
  });

  await attempt('/openapi.json is 200', async () => {
    const r = await get(`${base}/openapi.json`, { headers: { 'Cache-Control': 'no-cache' } });
    let version = 'not JSON';
    try {
      version = (await r.json()).openapi || 'no openapi field';
    } catch {
      // reported below
    }
    return { ok: r.status === 200 && version === '3.1.0', detail: `${r.status}, openapi ${version}` };
  });

  await attempt(`unpaid ${PAID_ROUTE} is 402 with the 1 November challenge`, async () => {
    const r = await get(`${base}${PAID_ROUTE}`);
    await r.text();
    if (r.status !== 402) return { ok: false, detail: `${r.status}, expected 402` };
    const { challenge, error } = readChallenge(r);
    if (error) return { ok: false, detail: error };
    return challengeMatches(challenge, expected);
  });

  return results;
}

/**
 * Retries until every check passes or the attempts run out, and returns the last pass.
 *
 * @param {string} origin
 * @param {{ fetch?: typeof fetch, expected?: typeof EXPECTED, attempts?: number, waitMs?: number }} [options]
 */
export async function checkLive(origin, options = {}) {
  const attempts = options.attempts ?? 12;
  const waitMs = options.waitMs ?? 10000;
  let results = [];
  for (let i = 1; i <= attempts; i++) {
    results = await checkOnce(origin, options);
    if (results.every((r) => r.ok)) return { ok: true, attempts: i, results };
    if (i < attempts) await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  return { ok: false, attempts, results };
}

/** A Markdown table of the results, for the run summary. */
export function report(origin, outcome) {
  const lines = [
    `Live check of ${origin}: ${outcome.ok ? 'PASS' : 'FAIL'} (attempt ${outcome.attempts})`,
    '',
    '| Check | Result | Detail |',
    '| --- | --- | --- |',
    ...outcome.results.map((r) => `| ${r.name} | ${r.ok ? 'PASS' : 'FAIL'} | ${r.detail.replace(/\|/g, '/')} |`),
    '',
  ];
  return lines.join('\n');
}

const invoked = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invoked) {
  const origin = process.argv[2];
  if (!origin || !/^https:\/\//.test(origin)) {
    console.error('Usage: node scripts/live-check.mjs https://bellwether.dap.solutions');
    process.exit(2);
  }
  const outcome = await checkLive(origin);
  console.log(report(origin, outcome));
  process.exit(outcome.ok ? 0 : 1);
}
