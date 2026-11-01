/**
 * Builds a gate from environment variables, so the same code runs on testnet in preview and on
 * Base mainnet in production by changing settings, not code.
 *
 *   X402_PAY_TO           required  wallet that receives USDC
 *   X402_NETWORKS         optional  comma-separated CAIP-2 ids, default eip155:84532 (Base Sepolia)
 *   X402_FACILITATOR_URL  optional  default x402.org on testnet, Coinbase CDP when any mainnet is listed
 *   CDP_API_KEY_ID        optional  required for the CDP facilitator
 *   CDP_API_KEY_SECRET    optional  required for the CDP facilitator
 */
import * as z from "zod/mini";
import { cdpAuth } from "./cdp-auth.ts";
import { createFacilitator } from "./facilitator.ts";
import { createGate, type Gate, type GateConfig } from "./gate.ts";
import { FACILITATORS, usdcFor } from "./networks.ts";

const Env = z.object({
  X402_PAY_TO: z.string({ error: "X402_PAY_TO is not set" }).check(z.minLength(1, "X402_PAY_TO is not set")),
  X402_NETWORKS: z.optional(z.string()),
  X402_FACILITATOR_URL: z.optional(z.url()),
  CDP_API_KEY_ID: z.optional(z.string()),
  CDP_API_KEY_SECRET: z.optional(z.string()),
});

export type X402Env = z.input<typeof Env>;

export function gateFromEnv(
  rawEnv: Record<string, unknown>,
  options: Omit<GateConfig, "payTo" | "networks" | "facilitator">,
): Gate {
  const parsed = Env.safeParse(rawEnv);
  if (!parsed.success) {
    throw new Error(
      `x402 settings: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
    );
  }
  const env = parsed.data;
  const networks = (env.X402_NETWORKS ?? "eip155:84532")
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
  const anyMainnet = networks.some((n) => !usdcFor(n).testnet);
  const url = env.X402_FACILITATOR_URL ?? (anyMainnet ? FACILITATORS.cdp : FACILITATORS.x402Org);

  if (anyMainnet && url.startsWith(FACILITATORS.x402Org)) {
    throw new Error("x402.org settles testnets only. Set X402_FACILITATOR_URL to a mainnet facilitator.");
  }
  const hasCdpKey = Boolean(env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET);
  if (url.startsWith(FACILITATORS.cdp) && !hasCdpKey) {
    throw new Error("The CDP facilitator needs CDP_API_KEY_ID and CDP_API_KEY_SECRET.");
  }

  const facilitator = createFacilitator({
    url,
    ...(hasCdpKey
      ? {
          authHeaders: cdpAuth({
            apiKeyId: env.CDP_API_KEY_ID ?? "",
            apiKeySecret: env.CDP_API_KEY_SECRET ?? "",
          }),
        }
      : {}),
  });
  return createGate({ ...options, payTo: env.X402_PAY_TO, networks, facilitator });
}
