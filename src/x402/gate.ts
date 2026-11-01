/**
 * The x402 gate: one fetch-standard function that sits in front of any handler.
 *
 *   no PAYMENT-SIGNATURE      -> 402 with the price (PAYMENT-REQUIRED header and the same JSON body)
 *   malformed payment         -> 400
 *   wrong price, expired,
 *   replayed or refused       -> 402 with a fresh price and the reason code
 *   valid payment             -> verify, run the handler, settle, then release the answer
 *                                with PAYMENT-RESPONSE (the settlement record)
 *
 * The answer is only released after settlement succeeds. A handler response with status 400 or
 * above (for example Foundry's 422 refusal) is passed through and not charged.
 */
import { decodeHeader, encodeHeader, HeaderDecodeError } from "./codec.ts";
import type { Facilitator } from "./facilitator.ts";
import { FacilitatorError } from "./facilitator.ts";
import { type McpConfig, mcpHandler, UNCONFIRMED } from "./mcp.ts";
import { usdcFor } from "./networks.ts";
import { canonicalPath } from "./path.ts";
import { checkPayment, forFacilitator } from "./payment.ts";
import { usdToAtomic } from "./price.ts";
import { memoryReplayGuard, type ReplayGuard } from "./replay.ts";
import {
  ErrorCode,
  EvmAddress,
  type PaymentRequired,
  PaymentRequirements,
  type ResourceInfo,
  type SettleResponse,
  X402_VERSION,
} from "./schemas.ts";

export const HEADER = {
  required: "PAYMENT-REQUIRED",
  signature: "PAYMENT-SIGNATURE",
  response: "PAYMENT-RESPONSE",
  legacyV1: "X-PAYMENT",
} as const;

const EXPOSED = `${HEADER.required}, ${HEADER.response}`;

export interface HttpExample {
  method: "GET" | "POST";
  queryParams?: Record<string, string>;
  body?: Record<string, unknown>;
}

export interface RouteConfig {
  /** Exact path ("/api/tool") or a prefix ending in "*" ("/api/tools/*"). */
  path: string;
  /** Methods that require payment. Default GET and POST. HEAD always answers with the price. */
  methods?: readonly string[];
  /** Price per answer in US dollars, settled in USDC, for example "$0.001". */
  price: string;
  /** One line an agent reads to decide whether to buy. */
  description: string;
  /** Response MIME type. Default application/json. */
  mimeType?: string;
  /** Example call and answer, published through the x402 Bazaar extension so agent directories can list the tool. */
  discovery?: { input: HttpExample; output?: { type: string; example?: unknown } };
}

export type X402Event =
  | { type: "challenge"; path: string; method: string }
  | { type: "rejected"; path: string; status: number; code: string }
  | { type: "verified"; path: string; payer: string | undefined; ms: number }
  | { type: "not_charged"; path: string; status: number }
  | {
      type: "settled";
      path: string;
      payer: string | undefined;
      network: string;
      amount: string;
      transaction: string;
      pending: boolean;
      ms: number;
    }
  | { type: "facilitator_error"; path: string; op: string; message: string };

export interface GateConfig {
  /** Wallet that receives payment. */
  payTo: string;
  /** CAIP-2 networks to accept, in order of preference. Each needs a USDC entry in networks.ts. */
  networks: readonly string[];
  facilitator: Facilitator;
  routes: readonly RouteConfig[];
  /** Prices tools/call on an MCP endpoint (x402 MCP transport). Unlisted tools are free. */
  mcp?: McpConfig;
  /** Seconds a client has to complete payment. Default 60. */
  maxTimeoutSeconds?: number;
  /** Shown to agents and directories. Printable ASCII, 32 characters or fewer. */
  serviceName?: string;
  tags?: readonly string[];
  iconUrl?: string;
  /** Human and agent documentation, sent as a Link header on every price response. */
  docsUrl?: string;
  /** Access-Control-Allow-Origin on responses the gate writes itself. Default "*". Null to omit. */
  corsOrigin?: string | null;
  /**
   * Release the answer when the facilitator reports settlement_pending (broadcast, not yet confirmed).
   * Default false. Safe only with a replay guard shared by every instance: with an in-memory guard, one
   * authorization sent to two instances at once can come back pending twice.
   */
  acceptPending?: boolean;
  /** Decides whether a handler response is billable. Default: status below 400. */
  chargeFor?: (response: Response) => boolean;
  replayGuard?: ReplayGuard;
  /** Telemetry. Never receives request bodies or query strings. Errors thrown here are ignored. */
  onEvent?: (event: X402Event) => void;
  /** Clock in epoch milliseconds. Injectable for tests. */
  now?: () => number;
}

/** Runs the protected handler. A transport that rebuilds the request (MCP) passes the rebuilt one. */
export type Next = (request?: Request) => Response | Promise<Response>;

export { canonicalPath };

export interface Gate {
  /** Handles one request. Unpriced paths go straight to `next`. */
  handle(request: Request, next: Next): Promise<Response>;
  /** The price list, for a manifest or health page. */
  readonly routes: ReadonlyArray<{
    path: string;
    methods: readonly string[];
    accepts: PaymentRequirements[];
  }>;
}

interface CompiledRoute {
  config: RouteConfig;
  /** Canonical path (exact routes) or canonical prefix (wildcard routes). */
  key: string;
  methods: ReadonlySet<string>;
  accepts: PaymentRequirements[];
  bazaar: BazaarExtension | undefined;
}

interface BazaarExtension {
  [key: string]: unknown;
  info: Record<string, unknown>;
  schema: Record<string, unknown>;
}

export function createGate(config: GateConfig): Gate {
  const parsedPayTo = EvmAddress.safeParse(config.payTo);
  if (!parsedPayTo.success) throw new Error("payTo must be a 20-byte 0x address");
  const payTo = parsedPayTo.data;
  if (/^0x0{40}$/i.test(payTo)) throw new Error("payTo must not be the zero address");
  if (config.networks.length === 0) throw new Error("networks must list at least one CAIP-2 network");
  if (config.routes.length === 0 && !config.mcp) {
    throw new Error("routes must list at least one priced path");
  }

  const now = config.now ?? Date.now;
  const maxTimeoutSeconds = config.maxTimeoutSeconds ?? 60;
  const corsOrigin = config.corsOrigin === undefined ? "*" : config.corsOrigin;
  const chargeFor = config.chargeFor ?? ((response: Response) => response.status < 400);
  const replay = config.replayGuard ?? memoryReplayGuard({ now });
  const emit = (event: X402Event): void => {
    try {
      config.onEvent?.(event);
    } catch {
      // Telemetry must never break a paid request.
    }
  };

  const offersFor = (price: string): PaymentRequirements[] =>
    config.networks.map((network) => {
      const usdc = usdcFor(network);
      return PaymentRequirements.parse({
        scheme: "exact",
        network,
        amount: usdToAtomic(price, usdc.decimals),
        asset: usdc.asset,
        payTo,
        maxTimeoutSeconds,
        extra: { assetTransferMethod: "eip3009", name: usdc.eip712.name, version: usdc.eip712.version },
      });
    });

  const compiled: CompiledRoute[] = config.routes.map((route) => {
    if (!route.path.startsWith("/")) throw new Error(`route path "${route.path}" must start with "/"`);
    const wildcard = route.path.endsWith("*");
    const base = wildcard ? route.path.slice(0, -1) : route.path;
    const canonical = canonicalPath(base);
    if (canonical === null) throw new Error(`route path "${route.path}" is not a valid URL path`);
    const key = wildcard && base.endsWith("/") && canonical !== "/" ? `${canonical}/` : canonical;
    const accepts = offersFor(route.price);
    return {
      config: route,
      key,
      methods: new Set((route.methods ?? ["GET", "POST"]).map((m) => m.toUpperCase())),
      accepts,
      bazaar: route.discovery ? bazaarExtension(route.discovery) : undefined,
    };
  });
  const exact = new Map(compiled.filter((r) => !r.config.path.endsWith("*")).map((r) => [r.key, r]));
  const prefixes = compiled
    .filter((r) => r.config.path.endsWith("*"))
    .sort((a, b) => b.key.length - a.key.length);

  /** Matches on the canonical path, so no spelling a router accepts (case, slashes, escapes) skips the price. */
  function match(canonical: string): CompiledRoute | undefined {
    return (
      exact.get(canonical) ?? prefixes.find((r) => canonical.startsWith(r.key) || `${canonical}/` === r.key)
    );
  }

  function resourceFor(route: CompiledRoute, at: Target): ResourceInfo {
    return {
      url: `${at.origin}${at.path}`,
      description: route.config.description,
      mimeType: route.config.mimeType ?? "application/json",
      ...(config.serviceName ? { serviceName: config.serviceName } : {}),
      ...(config.tags ? { tags: [...config.tags] } : {}),
      ...(config.iconUrl ? { iconUrl: config.iconUrl } : {}),
    };
  }

  // The plain price response is the hot path for agents probing. Encode it once per resource URL.
  const challengeCache = new Map<string, { header: string; body: string }>();

  function paymentRequired(
    route: CompiledRoute,
    at: Target,
    error?: string,
  ): { header: string; body: string } {
    // Origin and canonical path only: query strings carry the caller's inputs and never leave this process.
    const resourceUrl = `${at.origin}${at.path}`;
    if (error === undefined) {
      const cached = challengeCache.get(resourceUrl);
      if (cached) return cached;
    }
    const resource = resourceFor(route, at);
    const body: PaymentRequired = {
      x402Version: X402_VERSION,
      ...(error ? { error } : {}),
      resource,
      accepts: route.accepts,
      ...(route.bazaar ? { extensions: { bazaar: route.bazaar } } : {}),
    };
    const result = { header: encodeHeader(body), body: JSON.stringify(body) };
    if (error === undefined) {
      if (challengeCache.size >= 1_000) challengeCache.clear();
      challengeCache.set(resourceUrl, result);
    }
    return result;
  }

  function gateHeaders(extra?: Record<string, string>): Headers {
    const headers = new Headers({
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-expose-headers": EXPOSED,
      ...extra,
    });
    if (corsOrigin) headers.set("access-control-allow-origin", corsOrigin);
    if (config.docsUrl) headers.set("link", `<${config.docsUrl}>; rel="describedby"`);
    return headers;
  }

  function priceResponse(
    route: CompiledRoute,
    at: Target,
    options: { status?: number; error?: string; settlement?: SettleResponse; head?: boolean } = {},
  ): Response {
    const { header, body } = paymentRequired(route, at, options.error);
    const headers = gateHeaders({ [HEADER.required]: header });
    if (options.settlement) headers.set(HEADER.response, encodeHeader(options.settlement));
    return new Response(options.head ? null : body, { status: options.status ?? 402, headers });
  }

  function reject(route: CompiledRoute, at: Target, status: number, code: string): Response {
    emit({ type: "rejected", path: at.path, status, code });
    return priceResponse(route, at, { status, error: code });
  }

  function unavailable(path: string, op: string, error: unknown, code: string): Response {
    const message = error instanceof Error ? error.message : String(error);
    emit({ type: "facilitator_error", path, op, message });
    return new Response(
      JSON.stringify({
        x402Version: X402_VERSION,
        error: code,
        message: "Payment service unavailable. Retry shortly.",
      }),
      { status: 503, headers: gateHeaders({ "retry-after": "2" }) },
    );
  }

  function unconfirmed(path: string, error: unknown): Response {
    const message = error instanceof Error ? error.message : String(error);
    emit({ type: "facilitator_error", path, op: "settle", message });
    return new Response(JSON.stringify({ x402Version: X402_VERSION, error: ErrorCode.settleError, message: UNCONFIRMED }), {
      status: 503,
      headers: gateHeaders({ "retry-after": "2" }),
    });
  }

  function withPaymentHeaders(response: Response, settlement?: SettleResponse): Response {
    const out = new Response(response.body, response);
    if (settlement) out.headers.set(HEADER.response, encodeHeader(settlement));
    mergeList(out.headers, "access-control-expose-headers", [HEADER.required, HEADER.response]);
    return out;
  }

  /**
   * On a priced path the tool runs only for a verified payment. Preflight and unpriced methods are
   * answered here, so a handler that computes on OPTIONS or PUT cannot give a free answer.
   */
  function allowList(route: CompiledRoute): string {
    return [...route.methods, "HEAD", "OPTIONS"].join(", ");
  }

  function preflight(route: CompiledRoute): Response {
    const headers = gateHeaders({
      allow: allowList(route),
      "access-control-allow-methods": allowList(route),
      "access-control-allow-headers": `content-type, ${HEADER.signature}`,
      "access-control-max-age": "86400",
    });
    headers.delete("content-type");
    return new Response(null, { status: 204, headers });
  }

  function methodNotAllowed(route: CompiledRoute): Response {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: gateHeaders({ allow: allowList(route) }),
    });
  }

  const mcp = config.mcp
    ? mcpHandler(config.mcp, {
        offersFor,
        facilitator: config.facilitator,
        replay,
        now,
        emit,
        acceptPending: config.acceptPending ?? false,
        service: {
          ...(config.serviceName ? { serviceName: config.serviceName } : {}),
          ...(config.tags ? { tags: [...config.tags] } : {}),
          ...(config.iconUrl ? { iconUrl: config.iconUrl } : {}),
        },
      })
    : undefined;

  async function handle(request: Request, next: Next): Promise<Response> {
    const url = new URL(request.url);
    const canonical = canonicalPath(url.pathname);
    if (canonical === null) {
      // A path that cannot be decoded cannot be proven unpriced. Refuse it rather than pass it through.
      return new Response(JSON.stringify({ error: "invalid_path" }), { status: 400, headers: gateHeaders() });
    }
    if (mcp?.matches(canonical)) return mcp.handle(request, next, { origin: url.origin, path: canonical });
    const route = match(canonical);
    if (!route) return next();
    const path = canonical;
    const at: Target = { origin: url.origin, path: canonical };
    const method = request.method.toUpperCase();

    if (method === "OPTIONS") return preflight(route);
    if (method === "HEAD") {
      emit({ type: "challenge", path, method });
      return priceResponse(route, at, { head: true });
    }
    if (!route.methods.has(method)) return methodNotAllowed(route);

    const raw = request.headers.get(HEADER.signature);
    if (raw === null) {
      if (request.headers.has(HEADER.legacyV1)) {
        return reject(route, at, 402, ErrorCode.version);
      }
      emit({ type: "challenge", path, method });
      return priceResponse(route, at);
    }

    // 1. Decode and validate the payment object.
    let decoded: unknown;
    try {
      decoded = decodeHeader(raw);
    } catch (error) {
      if (error instanceof HeaderDecodeError) return reject(route, at, 400, ErrorCode.payload);
      throw error;
    }
    const checked = checkPayment(decoded, route.accepts, now());
    if (!checked.ok) return reject(route, at, checked.status, checked.code);
    const { requirement, authorization: auth, replayKey, claimUntil } = checked.payment;
    const payload = forFacilitator(
      checked.payment,
      resourceFor(route, at),
      route.bazaar ? { bazaar: route.bazaar } : undefined,
    );

    // One authorization buys one answer.
    if (!(await replay.claim(replayKey, claimUntil))) {
      return reject(route, at, 402, ErrorCode.transactionState);
    }

    // 5. Facilitator verifies signature, balance and a simulated transfer. Our requirement is sent,
    //    never the client's copy.
    const started = now();
    let verified: Awaited<ReturnType<Facilitator["verify"]>>;
    try {
      verified = await config.facilitator.verify(payload, requirement);
    } catch (error) {
      await replay.release(replayKey);
      if (error instanceof FacilitatorError) return unavailable(path, "verify", error, ErrorCode.verifyError);
      throw error;
    }
    if (!verified.isValid) {
      await replay.release(replayKey);
      return reject(route, at, 402, verified.invalidReason ?? ErrorCode.payload);
    }
    emit({ type: "verified", path, payer: verified.payer ?? auth.from, ms: now() - started });

    // 6. Run the tool.
    let response: Response;
    try {
      response = await next();
    } catch (error) {
      await replay.release(replayKey);
      throw error;
    }
    if (!chargeFor(response)) {
      await replay.release(replayKey);
      emit({ type: "not_charged", path, status: response.status });
      return withPaymentHeaders(response);
    }

    // 7. Settle, then release the answer.
    let settlement: SettleResponse;
    try {
      settlement = await config.facilitator.settle(payload, requirement);
    } catch (error) {
      await response.body?.cancel();
      // The transfer may or may not have happened. Release the claim, so the same signed payment can be
      // sent again: its nonce settles at most once, so a retry can never charge twice.
      await replay.release(replayKey);
      if (error instanceof FacilitatorError) return unconfirmed(path, error);
      throw error;
    }
    const pending = !settlement.success && settlement.errorReason === ErrorCode.settlementPending;
    if (settlement.success || (config.acceptPending === true && pending && settlement.transaction !== "")) {
      emit({
        type: "settled",
        path,
        payer: settlement.payer ?? verified.payer ?? auth.from,
        network: settlement.network,
        amount: settlement.amount ?? requirement.amount,
        transaction: settlement.transaction,
        pending,
        ms: now() - started,
      });
      return withPaymentHeaders(response, settlement);
    }
    await response.body?.cancel();
    await replay.release(replayKey);
    emit({ type: "rejected", path, status: 402, code: settlement.errorReason ?? ErrorCode.settleError });
    return priceResponse(route, at, {
      error: settlement.errorReason ?? ErrorCode.settleError,
      settlement,
    });
  }

  return {
    handle,
    routes: compiled.map((r) => ({ path: r.config.path, methods: [...r.methods], accepts: r.accepts })),
  };
}

interface Target {
  origin: string;
  path: string;
}

function mergeList(headers: Headers, name: string, values: readonly string[]): void {
  const current = headers.get(name);
  if (current?.trim() === "*") return;
  const items = (current ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  const lower = new Set(items.map((v) => v.toLowerCase()));
  for (const value of values) if (!lower.has(value.toLowerCase())) items.push(value);
  headers.set(name, items.join(", "));
}

/** x402 Bazaar discovery extension (specs/extensions/bazaar.md): `info` plus a JSON Schema for it. */
function bazaarExtension(discovery: NonNullable<RouteConfig["discovery"]>): BazaarExtension {
  const { input, output } = discovery;
  const isBody = input.method === "POST";
  const info = {
    input: {
      type: "http",
      method: input.method,
      ...(input.queryParams ? { queryParams: input.queryParams } : {}),
      ...(isBody ? { bodyType: "json", body: input.body ?? {} } : {}),
    },
    ...(output ? { output } : {}),
  };
  const inputSchema = {
    type: "object",
    properties: {
      type: { type: "string", const: "http" },
      method: { type: "string", enum: isBody ? ["POST", "PUT", "PATCH"] : ["GET", "HEAD", "DELETE"] },
      ...(isBody ? { bodyType: { type: "string", enum: ["json", "form-data", "text"] } } : {}),
      ...(isBody ? { body: { type: "object" } } : {}),
      queryParams: { type: "object", additionalProperties: { type: "string" } },
      headers: { type: "object", additionalProperties: { type: "string" } },
    },
    required: isBody ? ["type", "method", "bodyType", "body"] : ["type", "method"],
    additionalProperties: false,
  };
  return {
    info,
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        input: inputSchema,
        output: { type: "object", properties: { type: { type: "string" } }, required: ["type"] },
      },
      required: ["input"],
    },
  };
}
