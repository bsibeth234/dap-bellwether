/**
 * The JSON API for agents: the same records as the connector, as JSON over
 * plain HTTPS GET, for agents and systems that do not speak MCP.
 *
 *   GET /api/search        priced from the first call
 *   GET /api/recent        priced from the first call
 *   GET /api/change?id=    priced from the first call
 *   GET /api/coverage      free
 *
 * Three ways to be answered, checked in this order:
 *   a bad request        400, before any payment is asked for, never charged
 *   a DAP licence key    answered and counted against the licence (licences.js)
 *   an x402 payment      verified, answered, settled, then released (the gate)
 * Without either, a priced endpoint answers 402 with the price.
 *
 * Only the gate ever runs a priced answer for a paying caller, and it runs it
 * only after the payment verifies. Which paths are priced is read from the
 * gate's own price list (pricedByGate), so the router here can never answer a
 * spelling of a path that the gate would have let through unpriced.
 */

import { canonicalPath } from './x402/path.ts';
import { decodeHeader, encodeHeader } from './x402/codec.ts';
import { searchChanges, getChange, getSourceHealth, countChanges, lastIngestRun } from './db.js';
import { JURISDICTIONS, SOURCES, enabledSources } from './sources.js';
import { CATEGORIES, JURISDICTION_CODES, dateBound } from './tools.js';
import { API_ENDPOINTS, pricingFor } from './pricing.js';
import { countLicensedCall, licenceRefused, licenceUnavailable, readLicence } from './licences.js';
import { MAX_PAYMENT_VALIDITY_SECONDS, recordUsage, utcDay } from './payments.js';

const NOTICE = 'This is a public information service. It is not legal or compliance advice. Use is under the DAP API terms: https://dap.solutions/terms/api/.';
const COVERAGE_NOTE =
  'Coverage begins from when this service first collected each source, so older material may not be present. Check /api/coverage before reading an absence of results as an absence of publications.';

const BASE_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'PAYMENT-REQUIRED, PAYMENT-RESPONSE',
};

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, ...extra } });
}

function badRequest(message) {
  return json({ error: 'invalid_request', message }, 400);
}

/**
 * Which endpoint a canonical path names.
 * @returns {{ name: string, tool?: string, id?: string } | null}
 */
export function resolveEndpoint(canonical) {
  if (canonical === '/api/coverage') return { name: 'coverage' };
  for (const endpoint of API_ENDPOINTS) {
    if (!endpoint.path.endsWith('*')) {
      if (canonical === endpoint.path) return { name: endpoint.name, tool: endpoint.tool };
      continue;
    }
    // A wildcard endpoint covers its directory and everything under it, as the gate prices it.
    const prefix = endpoint.path.slice(0, -1);
    if (canonical === prefix.slice(0, -1) || canonical.startsWith(prefix)) return { name: endpoint.name, tool: endpoint.tool };
  }
  return null;
}

/**
 * Whether the gate's price list covers this canonical path, by the gate's own
 * rule: an exact path, or a wildcard prefix (which also covers the bare
 * directory). A priced endpoint the gate would not price is refused, never
 * answered free.
 */
export function pricedByGate(gateRoutes, canonical) {
  return gateRoutes.some(({ path }) => {
    if (!path.endsWith('*')) return canonicalPath(path) === canonical;
    const base = path.slice(0, -1);
    const root = canonicalPath(base);
    const key = base.endsWith('/') && root !== '/' ? `${root}/` : root;
    return canonical.startsWith(key) || `${canonical}/` === key;
  });
}

const ALLOWED = {
  search: ['query', 'jurisdiction', 'regulator', 'category', 'since', 'until', 'limit'],
  recent: ['jurisdiction', 'days', 'limit'],
  change: ['id'],
};

function wholeNumber(raw, name, min, max) {
  if (!/^\d{1,4}$/.test(raw)) return { error: `${name} must be a whole number from ${min} to ${max}.` };
  const n = Number(raw);
  if (n < min || n > max) return { error: `${name} must be a whole number from ${min} to ${max}.` };
  return { value: n };
}

/**
 * The query, checked before any payment is asked for. Strict on purpose: a
 * misspelt filter would otherwise return an unfiltered answer the agent paid for.
 *
 * @returns {{ params: object } | { error: string }}
 */
export function parseParams(endpoint, searchParams) {
  const allowed = ALLOWED[endpoint.name];
  const seen = new Set();
  for (const key of searchParams.keys()) {
    if (!allowed.includes(key)) {
      return {
        error: allowed.length
          ? `Unknown parameter "${key}". This endpoint takes: ${allowed.join(', ')}.`
          : `This endpoint takes no query parameters.`,
      };
    }
    if (seen.has(key)) return { error: `Send "${key}" once.` };
    seen.add(key);
  }
  const get = (key) => searchParams.get(key);
  const params = {};

  if (endpoint.name === 'change') {
    const id = get('id');
    if (id === null || !/^[0-9a-f]{32}$/.test(id)) {
      return { error: 'id is required: 32 lower case hexadecimal characters, from a search or recent result.' };
    }
    params.id = id;
    return { params };
  }

  const jurisdiction = get('jurisdiction');
  if (jurisdiction !== null) {
    const code = jurisdiction.toUpperCase();
    if (!JURISDICTION_CODES.includes(code)) return { error: `jurisdiction must be one of ${JURISDICTION_CODES.join(', ')}.` };
    params.jurisdiction = code;
  }
  const limit = get('limit');
  if (limit !== null) {
    const parsed = wholeNumber(limit, 'limit', 1, 100);
    if (parsed.error) return parsed;
    params.limit = parsed.value;
  }

  if (endpoint.name === 'recent') {
    const days = get('days');
    if (days !== null) {
      const parsed = wholeNumber(days, 'days', 1, 365);
      if (parsed.error) return parsed;
      params.days = parsed.value;
    }
    return { params };
  }

  const query = get('query');
  if (query !== null) {
    if (query.trim() === '' || query.length > 200) return { error: 'query must be 1 to 200 characters.' };
    params.query = query.trim();
  }
  const regulator = get('regulator');
  if (regulator !== null) {
    if (!/^[A-Za-z0-9 .&]{1,20}$/.test(regulator)) return { error: 'regulator is a short name such as OSFI, SEC, FCA or ESMA.' };
    params.regulator = regulator;
  }
  const category = get('category');
  if (category !== null) {
    if (!CATEGORIES.includes(category)) return { error: `category must be one of ${CATEGORIES.join(', ')}.` };
    params.category = category;
  }
  for (const key of ['since', 'until']) {
    const value = get(key);
    if (value === null) continue;
    const bound = dateBound(value, key);
    if (bound === null) return { error: `${key} must be an ISO 8601 date or timestamp, for example 2026-10-01.` };
    params[key] = bound;
  }
  return { params };
}

/** One record as JSON. A date the regulator did not publish is null, never our collection time. */
function record(row) {
  return {
    id: row.id,
    regulator: row.regulator,
    jurisdiction: row.jurisdiction,
    category: row.category,
    title: row.title,
    summary: row.summary || null,
    url: row.url || null,
    ...(row.source_notice ? { source_notice: row.source_notice } : {}),
    published_at: row.published_at || null,
    first_collected_at: row.first_seen_at,
    last_confirmed_at: row.last_seen_at,
    revision: row.revision,
  };
}

/** The answer for a checked request. Runs only after a licence or a verified payment. */
async function answer(endpoint, params, env) {
  if (endpoint.name === 'change') {
    const found = await getChange(env.DB, params.id);
    if (!found) return json({ error: 'not_found', message: `No record with id ${params.id}.` }, 404);
    return json({
      record: record(found),
      revisions: found.revisions.map((r) => ({
        revision: r.revision,
        observed_at: r.observed_at,
        title: r.title || null,
        summary: r.summary || null,
        url: r.url || null,
      })),
      notice: NOTICE,
    });
  }
  let rows;
  if (endpoint.name === 'recent') {
    const days = params.days || 14;
    rows = await searchChanges(env.DB, {
      jurisdiction: params.jurisdiction,
      since: new Date(Date.now() - days * 86400000).toISOString(),
      limit: params.limit || 25,
    });
  } else {
    rows = await searchChanges(env.DB, { ...params, limit: params.limit || 20 });
  }
  return json({ count: rows.length, records: rows.map(record), coverage_note: COVERAGE_NOTE, notice: NOTICE });
}

/** What is monitored and how fresh it is. Free, always. */
export async function coverage(env) {
  const [health, total, lastRun] = await Promise.all([getSourceHealth(env.DB), countChanges(env.DB), lastIngestRun(env.DB)]);
  return {
    records: total,
    feeds: enabledSources().map((s) => {
      const h = health[s.id] || {};
      return {
        regulator: s.regulator,
        jurisdiction: s.jurisdiction,
        jurisdiction_name: JURISDICTIONS[s.jurisdiction] || s.jurisdiction,
        feed: s.name,
        last_collected_at: h.last_ok_at || null,
        consecutive_failures: h.consecutive_failures || 0,
      };
    }),
    not_monitored: SOURCES.filter((s) => !s.enabled).map((s) => ({
      regulator: s.regulator,
      jurisdiction: s.jurisdiction,
      feed: s.name,
    })),
    last_run: lastRun
      ? {
          finished_at: lastRun.finished_at,
          sources_ok: lastRun.sources_ok,
          sources_failed: lastRun.sources_failed,
          inserted: lastRun.inserted,
          revised: lastRun.revised,
        }
      : null,
    coverage_note: COVERAGE_NOTE,
    notice: NOTICE,
  };
}

/** Usage is a side record. It never delays or breaks an answer. */
function note(env, ctx, day, tool, outcome) {
  if (!env || !env.DB) return;
  const job = recordUsage(env.DB, day, tool, outcome).catch((err) => {
    console.error(`Bellwether usage count failed: ${err && err.message ? err.message : String(err)}`);
  });
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(job);
}

const VALID_BEFORE_ERROR = 'invalid_exact_evm_payload_authorization_valid_before';

/** Whether a payment's validBefore reaches past what a claim can cover (same rule as /mcp). */
function outlivesClaim(raw, nowMs) {
  let payment;
  try {
    payment = decodeHeader(raw);
  } catch {
    return false; // the gate refuses it
  }
  const validBefore =
    payment && payment.payload && payment.payload.authorization ? payment.payload.authorization.validBefore : undefined;
  if (typeof validBefore !== 'string' || !/^\d{1,20}$/.test(validBefore)) return false;
  return Number(validBefore) > Math.floor(nowMs / 1000) + MAX_PAYMENT_VALIDITY_SECONDS;
}

/** The gate's price for this request, with the reason a payment was refused. */
async function priceWithError(request, gate, code) {
  const headers = new Headers(request.headers);
  headers.delete('PAYMENT-SIGNATURE');
  const bare = new Request(request.url, { method: 'GET', headers });
  const response = await gate.handle(bare, () => json({ error: 'unreachable' }, 500));
  let body;
  try {
    body = await response.clone().json();
  } catch {
    return response;
  }
  body.error = code;
  const out = new Headers(response.headers);
  out.set('PAYMENT-REQUIRED', encodeHeader(body));
  out.delete('content-length');
  return new Response(JSON.stringify(body), { status: response.status, headers: out });
}

/** A 503 for a request the service could not answer. Nothing was charged or counted. */
function unanswerable(err) {
  console.error(`Bellwether API could not answer: ${err && err.message ? err.message : String(err)}`);
  return json({ error: 'service_unavailable', message: 'The service could not answer. Nothing was charged. Retry shortly.' }, 503, { 'Retry-After': '2' });
}

function outcomeOf(response, paying) {
  if (response.status === 402) return 'challenged';
  if (response.status < 400 && response.headers.has('PAYMENT-RESPONSE')) return 'paid';
  return paying ? 'not_charged' : 'challenged';
}

/**
 * Handle a request under /api.
 *
 * @param {Request} request
 * @param {object} env
 * @param {object} [ctx]
 * @param {{ facilitator?: object, now?: () => number }} [overrides]  tests only
 */
export async function handleApi(request, env, ctx, overrides) {
  const url = new URL(request.url);
  const canonical = canonicalPath(url.pathname);
  if (canonical === null) return json({ error: 'invalid_path' }, 400);
  const endpoint = resolveEndpoint(canonical);
  if (!endpoint) {
    return json({ error: 'not_found', message: 'See https://bellwether.dap.solutions/openapi.json for the endpoints.' }, 404);
  }
  const method = request.method.toUpperCase();
  const now = (overrides && overrides.now) || Date.now;
  const day = utcDay(now());

  if (endpoint.name === 'coverage') {
    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', Allow: 'GET, HEAD, OPTIONS' },
      });
    }
    if (method !== 'GET' && method !== 'HEAD') return json({ error: 'method_not_allowed' }, 405, { Allow: 'GET, HEAD, OPTIONS' });
    const response = json(await coverage(env));
    return method === 'HEAD' ? new Response(null, { status: 200, headers: response.headers }) : response;
  }

  const tool = `api:${endpoint.name}`;
  let params = null;
  if (method === 'GET') {
    const parsed = parseParams(endpoint, url.searchParams);
    if (parsed.error) return badRequest(parsed.error);
    params = parsed.params;

    const licence = await readLicence(request, env);
    if (licence.status === 'invalid') return licenceRefused();
    if (licence.status === 'unavailable') return licenceUnavailable();
    if (licence.status === 'valid') {
      let response;
      try {
        response = await answer(endpoint, params, env);
      } catch (err) {
        return unanswerable(err);
      }
      if (response.status >= 400) return response;
      // Every licensed answer is counted before it is released, or not released.
      if (!(await countLicensedCall(env.LICENCES, day, licence.licence.id, tool))) return licenceUnavailable();
      note(env, ctx, day, tool, 'licensed');
      return response;
    }
  }

  const pricing = pricingFor(env, overrides);
  if (pricing.status !== 'on') {
    // With the paid tier off, nothing is charged anywhere.
    if (method === 'GET') {
      note(env, ctx, day, tool, 'unmetered');
      try {
        return await answer(endpoint, params, env);
      } catch (err) {
        return unanswerable(err);
      }
    }
    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', Allow: 'GET, OPTIONS' },
      });
    }
    return json({ error: 'method_not_allowed' }, 405, { Allow: 'GET, OPTIONS' });
  }

  // Never answer a priced endpoint the gate would let through unpriced.
  if (!pricedByGate(pricing.gate.routes, canonical)) {
    console.error(`Bellwether API path ${canonical} is not on the gate's price list`);
    return json({ error: 'not_priced' }, 500);
  }

  const signature = request.headers.get('PAYMENT-SIGNATURE');
  if (method === 'GET' && signature !== null && outlivesClaim(signature, now())) {
    note(env, ctx, day, tool, 'challenged');
    return priceWithError(request, pricing.gate, VALID_BEFORE_ERROR);
  }

  let response;
  try {
    response = await pricing.gate.handle(request, () => answer(endpoint, params, env));
  } catch (err) {
    // The claim (taken before verification) or the answer threw. The gate
    // releases the claim when the answer throws and settles nothing, so
    // nothing was charged.
    return unanswerable(err);
  }
  if (method === 'GET') note(env, ctx, day, tool, outcomeOf(response, signature !== null));
  return response;
}
