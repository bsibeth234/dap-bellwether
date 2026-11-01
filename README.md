# DAP Bellwether

A free regulatory change feed for financial regulators in Canada, the United States, the United Kingdom and the European Union, delivered as an MCP connector.

No account. No key. No seat licence. Paste a URL and it is there.

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

Free for everyday use. While the paid tier is on, each caller gets 50 calls a day to the three data tools, counted per network address (IPv6 per /64) and reset at 00:00 UTC. `list_coverage`, `initialize` and `tools/list` are always free.

Past that, each call costs $0.02 in USDC on Base, paid per call with [x402](https://x402.org) through [DAP Agent Payments](https://dap.solutions/solutions/systems/agent-payments/). An agent that cannot pay gets a payment required result, with the price and a plain sentence saying when the allowance resets. A call that fails is never charged, and an answer is released only after its payment settles.

The paid tier is off until it is switched on (see Deploying). While it is off, every call is free and nothing is counted per caller. The landing page, `/health` and the MCP `instructions` all say which state is live.

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
- **D1 rather than Postgres.** The store lives inside the same Worker with no external credentials and no egress. For a free public read-only surface, fewer moving parts wins.
- **The MCP layer is written directly against JSON-RPC.** The reference SDK's HTTP transport expects a Node request and response pair, and the Workers path around it wants Durable Objects for session state. A read-only server has no session state worth keeping, so the stateless JSON mode the specification already permits is simpler and has less to break.
- **Keyword search is `LIKE`, not FTS5.** At the volumes these feeds produce, `LIKE` with the jurisdiction and date indexes is comfortably fast, and it avoids keeping an FTS index in sync through revisions. Worth revisiting if the corpus grows an order of magnitude.

## Deploying

```bash
npm install
npm test                     # 90 tests, no network required (Node 22.7 or later)
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

It is off until `X402_PAY_TO` is set. Switching it on is settings, not code:

```bash
npm run db:migrate                                     # adds allowance_counts and tool_usage_daily
openssl rand -hex 32 | npx wrangler secret put ALLOWANCE_KEY
npx wrangler secret put CDP_API_KEY_ID                 # a Coinbase Developer Platform API key
npx wrangler secret put CDP_API_KEY_SECRET
npx wrangler secret put X402_PAY_TO                    # the wallet that receives USDC; this one switches it on
curl -s https://bellwether.dap.solutions/health        # payments.status should read "on"
```

`X402_NETWORKS` (Base mainnet, `eip155:8453`) and `FREE_CALLS_PER_DAY` (50) are plain settings in `wrangler.toml`. A setting that is present but wrong leaves the tier off and `/health` names the problem, so a bad setting costs revenue and never costs a light user an answer. Deleting `X402_PAY_TO` switches it off again.

Usage, with no caller attached:

```bash
npx wrangler d1 execute bellwether --remote --command "SELECT * FROM tool_usage_daily ORDER BY day DESC, calls DESC"
```

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

The connector keeps no accounts, no email addresses and no network addresses. This page counts visits without cookies or identifiers.

This section is kept word for word in step with the privacy section rendered on the landing page, from `PRIVACY` in `src/landing.js`. A test fails if they differ. Change one and change the other.

- **What is stored.** Regulatory publications retrieved from public regulator websites: title, link, summary, publication date and revision history. A daily total of calls per tool, with no caller attached, so we know what the service is used for. While the paid tier is on, the allowance counts described below. Nothing else a user sends is written to the database.
- **What is received.** Tool calls arrive as search parameters, for example a keyword or jurisdiction. These are used to answer the request and are not stored, logged to durable storage, or associated with any identity. A paid call also carries an x402 payment authorization, a signed USDC transfer from the caller's wallet. It is passed to the payment facilitator and not stored here.
- **Allowance counts.** While the paid tier is on, the service counts calls to the three data tools per caller per UTC day, to meter the free allowance. The caller is recorded only as a keyed one-way hash of its network address, bound to the day: never the address itself, and never with the query. Counts are deleted by the first scheduled run after the day ends, normally at 00:00 UTC. The Price section says whether the paid tier is on.
- **Accounts.** There are none. The service has no sign in, so it holds no credentials or email addresses.
- **Analytics.** This page uses Cloudflare Web Analytics, a cookieless measurement service. It records the page viewed, the referring link, browser and operating system, approximate country and page load timings. It sets no cookies and writes nothing to your device. Visitor IP addresses are used to derive country and are not stored by the service. The connector endpoint at /mcp does not load the beacon. Tool calls are counted only as described above.
- **Third party sharing.** Regulatory data is not sold, shared or transferred. This page loads no third party fonts, no advertising and no cross site trackers. The only third party request it makes is the analytics beacon described above. A paid call's payment authorization goes to Coinbase's x402 facilitator, which verifies it and settles the transfer on the Base network, where the transfer is public. The query is never sent to it.
- **Retention.** Regulatory records and their revision history are retained indefinitely, because the historical record is the point of the service. Daily totals per tool are retained to report usage. Allowance counts are deleted once their day ends. Request parameters are not retained.
- **Infrastructure.** Hosted on Cloudflare Workers and D1, with Cloudflare Web Analytics on this page. Cloudflare processes requests as an infrastructure provider and as an analytics processor under its own terms. Paid calls settle through Coinbase's x402 facilitator under its own terms.
- **Contact.** bsibeth@dap.solutions

## Licence

MIT. Use it, fork it, run your own. No lock-in.
