/**
 * Asks the payment facilitator what it settles and confirms it covers the
 * networks Bellwether prices in. With a CDP key in the environment, this also
 * proves the key works, which is why switch-on.sh runs it before storing it.
 *
 *   X402_NETWORKS=eip155:8453 CDP_API_KEY_ID=... CDP_API_KEY_SECRET=... \
 *     node --import ./test/register-ts.mjs scripts/check-facilitator.mjs
 *
 * Prints PASS or FAIL per network and never prints the key.
 */
import { cdpAuth } from '../src/x402/cdp-auth.ts';
import { createFacilitator } from '../src/x402/facilitator.ts';
import { FACILITATORS, usdcFor } from '../src/x402/networks.ts';

const networks = (process.env.X402_NETWORKS || 'eip155:8453').split(',').map((n) => n.trim());
const anyMainnet = networks.some((n) => !usdcFor(n).testnet);
const url = process.env.X402_FACILITATOR_URL || (anyMainnet ? FACILITATORS.cdp : FACILITATORS.x402Org);
const id = process.env.CDP_API_KEY_ID;
const secret = process.env.CDP_API_KEY_SECRET;

const facilitator = createFacilitator({
  url,
  ...(id && secret ? { authHeaders: cdpAuth({ apiKeyId: id, apiKeySecret: secret }) } : {}),
});

let supported;
try {
  supported = await facilitator.supported();
} catch (err) {
  console.log(`FAIL  the facilitator at ${url} refused or did not answer: ${err && err.message ? err.message : err}`);
  process.exit(1);
}
console.log(`Facilitator: ${url}`);
let ok = true;
for (const network of networks) {
  const hit = supported.kinds.some((k) => k.x402Version === 2 && k.scheme === 'exact' && k.network === network);
  console.log(`${hit ? 'PASS' : 'FAIL'}  x402 v2, exact, ${network} (${usdcFor(network).label})`);
  ok &&= hit;
}
process.exit(ok ? 0 : 1);
