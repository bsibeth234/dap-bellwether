/**
 * Wraps any fetch-style handler: a Cloudflare Worker `fetch`, a Next.js App Router route handler,
 * Hono, Bun or Deno.
 *
 *   export const POST = withX402(gate, async (request) => Response.json(answer));
 */
import type { Gate } from "../gate.ts";

export function withX402<Rest extends unknown[]>(
  gate: Gate,
  handler: (request: Request, ...rest: Rest) => Response | Promise<Response>,
): (request: Request, ...rest: Rest) => Promise<Response> {
  return (request, ...rest) => gate.handle(request, (rebuilt) => handler(rebuilt ?? request, ...rest));
}
