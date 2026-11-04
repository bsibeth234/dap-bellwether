/**
 * What an agent reads to decide whether to call and pay: one line per tool, under 300 characters, opening
 * with when to use the tool, then the job, then the price. The MCP tool list (tools.js), the price list and
 * the 402 every priced call returns (pricing.js), and the OpenAPI file (openapi.js) all read these lines, so
 * they cannot disagree. Detail an agent needs to build a call lives in each input schema (tools.js).
 *
 * MCP lines name the daily allowance: 50 calls per caller each UTC day to the three data tools, then $0.01.
 * A test holds that number to FREE_CALLS_PER_DAY in wrangler.toml. API lines are priced from the first
 * call, as the API is. The same pattern as the Compute Market Tracker (dap-solutions-site,
 * workers/compute-agent/src/descriptions.js).
 */

export const MCP_PRICE = 'Free for 50 calls per caller each UTC day, then $0.01 USDC on Base per call via x402.';
export const API_PRICE = '$0.01 USDC on Base per call via x402. A refused request is never charged.';

/** When to use each tool, then the job it does. */
const JOBS = {
  search_regulatory_changes: [
    'Use when you need what financial regulators in Canada, the US, the UK or the EU have published on a topic or in a date range.',
    'Returns matching records newest first, each with its link and id.',
  ],
  recent_regulatory_changes: [
    'Use when you need what is new from financial regulators rather than a specific topic.',
    'Lists the latest publications across every covered regulator, newest first, optionally for one jurisdiction.',
  ],
  get_regulatory_change: [
    'Use when you have a record id and need to know whether the publication was amended and what changed.',
    'Returns the record in full with every revision observed since first collection.',
  ],
  list_coverage: [
    'Use when you need to know which regulators and feeds are monitored, and how fresh each is, before reading an absence of results as an absence of publications.',
    'Lists every feed with when it was last collected.',
  ],
};

/** The MCP description of a tool. list_coverage is always free. */
export function describe(name) {
  const job = JOBS[name];
  if (!job) throw new Error(`No description for ${name}`);
  return `${job.join(' ')} ${name === 'list_coverage' ? 'Always free.' : MCP_PRICE}`;
}

/** The description a priced API endpoint carries in its 402 and its OpenAPI entry, by the tool it answers as. */
export function describeApi(tool) {
  const job = JOBS[tool];
  if (!job || tool === 'list_coverage') throw new Error(`No priced endpoint answers as ${tool}`);
  return `${job.join(' ')} ${API_PRICE}`;
}

export const TOOL_NAMES = Object.freeze(Object.keys(JOBS));
