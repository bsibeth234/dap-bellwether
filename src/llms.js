/**
 * /llms.txt: the service in plain text, for agents and crawlers that read terms and prices before they pay.
 *
 * Never written by hand. Every line is built from what the service itself runs on, per request, the same way
 * /openapi.json is:
 *   the JSON API routes, their prices and the terms   openApiDocument() (openapi.js)
 *   the MCP tools                                      TOOLS (tools.js) and their jobs (descriptions.js)
 *   the allowance, the price and the network           pricingFor(env) (pricing.js), the live settings
 *   the MCP endpoint, registry name and source repo    server.json, the file the MCP Registry publishes
 *   the regulators covered                             enabledSources() (sources.js)
 * So it cannot promise a price, a route or an allowance the service does not have. Built per request rather
 * than at build time because the allowance (FREE_CALLS_PER_DAY) and whether the paid tier is on (the secret
 * X402_PAY_TO) are runtime settings: a file written at build time could quote a price the service is not
 * charging. test/llms.test.mjs holds every price and allowance here to the config.
 */

import SERVER from '../server.json' with { type: 'json' };
import { openApiDocument } from './openapi.js';
import { METERED_TOOLS, PRICE, pricingFor } from './pricing.js';
import { TOOLS } from './tools.js';
import { jobOf } from './descriptions.js';
import { JURISDICTIONS, enabledSources } from './sources.js';

/** "a, b and c". */
function list(items) {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** A jurisdiction's name as it reads in a sentence: "Canada", "the United States". */
function inSentence(name) {
  return name.includes(' ') ? `the ${name}` : name;
}

/** The regulators collected, grouped by jurisdiction, in registry order. */
function coverageLine() {
  const byJurisdiction = new Map();
  for (const source of enabledSources()) {
    const names = byJurisdiction.get(source.jurisdiction) || [];
    if (!names.includes(source.regulator)) names.push(source.regulator);
    byJurisdiction.set(source.jurisdiction, names);
  }
  return [...byJurisdiction].map(([code, names]) => `${JURISDICTIONS[code]}: ${names.join(', ')}.`).join(' ');
}

/** The streamable HTTP remote in server.json, which is what the registry lists. */
function mcpUrl() {
  const remote = (SERVER.remotes || []).find((r) => r.type === 'streamable-http');
  if (!remote) throw new Error('server.json has no streamable-http remote');
  return remote.url;
}

/** The price an OpenAPI operation states for x402 directories, or null for a free one. */
function operationPrice(operation) {
  const info = operation['x-payment-info'];
  if (!info) return null;
  if (info.price.currency !== 'USD' || `$${info.price.amount}` !== PRICE) {
    throw new Error(`OpenAPI price ${info.price.amount} ${info.price.currency} is not the configured ${PRICE}`);
  }
  return `$${info.price.amount}`;
}

/**
 * The text of /llms.txt for these settings.
 *
 * @param {object} env  Worker bindings and settings, read only through pricingFor
 * @returns {string}
 */
export function llmsTxt(env) {
  const doc = openApiDocument();
  const pricing = pricingFor(env);
  const on = pricing.status === 'on';
  const origin = doc.servers[0].url;
  const operator = doc.info.contact;
  const terms = doc.info.termsOfService;
  const metered = list(METERED_TOOLS);

  const tools = TOOLS.map((tool) => {
    const price = !METERED_TOOLS.includes(tool.name)
      ? 'Always free.'
      : on
        ? `Free for ${pricing.freeCallsPerDay} calls per caller each UTC day, then ${pricing.price} per call.`
        : 'Free.';
    return `- ${tool.name}: ${jobOf(tool.name)} ${price}`;
  });

  const routes = Object.entries(doc.paths).map(([path, item]) => {
    const operation = item.get;
    const price = operationPrice(operation);
    const params = (operation.parameters || []).filter((p) => p.in === 'query').map((p) => (p.required ? `${p.name} (required)` : p.name));
    const cost = price === null ? 'Free.' : on ? `Paid: ${pricing.price} per call from the first call.` : 'Free while payments are off.';
    const takes = params.length ? ` Parameters: ${params.join(', ')}.` : '';
    return `- GET ${origin}${path}: ${operation.summary.replace(/ Free\.$/, '')} ${cost}${takes}`;
  });

  const payment = on
    ? [
        `- MCP data tools (${metered}): free for ${pricing.freeCallsPerDay} calls per caller each UTC day.`,
        '- The allowance resets at 00:00 UTC.',
        `- After the allowance: ${pricing.price} per call in USDC on ${pricing.network.label}, paid with x402.`,
        '- list_coverage is always free, and so are initialize and tools/list.',
        `- JSON API: paid routes cost ${pricing.price} per call in USDC on ${pricing.network.label} from the first call. There is no free allowance on /api.`,
        '- How to pay: call, read the price from the PAYMENT-REQUIRED header of the 402, call again with a signed payment in PAYMENT-SIGNATURE.',
        '- A call that fails or is refused is never charged. A failed MCP call does not count against the allowance.',
      ]
    : ['- Payments are off right now. Every tool and every API route is free.', '- When payments are on, this file states the allowance and the price.'];

  const lines = [
    '# DAP Bellwether',
    '',
    `> Public regulatory change feed from ${operator.name}. It covers financial regulators in ${list(Object.values(JURISDICTIONS).map(inSentence))}.`,
    '',
    '- This is a public information service. It is not legal or compliance advice.',
    '- Coverage starts from when this service first collected each source. It is not a full archive.',
    '- Use list_coverage before reading an absence of results as an absence of publications.',
    `- Regulators collected. ${coverageLine()}`,
    '- Free for people. Agents pay per call.',
    '',
    '## Connect',
    '',
    `- MCP, streamable HTTP: ${mcpUrl()}`,
    `- MCP Registry name: ${SERVER.name}`,
    `- OpenAPI 3.1: ${origin}/openapi.json`,
    `- x402 discovery: ${origin}/.well-known/x402`,
    `- This file: ${origin}/llms.txt`,
    '',
    '## MCP tools',
    '',
    `All ${TOOLS.length} MCP tools are read-only.`,
    ...tools,
    '',
    '## JSON API',
    '',
    ...routes,
    '',
    '## Price and payment',
    '',
    ...payment,
    `- Institutions: a DAP licence key instead of a wallet. One agreement, one invoice for what was used.`,
    '- A licence key skips the allowance and x402. Send it as Authorization: Bearer <key> or X-API-Key: <key> on /mcp and /api.',
    `- Licences: write to ${operator.email}`,
    '',
    '## Terms and operator',
    '',
    `- Terms: ${terms}`,
    '- Calling a tool, sending a payment or using a licence key accepts the terms.',
    `- Source: ${SERVER.repository.url}`,
    `- Operator: ${operator.name}, ${new URL(terms).origin}`,
    '',
  ];
  return lines.join('\n');
}
