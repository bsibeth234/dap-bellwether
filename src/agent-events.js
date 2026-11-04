/**
 * One Workers Analytics Engine data point per answered agent call, in the dataset every DAP agent surface
 * writes to (dap_agent_calls), so one weekly query sums Foundry, Bellwether and the Compute Market Tracker
 * by tool (dap-solutions-site, workers/agent-report). The same layout as dap-foundry
 * edge/x402/src/agent-events.ts and dap-solutions-site workers/compute-agent/src/agent-events.js. Change all
 * of them together.
 *
 *   index    surface                                  the sampling key
 *   blob1    surface   bellwether
 *   blob2    tool      the tool or endpoint name, never an input
 *   blob3    outcome   paid | licensed | free | challenged | refused | error
 *   blob4    payer     a one way hash of the paying wallet, empty when nobody paid. Never the address.
 *   blob5    network   CAIP-2 network of a payment, empty otherwise
 *   blob6    rail      api | mcp
 *   double1  amount    atomic USDC settled (6 decimals), 0 when nothing was paid
 *   double2  status    the HTTP status the caller received
 *   double3  1         one call
 *
 * Nothing else: no query, arguments, body, network address, wallet address, licence key or licence id.
 * Without the AGENT_CALLS binding nothing is written, and a write that fails is ignored: analytics never
 * delays or changes an answer.
 */

import { createHash } from 'node:crypto';

export const OUTCOMES = Object.freeze(['paid', 'licensed', 'free', 'challenged', 'refused', 'error']);
const SURFACE = 'bellwether';
const WALLET = /^0x[0-9a-fA-F]{40}$/;

/** A one way hash of a wallet, the same on every DAP surface. Empty for anything that is not a wallet. */
export function payerHash(address) {
  if (typeof address !== 'string' || !WALLET.test(address)) return '';
  return createHash('sha256').update(`dap-payer-v1|${address.toLowerCase()}`).digest('hex').slice(0, 32);
}

/** Writes one data point. Never throws, never delays an answer. */
export function writeAgentCall(dataset, call) {
  if (!dataset || typeof dataset.writeDataPoint !== 'function') return false;
  if (!OUTCOMES.includes(call.outcome)) return false;
  const amount = Number.isFinite(call.amount) && call.amount > 0 ? Math.floor(call.amount) : 0;
  try {
    dataset.writeDataPoint({
      indexes: [SURFACE],
      blobs: [SURFACE, String(call.tool).slice(0, 96), call.outcome, call.payer || '', call.network || '', call.rail],
      doubles: [amount, Number(call.status) || 0, 1],
    });
    return true;
  } catch {
    return false;
  }
}

/** The settlement a paid HTTP answer carries in PAYMENT-RESPONSE, or undefined. */
export function settlementOf(response) {
  const raw = response && response.headers ? response.headers.get('PAYMENT-RESPONSE') : null;
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(atob(raw));
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Settled, or broadcast and pending (this surface releases pending answers: acceptPending). */
export function settled(s) {
  return Boolean(s && (s.success === true || (s.errorReason === 'settlement_pending' && typeof s.transaction === 'string' && s.transaction !== '')));
}

/** The outcome of an HTTP answer on a priced path. */
export function httpOutcome(response, { licensed = false, free = false } = {}) {
  if (response.status >= 500) return 'error';
  if (response.status === 402) return 'challenged';
  if (response.status >= 400) return 'refused';
  if (licensed) return 'licensed';
  if (settled(settlementOf(response))) return 'paid';
  return free ? 'free' : 'refused';
}

/** Records one call to the JSON API. */
export function recordHttpCall(env, ctx, { tool, rail, response, licensed = false, free = false }) {
  if (!env || !env.AGENT_CALLS) return false;
  const outcome = httpOutcome(response, { licensed, free });
  const s = outcome === 'paid' ? settlementOf(response) : undefined;
  return writeAgentCall(env.AGENT_CALLS, {
    tool,
    outcome,
    rail,
    payer: s ? payerHash(s.payer) : '',
    network: s ? s.network || '' : '',
    amount: s ? Number(s.amount || 0) : 0,
    status: response.status,
  });
}

/**
 * Records one MCP tools/call from the reply the caller receives. meter is the meter's own reading
 * (payments.js): paid, licensed, challenged, not_charged, allowance or unmetered.
 */
export async function recordMcpCall(env, { tool, meter, response }) {
  if (!env || !env.AGENT_CALLS || !tool) return false;
  const map = { paid: 'paid', licensed: 'licensed', challenged: 'challenged', not_charged: 'refused', allowance: 'free', unmetered: 'free' };
  let outcome = map[meter] || 'refused';
  if (response.status >= 500) outcome = 'error';
  let receipt;
  if (outcome === 'paid') {
    try {
      const body = await response.clone().json();
      receipt = body && body.result && body.result._meta ? body.result._meta['x402/payment-response'] : undefined;
    } catch {
      receipt = undefined;
    }
  }
  return writeAgentCall(env.AGENT_CALLS, {
    tool,
    outcome,
    rail: 'mcp',
    payer: receipt ? payerHash(receipt.payer) : '',
    network: receipt ? receipt.network || '' : '',
    amount: receipt ? Number(receipt.amount || 0) : 0,
    status: response.status,
  });
}
