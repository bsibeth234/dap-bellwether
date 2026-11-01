/**
 * Cloudflare Pages Functions adapter. Export the result as `onRequest` from functions/api/_middleware.ts
 * and every route under /api passes through the gate. Unpriced paths are untouched.
 *
 * The gate is built once per isolate from the Pages environment. If the configuration is invalid,
 * priced and unpriced /api calls alike get a 503 rather than a free answer: the gate fails closed.
 */
import type { Gate } from "../gate.ts";

/** The parts of the Pages EventContext the gate uses. Declared here to avoid a types dependency. */
export interface PagesContext<Env> {
  request: Request;
  env: Env;
  next: (input?: Request) => Promise<Response>;
  waitUntil: (promise: Promise<unknown>) => void;
}

export function x402PagesMiddleware<Env>(build: (env: Env) => Gate) {
  let gate: Gate | undefined;
  let failure: string | undefined;
  return async (context: PagesContext<Env>): Promise<Response> => {
    if (!gate && !failure) {
      try {
        gate = build(context.env);
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        console.error(`x402 gate configuration error: ${failure}`);
      }
    }
    if (!gate) {
      return new Response(JSON.stringify({ error: "payment_gate_unavailable" }), {
        status: 503,
        headers: { "content-type": "application/json; charset=utf-8", "retry-after": "60" },
      });
    }
    return gate.handle(context.request, (rebuilt) => (rebuilt ? context.next(rebuilt) : context.next()));
  };
}
