/**
 * x402 over MCP (specs/transports-v2/mcp.md): prices tools/call on a Streamable HTTP MCP endpoint.
 *
 *   tools/call, priced tool, no payment   -> result { isError: true, structuredContent: PaymentRequired }
 *   payment in params._meta["x402/payment"] -> verify, run the tool, settle, then the tool's result with
 *                                              result._meta["x402/payment-response"]
 *   tool answers isError, or a JSON-RPC error -> passed back, not charged
 *   anything else (initialize, tools/list, unpriced tools) -> passed through
 *   a batch                                    -> 400, -32600; nothing is passed through
 *
 * The server always receives the message the gate inspected, re-serialized, so a parser difference
 * cannot hide a priced call. The tool never sees the payment: it is removed from _meta before forwarding.
 */
import { type Facilitator, FacilitatorError } from "./facilitator.ts";
import { canonicalPath } from "./path.ts";
import { checkPayment, forFacilitator } from "./payment.ts";
import type { ReplayGuard } from "./replay.ts";
import {
  ErrorCode,
  type PaymentRequired,
  type PaymentRequirements,
  type ResourceInfo,
  type SettleResponse,
  X402_VERSION,
} from "./schemas.ts";

export const MCP_META = { payment: "x402/payment", response: "x402/payment-response" } as const;

/** Sent when settlement could not be confirmed. True because an EIP-3009 nonce settles at most once. */
export const UNCONFIRMED =
  "Settlement could not be confirmed, so no answer was released. Send the same call with the same signed payment: it can be charged at most once. Do not sign a new payment for this call until that retry answers.";

export interface McpToolPrice {
  /** Price per call in US dollars, settled in USDC, for example "$0.01". */
  price: string;
  description: string;
  /** The tool's input JSON Schema. When given, the price carries a Bazaar listing for the tool. */
  inputSchema?: Record<string, unknown>;
}

export interface McpConfig {
  /** The MCP endpoint, for example "/mcp". */
  path: string;
  /** Priced tools by name. A tool not listed here is free. */
  tools: Record<string, McpToolPrice>;
  /** Largest request body read. Default 64 KiB. A larger body is refused, never passed through unread. */
  maxBodyBytes?: number;
  /**
   * Pass GET (a server stream) and DELETE (session end) through to the server. Default false: a stateless
   * server needs neither, so the gate answers them 405 and only POST reaches the server.
   */
  allowStreams?: boolean;
}

type McpEvent =
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

interface Deps {
  offersFor(price: string): PaymentRequirements[];
  facilitator: Facilitator;
  replay: ReplayGuard;
  now: () => number;
  emit(event: McpEvent): void;
  acceptPending: boolean;
  service: Partial<Pick<ResourceInfo, "serviceName" | "tags" | "iconUrl">>;
}

type Json = Record<string, unknown>;
type RpcId = string | number;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface PricedTool extends McpToolPrice {
  name: string;
  accepts: PaymentRequirements[];
  bazaar: Json | undefined;
}

export function mcpHandler(config: McpConfig, deps: Deps) {
  const key = canonicalPath(config.path);
  if (key === null) throw new Error(`mcp path "${config.path}" is not a valid URL path`);
  const maxBody = config.maxBodyBytes ?? 64 * 1024;
  const tools = new Map<string, PricedTool>(
    Object.entries(config.tools).map(([name, tool]) => [
      fold(name),
      {
        ...tool,
        name,
        accepts: deps.offersFor(tool.price),
        bazaar: tool.inputSchema ? mcpBazaar(name, tool) : undefined,
      },
    ]),
  );

  type Classified =
    | { kind: "other" }
    | { kind: "priced"; tool: PricedTool }
    | { kind: "free" }
    | { kind: "malformed"; code: number; reason: string };

  /**
   * Strict on purpose: a call a lenient server might still run as a tool call (a method in another case,
   * positional params, a name that is not a string) is refused rather than passed through unpriced.
   */
  const classify = (message: unknown): Classified => {
    if (!isObject(message)) return { kind: "other" };
    const method = message["method"];
    if (typeof method !== "string" || fold(method) !== "tools/call") return { kind: "other" };
    if (method !== "tools/call")
      return { kind: "malformed", code: -32601, reason: "Method must be tools/call" };
    const params = message["params"];
    if (!isObject(params))
      return { kind: "malformed", code: -32602, reason: "tools/call params must be an object" };
    const name = params["name"];
    if (typeof name !== "string")
      return { kind: "malformed", code: -32602, reason: "Tool name must be a string" };
    const tool = tools.get(fold(name));
    return tool ? { kind: "priced", tool } : { kind: "free" };
  };

  function json(body: unknown, status = 200, extra?: HeadersInit): Response {
    const headers = new Headers(extra);
    headers.set("content-type", "application/json; charset=utf-8");
    headers.set("cache-control", "no-store");
    headers.set("access-control-allow-origin", "*");
    headers.delete("content-length");
    headers.delete("content-encoding");
    return new Response(JSON.stringify(body), { status, headers });
  }

  const rpcError = (id: RpcId | null, code: number, message: string, status = 200) =>
    json({ jsonrpc: "2.0", id, error: { code, message } }, status);

  function paymentRequired(id: RpcId, body: PaymentRequired, settlement?: SettleResponse): Response {
    return json({
      jsonrpc: "2.0",
      id,
      result: {
        resultType: "complete",
        isError: true,
        structuredContent: body,
        content: [{ type: "text", text: JSON.stringify(body) }],
        ...(settlement ? { _meta: { [MCP_META.response]: settlement } } : {}),
      },
    });
  }

  function unavailable(id: RpcId, path: string, op: string, error: FacilitatorError): Response {
    deps.emit({ type: "facilitator_error", path, op, message: error.message });
    return rpcError(id, -32603, "Payment service unavailable. Retry shortly.", 503);
  }

  function unconfirmed(id: RpcId, path: string, error: FacilitatorError): Response {
    deps.emit({ type: "facilitator_error", path, op: "settle", message: error.message });
    return rpcError(id, -32603, UNCONFIRMED, 503);
  }

  /** The server receives exactly what the gate inspected, re-serialized, with no payment in it. */
  function rebuilt(request: Request, message: unknown): Request | undefined {
    const clean = Array.isArray(message) ? message.map(withoutPayment) : withoutPayment(message);
    let body: string;
    try {
      body = JSON.stringify(clean);
    } catch {
      return undefined;
    }
    const headers = new Headers(request.headers);
    headers.delete("content-length");
    return new Request(request.url, { method: "POST", headers, body });
  }

  const forward = (
    request: Request,
    message: unknown,
    next: (request?: Request) => Response | Promise<Response>,
  ) => {
    const out = rebuilt(request, message);
    return out ? next(out) : rpcError(null, -32600, "Invalid request", 400);
  };

  function preflight(): Response {
    const methods = config.allowStreams ? "POST, GET, DELETE, OPTIONS" : "POST, OPTIONS";
    return new Response(null, {
      status: 204,
      headers: {
        allow: methods,
        "access-control-allow-origin": "*",
        "access-control-allow-methods": methods,
        "access-control-allow-headers":
          "content-type, accept, authorization, mcp-session-id, mcp-protocol-version, mcp-method, mcp-name, last-event-id",
        "access-control-expose-headers": "mcp-session-id",
        "access-control-max-age": "86400",
      },
    });
  }

  async function handle(
    request: Request,
    next: (request?: Request) => Response | Promise<Response>,
    at: { origin: string; path: string },
  ): Promise<Response> {
    const method = request.method.toUpperCase();
    if (method === "OPTIONS") return preflight();
    if (method !== "POST") {
      const stream = config.allowStreams && (method === "GET" || method === "DELETE");
      if (stream && request.body === null) return next();
      return new Response(JSON.stringify({ error: "method_not_allowed" }), {
        status: 405,
        headers: {
          allow: config.allowStreams ? "POST, GET, DELETE, OPTIONS" : "POST, OPTIONS",
          "content-type": "application/json; charset=utf-8",
          "access-control-allow-origin": "*",
        },
      });
    }

    const text = await readCapped(request, maxBody);
    if (text === "too_large") return rpcError(null, -32600, "Request too large", 413);
    if (text === "not_utf8") return rpcError(null, -32700, "Parse error: the body is not valid UTF-8", 400);
    let message: unknown;
    try {
      message = JSON.parse(text ?? "");
    } catch {
      return rpcError(null, -32700, "Parse error", 400);
    }

    // JSON-RPC batches left MCP in 2025-06-18; none is read or passed on.
    if (Array.isArray(message)) {
      return rpcError(null, -32600, "Send one JSON-RPC message per request; batches are not supported.", 400);
    }
    const kind = classify(message);
    if (kind.kind === "malformed") {
      const rawId = isObject(message) ? message["id"] : null;
      return rpcError(isRpcId(rawId) ? rawId : null, kind.code, kind.reason, kind.code === -32601 ? 404 : 400);
    }
    if (kind.kind !== "priced" || !isObject(message)) return forward(request, message, next);
    const tool = kind.tool;

    const id = message["id"];
    if (!isRpcId(id))
      return rpcError(null, -32600, "A call to a priced tool needs a string or finite number id", 400);
    const path = `${at.path}#${tool.name}`;
    const params = message["params"] as Json;
    const meta = isObject(params["_meta"]) ? params["_meta"] : undefined;
    const raw = meta?.[MCP_META.payment];
    const resource: ResourceInfo = {
      url: `${at.origin}${at.path}`,
      description: tool.description,
      mimeType: "application/json",
      ...deps.service,
    };
    const price = (error: string, settlement?: SettleResponse) =>
      paymentRequired(
        id,
        {
          x402Version: X402_VERSION,
          error,
          resource,
          accepts: tool.accepts,
          ...(tool.bazaar ? { extensions: { bazaar: tool.bazaar as { info: Json; schema: Json } } } : {}),
        },
        settlement,
      );

    if (raw === undefined) {
      deps.emit({ type: "challenge", path, method: "tools/call" });
      return price("Payment required");
    }
    const checked = checkPayment(raw, tool.accepts, deps.now());
    if (!checked.ok) {
      deps.emit({ type: "rejected", path, status: checked.status, code: checked.code });
      return price(checked.code);
    }
    const { requirement, authorization: auth, replayKey, claimUntil } = checked.payment;
    const payload = forFacilitator(
      checked.payment,
      resource,
      tool.bazaar ? { bazaar: tool.bazaar } : undefined,
    );

    if (!(await deps.replay.claim(replayKey, claimUntil))) {
      deps.emit({ type: "rejected", path, status: 402, code: ErrorCode.transactionState });
      return price(ErrorCode.transactionState);
    }

    const started = deps.now();
    let verified: Awaited<ReturnType<Facilitator["verify"]>>;
    try {
      verified = await deps.facilitator.verify(payload, requirement);
    } catch (error) {
      await deps.replay.release(replayKey);
      if (error instanceof FacilitatorError) return unavailable(id, path, "verify", error);
      throw error;
    }
    if (!verified.isValid) {
      await deps.replay.release(replayKey);
      deps.emit({ type: "rejected", path, status: 402, code: verified.invalidReason ?? ErrorCode.payload });
      return price(verified.invalidReason ?? ErrorCode.payload);
    }
    deps.emit({ type: "verified", path, payer: verified.payer ?? auth.from, ms: deps.now() - started });

    // The tool never sees the payment.
    const restMeta = Object.fromEntries(Object.entries(meta ?? {}).filter(([k]) => k !== MCP_META.payment));
    const { _meta: _payment, ...restParams } = params;
    const forTool = {
      ...message,
      params: { ...restParams, ...(Object.keys(restMeta).length > 0 ? { _meta: restMeta } : {}) },
    };

    const outbound = rebuilt(request, forTool);
    if (!outbound) {
      await deps.replay.release(replayKey);
      return rpcError(id, -32600, "Invalid request", 400);
    }
    let response: Response;
    try {
      response = await next(outbound);
    } catch (error) {
      await deps.replay.release(replayKey);
      throw error;
    }
    const reply = await readReply(response, id);
    const result = reply?.["result"];
    const answered = isObject(result) && result["isError"] !== true;

    if (reply === undefined || (!response.ok && answered)) {
      // Unreadable, or a successful result under an error status: nothing is charged and nothing is shown.
      await deps.replay.release(replayKey);
      deps.emit({ type: "not_charged", path, status: response.status });
      return rpcError(id, -32603, "The tool's reply could not be read; nothing was charged.", 502);
    }
    if (!answered) {
      // A JSON-RPC error or a tool refusal: passed back, not charged.
      await deps.replay.release(replayKey);
      deps.emit({ type: "not_charged", path, status: response.status });
      return json(reply, response.ok ? 200 : response.status, response.headers);
    }

    let settlement: SettleResponse;
    try {
      settlement = await deps.facilitator.settle(payload, requirement);
    } catch (error) {
      // The transfer may or may not have happened. Release the claim, so the same signed payment can be
      // sent again: its nonce settles at most once, so a retry can never charge twice.
      await deps.replay.release(replayKey);
      if (error instanceof FacilitatorError) return unconfirmed(id, path, error);
      throw error;
    }
    const pending = !settlement.success && settlement.errorReason === ErrorCode.settlementPending;
    if (settlement.success || (deps.acceptPending && pending && settlement.transaction !== "")) {
      deps.emit({
        type: "settled",
        path,
        payer: settlement.payer ?? verified.payer ?? auth.from,
        network: settlement.network,
        amount: settlement.amount ?? requirement.amount,
        transaction: settlement.transaction,
        pending,
        ms: deps.now() - started,
      });
      const resultMeta = isObject(result) && isObject(result["_meta"]) ? result["_meta"] : {};
      return json(
        { ...reply, result: { ...result, _meta: { ...resultMeta, [MCP_META.response]: settlement } } },
        200,
        response.headers,
      );
    }
    await deps.replay.release(replayKey);
    deps.emit({ type: "rejected", path, status: 402, code: settlement.errorReason ?? ErrorCode.settleError });
    return price(settlement.errorReason ?? ErrorCode.settleError, settlement);
  }

  return { matches: (canonical: string) => canonical === key, handle };
}

/** Unicode compatibility form, lower case: "Tools/Call", fullwidth letters and the long s fold together. */
function fold(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

const isRpcId = (value: unknown): value is RpcId =>
  typeof value === "string" || (typeof value === "number" && Number.isFinite(value));

/** A message with any x402 payment removed from params._meta. */
function withoutPayment(message: unknown): unknown {
  if (!isObject(message) || !isObject(message["params"])) return message;
  const params = message["params"];
  if (!isObject(params["_meta"]) || !(MCP_META.payment in params["_meta"])) return message;
  const { [MCP_META.payment]: _payment, ...meta } = params["_meta"];
  const { _meta: _old, ...rest } = params;
  return { ...message, params: { ...rest, ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}) } };
}

/** Reads a request body without holding more than `max` bytes. */
async function readCapped(request: Request, max: number): Promise<string | "too_large" | "not_utf8" | undefined> {
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared) > max) return "too_large";
  if (request.body === null) return undefined;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return "too_large";
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  // Strict, as the endpoints read their own bodies: a byte that is not UTF-8 is never turned into U+FFFD
  // and passed on as a different text.
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return "not_utf8";
  }
}

/** Finds the JSON-RPC response with this id in a JSON or Server-Sent Events reply. */
async function readReply(response: Response, id: RpcId): Promise<Json | undefined> {
  const text = await response.text().catch(() => undefined);
  if (text === undefined) return undefined;
  const candidates: unknown[] = [];
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("text/event-stream")) {
    for (const event of text.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data === "") continue;
      try {
        candidates.push(JSON.parse(data));
      } catch {
        // Not a JSON-RPC message.
      }
    }
  } else {
    try {
      const parsed: unknown = JSON.parse(text);
      candidates.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    } catch {
      return undefined;
    }
  }
  return candidates.find((m): m is Json => isObject(m) && m["id"] === id && ("result" in m || "error" in m));
}

/** Bazaar listing for an MCP tool (specs/extensions/bazaar.md, input type "mcp"). */
function mcpBazaar(name: string, tool: McpToolPrice): Json {
  return {
    info: {
      input: {
        type: "mcp",
        toolName: name,
        description: tool.description,
        inputSchema: tool.inputSchema ?? {},
      },
      output: { type: "json" },
    },
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        input: {
          type: "object",
          properties: {
            type: { type: "string", const: "mcp" },
            toolName: { type: "string" },
            description: { type: "string" },
            inputSchema: { type: "object" },
          },
          required: ["type", "toolName", "inputSchema"],
        },
        output: { type: "object", properties: { type: { type: "string" } }, required: ["type"] },
      },
      required: ["input"],
    },
  };
}
