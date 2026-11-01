#!/usr/bin/env bash
# Switches on Bellwether's paid tier: free for people, agents pay per call.
# Typed by Brendan on his Mac, from the repo root, on main:
#
#   bash scripts/switch-on.sh
#
# It asks for two things: the wallet that receives payments (its public 0x
# address, the same one Foundry pays to) and a Coinbase CDP API key (the
# downloaded key file, or the id and secret pasted by hand). Then it:
#
#   1. runs the tests
#   2. checks the CDP key with the Coinbase facilitator on Base mainnet
#   3. adds the payment tables to the live database (safe to run twice)
#   4. stores four Worker secrets, the wallet last
#   5. deploys, which switches the paid tier on
#   6. checks /health reads "on"
#   7. checks the paywall from this Mac: 50 free calls, then call 51 asks for one cent
#
# Values go to wrangler through a pipe only. They are never printed, written
# to a file, kept in the shell history or put in this repository.
#
# Off again at any time: npx wrangler secret delete X402_PAY_TO

set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
export WRANGLER_SEND_METRICS=false
NODE_TS=(node --experimental-transform-types --disable-warning=ExperimentalWarning)
HOST="https://bellwether.dap.solutions"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

say() { printf '%s\n' "$*"; }
stop() { say ""; say "Stopped: $*"; exit 1; }

say ""
say "DAP Bellwether: switch on the paid tier"
say ""

# 0. The right checkout.
[ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || stop "check out main first: git checkout main && git pull"
git diff --quiet && git diff --cached --quiet || stop "this checkout has uncommitted changes."
[ -f src/payments.js ] || stop "this checkout does not have the paid tier. Run: git pull"
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=7)?0:1)' \
  || stop "Node 22.7 or later is needed. This Mac has $(node --version)."

# 1. Tests.
say "1/7 Installing and testing..."
npm ci --silent >"$work/npm.log" 2>&1 || { tail -n 20 "$work/npm.log"; stop "npm ci failed."; }
if ! npm test >"$work/test.log" 2>&1; then
  grep -E "^not ok" "$work/test.log" | head -n 10
  stop "the tests failed. Nothing was changed."
fi
say "    $(grep -E '^# pass' "$work/test.log" | sed 's/# //') tests, $(grep -E '^# fail' "$work/test.log" | sed 's/# //')"

# 2. The wallet and the CDP key.
say ""
read -r -p "2/7 Wallet that receives payments (public address, starts 0x): " pay_to
pay_to="${pay_to//[[:space:]]/}"
[[ "$pay_to" =~ ^0x[0-9a-fA-F]{40}$ ]] || stop "that is not a 0x address with 40 hex characters. Nothing was changed."

say "    Coinbase CDP API key."
read -r -p "    Drag the downloaded key file here and press Enter, or just press Enter to paste: " key_file
key_file="$(printf '%s' "$key_file" | sed -E "s/^[[:space:]]+//; s/[[:space:]]+\$//; s/^'(.*)'\$/\\1/; s/^\"(.*)\"\$/\\1/; s/\\\\(.)/\\1/g")"
cdp_id=""
cdp_secret=""
if [ -n "$key_file" ]; then
  [ -f "$key_file" ] || stop "no file at that path. Nothing was changed."
  cdp_id="$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=j.id??j.name;if(typeof v!=="string"||!v)process.exit(3);process.stdout.write(v)' "$key_file")" \
    || stop "the key file has no id or name. Nothing was changed."
  cdp_secret="$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=j.privateKey;if(typeof v!=="string"||!v)process.exit(3);process.stdout.write(v)' "$key_file")" \
    || stop "the key file has no privateKey. Nothing was changed."
else
  read -r -p "    API key id: " cdp_id
  cdp_id="${cdp_id//[[:space:]]/}"
  [ -n "$cdp_id" ] || stop "no API key id. Nothing was changed."
  read -r -s -p "    API key secret (hidden as you paste, then press Enter): " cdp_secret
  say ""
  [ -n "$cdp_secret" ] || stop "no API key secret. Nothing was changed."
fi

say "    Checking the key with the Coinbase facilitator..."
if ! X402_NETWORKS="eip155:8453" CDP_API_KEY_ID="$cdp_id" CDP_API_KEY_SECRET="$cdp_secret" \
  "${NODE_TS[@]}" scripts/check-facilitator.mjs | sed 's/^/    /'; then
  stop "the facilitator check failed. Check the key in the CDP portal and run this again. Nothing was changed."
fi

# 3. The payment tables. CREATE TABLE IF NOT EXISTS throughout, so a second run changes nothing.
say ""
say "3/7 Adding the payment tables to the live database..."
npx --no-install wrangler d1 execute bellwether --remote --file=./schema.sql --yes >"$work/migrate.log" 2>&1 \
  || { tail -n 20 "$work/migrate.log"; stop "the migration failed. No secret was set and nothing was deployed."; }
tables="$(npx --no-install wrangler d1 execute bellwether --remote --json \
  --command "SELECT name FROM sqlite_master WHERE name IN ('allowance_counts','payment_claims','tool_usage_daily')" 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log(r[0].results.length)})')"
[ "$tables" = "3" ] || stop "the three payment tables are not all there (found $tables). Nothing was deployed."
say "    allowance_counts, payment_claims and tool_usage_daily are in place."

# 4. Secrets. The wallet goes last: it is the one that switches the tier on.
say ""
say "4/7 Storing the secrets..."
put() {
  local name="$1" value="$2"
  if printf '%s' "$value" | npx --no-install wrangler secret put "$name" >/dev/null 2>"$work/secret.err"; then
    say "    set: $name"
  else
    tail -n 5 "$work/secret.err"
    stop "could not set $name. Secrets set so far stay set; the tier is still off until the deploy."
  fi
}
put ALLOWANCE_KEY "$(openssl rand -hex 32)"
put CDP_API_KEY_ID "$cdp_id"
put CDP_API_KEY_SECRET "$cdp_secret"
put X402_PAY_TO "$pay_to"
unset cdp_secret

# 5. Deploy.
say ""
say "5/7 Deploying..."
npx --no-install wrangler deploy >"$work/deploy.log" 2>&1 || { tail -n 30 "$work/deploy.log"; stop "the deploy failed. The site still runs the previous version."; }
grep -E "Current Version ID|Deployed dap-bellwether" "$work/deploy.log" | sed 's/^/    /' || true

# 6. /health.
say ""
say "6/7 Checking /health..."
status=""
for _ in $(seq 1 20); do
  status="$(curl -4 -s "$HOST/health" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const p=JSON.parse(s).payments||{};console.log(p.status+(p.reason?": "+p.reason:""))}catch{console.log("unreadable")}})')"
  [ "$status" = "on" ] && break
  sleep 3
done
[ "$status" = "on" ] || stop "/health reads \"$status\", not \"on\". Off again: npx wrangler secret delete X402_PAY_TO"
say "    PASS  payments: on"

# 7. The paywall, from this Mac.
say ""
say "7/7 Checking the paywall from this Mac (51 searches, about a minute)..."
body='{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_regulatory_changes","arguments":{"query":"capital","limit":1}}}'
answered=0
for _ in $(seq 1 50); do
  if curl -4 -s "$HOST/mcp" -H 'content-type: application/json' -d "$body" | grep -q '"isError":true'; then :; else answered=$((answered + 1)); fi
done
curl -4 -s "$HOST/mcp" -H 'content-type: application/json' -d "$body" >"$work/call51.json"
verdict="$(node -e '
  const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).result || {};
  const a = (r.structuredContent && r.structuredContent.accepts || [])[0];
  if (r.isError === true && a && a.amount === "10000" && a.network === "eip155:8453") {
    console.log("PASS  call 51 asks for one cent (10000 atomic USDC) on Base, paid to " + a.payTo);
  } else {
    console.log("FAIL  call 51 did not ask for one cent on Base");
    process.exitCode = 1;
  }' "$work/call51.json")" || { say "    $verdict"; stop "the paywall check failed. Off again: npx wrangler secret delete X402_PAY_TO"; }
say "    $answered of the first 50 answered free"
say "    $verdict"

say ""
say "Done. Bellwether is free for people, and agents pay one cent a call."
say "Off again at any time: npx wrangler secret delete X402_PAY_TO"
