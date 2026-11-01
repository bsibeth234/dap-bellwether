/**
 * The metered MCP endpoint: a free daily allowance per caller, then x402.
 *
 *   initialize, tools/list, list_coverage    always free, never counted per caller
 *   a data tool, within the allowance       answered free, one more on the caller's count
 *   a data tool, past the allowance         a payment required result, with the price
 *   a data tool, with a payment attached    verified, answered, settled, then released
 *   a call that fails                        never charged, its count given back
 *   any call with a DAP licence key          answered under the licence (licences.js):
 *                                            no allowance, no x402, counted per licence
 *
 * With the paid tier off, every call is free and nothing is counted per caller.
 * In both states a daily total per tool, with no caller attached, is kept so
 * we know what the service is actually used for.
 *
 * The caller is the network address the request came from, IPv6 taken to its
 * /64 because one host usually holds a whole /64, with a shared ceiling across
 * the /48 so a larger block cannot be rotated into free allowances. The address
 * is never stored. What is stored is a keyed hash of it, bound to the day, and
 * the rows are deleted by the first scheduled run after that day ends.
 *
 * The server receives the message inspected here, re-serialized, never the
 * raw bytes. A body that does not parse is answered here as a parse error, so
 * no difference between two readers can carry a call past the meter.
 */

import { handleMcpRequest, isAllowedOrigin } from './mcp.js';
import { METERED_TOOLS, NETWORK_ALLOWANCE_MULTIPLE, pricingFor } from './pricing.js';
import { TOOLS } from './tools.js';
import { countLicensedCall, countLicensedCalls, licenceRefused, licenceUnavailable, readLicence } from './licences.js';

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

/**
 * Every count a call is held to: the address itself, and for IPv6 its /48 at
 * a higher ceiling.
 *
 * @returns {{ address: string, limit: number }[]}
 */
export function callerScopes(request, freeCallsPerDay) {
  const address = callerAddress(request);
  const scopes = [{ address, limit: freeCallsPerDay }];
  if (address.endsWith('::/64')) {
    const network = `${address.slice(0, -'::/64'.length).split(':').slice(0, 3).join(':')}::/48`;
    scopes.push({ address: network, limit: freeCallsPerDay * NETWORK_ALLOWANCE_MULTIPLE });
  }
  return scopes;
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

/**
 * Adds one to each count for the day, in one statement, and returns the new
 * counts by caller hash.
 */
export async function countCalls(db, day, callers) {
  const values = callers.map(() => '(?, ?, 1)').join(', ');
  const { results } = await db
    .prepare(
      `INSERT INTO allowance_counts (day, caller, calls) VALUES ${values} ` +
        'ON CONFLICT (day, caller) DO UPDATE SET calls = calls + 1 RETURNING caller, calls'
    )
    .bind(...callers.flatMap((caller) => [day, caller]))
    .all();
  return new Map(results.map((row) => [row.caller, Number(row.calls)]));
}

/** Gives back the count taken for a call that failed. */
export async function refundCalls(db, day, callers) {
  await db
    .prepare(
      `UPDATE allowance_counts SET calls = calls - 1 WHERE day = ? AND caller IN (${callers
        .map(() => '?')
        .join(', ')}) AND calls > 0`
    )
    .bind(day, ...callers)
    .run();
}

/**
 * Whether the tables the paid tier writes exist. /health asks, so a tier
 * switched on before the migration shows as degraded instead of quietly
 * answering every call free.
 */
export async function paymentStoreReady(db) {
  try {
    await db.prepare('SELECT 1 FROM allowance_counts WHERE 0').all();
    await db.prepare('SELECT 1 FROM payment_claims WHERE 0').all();
    return true;
  } catch {
    return false;
  }
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
 * as UTF-8. `max` is Infinity while the paid tier is off, so nothing that was
 * answered before is refused now.
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
      const receipt = result._meta[PAYMENT_RESPONSE_META];
      if (receipt.success === true || receipt.errorReason === 'settlement_pending') return 'paid';
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

  // A DAP licence key decides the rail before anything else is read. Requests
  // without one cost no lookup at all.
  const licence = await readLicence(request, env);
  if (licence.status === 'invalid') return licenceRefused({ jsonRpc: true });
  if (licence.status === 'unavailable') return licenceUnavailable({ jsonRpc: true });

  const pricing = pricingFor(env, overrides);
  const on = pricing.status === 'on';
  const now = (overrides && overrides.now) || Date.now;
  const licensed = licence.status === 'valid';
  const text = await readCapped(request, on || licensed ? MAX_BODY_BYTES : Infinity);
  if (text === null) return rpcError(null, -32600, 'Request too large', 413);

  let message;
  try {
    message = JSON.parse(text);
  } catch {
    // Answered here, as the server would answer it. Never passed on: a body
    // this reader refuses might still be one another reader accepts.
    return rpcError(null, -32700, 'Parse error', 400);
  }
  const forward = () => handleMcpRequest(withBody(request, JSON.stringify(message)), env);
  const day = utcDay(now());

  if (licensed) return licensedCall(request, message, env, ctx, day, licence.licence, on);

  if (Array.isArray(message)) {
    const calls = message.map(classify);
    if (on && calls.some((c) => c.kind === 'metered' || c.kind === 'malformed')) {
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
  if (!on || call.kind === 'free') {
    noteUsage(env, ctx, day, call.tool, 'unmetered');
    return forward();
  }

  const gated = () =>
    pricing.gate.handle(withBody(request, JSON.stringify(message)), (rebuilt) => handleMcpRequest(rebuilt, env));

  // A call no strict reader would run is refused by the gate, never counted.
  if (call.kind === 'malformed') return gated();

  // A tools/call notification gets no answer from the server, so it is not counted.
  if (message.id === undefined || message.id === null) return forward();

  // A caller who sends a payment has chosen to pay, allowance or not.
  if (hasPayment(message)) {
    // A payment that stays valid longer than the claim on it can be held is
    // refused before anything runs, so no claim lapses while its payment could
    // still be presented again.
    if (outlivesClaim(message, now())) {
      noteUsage(env, ctx, day, call.tool, 'challenged');
      return withError(await gatedWithoutPayment(request, message, pricing, env), VALID_BEFORE_ERROR);
    }
    let response;
    try {
      response = await gated();
    } catch (err) {
      // Only the claim can throw here (claims.js swallows a failed release),
      // and it is taken before verification: nothing ran and nothing was charged.
      console.error(`Bellwether payment claim failed: ${err && err.message ? err.message : String(err)}`);
      return rpcError(message.id, -32603, 'Payment service unavailable. Retry shortly.', 503);
    }
    noteUsage(env, ctx, day, call.tool, await paidOutcome(response));
    return response;
  }

  const scopes = callerScopes(request, pricing.freeCallsPerDay);
  let hashes;
  let counts;
  try {
    hashes = await Promise.all(scopes.map((scope) => callerHash(pricing.allowanceKey, day, scope.address)));
    counts = await countCalls(env.DB, day, hashes);
  } catch (err) {
    // The count could not be kept. The call is answered free rather than
    // refused: a light user must not lose an answer to our storage. /health
    // shows the store as missing (paymentStoreReady).
    console.error(`Bellwether allowance count failed: ${err && err.message ? err.message : String(err)}`);
    noteUsage(env, ctx, day, call.tool, 'allowance');
    return forward();
  }

  // Counts hold answered calls only. A call that fails, and a call that is
  // asked to pay, gives its count back before the reply goes out, so a caller
  // looping on payment required can never use up its neighbours' allowance.
  const giveBack = () =>
    refundCalls(env.DB, day, hashes).catch((err) => {
      console.error(`Bellwether allowance refund failed: ${err && err.message ? err.message : String(err)}`);
    });

  if (scopes.every((scope, i) => (counts.get(hashes[i]) || 0) <= scope.limit)) {
    const response = await forward();
    if (await failed(response)) {
      await giveBack();
      noteUsage(env, ctx, day, call.tool, 'not_charged');
    } else {
      noteUsage(env, ctx, day, call.tool, 'allowance');
    }
    return response;
  }

  await giveBack();
  noteUsage(env, ctx, day, call.tool, 'challenged');
  return explainAllowance(await gated(), pricing, now());
}

/**
 * A call under a DAP licence. No allowance and no x402: an answered call to a
 * data tool adds one to the licence's count for the day, which the invoice
 * reads, before the answer is released. A payment attached by mistake is
 * removed unread, so nothing is charged twice and the tool never sees it.
 * While the paid tier is on, batches follow its rule, one data call per
 * request, so every count matches one answer; with it off, a batch is
 * answered free like anyone else's.
 */
async function licensedCall(request, message, env, ctx, day, licence, on) {
  const send = (msg) => handleMcpRequest(withBody(request, JSON.stringify(msg)), env);

  if (Array.isArray(message)) {
    const calls = message.map(classify);
    if (on && calls.some((c) => c.kind === 'metered' || c.kind === 'malformed')) {
      return rpcError(null, -32600, `Send each call to ${METERED_TOOLS.join(', ')} as its own request, not in a batch.`, 400);
    }
    // With the tier off a licensee may batch, and each answered data call in
    // the batch is counted before the batch is released. Every answer must
    // match exactly one call, so when a batch holds a data call, each message
    // that expects an answer carries a string or number id no other message
    // in the batch uses.
    if (calls.some((c) => c.kind === 'metered') && !batchIdsDistinct(message)) {
      return rpcError(null, -32600, 'In a batch with a data call, give each call a string or number id of its own.', 400);
    }
    for (const c of calls) if (c.kind === 'free') noteUsage(env, ctx, day, c.tool, 'unmetered');
    const metered = message
      .map((m, i) => ({ id: m && m.id, tool: calls[i].tool, kind: calls[i].kind }))
      .filter((c) => c.kind === 'metered' && c.id !== undefined && c.id !== null);
    const response = await send(message.map(withoutPayment));
    if (metered.length === 0) return response;
    let replies = [];
    try {
      const body = await response.clone().json();
      replies = Array.isArray(body) ? body : [];
    } catch {
      replies = [];
    }
    const answered = metered.filter((call) => {
      const reply = replies.find((r) => isObject(r) && r.id === call.id);
      return reply && !reply.error && !(isObject(reply.result) && reply.result.isError === true);
    });
    // One transaction for the whole batch: every answer counted, or none released.
    if (!(await countLicensedCalls(env.LICENCES, day, licence.id, answered.map((c) => c.tool)))) {
      return licenceUnavailable({ jsonRpc: true });
    }
    for (const call of answered) noteUsage(env, ctx, day, call.tool, 'licensed');
    return response;
  }

  const call = classify(message);
  if (call.kind === 'other') return send(message);
  if (call.kind === 'malformed') return rpcError(isRpcId(message.id) ? message.id : null, -32600, 'Invalid tools/call request', 400);
  if (call.kind === 'free') {
    noteUsage(env, ctx, day, call.tool, 'unmetered');
    return send(message);
  }

  const clean = withoutPayment(message);
  // A notification gets no answer, so it is not counted.
  if (clean.id === undefined || clean.id === null) return send(clean);
  const response = await send(clean);
  if (await failed(response)) {
    noteUsage(env, ctx, day, call.tool, 'not_charged');
    return response;
  }
  // Every licensed answer is counted before it is released, or not released.
  if (!(await countLicensedCall(env.LICENCES, day, licence.id, call.tool))) return licenceUnavailable({ jsonRpc: true });
  noteUsage(env, ctx, day, call.tool, 'licensed');
  return response;
}

function isRpcId(id) {
  return typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
}

/**
 * Whether every message in a batch that expects an answer has a string or
 * number id that no other message in the batch uses. A message with no id,
 * or a null id, is a notification and gets no answer.
 */
function batchIdsDistinct(batch) {
  const seen = new Set();
  for (const m of batch) {
    const id = isObject(m) ? m.id : undefined;
    if (id === undefined || id === null) continue;
    if (!isRpcId(id)) return false;
    const key = `${typeof id}:${id}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

/** The message with any x402 payment removed from params._meta. */
function withoutPayment(message) {
  if (!isObject(message) || !hasPayment(message)) return message;
  const meta = { ...message.params._meta };
  delete meta[PAYMENT_META];
  const { _meta: _dropped, ...params } = message.params;
  return { ...message, params: Object.keys(meta).length ? { ...params, _meta: meta } : params };
}

/**
 * The longest a payment authorization may stay valid. The gate offers 60
 * seconds; an hour leaves room for clock skew and slow clients, and sits well
 * inside the day a claim can be held.
 */
export const MAX_PAYMENT_VALIDITY_SECONDS = 60 * 60;
const VALID_BEFORE_ERROR = 'invalid_exact_evm_payload_authorization_valid_before';

/** Whether a payment's validBefore reaches past what a claim can cover. */
function outlivesClaim(message, nowMs) {
  const payment = message.params._meta[PAYMENT_META];
  const validBefore =
    isObject(payment) && isObject(payment.payload) && isObject(payment.payload.authorization)
      ? payment.payload.authorization.validBefore
      : undefined;
  if (typeof validBefore !== 'string' || !/^\d{1,20}$/.test(validBefore)) return false; // the gate refuses it
  return Number(validBefore) > Math.floor(nowMs / 1000) + MAX_PAYMENT_VALIDITY_SECONDS;
}

/** The gate's price for this call, as if no payment had been sent. */
function gatedWithoutPayment(request, message, pricing, env) {
  const meta = { ...message.params._meta };
  delete meta[PAYMENT_META];
  const { _meta: _dropped, ...params } = message.params;
  const bare = { ...message, params: Object.keys(meta).length ? { ...params, _meta: meta } : params };
  return pricing.gate.handle(withBody(request, JSON.stringify(bare)), (rebuilt) => handleMcpRequest(rebuilt, env));
}

/** A payment required result with the reason a payment was refused. */
async function withError(response, code) {
  let body;
  try {
    body = await response.clone().json();
  } catch {
    return response;
  }
  const result = body && body.result;
  if (!isObject(result) || !isObject(result.structuredContent)) return response;
  result.structuredContent.error = code;
  if (Array.isArray(result.content) && result.content[0] && result.content[0].type === 'text') {
    result.content[0].text = JSON.stringify(result.structuredContent);
  }
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(JSON.stringify(body), { status: response.status, headers });
}

/** Whether the server's answer is an error: a JSON-RPC error or a tool result marked isError. */
async function failed(response) {
  try {
    const body = await response.clone().json();
    return Boolean(body && (body.error || (isObject(body.result) && body.result.isError === true)));
  } catch {
    return true;
  }
}
