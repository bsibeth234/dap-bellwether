/**
 * Facilitator client. The facilitator checks the signature and balance (/verify) and broadcasts the
 * transfer (/settle). Request and response shapes follow x402 spec v2, section 7.
 */
import {
  type PaymentPayload,
  type PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
  X402_VERSION,
} from "./schemas.ts";

export type FacilitatorOp = "verify" | "settle" | "supported";

export type AuthHeaders = (
  op: FacilitatorOp,
  method: "GET" | "POST",
  url: URL,
) => Promise<Record<string, string>> | Record<string, string>;

export interface FacilitatorOptions {
  /** Base URL, for example https://x402.org/facilitator. */
  url: string;
  /** Milliseconds to wait for /verify. Default 5,000. */
  verifyTimeoutMs?: number;
  /** Milliseconds to wait for /settle, which waits for the chain. Default 30,000. */
  settleTimeoutMs?: number;
  /** Milliseconds /supported stays cached. Default 600,000. */
  supportedTtlMs?: number;
  /** Adds credentials per request, for example `cdpAuth(...)` for the Coinbase facilitator. */
  authHeaders?: AuthHeaders;
  /** Injected for tests. Defaults to the global fetch. */
  fetch?: typeof fetch;
}

export interface Facilitator {
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
  supported(): Promise<SupportedResponse>;
}

export class FacilitatorError extends Error {
  override readonly name = "FacilitatorError";
  constructor(
    readonly op: FacilitatorOp,
    message: string,
    readonly status?: number,
  ) {
    super(`facilitator ${op}: ${message}`);
  }
}

export function createFacilitator(options: FacilitatorOptions): Facilitator {
  const base = options.url.replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  const verifyTimeout = options.verifyTimeoutMs ?? 5_000;
  const settleTimeout = options.settleTimeoutMs ?? 30_000;
  const supportedTtl = options.supportedTtlMs ?? 600_000;
  let supportedCache: { value: SupportedResponse; expires: number } | undefined;

  async function call<T>(
    op: FacilitatorOp,
    method: "GET" | "POST",
    body: unknown,
    timeoutMs: number,
    parse: (json: unknown) => { success: true; data: T } | { success: false },
  ): Promise<T> {
    const url = new URL(`${base}/${op}`);
    const headers: Record<string, string> = { accept: "application/json" };
    if (method === "POST") headers["content-type"] = "application/json";
    if (options.authHeaders) {
      try {
        Object.assign(headers, await options.authHeaders(op, method, url));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new FacilitatorError(op, `credentials failed: ${reason}`);
      }
    }

    let response: Response;
    try {
      response = await doFetch(url, {
        method,
        headers,
        ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error && error.name === "TimeoutError" ? "timed out" : "unreachable";
      throw new FacilitatorError(op, reason);
    }

    // Facilitators answer a refused payment with a typed body, sometimes on a 4xx status. Accept any
    // status whose body parses as the expected response; anything else is a facilitator fault.
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new FacilitatorError(op, `non-JSON response (HTTP ${response.status})`, response.status);
    }
    const parsed = parse(json);
    if (!parsed.success) {
      throw new FacilitatorError(op, `unexpected response (HTTP ${response.status})`, response.status);
    }
    return parsed.data;
  }

  const envelope = (payload: PaymentPayload, requirements: PaymentRequirements) => ({
    x402Version: X402_VERSION,
    paymentPayload: payload,
    paymentRequirements: requirements,
  });

  return {
    verify: (payload, requirements) =>
      call("verify", "POST", envelope(payload, requirements), verifyTimeout, (j) =>
        VerifyResponse.safeParse(j),
      ),
    settle: (payload, requirements) =>
      call("settle", "POST", envelope(payload, requirements), settleTimeout, (j) =>
        SettleResponse.safeParse(j),
      ),
    async supported() {
      const now = Date.now();
      if (supportedCache && supportedCache.expires > now) return supportedCache.value;
      const value = await call("supported", "GET", undefined, verifyTimeout, (j) =>
        SupportedResponse.safeParse(j),
      );
      supportedCache = { value, expires: now + supportedTtl };
      return value;
    },
  };
}
