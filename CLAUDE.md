# DAP Bellwether

A public, read-only MCP connector serving regulatory publications from
financial regulators in Canada, the US, the UK and the EU. Free for people,
agents pay per call (positioning set by Brendan, 1 November 2026). A cron job ingests
feeds into Cloudflare D1 and the MCP tools read from D1. Read `README.md` for
what it does.

## Deployment record

| | |
| --- | --- |
| Canonical URL | https://bellwether.dap.solutions |
| Canonical MCP endpoint | https://bellwether.dap.solutions/mcp |
| Fallback URL | https://dap-bellwether.dap-solutions.workers.dev, kept enabled via `workers_dev = true` |
| Custom domain bound | 2026-07-25. Creates one proxied DNS record for `bellwether` in the dap.solutions zone and its certificate. No other record in the zone was touched. |
| D1 database name | bellwether |
| workers.dev subdomain | dap-solutions |
| Cron | `0 */6 * * *`, every six hours |
| First successful ingest | 2026-07-25, 10 of 10 sources, 117 records |
| Sources verified against the live web | 2026-07-24 |
| Registry name | `solutions.dap/bellwether` |
| Registry entry | https://registry.modelcontextprotocol.io, 1.0.0 published 2026-07-25; 1.1.0 published 2026-11-01T06:22:31Z ("Free for people, agents pay per call."), status active, latest |
| Signing key | `~/.config/mcp-publisher/dap-solutions-key.pem`, mode 600, outside the repo, not recoverable, also held in a password manager |
| Domain proof | TXT record at the `dap.solutions` apex, starts `v=MCPv1`. The registry re-verifies domain ownership at each login, so removing this record blocks future publishes even though it does not break the existing listing. |
| Republishing | Bump `version` in `server.json`, then `mcp-publisher login dns`, then `mcp-publisher publish`. The registry rejects a republish at the same version. |
| Paid tier | `src/pricing.js` and `src/payments.js`. 50 free calls per address per UTC day to the three data tools, then $0.01 USDC on Base through x402 (DAP Agent Payments). Off until the secret `X402_PAY_TO` is set; `/health` reports `payments.status` as off, on, misconfigured or degraded. README, "The paid tier", has the switch-on steps. |
| Paid tier switched on | 2026-11-01 about 06:18 UTC, by Brendan running `scripts/switch-on.sh` on his Mac: CDP key checked with the facilitator, tables added, four secrets set, deploy version `61c5dd42-5ff9-4edd-af41-6eeeeec44bc1`, `/health` on, then from his Mac 50 of 50 searches free and call 51 priced at 10000 atomic USDC on Base to `0xa590d98bbee97533bd7dfed19c0a89ffeeeb1384`. Checked again from Chrome: `/health` on with 10 of 10 feeds, and the Claude connector still answers a search free. Off again: `npx wrangler secret delete X402_PAY_TO`. |

## The corrected endpoints

This is the durable finding. Eight of the thirteen endpoints originally in
`src/sources.js` failed when first pulled against the live web. Without this
record the next person repeats the whole verification.

| Source | Was | Now | Why |
| --- | --- | --- | --- |
| `ca-osfi-news` | `osfi-bsif.gc.ca/en/rss/news.xml` | `osfi-bsif.gc.ca/en/rss.xml` | 404. OSFI serves one site-wide feed and no news-only feed, so the entry is named "Site-wide publications" rather than claiming to be news. |
| `ca-osc-news` | `osc.ca/en/rss/news.xml` | `feeds.feedburner.com/rss_osc_headlines_en` | 404, and osc.ca returns 403 to non-browser clients. This is the address the OSC's own RSS page publishes. |
| `us-sec-proposed-rules` | `sec.gov/rss/rules/proposed.xml` | Federal Register, SEC, type PRORULE | Answered 200 and parsed while frozen since 2023-07-26. The SEC retired its rules feeds and points at the Federal Register. |
| `us-sec-final-rules` | `sec.gov/rss/rules/final.xml` | Federal Register, SEC, type RULE | 404, same reason. |
| `us-finra-notices` | `finra.org/rss/notices.xml` | `finra.org/rules-guidance/notices/rss` | 404. |

Disabled, because no collectable feed exists:

- `ca-ciro-bulletins`: CIRO returns 403 to automated clients at every address
  including the site root, under our user agent and a browser one alike.
- `uk-tpr-news`: TPR publishes no RSS. Nothing declared on the media hub or
  the site root, no address pattern resolves.
- `eu-eiopa-news`: EIOPA publishes no RSS. Nothing on the homepage, the media
  page or the Commission newsroom, and every pattern 404s including the one
  its sibling ESMA serves.

Two failures were ours rather than the regulators':

- The XML parser rejected valid documents on fast-xml-parser's default
  `maxTotalExpansions` of 1000. Regulator feeds embed escaped HTML in
  descriptions and exceed that on volume alone. ESMA died at 1002 on a valid
  50KB feed. Ceiling raised in `src/feedparser.js`.
- FCA stamps items `Thursday, July 23, 2026 - 12:05`, which `Date.parse`
  refuses, so every UK record was landing with no date. Handled in `toIso`.

## Gotchas worth knowing before you debug

- **Do not trust local `wrangler dev` for coverage.** OSFI and CFTC both fail
  in local `workerd` with a header-independent `internal error` while working
  perfectly from Cloudflare's network. Verified: 8 of 10 sources locally, 10
  of 10 from the edge. Use `wrangler dev --remote` when checking ingest.
- **`verify:sources` checks more than reachability**, deliberately. Two of the
  original five passes were false: a feed frozen for three years and a feed
  with no parseable dates. It now asserts freshness (90 days, overridable per
  source with `maxAgeDays`) and a dated-items floor (80 percent). Sources that
  are legitimately sparse or undated carry `sparse` or `datesUnavailable` so
  the exception is explicit and reported every run, rather than the threshold
  being lowered for everyone.
- **ESMA publishes no date element at all.** Its records fall back to
  collection time. `formatChange` renders that as "first collected YYYY-MM-DD,
  publication date not provided by source" rather than a bare date, and
  `searchChanges` ranks dated records above undated ones so a collection
  timestamp cannot outrank a real publication date. Do not try to recover the
  date from summary text: those summaries carry comment deadlines alongside
  publication dates, and a pattern that cannot tell them apart will eventually
  stamp a record with the wrong one. A missing date beats a wrong date.
- **The Federal Register feeds are a rolling 30 day window.** A quiet
  rulemaking month returns zero items legitimately, which is why both carry
  `sparse: true`.
- **IPv6 from at least one dev machine cannot reach the worker.** `curl` fails
  with `sslv3 alert handshake failure` over IPv6 and returns 200 over IPv4.
  This is a local network path issue, not an outage. Use `curl -4` before
  concluding the service is down.
- **`workers_dev = true` must stay above the `[[routes]]` table** in
  `wrangler.toml`. It is a top level key, and TOML assigns any key after a
  table header to that table, so putting it below makes the deploy fail
  validation. Without it, declaring a route silently disables the workers.dev
  fallback.
- **Run `npm run build:assets` after changing anything in `public/`.** A Worker
  has no filesystem, so icons, the manifest and the fonts are base64 inlined
  into the generated `src/assets.js`, which is committed. Editing `public/`
  without regenerating deploys the previous bytes and nothing complains.
- **The landing page is rendered per request, not static.** Its coverage list
  comes from the source registry, so correcting or disabling a regulator
  updates the public page automatically. Never hardcode that list: the page
  would then claim coverage the connector does not have.

- **`src/x402/` is vendored, not ours to edit here.** It is the DAP Agent
  Payments library copied byte for byte from `dap-foundry/edge/x402/src/lib`.
  `test/payments.test.mjs` fails if a file drifts from the hashes in
  `src/x402/VENDORED.md`. Change it in dap-foundry, where its own tests run,
  then copy it across and update the hashes.
- **Tests load the vendored TypeScript through esbuild** (`test/register-ts.mjs`),
  not through Node's own TypeScript support. The library uses parameter
  properties, which plain type stripping refuses, and Node 26 removed the
  `--experimental-transform-types` flag that once allowed them (found on
  Brendan's Mac, 1 November 2026). Wrangler bundles the same files with
  esbuild, so tests and the Worker read one source. Node 22.5 or later.
- **A bad payment setting fails open.** The paid tier stays off and `/health`
  names the setting. This is a public information service: a mistake should
  cost revenue, never a light user's answer. A facilitator outage during a
  paid call is different: that call gets a 503 and no free answer.
- **Claude's tool calls come from Anthropic's published outbound range,
  160.79.104.0/21.** Measured 2026-10-25 to 2026-11-01: 681 `Claude-User`
  requests from 59 addresses, at most 40 per address in the week, so a per
  address allowance does not pool Claude users into one count.

## Conventions

- Never use em dashes or en dashes anywhere, including code comments and
  commit messages.
- "Gate Zero" is the only name for the build framework. Never abbreviate it.
- Canadian spelling in prose.
- Done means demonstrated. A passing build is not a working connector.
