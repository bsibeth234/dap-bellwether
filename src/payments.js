/**
 * The metered MCP endpoint: a free daily allowance per caller, then x402.
 *
 *   initialize, tools/list, list_coverage    always free, never counted per caller
 *   a data tool, within the allowance       answered free, one more on the caller's count
 *   a data tool, past the allowance         a payment required result, with the price
 *   a data tool, with a payment attached    verified, answered, settled, then released
 *   a call that fails                        never charged
 *
 * With the paid tier off, every call is free and nothing is counted per caller.
 * In both states a daily total per tool, with no caller attached, is kept so
 * we know what the service is actually used for.
 *
 * The caller is the network address the request came from, IPv6 taken to its
 * /64 because one host usually holds a whole /64. It is never stored. What is
 * stored is a keyed one-way hash of it, bound to the day, and the rows are
 * deleted by the first scheduled run after that day ends.
 *
 * The server always receives the text that was inspected here. A message that
 * cannot be read as one JSON-RPC message the same way twice is refused rather
 * than passed through unpriced.
 */

import { handleMcpRequest, isAllowedOrigin } from './mcp.js';
import { METERED_TOOLS, pricingFor } from './pricing.js';
import { TOOLS } from './tools.js';

/** Largest request body read. MCP messages here are a few hundred bytes. */
export const MAX_BODY_BYTES = 64 * 1024;

const PAYMENT_META = 'x402/payment';
const PAYMENT_RESPONSE_META = 'x402/payment-response';
const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));
const METERED = new Set(METERED_TOOLS.map(fold));

/** Unicode compatibility form, lower case, as the gate folds names. */
function fold(value) {
  return value.normalize('NFKC').trim().toLowerCase();
}

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The UTC day a timestamp falls on, as YYYY-MM-DD. */
export function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The next 00:00 UTC after a timestamp, as an ISO string. */
function nextReset(ms) {
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
}

/**
 * What a message is, for metering.
 *   other      not a tool call
 *   free       a tool call to an unmetered tool
 *   metered    a tool call to a metered tool
 *   malformed  something a lenient reader might still run as a tool call
 *
 * @returns {{ kind: 'other'|'free'|'metered'|'malformed', tool: string|null }}
 */
export function classify(message) {
  if (!isObject(message)) return { kind: 'other', tool: null };
  const method = message.method;
  if (typeof method !== 'string' || fold(method) !== 'tools/call') return { kind: 'other', tool: null };
  const params = message.params;
  const name = isObject(params) ? params.name : undefined;
  if (method !== 'tools/call' || typeof name !== 'string') return { kind: 'malformed', tool: null };
  const tool = TOOL_NAMES.has(name) ? name : null;
  return { kind: METERED.has(fold(name)) ? 'metered' : 'free', tool };
}

function hasPayment(message) {
  const meta = isObject(message.params) ? message.params._meta : undefined;
  return isObject(meta) && meta[PAYMENT_META] !== undefined;
}

/**
 * The caller's network address, as metered. IPv4 whole, IPv6 to its /64.
 * Never stored: only its keyed hash is.
 */
export function callerAddress(request) {
  const raw = (request.headers.get('CF-Connecting-IP') || '').trim().toLowerCase();
  if (!raw) return 'unknown';
  if (!raw.includes(':')) return raw;
  const mapped = /^(?:0{0,4}:){0,5}:?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(raw);
  if (mapped) return mapped[1];
  const [head, tail] = raw.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups =
    tail === undefined ? left : [...left, ...Array(Math.max(8 - left.length - right.length, 0)).fill('0'), ...right];
  return `${groups
    .slice(0, 4)
    .map((g) => g.padStart(4, '0'))
    .join(':')}::/64`;
}

let hmacKey = { secret: null, key: null };

/** A keyed one-way hash of the caller, bound to the day, so no two days link. */
export async function callerHash(secret, day, address) {
  if (hmacKey.secret !== secret) {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    hmacKey = { secret, key };
  }
  const mac = await crypto.subtle.sign('HMAC', hmacKey.key, new TextEncoder().encode(`${day}|${address}`));
  return [...new Uint8Array(mac).slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Adds one to the caller's count for the day and returns the new count. */
export async function countCall(db, day, caller) {
  const row = await db
    .prepare(
      'INSERT INTO allowance_counts (day, caller, calls) VALUES (?, ?, 1) ' +
        'ON CONFLICT (day, caller) DO UPDATE SET calls = calls + 1 RETURNING calls'
    )
    .bind(day, caller)
    .first();
  return Number(row.calls);
}

/** Adds one to a tool's daily total for an outcome. No caller is recorded. */
export async function recordUsage(db, day, tool, outcome) {
  await db
    .prepare(
      'INSERT INTO tool_usage_daily (day, tool, outcome, calls) VALUES (?, ?, ?, 1) ' +
        'ON CONFLICT (day, tool, outcome) DO UPDATE SET calls = calls + 1'
    )
    .bind(day, tool, outcome)
    .run();
}

/** Deletes every allowance count from a day that has ended. Run by the cron. */
export async function purgeAllowanceCounts(db, nowMs) {
  const result = await db.prepare('DELETE FROM allowance_counts WHERE day < ?').bind(utcDay(nowMs)).run();
  return (result && result.meta && result.meta.changes) || 0;
}

/** Usage is a side record. It never delays or breaks an answer. */
function noteUsage(env, ctx, day, tool, outcome) {
  if (!tool || !env || !env.DB) return;
  const job = recordUsage(env.DB, day, tool, outcome).catch((err) => {
    console.error(`Bellwether usage count failed: ${err && err.message ? err.message : String(err)}`);
  });
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(job);
}

/**
 * Reads a request body without holding more than `max` bytes, then decodes it
 * as UTF-8 the way Request.json() does, so what is inspected here is what the
 * server would have read.
 */
async function readCapped(request, max) {
  const declared = request.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared) > max) return null;
  if (request.body === null) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder('utf-8').decode(bytes);
}

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  Vary: 'Accept',
};

function rpcError(id, code, message, status) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), {
    status,
    headers: JSON_HEADERS,
  });
}

/** A copy of the request carrying exactly this text. */
function withBody(request, text) {
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  return new Request(request.url, { method: 'POST', headers, body: text });
}

/**
 * The gate's payment required result, plus one line a person can read. The
 * x402 body stays first and untouched, so a paying client parses what it
 * expects; the explanation is for the model, and through it the user.
 */
async function explainAllowance(response, pricing, nowMs) {
  let body;
  try {
    body = await response.clone().json();
  } catch {
    return response;
  }
  const result = body && body.result;
  if (!isObject(result) || !Array.isArray(result.content)) return response;
  result.content.push({
    type: 'text',
    text:
      `The free allowance of ${pricing.freeCallsPerDay} calls a day to Bellwether's data tools is used up for this caller. ` +
      `Each further call costs ${pricing.price} in USDC on ${pricing.network.label}, paid per call with x402 (DAP Agent Payments). ` +
      `The allowance resets at ${nextReset(nowMs)}. list_coverage stays free.`,
  });
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.set('Vary', 'Accept');
  return new Response(JSON.stringify(body), { status: response.status, headers });
}

/** How a paid attempt ended, read from the reply the gate released. */
async function paidOutcome(response) {
  try {
    const body = await response.clone().json();
    const result = body && body.result;
    if (isObject(result) && isObject(result._meta) && isObject(result._meta[PAYMENT_RESPONSE_META])) {
      if (result._meta[PAYMENT_RESPONSE_META].success === true) return 'paid';
    }
    if (isObject(result) && result.isError === true && isObject(result.structuredContent)) {
      if (result.structuredContent.x402Version !== undefined) return 'challenged';
    }
  } catch {
    // Not JSON: an error the gate wrote. Nothing was charged.
  }
  return 'not_charged';
}

/**
 * Handle a request to /mcp.
 *
 * @param {Request} request
 * @param {object} env      Worker bindings and settings
 * @param {object} [ctx]    execution context, for waitUntil
 * @param {{ facilitator?: object, now?: () => number }} [overrides]  tests only
 * @returns {Promise<Response>}
 */
export async function handleMcp(request, env, ctx, overrides) {
  // The browser notice, GET, OPTIONS, other methods and a refused Origin are
  // all answered by the server exactly as before. Only a POST from an allowed
  // origin carries a tool call, so only that is read here.
  if (request.method !== 'POST' || !isAllowedOrigin(request.headers.get('Origin'))) {
    return handleMcpRequest(request, env);
  }

  const pricing = pricingFor(env, overrides);
  const now = (overrides && overrides.now) || Date.now;
  const text = await readCapped(request, MAX_BODY_BYTES);
  if (text === null) return rpcError(null, -32600, 'Request too large', 413);

  const forward = () => handleMcpRequest(withBody(request, text), env);
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return forward();
  }
  const day = utcDay(now());

  if (Array.isArray(message)) {
    const calls = message.map(classify);
    if (pricing.status === 'on' && calls.some((c) => c.kind === 'metered' || c.kind === 'malformed')) {
      return rpcError(
        null,
        -32600,
        `Send each call to ${METERED_TOOLS.join(', ')} as its own request, not in a batch.`,
        400
      );
    }
    for (const c of calls) if (c.kind === 'free' || c.kind === 'metered') noteUsage(env, ctx, day, c.tool, 'unmetered');
    return forward();
  }

  const call = classify(message);
  if (call.kind === 'other') return forward();
  if (pricing.status !== 'on' || call.kind === 'free') {
    noteUsage(env, ctx, day, call.tool, 'unmetered');
    return forward();
  }

  const gated = () => pricing.gate.handle(withBody(request, text), (rebuilt) => handleMcpRequest(rebuilt, env));

  // A call no strict reader would run is refused by the gate, never counted.
  if (call.kind === 'malformed') return gated();

  // A caller who sends a payment has chosen to pay, allowance or not.
  if (hasPayment(message)) {
    const response = await gated();
    noteUsage(env, ctx, day, call.tool, await paidOutcome(response));
    return response;
  }

  let used;
  try {
    used = await countCall(env.DB, day, await callerHash(pricing.allowanceKey, day, callerAddress(request)));
  } catch (err) {
    // The count could not be kept. The call is answered free rather than
    // refused: a light user must not lose an answer to our storage.
    console.error(`Bellwether allowance count failed: ${err && err.message ? err.message : String(err)}`);
    noteUsage(env, ctx, day, call.tool, 'allowance');
    return forward();
  }

  if (used <= pricing.freeCallsPerDay) {
    noteUsage(env, ctx, day, call.tool, 'allowance');
    return forward();
  }

  noteUsage(env, ctx, day, call.tool, 'challenged');
  return explainAllowance(await gated(), pricing, now());
}
