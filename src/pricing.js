/**
 * Pricing: whether the paid tier is on, and the gate that charges for it.
 *
 * The three data tools are free for a daily allowance per caller. Past the
 * allowance each call costs one cent in USDC, paid per call with x402 through
 * DAP Agent Payments. list_coverage is always free, and so are initialize,
 * tools/list and every other protocol message.
 *
 * The paid tier is off until X402_PAY_TO is set, so deploying this code changes
 * nothing for anyone. Switching it on is setting the secrets, not a code change.
 *
 * A setting that is present but wrong (a missing CDP key, a bad address, no
 * allowance key) leaves the tier off and says why on /health. That fails open,
 * on purpose: this is a public information service, and a bad setting should
 * cost us revenue, never cost a light user their answer.
 *
 * The payment code in ./x402 is the DAP Agent Payments library, vendored from
 * dap-foundry (see ./x402/VENDORED.md), so Bellwether charges exactly the way
 * the Foundry edge already charges in production.
 */

import { gateFromEnv } from './x402/env.ts';
import { createGate } from './x402/gate.ts';
import { usdcFor } from './x402/networks.ts';
import { TOOLS } from './tools.js';
import { d1ReplayGuard } from './claims.js';

/** The tools the allowance counts. Everything else is free. */
export const METERED_TOOLS = Object.freeze([
  'search_regulatory_changes',
  'recent_regulatory_changes',
  'get_regulatory_change',
]);

/** Price per call past the allowance, in US dollars, settled in USDC. */
export const PRICE = '$0.01';

/** Calls per caller per UTC day before a metered tool asks for payment. */
export const DEFAULT_FREE_CALLS_PER_DAY = 50;

/**
 * An IPv6 caller is counted per /64, and every /64 in a /48 also shares a
 * ceiling of this many allowances, so a holder of a /56 or a /48 cannot rotate
 * addresses into thousands of free allowances.
 */
export const NETWORK_ALLOWANCE_MULTIPLE = 10;

/** The keyed hash needs a real secret. Shorter than this and it is refused. */
const MIN_ALLOWANCE_KEY_LENGTH = 32;

/** Shown to paying agents and to x402 directories. */
const SERVICE = {
  serviceName: 'DAP Bellwether',
  tags: ['regulation', 'finance', 'compliance', 'mcp'],
  iconUrl: 'https://bellwether.dap.solutions/icons/favicon-192.png',
};

/** One line each, which is what an agent reads to decide whether to buy. */
const DESCRIPTIONS = {
  search_regulatory_changes:
    'Search publications from financial regulators in Canada, the US, the UK and the EU.',
  recent_regulatory_changes:
    'The newest publications from financial regulators in Canada, the US, the UK and the EU.',
  get_regulatory_change: 'One regulatory publication in full, with every revision observed.',
};

function meteredTools() {
  return Object.fromEntries(
    METERED_TOOLS.map((name) => {
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) throw new Error(`Metered tool ${name} is not in the tool list`);
      return [name, { price: PRICE, description: DESCRIPTIONS[name], inputSchema: tool.inputSchema }];
    })
  );
}

/**
 * The JSON API for agents. Priced from the first call: there is no free
 * allowance here, because people use the connector and agents that call an API
 * can pay. That is also what lets agent directories list it: they index an
 * endpoint by calling it and expecting the price. /api/coverage is free.
 */
export const API_ENDPOINTS = Object.freeze([
  {
    name: 'search',
    path: '/api/search',
    tool: 'search_regulatory_changes',
    discovery: { input: { method: 'GET', queryParams: { query: 'capital', limit: '5' } }, output: { type: 'json' } },
  },
  {
    name: 'recent',
    path: '/api/recent',
    tool: 'recent_regulatory_changes',
    discovery: { input: { method: 'GET', queryParams: { days: '7', limit: '5' } }, output: { type: 'json' } },
  },
  // The id is a query parameter, not part of the path: the gate sends the
  // path to the payment facilitator and strips the query, so the record a
  // caller asked for never reaches Coinbase.
  { name: 'change', path: '/api/change', tool: 'get_regulatory_change' },
]);

function apiRoutes() {
  return API_ENDPOINTS.map((endpoint) => ({
    path: endpoint.path,
    methods: ['GET'],
    price: PRICE,
    description: DESCRIPTIONS[endpoint.tool],
    mimeType: 'application/json',
    ...(endpoint.discovery ? { discovery: endpoint.discovery } : {}),
  }));
}

function readFreeCalls(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_FREE_CALLS_PER_DAY;
  const text = String(raw).trim();
  if (!/^\d{1,6}$/.test(text)) return null;
  return Number(text);
}

function networkLabel(env) {
  const first = String(env.X402_NETWORKS || 'eip155:84532').split(',')[0].trim();
  try {
    return { id: first, label: usdcFor(first).label };
  } catch {
    return { id: first, label: first };
  }
}

const OFF = Object.freeze({ status: 'off' });

/** Settings that decide the pricing state. A change to any of them builds a new one. */
const SETTINGS = [
  'X402_PAY_TO',
  'X402_NETWORKS',
  'X402_FACILITATOR_URL',
  'CDP_API_KEY_ID',
  'CDP_API_KEY_SECRET',
  'ALLOWANCE_KEY',
  'FREE_CALLS_PER_DAY',
];

/**
 * One state per isolate, keyed on the settings themselves rather than on the
 * env object, because the runtime does not promise the same env object on
 * every request. Held in memory only, never logged.
 */
let cached = { fingerprint: null, state: OFF };

/**
 * The pricing state for this Worker's settings. Built once per isolate.
 *
 * @param {object} env  Worker bindings and settings
 * @param {{ facilitator?: object, now?: () => number }} [overrides]
 *   Tests inject a facilitator and a clock. Production passes nothing, and the
 *   facilitator is built from the settings.
 * @returns {{ status: 'off' } |
 *           { status: 'misconfigured', reason: string } |
 *           { status: 'on', gate: object, freeCallsPerDay: number, price: string,
 *             network: { id: string, label: string }, allowanceKey: string }}
 */
export function pricingFor(env, overrides) {
  if (!env || typeof env !== 'object') return OFF;
  if (overrides) return build(env, overrides);
  const fingerprint = JSON.stringify(SETTINGS.map((name) => (env[name] === undefined ? null : String(env[name]))));
  if (cached.fingerprint === fingerprint) return cached.state;
  const state = build(env);
  cached = { fingerprint, state };
  if (state.status === 'misconfigured') console.error(`Bellwether paid tier is off: ${state.reason}`);
  return state;
}

function build(env, overrides) {
  const payTo = typeof env.X402_PAY_TO === 'string' ? env.X402_PAY_TO.trim() : '';
  if (!payTo) return OFF;

  const freeCallsPerDay = readFreeCalls(env.FREE_CALLS_PER_DAY);
  if (freeCallsPerDay === null) {
    return { status: 'misconfigured', reason: 'FREE_CALLS_PER_DAY must be a whole number.' };
  }
  const allowanceKey = typeof env.ALLOWANCE_KEY === 'string' ? env.ALLOWANCE_KEY : '';
  if (allowanceKey.length < MIN_ALLOWANCE_KEY_LENGTH) {
    return {
      status: 'misconfigured',
      reason: `ALLOWANCE_KEY must be set, at least ${MIN_ALLOWANCE_KEY_LENGTH} characters.`,
    };
  }

  // acceptPending: when the facilitator reports the transfer sent but not yet
  // confirmed, the answer is released rather than withheld, so a payer is never
  // charged with nothing to show for it. Safe only because the claim on each
  // payment is shared through D1 (claims.js), not held per instance.
  const now = (overrides && overrides.now) || Date.now;
  const options = {
    ...SERVICE,
    tags: [...SERVICE.tags],
    routes: apiRoutes(),
    mcp: { path: '/mcp', tools: meteredTools() },
    docsUrl: 'https://bellwether.dap.solutions/openapi.json',
    replayGuard: d1ReplayGuard(() => env.DB, allowanceKey, now),
    acceptPending: true,
  };
  let gate;
  try {
    // Always built from the settings first, so a test that injects a
    // facilitator still meets every check production does.
    gate = gateFromEnv({ ...env, X402_PAY_TO: payTo }, options);
    if (overrides && overrides.facilitator) {
      const networks = String(env.X402_NETWORKS || 'eip155:84532')
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean);
      gate = createGate({
        ...options,
        payTo,
        networks,
        facilitator: overrides.facilitator,
        ...(overrides.now ? { now: overrides.now } : {}),
      });
    }
  } catch (err) {
    return { status: 'misconfigured', reason: err && err.message ? err.message : String(err) };
  }

  return {
    status: 'on',
    gate,
    freeCallsPerDay,
    price: PRICE,
    network: networkLabel(env),
    allowanceKey,
  };
}

/**
 * What /health and the landing page may say about pricing. Never the gate,
 * never a key, never the wallet.
 */
export function pricingSummary(pricing) {
  if (pricing.status === 'on') {
    return {
      status: 'on',
      freeCallsPerDay: pricing.freeCallsPerDay,
      price: pricing.price,
      currency: 'USDC',
      network: pricing.network.id,
      networkLabel: pricing.network.label,
      meteredTools: [...METERED_TOOLS],
    };
  }
  if (pricing.status === 'misconfigured') return { status: 'misconfigured', reason: pricing.reason };
  return { status: 'off' };
}

/** The sentence agents read in the MCP instructions while the paid tier is on. */
export function pricingInstructions(pricing) {
  if (pricing.status !== 'on') return '';
  return [
    `${METERED_TOOLS.join(', ').replace(/, ([^,]*)$/, ' and $1')} are free for ${pricing.freeCallsPerDay} calls per caller each UTC day.`,
    `After that each call costs ${pricing.price} in USDC on ${pricing.network.label}, paid per call with x402.`,
    'A client that cannot pay gets a payment required result until the allowance resets at 00:00 UTC.',
    'A call that fails is never charged and does not count against the allowance. list_coverage is always free.',
  ].join(' ');
}
