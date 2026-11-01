/**
 * Payment checks shared by every transport (HTTP headers, MCP _meta). One place decides whether a
 * payment matches today's terms, so HTTP and MCP cannot drift apart.
 */
import {
  ErrorCode,
  ExactEvmPayload,
  PaymentPayload,
  type PaymentRequirements,
  type ResourceInfo,
  X402_VERSION,
} from "./schemas.ts";

/** Seconds of headroom a signed authorization must still have, to cover block time at settlement. */
export const VALID_BEFORE_BUFFER_S = 6;
/** Seconds of clock skew tolerated on validAfter. */
export const VALID_AFTER_SKEW_S = 5;
/** Longest a replay claim is held, whatever validBefore says. */
export const MAX_CLAIM_MS = 24 * 60 * 60 * 1000;

export interface CheckedPayment {
  requirement: PaymentRequirements;
  signature: string;
  authorization: ExactEvmPayload["authorization"];
  /** network|asset|from|nonce, lower case. One authorization buys one answer, on any transport. */
  replayKey: string;
  claimUntil: number;
}

export type Checked = { ok: true; payment: CheckedPayment } | { ok: false; status: 400 | 402; code: string };

export function sameTerms(ours: PaymentRequirements, theirs: PaymentRequirements): boolean {
  return (
    ours.scheme === theirs.scheme &&
    ours.network === theirs.network &&
    ours.amount === theirs.amount &&
    ours.asset.toLowerCase() === theirs.asset.toLowerCase() &&
    ours.payTo.toLowerCase() === theirs.payTo.toLowerCase() &&
    ours.maxTimeoutSeconds === theirs.maxTimeoutSeconds &&
    (theirs.extra?.["assetTransferMethod"] ?? "eip3009") === ours.extra?.["assetTransferMethod"]
  );
}

/** Validates a decoded payment against our own offers. No network call. */
export function checkPayment(
  decoded: unknown,
  accepts: readonly PaymentRequirements[],
  nowMs: number,
): Checked {
  const parsed = PaymentPayload.safeParse(decoded);
  if (!parsed.success) return { ok: false, status: 400, code: ErrorCode.payload };
  const payment = parsed.data;
  if (payment.x402Version !== X402_VERSION) return { ok: false, status: 400, code: ErrorCode.version };

  // The client must have accepted one of today's prices, exactly.
  const requirement = accepts.find((r) => sameTerms(r, payment.accepted));
  if (!requirement) return { ok: false, status: 402, code: ErrorCode.requirements };

  const evm = ExactEvmPayload.safeParse(payment.payload);
  if (!evm.success) return { ok: false, status: 400, code: ErrorCode.payload };
  const auth = evm.data.authorization;
  const nowS = Math.floor(nowMs / 1000);
  if (auth.to.toLowerCase() !== requirement.payTo.toLowerCase()) {
    return { ok: false, status: 402, code: ErrorCode.recipientMismatch };
  }
  if (auth.value !== requirement.amount) return { ok: false, status: 402, code: ErrorCode.valueMismatch };
  if (BigInt(auth.validAfter) > BigInt(nowS + VALID_AFTER_SKEW_S)) {
    return { ok: false, status: 402, code: ErrorCode.validAfter };
  }
  if (BigInt(auth.validBefore) < BigInt(nowS + VALID_BEFORE_BUFFER_S)) {
    return { ok: false, status: 402, code: ErrorCode.validBefore };
  }
  return {
    ok: true,
    payment: {
      requirement,
      signature: evm.data.signature,
      authorization: auth,
      replayKey: `${requirement.network}|${requirement.asset}|${auth.from}|${auth.nonce}`.toLowerCase(),
      claimUntil: Math.min(Number(auth.validBefore) * 1000 + 60_000, nowMs + MAX_CLAIM_MS),
    },
  };
}

/**
 * The payload the facilitator sees: rebuilt from validated fields and our own terms. Nothing else the
 * client sent (another transfer method, its copy of the terms, its extensions) reaches it.
 */
export function forFacilitator(
  checked: CheckedPayment,
  resource: ResourceInfo,
  extensions?: Record<string, unknown>,
): PaymentPayload {
  const a = checked.authorization;
  return {
    x402Version: X402_VERSION,
    resource,
    accepted: checked.requirement,
    payload: {
      signature: checked.signature,
      authorization: {
        from: a.from,
        to: a.to,
        value: a.value,
        validAfter: a.validAfter,
        validBefore: a.validBefore,
        nonce: a.nonce,
      },
    },
    ...(extensions ? { extensions } : {}),
  };
}
