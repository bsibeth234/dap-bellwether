/**
 * x402 protocol v2 wire types, validated with Zod at every boundary.
 *
 * Source: x402 specification v2 and the HTTP transport v2
 * (github.com/x402-foundation/x402, specs/x402-specification-v2.md, specs/transports-v2/http.md).
 * Objects are parsed loosely so a newer peer that adds fields is not refused.
 * Uses zod/mini: the same validation at a fraction of the bundle size, which matters at the edge.
 */
import * as z from "zod/mini";

export const X402_VERSION = 2 as const;

const hex = (bytes: number) =>
  z.string().check(z.regex(new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`), `expected ${bytes} bytes of hex`));
const pattern = (re: RegExp, message: string) => z.string().check(z.regex(re, message));
const optionalRecord = () => z.optional(z.record(z.string(), z.unknown()));

export const EvmAddress = hex(20);
export const Bytes32 = hex(32);
/** Unsigned integer carried as a decimal string, as the spec requires for atomic amounts. */
export const UintString = pattern(/^(0|[1-9][0-9]{0,77})$/, "expected an unsigned integer string");
/** CAIP-2 chain identifier, for example eip155:8453. */
export const Caip2 = pattern(/^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/, "expected a CAIP-2 network id");

export const ResourceInfo = z.looseObject({
  url: z.string().check(z.minLength(1)),
  description: z.optional(z.string()),
  mimeType: z.optional(z.string()),
  serviceName: z.optional(z.string().check(z.maxLength(32))),
  tags: z.optional(z.array(z.string().check(z.maxLength(32))).check(z.maxLength(5))),
  iconUrl: z.optional(z.string().check(z.maxLength(2048))),
});
export type ResourceInfo = z.infer<typeof ResourceInfo>;

export const PaymentRequirements = z.looseObject({
  scheme: z.string().check(z.minLength(1)),
  network: Caip2,
  amount: UintString,
  asset: z.string().check(z.minLength(1)),
  payTo: z.string().check(z.minLength(1)),
  maxTimeoutSeconds: z.int().check(z.positive()),
  extra: optionalRecord(),
});
export type PaymentRequirements = z.infer<typeof PaymentRequirements>;

export const ExtensionEntry = z.looseObject({
  info: z.record(z.string(), z.unknown()),
  schema: z.record(z.string(), z.unknown()),
});

export const PaymentRequired = z.looseObject({
  x402Version: z.literal(X402_VERSION),
  error: z.optional(z.string()),
  resource: ResourceInfo,
  accepts: z.array(PaymentRequirements),
  extensions: z.optional(z.record(z.string(), ExtensionEntry)),
});
export type PaymentRequired = z.infer<typeof PaymentRequired>;

export const PaymentPayload = z.looseObject({
  x402Version: z.int(),
  resource: z.optional(ResourceInfo),
  accepted: PaymentRequirements,
  payload: z.record(z.string(), z.unknown()),
  extensions: optionalRecord(),
});
export type PaymentPayload = z.infer<typeof PaymentPayload>;

/**
 * Scheme-specific payload for `exact` on EVM networks (EIP-3009 transferWithAuthorization).
 * Strict: a payload carrying another transfer method (for example a Permit2 authorization) is refused,
 * because the gate only advertises EIP-3009.
 */
export const ExactEvmPayload = z.strictObject({
  /** 65-byte EOA signature, or longer for smart wallets (ERC-1271 or ERC-6492). */
  signature: pattern(/^0x[0-9a-fA-F]{130,}$/, "expected a hex signature"),
  authorization: z.strictObject({
    from: EvmAddress,
    to: EvmAddress,
    value: UintString,
    validAfter: UintString,
    validBefore: UintString,
    nonce: Bytes32,
  }),
});
export type ExactEvmPayload = z.infer<typeof ExactEvmPayload>;

export const VerifyResponse = z.looseObject({
  isValid: z.boolean(),
  invalidReason: z.optional(z.string()),
  invalidMessage: z.optional(z.string()),
  payer: z.optional(z.string()),
});
export type VerifyResponse = z.infer<typeof VerifyResponse>;

export const SettleResponse = z.looseObject({
  success: z.boolean(),
  errorReason: z.optional(z.string()),
  errorMessage: z.optional(z.string()),
  payer: z.optional(z.string()),
  transaction: z.string(),
  network: z.string(),
  amount: z.optional(z.string()),
});
export type SettleResponse = z.infer<typeof SettleResponse>;

export const SupportedResponse = z.looseObject({
  kinds: z.array(
    z.looseObject({
      x402Version: z.int(),
      scheme: z.string(),
      network: z.string(),
      extra: optionalRecord(),
    }),
  ),
  extensions: z.optional(z.array(z.string())),
  signers: z.optional(z.record(z.string(), z.array(z.string()))),
});
export type SupportedResponse = z.infer<typeof SupportedResponse>;

/**
 * Stable error codes from the spec. Clients match on these, never on message text.
 * `settlement_pending` is non-terminal: the transaction was broadcast but not yet confirmed.
 */
export const ErrorCode = {
  insufficientFunds: "insufficient_funds",
  validAfter: "invalid_exact_evm_payload_authorization_valid_after",
  validBefore: "invalid_exact_evm_payload_authorization_valid_before",
  valueMismatch: "invalid_exact_evm_payload_authorization_value_mismatch",
  signature: "invalid_exact_evm_payload_signature",
  recipientMismatch: "invalid_exact_evm_payload_recipient_mismatch",
  network: "invalid_network",
  payload: "invalid_payload",
  requirements: "invalid_payment_requirements",
  scheme: "invalid_scheme",
  unsupportedScheme: "unsupported_scheme",
  version: "invalid_x402_version",
  transactionState: "invalid_transaction_state",
  verifyError: "unexpected_verify_error",
  settleError: "unexpected_settle_error",
  settlementPending: "settlement_pending",
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
