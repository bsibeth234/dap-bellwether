/**
 * The public landing page.
 *
 * Rendered per request rather than kept as a static file, because the coverage
 * list has to come from the source registry. A hardcoded list would drift the
 * moment a regulator is corrected or disabled, and this page would then be
 * claiming coverage the connector does not have, which is the one thing the
 * whole service is built not to do.
 *
 * Section brand: graphite ink on paper, Archivo for display, Hanken Grotesk
 * for text, JetBrains Mono for the URL and anything technical. Vermilion is
 * the single active mark and appears once, on the connector block, which is
 * the one thing a visitor came here to take away.
 */

import { SOURCES, JURISDICTIONS, enabledSources } from './sources.js';

/** One sentence, shared by the meta description and both card previews, so a
 *  link preview and a search result never describe the service differently. */
const DESCRIPTION =
  'A free, public MCP connector serving regulatory publications from financial regulators in Canada, the United States, the United Kingdom and the European Union. No account, no key.';

/**
 * The one address this service should be indexed under.
 *
 * Hardcoded on purpose, and the only URL on the page that is. The workers.dev
 * fallback serves the same document, so a crawler that reaches both sees two
 * copies of one page and picks a winner itself. Deriving this from the request
 * would tell it that each copy is its own canonical, which is the opposite of
 * what the tag is for.
 */
export const CANONICAL_URL = 'https://bellwether.dap.solutions/';

/** The connector setup steps, in one place because two pages show them. A
 *  second copy would drift the first time Claude renames a menu, and the copy
 *  that drifts is the one nobody remembers to open. */
export const SETUP_STEPS = [
  'In Claude, open Customize, then Connectors.',
  'Click the plus button next to Connectors and choose add custom connector.',
  'Give it a name, paste the URL above, and click Add.',
  'In a chat, click the plus button, hover Connectors, and toggle it on.',
];

/**
 * The privacy statement, as data, because two documents carry it: this page
 * and the README. A test holds them word for word in step. The statement is
 * the same whether or not the paid tier is on, and says which rows depend on
 * it, so it can never claim less than the service does.
 */
export const PRIVACY = {
  intro:
    'The connector keeps no accounts and no email addresses. This page counts visits without cookies or identifiers.',
  rows: [
    [
      'What is stored',
      'Regulatory publications retrieved from public regulator websites: title, link, summary, publication date and revision history. A daily total of calls per tool, with no caller attached, so we know what the service is used for. While the paid tier is on, the allowance counts and payment claims described below. Nothing else a user sends is written to the database.',
    ],
    [
      'What is received',
      "Tool calls arrive as search parameters, for example a keyword or jurisdiction. These are used to answer the request and are not stored, logged to durable storage, or associated with any identity. A paid call also carries an x402 payment authorization, a signed USDC transfer from the caller's wallet. It is passed to the payment facilitator and not stored here.",
    ],
    [
      'Allowance counts',
      'While the paid tier is on, the service counts calls to the three data tools per caller per UTC day, to meter the free allowance. The caller is recorded only as a keyed hash of its network address, bound to the day and never stored with the query. For IPv6 the count is kept for the /64 and for the /48 it sits in. Without the key, which only the service holds, a hash cannot be turned back into an address. Counts are deleted by the first scheduled run after the day ends, normally at 00:00 UTC. The Price section says whether the paid tier is on.',
    ],
    [
      'Payment claims',
      'For each paid call, a one-way hash of its payment authorization is kept until the authorization expires, at most a day, so one payment cannot buy two answers. It holds no query, and the wallet and nonce inside it cannot be read back.',
    ],
    [
      'Accounts',
      'There are none. The service has no sign in, so it holds no credentials or email addresses.',
    ],
    [
      'Analytics',
      'This page uses Cloudflare Web Analytics, a cookieless measurement service. It records the page viewed, the referring link, browser and operating system, approximate country and page load timings. It sets no cookies and writes nothing to your device. Visitor IP addresses are used to derive country and are not stored by the service. The connector endpoint at /mcp does not load the beacon. Tool calls are counted only as described above.',
    ],
    [
      'Third party sharing',
      "Regulatory data is not sold, shared or transferred. This page loads no third party fonts, no advertising and no cross site trackers. The only third party request it makes is the analytics beacon described above. A paid call's payment authorization goes to Coinbase's x402 facilitator, which verifies it and settles the transfer on the Base network, where the transfer is public. The query is never sent to it.",
    ],
    [
      'Retention',
      "Regulatory records and their revision history are retained indefinitely, because the historical record is the point of the service. Daily totals per tool are retained to report usage. Allowance counts are deleted once their day ends, and payment claims once they expire. Like everything in the database, a deleted row stays in Cloudflare D1's point-in-time recovery for up to 30 days, where only the service can restore it. Request parameters are not retained.",
    ],
    [
      'Infrastructure',
      "Hosted on Cloudflare Workers and D1, with Cloudflare Web Analytics on this page. The Worker keeps no request logs: it logs errors and the collection summary, never a caller's address or query. Cloudflare processes requests as an infrastructure provider and as an analytics processor under its own terms. Paid calls settle through Coinbase's x402 facilitator under its own terms.",
    ],
    ['Contact', 'bsibeth@dap.solutions'],
  ],
};

/** The DAP Agent Payments page, named wherever the price is. */
const AGENT_PAYMENTS_URL = 'https://dap.solutions/solutions/systems/agent-payments/';

/** Escape anything interpolated into markup. Registry text is ours, but a
 *  page that trusts its inputs teaches the next person to do the same. */
function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Coverage, grouped by jurisdiction, straight from the registry. */
function coverageMarkup() {
  const active = enabledSources();
  const byJurisdiction = new Map();
  for (const source of active) {
    if (!byJurisdiction.has(source.jurisdiction)) byJurisdiction.set(source.jurisdiction, []);
    byJurisdiction.get(source.jurisdiction).push(source);
  }

  const blocks = [...byJurisdiction.keys()]
    .sort()
    .map((code) => {
      const rows = byJurisdiction
        .get(code)
        .map(
          (s) =>
            `<li><span class="reg">${esc(s.regulator)}</span> <span class="feed">${esc(s.name)}</span></li>`
        )
        .join('');
      return `<div class="jur">
            <h3>${esc(JURISDICTIONS[code] || code)}</h3>
            <ul class="feeds">${rows}</ul>
          </div>`;
    })
    .join('');

  const disabled = SOURCES.filter((s) => !s.enabled);
  const notMonitored = disabled.length
    ? `<p class="note">Not monitored: ${disabled
        .map((s) => `${esc(s.regulator)} (${esc(JURISDICTIONS[s.jurisdiction] || s.jurisdiction)})`)
        .join(', ')}. These are listed rather than quietly omitted, because an absence of results is only meaningful if you know what is being watched.</p>`
    : '';

  return `<div class="jurs">${blocks}</div>${notMonitored}`;
}

/**
 * The price, from the live settings. While the paid tier is off the page says
 * every call is free, because it is: a price the connector does not charge is
 * a claim it cannot support.
 *
 * @param {{ status: string, freeCallsPerDay?: number, price?: string, networkLabel?: string }} pricing
 */
function priceMarkup(pricing) {
  if (!pricing || pricing.status !== 'on') {
    return '<p>Free. Every tool, every call. The paid tier is off.</p>';
  }
  return `<p>Free for everyday use. Each caller gets ${esc(pricing.freeCallsPerDay)} calls a day to the three data tools, counted per network address and reset at 00:00 UTC. list_coverage is always free.</p>
<p>Past that, each call costs ${esc(pricing.price)} in USDC on ${esc(pricing.networkLabel)}, paid per call with x402 through <a href="${AGENT_PAYMENTS_URL}">DAP Agent Payments</a>. An agent that cannot pay gets a payment required result until the allowance resets. A call that fails is never charged and never counted.</p>`;
}

function privacyMarkup() {
  const rows = PRIVACY.rows
    .map(([term, text]) => {
      const body = term === 'Contact' ? `<a href="mailto:${esc(text)}">${esc(text)}</a>` : esc(text);
      return `  <dt>${esc(term)}</dt>\n  <dd>${body}</dd>`;
    })
    .join('\n');
  return `<p>${esc(PRIVACY.intro)}</p>\n<dl>\n${rows}\n</dl>`;
}

/**
 * The page a person gets when they paste the connector URL into a browser
 * instead of into Claude.
 *
 * Served only for a GET whose Accept ranks text/html above the protocol types,
 * so no MCP client can reach it. It exists because the honest protocol answer,
 * a JSON-RPC error saying SSE is not supported, reads as a broken service to
 * the one audience most likely to see it.
 *
 * Deliberately self contained rather than sharing the landing page's stylesheet:
 * this is a dead end page, and coupling it to the main sheet would mean every
 * future landing page change has to be re-checked here.
 *
 * @param {string} origin the request origin, so the URL shown is the one the
 *   visitor actually reached and will actually work
 */
export function renderConnectorNotice(origin) {
  const mcpUrl = `${origin}/mcp`;
  let host = origin;
  try {
    host = new URL(origin).host;
  } catch {
    // An unparseable origin is not worth failing a page over.
  }

  return `<!doctype html>
<html lang="en-CA">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DAP Bellwether, connector endpoint</title>
<meta name="robots" content="noindex">
<meta name="theme-color" content="#15171A">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32.png">
<style>
@font-face{font-family:"Archivo";src:url("/fonts/Archivo-600.ttf") format("truetype");font-weight:600;font-style:normal;font-display:swap}
@font-face{font-family:"Hanken Grotesk";src:url("/fonts/Hanken-400.ttf") format("truetype");font-weight:400;font-style:normal;font-display:swap}
@font-face{font-family:"JetBrains Mono";src:url("/fonts/JBMono-400.ttf") format("truetype");font-weight:400;font-style:normal;font-display:swap}
:root{
  --paper:#F1F1ED; --field:#FBFBF8;
  --graphite:#23262A; --carbon:#15171A;
  --vermilion:#D8412F;
  --steel:#8A9099; --steel-ink:#565B61;
  --rule:#D6D6D0;
  --display:"Archivo",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  --text:"Hanken Grotesk",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  --mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0;
  background-color:var(--paper);
  background-image:
    repeating-linear-gradient(to right, var(--rule) 0 1px, transparent 1px 64px),
    repeating-linear-gradient(to bottom, var(--rule) 0 1px, transparent 1px 64px);
  background-size:64px 64px;
  color:var(--graphite);
  font-family:var(--text);
  font-size:17px;
  line-height:1.65;
}
body::before{content:"";position:fixed;inset:0;background:var(--paper);opacity:.88;z-index:-1}
.wrap{max-width:47rem;margin:0 auto;padding:4rem 1.5rem 5rem}
header{border-bottom:1px solid var(--rule);padding-bottom:1.75rem;margin-bottom:2.5rem}
.eyebrow{
  font-family:var(--mono);font-size:.72rem;letter-spacing:.14em;text-transform:uppercase;
  color:var(--steel-ink);margin:0 0 .85rem
}
h1{font-family:var(--display);font-weight:600;font-size:2.4rem;line-height:1.12;margin:0 0 .6rem;letter-spacing:-.015em}
.lede{font-size:1.12rem;margin:0;max-width:36rem}
p{margin:0 0 1rem;max-width:36rem}
a{color:var(--graphite);text-underline-offset:.18em;text-decoration-color:var(--steel)}
a:hover{text-decoration-color:var(--graphite)}
.connector{
  background:var(--field);
  border:1px solid var(--rule);
  border-left:3px solid var(--vermilion);
  padding:1.35rem 1.5rem;
  margin:1.25rem 0 1.5rem;
}
.connector .label{
  font-family:var(--mono);font-size:.7rem;letter-spacing:.12em;text-transform:uppercase;
  color:var(--steel-ink);margin:0 0 .55rem
}
.url{font-family:var(--mono);font-size:1rem;word-break:break-all;margin:0;color:var(--carbon);user-select:all}
ol{padding-left:1.15rem;max-width:36rem}
ol li{margin-bottom:.45rem}
footer{border-top:1px solid var(--rule);margin-top:3.5rem;padding-top:1.5rem;font-size:.9rem;color:var(--steel-ink)}
footer p{max-width:36rem}
@media (max-width:640px){
  .wrap{padding:2.5rem 1.15rem 3.5rem}
  h1{font-size:1.85rem}
  body{font-size:16px}
}
</style>
</head>
<body>
<div class="wrap">

<header>
  <p class="eyebrow">Dartmouth Advisory Partners</p>
  <h1>This is a connector endpoint, not a web page</h1>
  <p class="lede">This address is meant to be pasted into Claude as a custom connector rather than opened in a browser. Nothing is broken. There is simply nothing here for a browser to show.</p>
</header>

<div class="connector">
  <p class="label">Connector URL</p>
  <p class="url">${esc(mcpUrl)}</p>
</div>
<ol>
${SETUP_STEPS.map((step) => `  <li>${esc(step)}</li>`).join('\n')}
</ol>
<p>There is nothing to authenticate and nothing to configure. Adding a connector does not switch it on by itself, so the last step matters.</p>

<footer>
  <p>For what this service covers, who it is for and what it does not do, see <a href="${esc(origin)}/">${esc(host)}</a>.</p>
</footer>

</div>
</body>
</html>
`;
}

/**
 * @param {string} origin the request origin, so the page advertises the host
 *   it was actually reached on rather than a hardcoded one
 */
/**
 * @param {string} origin the request origin
 * @param {object} [pricing] pricingSummary() of the live settings; off when absent
 */
export function renderLanding(origin, pricing = { status: 'off' }) {
  const mcpUrl = `${origin}/mcp`;
  const feedCount = enabledSources().length;
  const jurisdictionCount = new Set(enabledSources().map((s) => s.jurisdiction)).size;

  return `<!doctype html>
<html lang="en-CA">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DAP Bellwether, a free regulatory change feed</title>
<meta name="description" content="${esc(DESCRIPTION)}">
<meta name="theme-color" content="#15171A">
<link rel="canonical" href="${esc(CANONICAL_URL)}">

<meta property="og:type" content="website">
<meta property="og:site_name" content="DAP Bellwether">
<meta property="og:title" content="DAP Bellwether, a free regulatory change feed">
<meta property="og:description" content="${esc(DESCRIPTION)}">
<meta property="og:url" content="${esc(CANONICAL_URL)}">
<meta property="og:image" content="${esc(origin)}/og.png">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="DAP Bellwether, a free regulatory change feed, at bellwether.dap.solutions">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="DAP Bellwether, a free regulatory change feed">
<meta name="twitter:description" content="${esc(DESCRIPTION)}">
<meta name="twitter:image" content="${esc(origin)}/og.png">
<meta name="twitter:image:alt" content="DAP Bellwether, a free regulatory change feed, at bellwether.dap.solutions">

<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" type="image/png" sizes="16x16" href="/icons/favicon-16.png">
<link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32.png">
<link rel="icon" type="image/png" sizes="48x48" href="/icons/favicon-48.png">
<link rel="icon" type="image/png" sizes="192x192" href="/icons/favicon-192.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">

<style>
@font-face{font-family:"Archivo";src:url("/fonts/Archivo-600.ttf") format("truetype");font-weight:600;font-style:normal;font-display:swap}
@font-face{font-family:"Hanken Grotesk";src:url("/fonts/Hanken-400.ttf") format("truetype");font-weight:400;font-style:normal;font-display:swap}
@font-face{font-family:"JetBrains Mono";src:url("/fonts/JBMono-400.ttf") format("truetype");font-weight:400;font-style:normal;font-display:swap}

:root{
  --paper:#F1F1ED; --field:#FBFBF8; --sunk:#E9E9E3;
  --graphite:#23262A; --carbon:#15171A;
  --vermilion:#D8412F;
  --steel:#8A9099; --steel-ink:#565B61;
  --rule:#D6D6D0;
  --display:"Archivo",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  --text:"Hanken Grotesk",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  --mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0;
  background-color:var(--paper);
  /* Blueprint substrate, kept faint. It should register as texture, not as a grid. */
  background-image:
    repeating-linear-gradient(to right, var(--rule) 0 1px, transparent 1px 64px),
    repeating-linear-gradient(to bottom, var(--rule) 0 1px, transparent 1px 64px);
  background-size:64px 64px;
  color:var(--graphite);
  font-family:var(--text);
  font-size:17px;
  line-height:1.65;
}
body::before{
  /* Wash the substrate back so the grid sits under the ink rather than in it. */
  content:"";position:fixed;inset:0;background:var(--paper);opacity:.88;z-index:-1;
}
.wrap{max-width:47rem;margin:0 auto;padding:4rem 1.5rem 5rem}
header{border-bottom:1px solid var(--rule);padding-bottom:1.75rem;margin-bottom:2.5rem}
.eyebrow{
  font-family:var(--mono);font-size:.72rem;letter-spacing:.14em;text-transform:uppercase;
  color:var(--steel-ink);margin:0 0 .85rem
}
h1{font-family:var(--display);font-weight:600;font-size:2.4rem;line-height:1.12;margin:0 0 .6rem;letter-spacing:-.015em}
.lede{font-size:1.12rem;margin:0;max-width:36rem}
h2{font-family:var(--display);font-weight:600;font-size:1.28rem;margin:3rem 0 .9rem;letter-spacing:-.01em}
h3{font-family:var(--display);font-weight:600;font-size:.92rem;margin:0 0 .5rem}
p{margin:0 0 1rem;max-width:36rem}
a{color:var(--graphite);text-underline-offset:.18em;text-decoration-color:var(--steel)}
a:hover{text-decoration-color:var(--graphite)}

/* The single active mark on this surface. */
.connector{
  background:var(--field);
  border:1px solid var(--rule);
  border-left:3px solid var(--vermilion);
  padding:1.35rem 1.5rem;
  margin:1.25rem 0 1.5rem;
}
.connector .label{
  font-family:var(--mono);font-size:.7rem;letter-spacing:.12em;text-transform:uppercase;
  color:var(--steel-ink);margin:0 0 .55rem
}
.url{
  font-family:var(--mono);font-size:1rem;word-break:break-all;margin:0;
  color:var(--carbon);user-select:all;
}
ol{padding-left:1.15rem;max-width:36rem}
ol li{margin-bottom:.45rem}
.jurs{display:grid;grid-template-columns:repeat(auto-fit,minmax(13rem,1fr));gap:1.5rem 2rem;margin:1.25rem 0}
.jur h3{color:var(--steel-ink);font-size:.78rem;letter-spacing:.1em;text-transform:uppercase;font-family:var(--mono);font-weight:400}
ul.feeds{list-style:none;margin:0;padding:0}
ul.feeds li{padding:.3rem 0;border-top:1px solid var(--rule);font-size:.95rem}
.reg{font-family:var(--mono);font-size:.88rem}
.feed{color:var(--steel-ink);font-size:.88rem}
.note{font-size:.92rem;color:var(--steel-ink)}
dl{margin:1rem 0;max-width:36rem}
dt{font-family:var(--display);font-weight:600;font-size:.95rem;margin-top:1rem}
dd{margin:.15rem 0 0}
.tools{width:100%;border-collapse:collapse;margin:1rem 0;max-width:36rem}
.tools td{border-top:1px solid var(--rule);padding:.5rem .75rem .5rem 0;vertical-align:top;font-size:.95rem}
.tools td:first-child{font-family:var(--mono);font-size:.85rem;white-space:nowrap;width:1%;padding-right:1.25rem}
footer{border-top:1px solid var(--rule);margin-top:3.5rem;padding-top:1.5rem;font-size:.9rem;color:var(--steel-ink)}
footer p{max-width:36rem}
.disclaimer{font-weight:400;color:var(--graphite)}
@media (max-width:640px){
  .wrap{padding:2.5rem 1.15rem 3.5rem}
  h1{font-size:1.85rem}
  body{font-size:16px}
}
</style>
</head>
<body>
<div class="wrap">

<header>
  <p class="eyebrow">Dartmouth Advisory Partners</p>
  <h1>DAP Bellwether</h1>
  <p class="lede">A free regulatory change feed for financial regulators in Canada, the United States, the United Kingdom and the European Union, delivered as an MCP connector. No account, no key, no seat licence.</p>
</header>

<h2>What it is</h2>
<p>Bellwether collects what financial regulators publish, normalises it into one record shape, and serves it to any MCP client as a set of read-only tools. It holds prior state, so it can tell you that a document was amended after publication and what the earlier text said. That is the difference between detecting change and displaying a list.</p>
<p>It is built for the people who have to keep track: compliance and legal teams, risk and policy functions, analysts covering regulated sectors, and anyone who would otherwise be checking ${feedCount} regulator pages by hand.</p>
<p>Coverage begins from when the service first collected each source. It is not a complete historical archive, and the tools say so rather than letting an absence of results look like an absence of regulation.</p>

<h2>Add it to Claude</h2>
<div class="connector">
  <p class="label">Connector URL</p>
  <p class="url">${esc(mcpUrl)}</p>
</div>
<ol>
${SETUP_STEPS.map((step) => `  <li>${esc(step)}</li>`).join('\n')}
</ol>
<p>There is nothing to authenticate and nothing to configure. Adding a connector does not switch it on by itself, so the last step matters. Free plan users are limited to one custom connector. On Team and Enterprise plans an owner adds it for the organization first.</p>

<h2>Tools</h2>
<table class="tools">
  <tbody>
    <tr><td>search_regulatory_changes</td><td>What a regulator has published on a topic, or in a window</td></tr>
    <tr><td>recent_regulatory_changes</td><td>What is new across all regulators</td></tr>
    <tr><td>get_regulatory_change</td><td>A full record, plus every revision observed since first collection</td></tr>
    <tr><td>list_coverage</td><td>What is monitored, and how fresh each source is</td></tr>
  </tbody>
</table>
<p>All four are read-only. There is no write surface.</p>

<h2>Price</h2>
${priceMarkup(pricing)}

<h2>Coverage</h2>
<p>${feedCount} feeds across ${jurisdictionCount} jurisdictions. This list is generated from the live source registry, so it is what the connector actually collects rather than what it once intended to.</p>
${coverageMarkup()}

<h2>How this was built</h2>
<p>Bellwether went from a question to a deployed public service in under forty minutes, built by one person who does not write code, working with Claude.</p>
<p>It runs on Cloudflare Workers with a D1 database and a cron trigger every six hours. The ingest normalises ${feedCount} feeds into one record shape and hashes each record, so an amendment is detected rather than quietly overwritten. The MCP layer is written against the streamable HTTP transport. There is a test suite, a privacy statement, a custom domain, and an entry in the official MCP Registry under a DNS verified namespace. Hosting costs nothing at this volume.</p>
<p>The source is public under the MIT licence. <a href="https://github.com/bsibeth234/dap-bellwether">Read it, fork it, run your own.</a></p>
<p>The point is not that the tool is clever. It is that the cost of building a working, governed, production system has collapsed, and most of what institutions license today was priced before that happened.</p>

<h2>Working with us</h2>
<p>Dartmouth Advisory Partners is software in a service, not software as a service. We do not hand you a licence and wish you luck. You name the outcome. We build the system that produces it, in your environment, and you own what we build.</p>
<p>We work with compliance, risk and investment functions at asset owners, asset managers, OCIOs, pensions, insurers and family offices. Work that is quoted in quarters elsewhere gets delivered here in weeks, and often in days. This page is the evidence, not the exception.</p>
<p>If something here made you think of a problem in your own shop, that is the conversation.</p>
<p><a href="mailto:bsibeth@dap.solutions">bsibeth@dap.solutions</a></p>

<h2>Privacy</h2>
${privacyMarkup()}

<footer>
  <p class="disclaimer">This is a public information service. It is not legal or compliance advice.</p>
  <p>Built and maintained by <a href="https://dap.solutions">Dartmouth Advisory Partners</a>, Toronto. Source released under the MIT licence.</p>
</footer>

</div>
</body>
</html>
`;
}
