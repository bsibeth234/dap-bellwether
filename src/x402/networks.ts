/**
 * Settlement assets the gate can price in, keyed by CAIP-2 network id.
 *
 * Sources:
 * - USDC addresses, EIP-712 names and decimals: r402-evm networks/usdc.rs (docs.rs, v0.20.0), which mirrors
 *   Circle's published contracts; the Base Sepolia entry also matches the exact-scheme example in the
 *   x402 spec (specs/schemes/exact/scheme_exact_evm.md).
 * - Network support per facilitator: docs.cdp.coinbase.com/x402/network-support (read 30 Oct 2026).
 *
 * The EIP-712 `name` and `version` go into PaymentRequirements.extra so clients can sign
 * transferWithAuthorization against the right domain.
 */
export interface SettlementAsset {
  readonly network: string;
  readonly label: string;
  readonly asset: `0x${string}`;
  readonly decimals: number;
  readonly eip712: { readonly name: string; readonly version: string };
  readonly testnet: boolean;
}

export const USDC: Readonly<Record<string, SettlementAsset>> = {
  "eip155:8453": {
    network: "eip155:8453",
    label: "Base",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    decimals: 6,
    eip712: { name: "USD Coin", version: "2" },
    testnet: false,
  },
  "eip155:84532": {
    network: "eip155:84532",
    label: "Base Sepolia",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    decimals: 6,
    eip712: { name: "USDC", version: "2" },
    testnet: true,
  },
};

export function usdcFor(network: string): SettlementAsset {
  const entry = USDC[network];
  if (!entry) {
    throw new Error(
      `No USDC settlement asset configured for ${network}. Supported: ${Object.keys(USDC).join(", ")}.`,
    );
  }
  return entry;
}

/** Well-known facilitator endpoints. Re-check /supported before relying on either. */
export const FACILITATORS = {
  /** Free, no credentials, testnets only (Base Sepolia among them). */
  x402Org: "https://x402.org/facilitator",
  /** Coinbase CDP: Base mainnet and testnet, needs a CDP API key. First 1,000 settlements a month are free. */
  cdp: "https://api.cdp.coinbase.com/platform/v2/x402",
} as const;
