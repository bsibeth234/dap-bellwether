/**
 * The public landing page.
 *
 * Rendered per request rather than kept as a static file, because the coverage
 * list has to come from the source registry. A hardcoded list would drift the
 * moment a regulator is corrected or disabled, and this page would then be
 * claiming coverage the connector does not have, which is the one thing the
 * whole service is built not to do.
 *
 * DAP's 2026 brand and its one-screen design language, as on dap.solutions
 * (brand/one-screen.md in dap-solutions-site). The first screen says four
 * things over one photograph: the name, one headline, one line on what the
 * visitor gets, and one action. Everything else sits below in short sections
 * on the light Reading Room ground. Raleway Light for display, Archivo for
 * text, JetBrains Mono for labels and the URL. One red line per view: the
 * photograph's on the first screen, the connector block's below it.
 */

import { SOURCES, JURISDICTIONS, enabledSources } from './sources.js';

/** What the service is, in one line, for the title and both card previews.
 *  Positioning set by Brendan Sibeth, 1 November 2026: free for people,
 *  agents pay per call. Said only while the paid tier is on, because the page
 *  says only what the connector does. */
const TAGLINE = 'Free for people. Agents pay per call.';

/** The meta description, shared by both card previews, so a link preview and
 *  a search result never describe the service differently. */
function describe(pricing) {
  return pricing && pricing.status === 'on'
    ? `Regulatory publications from financial regulators in Canada, the United States, the United Kingdom and the European Union, delivered as an MCP connector. ${TAGLINE}`
    : 'A free, public MCP connector serving regulatory publications from financial regulators in Canada, the United States, the United Kingdom and the European Union. No account, no key.';
}

function titleFor(pricing) {
  return pricing && pricing.status === 'on'
    ? 'DAP Bellwether, a regulatory change feed'
    : 'DAP Bellwether, a free regulatory change feed';
}

/** The product's own line, as on dap.solutions. The count comes from the
 *  registry, so the headline cannot claim a jurisdiction that is not watched. */
const COUNT_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
function headline() {
  const count = new Set(enabledSources().map((s) => s.jurisdiction)).size;
  const word = COUNT_WORDS[count] || String(count);
  return `Regulator updates from ${word} jurisdiction${count === 1 ? '' : 's'}, in one feed.`;
}

/** The photograph, shared with the Bellwether page on dap.solutions. */
const PHOTO = {
  base: '/media/bellwether',
  widths: [960, 1440, 1920],
  width: 1920,
  height: 1080,
  alt: 'Four slender concrete towers far apart in still water at dusk, each lit at the top, joined by a thin vermilion line on the water.',
};

/** Describes the social card image, which is a file and the same in every state. */
const CARD_ALT = `DAP Bellwether. Regulator updates from four jurisdictions, in one feed. ${TAGLINE} Four concrete towers in still water at dusk, joined by a thin vermilion line. bellwether.dap.solutions`;

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
      'For each paid call, a keyed hash of its payment authorization is kept so one payment cannot buy two answers. A payment may stay valid for at most an hour, and its claim is deleted by the first scheduled run after it expires, so within a day. It holds no query, and without the service\'s key it cannot be matched to the transfer.',
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
  return `<p>Free for people: ${esc(pricing.freeCallsPerDay)} calls a day from any one address to the three data tools, reset at 00:00 UTC. list_coverage is always free.</p>
<p>Agents pay per call past that: ${esc(pricing.price)} in USDC on ${esc(pricing.networkLabel)}, with x402 through <a href="${AGENT_PAYMENTS_URL}">DAP Agent Payments</a>. A call that fails is never charged and does not count.</p>`;
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

/** The brand faces, self hosted: the page makes no third party font request. */
const FONT_FACES = `@font-face{font-family:"Raleway";src:url("/fonts/Raleway-300.woff2") format("woff2");font-weight:300;font-style:normal;font-display:swap}
@font-face{font-family:"Archivo";src:url("/fonts/Archivo-400.woff2") format("woff2");font-weight:400;font-style:normal;font-display:swap}
@font-face{font-family:"Archivo";src:url("/fonts/Archivo-600.woff2") format("woff2");font-weight:600;font-style:normal;font-display:swap}
@font-face{font-family:"JetBrains Mono";src:url("/fonts/JBMono-400.woff2") format("woff2");font-weight:400;font-style:normal;font-display:swap}`;

/** DAP 2026 colour tokens (dap.solutions/assets/tokens.css). */
const TOKENS = `:root{
  --carbon:#111517; --graphite:#23262A; --warm-white:#F8F9FA; --vermilion:#D8412F;
  --bg:#F8F9FA; --surface:#FFFFFF; --ink:#111517; --ink-muted:#5B6168; --hairline:#E1E4E8; --rule:#8A9097;
  --scrim:rgba(17,21,23,.34); --scrim-tall:rgba(17,21,23,.44);
  --photo-ink-72:rgba(248,249,250,.72); --photo-ink-80:rgba(248,249,250,.80); --photo-ink-88:rgba(248,249,250,.88);
  --display:"Raleway","Archivo",system-ui,sans-serif;
  --sans:"Archivo",system-ui,sans-serif;
  --mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
}`;

/** The DAP lockup for a dark ground, linking home. A supplied kit file, never redrawn. */
const LOGO = '<a class="logo" href="https://dap.solutions"><img src="/brand/dap-logo-horizontal-carbon.svg" width="200" height="31" alt="DAP, Dartmouth Advisory Partners"></a>';

/**
 * The page a person gets when they paste the connector URL into a browser
 * instead of into Claude.
 *
 * Served only for a GET whose Accept ranks text/html above the protocol types,
 * so no MCP client can reach it. It exists because the honest protocol answer,
 * a JSON-RPC error saying SSE is not supported, reads as a broken service to
 * the one audience most likely to see it.
 *
 * Self contained rather than sharing the landing page's stylesheet: this is a
 * dead end page, and coupling it to the main sheet would mean every future
 * landing page change has to be re-checked here. It shares only the fonts and
 * colour tokens, which are the brand, not the layout. The DAP lockup carries
 * this view's one red line, so nothing else here is vermilion.
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
<meta name="theme-color" content="#111517">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32.png">
<style>
${FONT_FACES}
${TOKENS}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--carbon);color:var(--warm-white);font-family:var(--sans);font-size:16px;line-height:26px}
a{color:inherit}
.wrap{max-width:46rem;margin:0 auto;padding:40px 24px 64px}
.logo{display:inline-block}
.logo img{display:block;width:200px;height:auto}
.meta{font-family:var(--mono);font-size:12px;line-height:16px;letter-spacing:.12em;text-transform:uppercase;color:var(--photo-ink-72);margin:64px 0 0}
h1{font-family:var(--display);font-weight:300;font-size:clamp(34px,5vw,48px);line-height:1.12;letter-spacing:-.01em;margin:20px 0 0}
.lede{margin:20px 0 0;max-width:34rem;color:var(--photo-ink-88);font-size:18px;line-height:28px}
.connector{margin:40px 0 0;background:var(--graphite);border-top:1px solid rgba(248,249,250,.18);padding:20px 24px}
.connector .meta{margin:0 0 8px}
.url{font-family:var(--mono);font-size:16px;word-break:break-all;margin:0;user-select:all}
ol{margin:28px 0 0;padding-left:1.2rem;max-width:34rem}
li{margin:0 0 8px;color:var(--photo-ink-88)}
.note{margin:20px 0 0;max-width:34rem;color:var(--photo-ink-72)}
footer{margin-top:56px;padding-top:20px;border-top:1px solid rgba(248,249,250,.18);color:var(--photo-ink-72);font-size:14px}
</style>
</head>
<body>
<div class="wrap">
${LOGO}
<p class="meta">DAP Bellwether / Connector endpoint</p>
<h1>This is a connector endpoint, not a web page</h1>
<p class="lede">Paste this address into Claude as a custom connector. Nothing is broken: there is simply nothing here for a browser to show.</p>

<div class="connector">
  <p class="meta">Connector URL</p>
  <p class="url">${esc(mcpUrl)}</p>
</div>
<ol>
${SETUP_STEPS.map((step) => `  <li>${esc(step)}</li>`).join('\n')}
</ol>
<p class="note">Nothing to sign in to. Adding a connector does not switch it on by itself, so the last step matters.</p>

<footer>
  <p>What it covers and what it costs: <a href="${esc(origin)}/">${esc(host)}</a></p>
</footer>
</div>
</body>
</html>
`;
}

/**
 * @param {string} origin the request origin, so the page advertises the host
 *   it was actually reached on rather than a hardcoded one
 * @param {object} [pricing] pricingSummary() of the live settings; off when absent
 */
export function renderLanding(origin, pricing = { status: 'off' }) {
  const mcpUrl = `${origin}/mcp`;
  const feedCount = enabledSources().length;
  const jurisdictionCount = new Set(enabledSources().map((s) => s.jurisdiction)).size;
  const title = esc(titleFor(pricing));
  const description = esc(describe(pricing));
  const on = pricing && pricing.status === 'on';
  const line = on ? TAGLINE : 'Free. No account, no key.';
  const srcset = PHOTO.widths.map((w) => `${PHOTO.base}-${w}.webp ${w}w`).join(', ');

  return `<!doctype html>
<html lang="en-CA">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${description}">
<meta name="theme-color" content="#111517">
<link rel="canonical" href="${esc(CANONICAL_URL)}">

<meta property="og:type" content="website">
<meta property="og:site_name" content="DAP Bellwether">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${esc(CANONICAL_URL)}">
<meta property="og:image" content="${esc(origin)}/og.jpg">
<meta property="og:image:type" content="image/jpeg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(CARD_ALT)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${description}">
<meta name="twitter:image" content="${esc(origin)}/og.jpg">
<meta name="twitter:image:alt" content="${esc(CARD_ALT)}">

<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" type="image/png" sizes="16x16" href="/icons/favicon-16.png">
<link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32.png">
<link rel="icon" type="image/png" sizes="48x48" href="/icons/favicon-48.png">
<link rel="icon" type="image/png" sizes="192x192" href="/icons/favicon-192.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<link rel="preload" as="image" href="${PHOTO.base}-1440.webp" imagesrcset="${srcset}" imagesizes="100vw">

<style>
${FONT_FACES}
${TOKENS}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:16px;line-height:26px}
img{max-width:100%}
a{color:inherit;text-underline-offset:.2em;text-decoration-thickness:1px}
.wrap{width:100%;max-width:1440px;margin:0 auto;padding-left:80px;padding-right:80px}
.meta{font-family:var(--mono);font-size:12px;line-height:16px;letter-spacing:.12em;text-transform:uppercase;font-weight:400}
.disp{font-family:var(--display);font-weight:300;letter-spacing:-.01em}
.btn{display:inline-flex;align-items:flex-end;gap:14px;min-height:44px;padding:0 0 8px;border-bottom:1px solid currentColor;text-decoration:none;font-family:var(--sans);font-weight:600;font-size:12px;line-height:16px;letter-spacing:.18em;text-transform:uppercase;transition:opacity .3s ease}
.btn:hover{opacity:.7}
.btn:focus-visible,a:focus-visible{outline:2px solid currentColor;outline-offset:4px}

/* The first screen. */
.one{position:relative;overflow:hidden;height:100vh;height:100svh;min-height:600px;max-height:1200px;background:var(--carbon);color:var(--warm-white)}
.one-img{position:absolute;inset:0;width:100%;height:100%;max-width:none;object-fit:cover;object-position:50% 50%}
.one-scrim{position:absolute;inset:0;background:var(--scrim);pointer-events:none}
.one-inner{position:relative;height:100%;display:flex;flex-direction:column;padding-top:32px;padding-bottom:clamp(24px,4vh,44px)}
.logo{display:inline-block;align-self:flex-start}
.logo img{display:block;width:200px;height:auto}
.one-copy{max-width:700px;margin:auto 0}
.one-name{margin:0;color:var(--photo-ink-80)}
.one-title{margin:22px 0 0;font-size:clamp(42px,min(4.8vw,8.6vh),78px);line-height:1.04;color:var(--warm-white)}
.one-line{margin:22px 0 0;max-width:32ch;font-size:clamp(19px,min(1.7vw,3vh),26px);line-height:1.4;color:var(--photo-ink-88)}
.one-cta{margin-top:clamp(28px,4.5vh,44px);color:var(--warm-white)}

/* Below the screen: short sections on the Reading Room ground. */
.section{padding:72px 0;border-top:1px solid var(--hairline)}
.section:first-child{border-top:0}
.grid{display:grid;grid-template-columns:minmax(0,4fr) minmax(0,7fr);gap:24px 64px}
.section .meta{margin:0;color:var(--ink-muted)}
h2{margin:14px 0 0;font-family:var(--display);font-weight:300;font-size:clamp(30px,3.2vw,44px);line-height:1.15;letter-spacing:-.01em}
.body p{margin:0 0 16px;max-width:38rem}
.body p:last-child{margin-bottom:0}
.muted{color:var(--ink-muted)}

/* The one active mark below the screen: the address a visitor came for. */
.connector{background:var(--surface);border:1px solid var(--hairline);border-left:2px solid var(--vermilion);padding:20px 24px;margin:0 0 24px}
.connector .meta{margin:0 0 8px;color:var(--ink-muted)}
.url{font-family:var(--mono);font-size:16px;line-height:24px;word-break:break-all;margin:0;user-select:all}
ol.steps{margin:0 0 16px;padding:0;list-style:none;counter-reset:step;max-width:38rem}
ol.steps li{counter-increment:step;display:grid;grid-template-columns:32px 1fr;padding:12px 0;border-top:1px solid var(--hairline)}
ol.steps li::before{content:counter(step,decimal-leading-zero);font-family:var(--mono);font-size:12px;color:var(--ink-muted);padding-top:1px}

.tools{width:100%;border-collapse:collapse;max-width:38rem;margin:0 0 16px}
.tools td{border-top:1px solid var(--hairline);padding:12px 16px 12px 0;vertical-align:top}
.tools td:first-child{font-family:var(--mono);font-size:13px;white-space:nowrap;width:1%;padding-right:24px}

.jurs{display:grid;grid-template-columns:repeat(auto-fit,minmax(12rem,1fr));gap:24px 32px;margin:0 0 16px}
.jur h3{margin:0 0 8px;font-family:var(--mono);font-weight:400;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-muted)}
ul.feeds{list-style:none;margin:0;padding:0}
ul.feeds li{padding:8px 0;border-top:1px solid var(--hairline);font-size:15px;line-height:22px}
.reg{font-weight:600}
.feed{color:var(--ink-muted)}
.note{font-size:14px;line-height:22px;color:var(--ink-muted)}

dl{margin:16px 0 0;max-width:46rem}
dt{font-weight:600;margin:0;padding-top:14px;border-top:1px solid var(--hairline)}
dd{margin:4px 0 14px;color:var(--ink-muted);font-size:15px;line-height:24px}

footer{background:var(--carbon);color:var(--photo-ink-72);padding:40px 0 48px;font-size:14px;line-height:22px}
footer p{margin:0 0 6px;max-width:46rem}
.disclaimer{color:var(--warm-white)}

@media (max-width:1100px){.wrap{padding-left:32px;padding-right:32px}.grid{grid-template-columns:1fr}}
@media (max-width:640px),(orientation:portrait){
  .one-scrim{background:var(--scrim-tall)}
  .one-copy{margin:auto 0 32px}
  .one-img{object-position:74% 50%}
}
@media (max-width:640px){
  .wrap{padding-left:16px;padding-right:16px}
  .one-title{font-size:40px}
  .logo img{width:180px}
  .section{padding:48px 0}
  .tools td:first-child{white-space:normal;word-break:break-all}
}
</style>
</head>
<body>

<section class="one" aria-labelledby="page-title">
  <img class="one-img" src="${PHOTO.base}-1440.webp" srcset="${srcset}" sizes="100vw" width="${PHOTO.width}" height="${PHOTO.height}" alt="${esc(PHOTO.alt)}" fetchpriority="high" decoding="async">
  <div class="one-scrim" aria-hidden="true"></div>
  <div class="wrap one-inner">
    ${LOGO}
    <div class="one-copy">
      <p class="meta one-name">DAP Bellwether</p>
      <h1 id="page-title" class="disp one-title">${esc(headline())}</h1>
      <p class="one-line">${esc(line)}</p>
      <a class="btn one-cta" href="#add">Add it to Claude <span aria-hidden="true">↓</span></a>
    </div>
  </div>
</section>

<main>
<section class="section" id="add" aria-labelledby="add-title"><div class="wrap grid">
  <div><p class="meta">01 / Connect</p><h2 id="add-title">Add it to Claude</h2></div>
  <div class="body">
    <div class="connector">
      <p class="meta">Connector URL</p>
      <p class="url">${esc(mcpUrl)}</p>
    </div>
    <ol class="steps">
${SETUP_STEPS.map((step) => `      <li>${esc(step)}</li>`).join('\n')}
    </ol>
    <p class="muted">Nothing to sign in to. Adding a connector does not switch it on by itself, so the last step matters. Free plan users can add one custom connector. On Team and Enterprise plans, an owner adds it for the organization first.</p>
  </div>
</div></section>

<section class="section" id="price" aria-labelledby="price-title"><div class="wrap grid">
  <div><p class="meta">02 / People and agents</p><h2 id="price-title">Price</h2></div>
  <div class="body">
${priceMarkup(pricing)}
    <p class="muted">Agents connect to the same URL over streamable HTTP. It is listed in the official MCP Registry as solutions.dap/bellwether.</p>
  </div>
</div></section>

<section class="section" id="tools" aria-labelledby="tools-title"><div class="wrap grid">
  <div><p class="meta">03 / What it answers</p><h2 id="tools-title">Tools</h2></div>
  <div class="body">
    <table class="tools">
      <tbody>
        <tr><td>search_regulatory_changes</td><td>What a regulator has published on a topic, or in a window</td></tr>
        <tr><td>recent_regulatory_changes</td><td>What is new across all regulators</td></tr>
        <tr><td>get_regulatory_change</td><td>A full record, plus every revision observed since first collection</td></tr>
        <tr><td>list_coverage</td><td>What is monitored, and how fresh each source is</td></tr>
      </tbody>
    </table>
    <p class="muted">All four are read-only. There is no write surface.</p>
  </div>
</div></section>

<section class="section" id="coverage" aria-labelledby="coverage-title"><div class="wrap grid">
  <div><p class="meta">04 / ${feedCount} feeds, ${jurisdictionCount} jurisdictions</p><h2 id="coverage-title">Coverage</h2></div>
  <div class="body">
    <p>This list comes from the live source registry, so it is what the connector actually collects.</p>
${coverageMarkup()}
    <p class="note">Coverage begins when Bellwether first collected each source. It is not a complete historical archive, and the tools say so rather than let an absence of results look like an absence of regulation.</p>
  </div>
</div></section>

<section class="section" id="about" aria-labelledby="about-title"><div class="wrap grid">
  <div><p class="meta">05 / About</p><h2 id="about-title">What it is</h2></div>
  <div class="body">
    <p>Bellwether collects what financial regulators publish, normalizes it into one record shape and serves it to any MCP client. It keeps prior versions, so it can show that a document was amended after publication, and what changed.</p>
    <p>It went from a question to a deployed public service in under forty minutes, built by one person who does not write code, working with Claude. <a href="https://github.com/bsibeth234/dap-bellwether">The source is public under the MIT licence.</a></p>
    <p>Dartmouth Advisory Partners builds systems like this for compliance, risk and investment teams. Results as a service, not software as a service. Work that is quoted in quarters elsewhere gets delivered here in weeks, and often in days. <a href="mailto:bsibeth@dap.solutions">bsibeth@dap.solutions</a></p>
  </div>
</div></section>

<section class="section" id="privacy" aria-labelledby="privacy-title"><div class="wrap grid">
  <div><p class="meta">06 / Privacy</p><h2 id="privacy-title">Privacy</h2></div>
  <div class="body">
${privacyMarkup()}
  </div>
</div></section>
</main>

<footer><div class="wrap">
  <p class="disclaimer">This is a public information service. It is not legal or compliance advice.</p>
  <p>Built and maintained by <a href="https://dap.solutions">Dartmouth Advisory Partners</a>, Toronto. Source released under the MIT licence.</p>
</div></footer>

</body>
</html>
`;
}
