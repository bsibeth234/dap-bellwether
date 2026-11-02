# DAP Bellwether

A regulatory change feed for financial regulators in Canada, the United States, the United Kingdom and the European Union, delivered as an MCP connector.

Free for people. Agents pay per call. Institutions can take a licence, billed by invoice.

Built and maintained by [Dartmouth Advisory Partners](https://dap.solutions), Toronto.

## What it does

Bellwether collects what financial regulators publish, normalises it into one record shape, and serves it to any MCP client as a set of read-only tools. It holds prior state, so it can tell you that a document was amended after publication and what the earlier text said. That is the difference between detecting change and displaying a list.

Coverage begins from when the service first collected each source. It is not a complete historical archive, and the tools say so rather than letting an absence of results look like an absence of regulation.

This is a public information service. It is not legal or compliance advice.

## Using it

Add the server as a custom connector in Claude:

```
https://bellwether.dap.solutions/mcp
```

1. In Claude, open Customize, then Connectors.
2. Click the plus button next to Connectors and choose add custom connector.
3. Give it a name, paste the URL above, and click Add.
4. In a chat, click the plus button, hover Connectors, and toggle it on.

There is nothing to authenticate and nothing to configure. Adding a connector does not switch it on by itself, so the last step matters. Free plan users are limited to one custom connector, which is one reason a Connectors Directory listing is worth pursuing. No submission has been made yet. On Team and Enterprise plans an owner adds it for the organization first.

The Worker also answers on `https://dap-bellwether.dap-solutions.workers.dev/mcp`, which is kept enabled as a fallback and serves an identical response. Hand out the `bellwether.dap.solutions` address.

### Tools

| Tool | What it answers |
| --- | --- |
| `search_regulatory_changes` | What has a regulator published on this topic, or in this window |
| `recent_regulatory_changes` | What is new across all regulators |
| `get_regulatory_change` | Full record, plus every revision observed since first collection |
| `list_coverage` | What is monitored, and how fresh each source is |

All four are read-only. There is no write surface.

### Price

Free for people: 50 calls a day from any one address to the three data tools, reset at 00:00 UTC. An IPv6 caller is counted per /64, and every /64 in a /48 also shares a ceiling of ten allowances, so a larger block cannot be rotated into free calls. Only answered calls count. `list_coverage`, `initialize` and `tools/list` are always free.

Agents pay per call past that: $0.01 in USDC on Base, with [x402](https://x402.org) through [DAP Agent Payments](https://dap.solutions/solutions/systems/agent-payments/). An agent that cannot pay gets a payment required result, with the price and when the allowance resets. A call that fails is never charged and does not count. An answer is released only once its payment has been sent to the chain, one payment buys one answer however many Worker instances it reaches, and a payment may stay valid for at most an hour.

The paid tier is off until it is switched on (see Deploying). While it is off, every call is free and nothing is counted per caller. The landing page, `/health` and the MCP `instructions` all say which state is live.

### JSON API

The same records as JSON over HTTPS GET, for agents and systems that do not speak MCP. Described in OpenAPI 3.1 at `https://bellwether.dap.solutions/openapi.json`.

| Endpoint | Price |
| --- | --- |
| `GET /api/search?query=&jurisdiction=&regulator=&category=&since=&until=&limit=` | $0.01 from the first call |
| `GET /api/recent?jurisdiction=&days=&limit=` | $0.01 from the first call |
| `GET /api/change?id=` | $0.01 from the first call |
| `GET /api/coverage` | Free |

There is no free allowance on the API: people use the connector, and an agent calling an API can pay. That is also what lets x402 directories such as Coinbase's Bazaar list it, since they index an endpoint by calling it and expecting the price. A request with an unknown parameter or a bad value is refused with 400 before any payment is asked for. A record that does not exist answers 404 and is never charged. `since` and `until` are compared as UTC times: a year, a month or a date alone covers that whole period, a time may use `T` or a space, and a time without a zone is UTC. A date the regulator did not publish is `null`, never our collection time. The record id is a query parameter so it never reaches the payment facilitator, which sees the path only.

### Institutional licences

Institutions can take a licence instead of paying per call: one agreement, one invoice, and a key for their agents, with no crypto wallet. One DAP licence also covers the Compute Market Tracker at `dap.solutions/compute/`. Licences live in their own D1 database, `dap-licences` (`licences.sql`), which both Workers bind as `LICENCES` and nothing else binds; the tracker counts its calls under endpoint names starting `compute:`, so one usage report covers both, and neither Worker can reach the other's records. The key (`dapk_` and 43 characters) is sent as `Authorization: Bearer <key>` or `X-API-Key: <key>` on `/mcp` and `/api`. A licensed call skips the allowance and x402, and each answered call to a data tool or data endpoint adds one to the licence's daily count, which is what the invoice reads. On `/mcp` and the priced `/api` endpoints, an unknown or revoked key answers 401 rather than falling back to the free or paid rails, so a licensee finds out at once; `/api/coverage`, which is free, does not read keys. A key in any other shape, or two different keys, is refused the same way. A licensee may batch MCP calls while the paid tier is off, as anyone may, if every call in the batch carries a string or number id of its own; the batch's counts are written in one transaction before it is released. Any other `Authorization` header is ignored. Every licensed answer is counted before it is released; if the count cannot be written, the answer is withheld with 503. Keys are for the licensee's own servers and agents: the browser preflight does not allow these headers.

## Coverage

Canada: OSFI, OSC.
United States: SEC (press releases, and proposed and final rules through the Federal Register), FINRA, CFTC.
United Kingdom: FCA.
European Union: ESMA, EBA.

The live list is always what `list_coverage` returns, since a source that fails verification is disabled rather than shown.

Verified against the live web on 2026-07-24. Three regulators are deliberately absent:

- **CIRO** returns 403 to automated clients at every address, including the site root, so there is nothing to collect.
- **TPR** publishes no RSS feed.
- **EIOPA** publishes no RSS feed.

They are listed as not monitored rather than quietly omitted, because the point of `list_coverage` is that an absence of results can be trusted to mean an absence of publications.

Two limits worth knowing:

- **ESMA publishes no date on its items.** Those records are ordered by when Bellwether first collected them, and every result says so in place of a date rather than showing a collection date where a publication date belongs. Their first appearance is a burst of items all collected the same day.
- **The United Kingdom rests on the FCA alone.** If that feed breaks, the jurisdiction goes dark, and `list_coverage` will show it.

### Source limits

Some regulators' terms restrict commercial reuse. Records from OSFI, the OSC, the FCA and FINRA answer with title, date and link, so the regulator's own page remains the place to read them. FINRA collection is paused. ESMA material is available free of charge on the ESMA website.

Use of the API and connector is under the [DAP API terms](https://dap.solutions/terms/api/).

## Architecture

```
cron (every 6h) -> ingest -> normalise -> hash -> D1
                                                  |
                              MCP tools <---------+
```

A scheduled job pulls each feed, normalises RSS 2.0, RSS 1.0 (RDF) and Atom into one record shape, hashes the content, and writes to D1. The MCP tools read only from D1 and never call a regulator during a user request.

That separation is deliberate. If the tools fetched regulators on demand, then every outage, rate limit or retired feed would become a broken connector in front of a user, and there would be no prior state to compare against, so nothing could actually be detected as a change.

Sources are isolated during ingest. One regulator failing is recorded against that source and reported through `list_coverage`; the rest of the run continues.

### Notes on choices

- **No auth.** The entire surface is public regulatory material. There is nothing here to protect and nothing a user can damage, and skipping OAuth removes the largest source of directory review friction.
- **Metering by address, not by account.** An account would mean a sign in, which MCP hosts handle differently and many agents cannot do at all. A daily count per network address keeps the connector keyless, and x402 lets an agent pay per call without signing up for anything.
- **D1 rather than Postgres.** The store lives inside the same Worker with no external credentials and no egress. For a public read-only surface, fewer moving parts wins.
- **The MCP layer is written directly against JSON-RPC.** The reference SDK's HTTP transport expects a Node request and response pair, and the Workers path around it wants Durable Objects for session state. A read-only server has no session state worth keeping, so the stateless JSON mode the specification already permits is simpler and has less to break.
- **Keyword search is `LIKE`, not FTS5.** At the volumes these feeds produce, `LIKE` with the jurisdiction and date indexes is comfortably fast, and it avoids keeping an FTS index in sync through revisions. Worth revisiting if the corpus grows an order of magnitude.

## Deploying

```bash
npm install
npm test                     # 144 tests, no network required (Node 22.5 or later)
npm run verify:sources       # confirms every feed endpoint is live, requires network
```

`verify:sources` must pass before the first deploy, and again after any change to the registry. It checks that each feed resolves, parses, carries recent items and carries dates. The last two matter more than they sound: the first sweep of this registry produced two passes that were false, an SEC feed answering 200 while frozen since 2023 and an FCA feed returning twenty items with no parseable date between them. Both would have shipped as healthy coverage against a check that only asked whether a document arrived.

Anything that fails is corrected or set to `enabled: false`. Feeds that are legitimately sparse or legitimately undated carry an explicit flag on the registry entry, so the exception is recorded and reported on every run rather than the threshold being lowered for everyone.

Then:

```bash
npx wrangler d1 create bellwether        # paste database_id into wrangler.toml
npm run db:migrate                       # applies schema.sql to the remote D1
npx wrangler deploy
npx wrangler d1 execute bellwether --remote --command "SELECT COUNT(*) FROM changes"
```

The first ingest runs on the next cron tick. To trigger one immediately against the deployed database rather than waiting up to six hours:

```bash
npx wrangler dev --remote --test-scheduled     # then, in another shell:
curl "http://localhost:8790/__scheduled?cron=0+*/6+*+*+*"
```

Use `--remote` rather than plain `wrangler dev`. Local `workerd` cannot reach every regulator: OSFI and CFTC both fail there with a header-independent connection error while succeeding from Cloudflare's network, so a local run will under-report coverage and tell you a source is broken when it is not.

### The paid tier

The payment code in `src/x402/` is the DAP Agent Payments library, vendored unchanged from the Foundry payment edge (`src/x402/VENDORED.md` records the source and the hash of every file). Bellwether wraps it in `src/payments.js` with the daily allowance, and `src/pricing.js` decides from the settings whether the tier is on.

It is off until `X402_PAY_TO` is set. Switching it on is settings, not code, and one script does it in order, checking each step:

```bash
bash scripts/switch-on.sh      # tests, CDP key check, tables, secrets (wallet last), deploy, /health, paywall
```

It asks for the receiving wallet and a Coinbase CDP API key, checks the key with the facilitator before storing anything, and ends by proving the paywall from the machine it runs on: 50 free calls, then call 51 asks for one cent. By hand, the same steps are:

```bash
npm run db:migrate                                     # adds allowance_counts, payment_claims and tool_usage_daily
openssl rand -hex 32 | npx wrangler secret put ALLOWANCE_KEY
npx wrangler secret put CDP_API_KEY_ID                 # a Coinbase Developer Platform API key
npx wrangler secret put CDP_API_KEY_SECRET
npx wrangler secret put X402_PAY_TO                    # the wallet that receives USDC; this one switches it on
curl -s https://bellwether.dap.solutions/health        # payments.status should read "on"
```

`X402_NETWORKS` (Base mainnet, `eip155:8453`) and `FREE_CALLS_PER_DAY` (50) are plain settings in `wrangler.toml`. A setting that is present but wrong leaves the tier off and `/health` names the problem, so a bad setting costs revenue and never costs a light user an answer. A tier switched on before the migration reports `degraded` on `/health`, because it answers metered calls free until the tables exist. Deleting `X402_PAY_TO` switches it off again.

Known gap, shared with the Foundry edge because it is library code: if the facilitator does not answer a settlement within 30 seconds, the caller is told to resend the same payment, and a resend after the transfer has in fact landed is refused rather than answered. Fix it in dap-foundry and copy it across.

Usage, with no caller attached:

```bash
npx wrangler d1 execute bellwether --remote --command "SELECT * FROM tool_usage_daily ORDER BY day DESC, calls DESC"
```

### Issuing licences

Run on the Mac signed in to Cloudflare, from the repo root. The licence database is created once with `npx wrangler d1 create dap-licences`, its id goes in `wrangler.toml` here and in `workers/compute-agent/wrangler.toml` in dap-solutions-site, and `npm run db:migrate:licences` adds its two tables (it is safe to run again).

```bash
node scripts/licence.mjs issue "Example Pension Plan" --note "Master licence 2026-11"   # prints the key once
node scripts/licence.mjs list
node scripts/licence.mjs usage 2026-11        # answered calls per licence and endpoint, for the invoice
node scripts/licence.mjs revoke lic_1a2b3c4d  # the key answers 401 from then on; the record stays
node scripts/licence.mjs check                # live proof across Bellwether and the Compute Market Tracker: issue, call, revoke, expect 401
```

The key is shown once and never stored, only its SHA-256 is. Give it to the licensee over a secure channel. If it is lost, issue a new one and revoke the old. Revoking never deletes, so past usage can still be billed. Add `--local` to work on the local database. Run `check` a few seconds after a deploy of either service: straight after `wrangler deploy` it can still reach the old version at the edge.

### Verifying it works

```bash
curl https://bellwether.dap.solutions/health

curl -X POST https://bellwether.dap.solutions/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

`/health` reports record count, feeds monitored, and any feed currently failing.

Both hostnames should return byte identical output. If the custom domain fails while the workers.dev fallback answers, the problem is DNS or the certificate, not the Worker.

## Adding a regulator

Add an entry to `SOURCES` in `src/sources.js`, run `npm run verify:sources`, and deploy. Nothing else changes: the parser handles the three feed dialects, and the tools read whatever is in the store.

## Privacy policy

The connector keeps no accounts for people and no email addresses. This page counts visits without cookies or identifiers.

This section is kept word for word in step with the privacy section rendered on the landing page, from `PRIVACY` in `src/landing.js`. A test fails if they differ. Change one and change the other.

- **What is stored.** Regulatory publications retrieved from public regulator websites: title, link, summary, publication date and revision history. A daily total of calls per tool, with no caller attached, so we know what the service is used for. While the paid tier is on, the allowance counts and payment claims described below. For a licensed institution, its licence record and daily counts, also described below. Nothing else a user sends is written to the database.
- **What is received.** Tool calls arrive as search parameters, for example a keyword or jurisdiction. These are used to answer the request and are not stored, logged to durable storage, or associated with any identity. A paid call also carries an x402 payment authorization, a signed USDC transfer from the caller's wallet. It is passed to the payment facilitator and not stored here. A licensed call carries the institution's key, which is checked against a stored hash and not stored itself.
- **Allowance counts.** While the paid tier is on, the service counts calls to the three data tools per caller per UTC day, to meter the free allowance. The caller is recorded only as a keyed hash of its network address, bound to the day and never stored with the query. For IPv6 the count is kept for the /64 and for the /48 it sits in. Without the key, which only the service holds, a hash cannot be turned back into an address. Counts are deleted by the first scheduled run after the day ends, normally at 00:00 UTC. The Price section says whether the paid tier is on.
- **Payment claims.** For each paid call, a keyed hash of its payment authorization is kept so one payment cannot buy two answers. A payment may stay valid for at most an hour, and its claim is deleted by the first scheduled run after it expires, so within a day. It holds no query, and without the service's key it cannot be matched to the transfer.
- **Licences.** An institution that takes a licence has one record: its name as written on the licence, an internal note about the agreement, when the licence was issued and revoked, and a one-way hash of its key. The key itself is never stored. Each answered call under a licence adds one to a daily count for that licence and endpoint, which is what the invoice reads. No query or address is stored with it.
- **Accounts.** There are none for people. The service has no sign in, so it holds no passwords or email addresses. A licence is not an account: it holds only what the Licences row describes.
- **Analytics.** This page uses Cloudflare Web Analytics, a cookieless measurement service. It records the page viewed, the referring link, browser and operating system, approximate country and page load timings. It sets no cookies and writes nothing to your device. Visitor IP addresses are used to derive country and are not stored by the service. The connector endpoint at /mcp does not load the beacon. Tool calls are counted only as described above.
- **Third party sharing.** We do not sell personal information. Regulatory records are free within the daily allowance, then by paid call or licence. This page loads no third party fonts, no advertising and no cross site trackers. The only third party request it makes is the analytics beacon described above. A paid call's payment authorization goes to Coinbase's x402 facilitator, which verifies it and settles the transfer on the Base network, where the transfer is public. The query is never sent to it.
- **Retention.** Regulatory records and their revision history are retained indefinitely, because the historical record is the point of the service. Daily totals per tool are retained to report usage. Allowance counts are deleted once their day ends, and payment claims once they expire. Licence records and their daily counts are kept for invoicing and audit. Like everything in the database, a deleted row stays in Cloudflare D1's point-in-time recovery for up to 30 days, where only the service can restore it. Request parameters are not retained.
- **Infrastructure.** Hosted on Cloudflare Workers and D1, with Cloudflare Web Analytics on this page. The Worker keeps no request logs: it logs errors and the collection summary, never a caller's address or query. Cloudflare processes requests as an infrastructure provider and as an analytics processor under its own terms. Paid calls settle through Coinbase's x402 facilitator under its own terms.
- **Contact.** bsibeth@dap.solutions

## Licence

MIT. Use it, fork it, run your own. No lock-in.

The page's fonts (Raleway, Archivo and JetBrains Mono) are self-hosted under the SIL Open Font License, with each licence in `licences/fonts/`. The DAP logo and the Bellwether photograph are DAP brand assets, from the dap.solutions site, and are not covered by the MIT licence.
