/**
 * MCP over streamable HTTP, stateless.
 *
 * Written directly against the JSON-RPC surface rather than pulled in from an
 * SDK. The reference SDK's HTTP transport expects a Node request and response
 * pair, and the Workers path around it wants Durable Objects for session
 * state. A read only server has no session state worth keeping, so the
 * stateless JSON response mode the spec already allows is both simpler and
 * has fewer moving parts to break in public. Every POST is self contained.
 *
 * Assumption this rests on: no tool here ever needs to stream partial results
 * or push a server initiated message. If that changes, this file is where the
 * SSE path gets added, and nothing else moves.
 */

import { TOOLS, callTool } from './tools.js';
import { renderConnectorNotice } from './landing.js';
import { pricingFor, pricingInstructions } from './pricing.js';

const SERVER_INFO = { name: 'DAP Bellwether', version: '1.0.0' };

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

const INSTRUCTIONS = [
  'DAP Bellwether monitors financial regulators in Canada, the United States, the United Kingdom and the European Union, and records what they publish.',
  'Coverage starts from when this service first collected each source, so it is not a complete historical archive. Say so if a user asks about material older than the coverage window.',
  'Use list_coverage before concluding that something was not published, so an absence of results is not mistaken for an absence of regulation.',
  'This is a public information service. It is not legal or compliance advice.',
  'Use of this service is under the DAP API terms at https://dap.solutions/terms/api/. Calling a tool, sending a payment or using a licence key accepts them.',
].join(' ');

/** The instructions, plus the price while the paid tier is on, so an agent
 *  learns the allowance before it meets it rather than from a refusal. */
function instructionsFor(env) {
  const pricing = pricingInstructions(pricingFor(env));
  return pricing ? `${INSTRUCTIONS} ${pricing}` : INSTRUCTIONS;
}

/**
 * Origin validation, required by the spec to prevent DNS rebinding.
 * Server to server callers legitimately send no Origin, so absence is allowed
 * while a present but unrecognised Origin is refused.
 */
const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/([a-z0-9-]+\.)*claude\.ai$/i,
  /^https:\/\/([a-z0-9-]+\.)*claude\.com$/i,
  /^https:\/\/([a-z0-9-]+\.)*anthropic\.com$/i,
  /^http:\/\/localhost(:\d+)?$/i,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/i,
];

export function isAllowedOrigin(origin) {
  if (!origin) return true;
  return ALLOWED_ORIGIN_PATTERNS.some((pattern) => pattern.test(origin));
}

/**
 * Whether an Accept header ranks HTML above the protocol media types, which in
 * practice means a person opened this URL in a browser.
 *
 * Strict on purpose. Only an explicit `text/html` counts, so a wildcard cannot
 * trigger it: curl sends a bare wildcard, plenty of server to server callers
 * send nothing at all, and both must keep the JSON-RPC path. HTML has to
 * outrank both text/event-stream and application/json, so a client that lists
 * HTML among several equal alternatives is still treated as a client.
 *
 * @param {string|null} accept
 * @returns {boolean}
 */
export function prefersHtml(accept) {
  if (!accept) return false;

  const weightOf = (mediaType) => {
    let best = 0;
    for (const part of accept.split(',')) {
      const [media, ...params] = part.trim().split(';');
      if (media.trim().toLowerCase() !== mediaType) continue;
      const q = params.map((p) => p.trim()).find((p) => p.toLowerCase().startsWith('q='));
      const value = q === undefined ? 1 : Number.parseFloat(q.slice(2));
      if (Number.isFinite(value) && value > best) best = value;
    }
    return best;
  };

  const html = weightOf('text/html');
  return html > 0 && html > weightOf('text/event-stream') && html > weightOf('application/json');
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

function negotiateProtocolVersion(requested) {
  if (requested && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) return requested;
  return DEFAULT_PROTOCOL_VERSION;
}

/**
 * Handle one JSON-RPC message.
 * @returns {Promise<object|null>} a response, or null for a notification
 */
async function handleMessage(message, env) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return rpcError(message && message.id !== undefined ? message.id : null, -32600, 'Invalid Request');
  }

  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize': {
      if (isNotification) return null;
      return rpcResult(id, {
        protocolVersion: negotiateProtocolVersion(params && params.protocolVersion),
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: instructionsFor(env),
      });
    }

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;

    case 'ping':
      return isNotification ? null : rpcResult(id, {});

    case 'tools/list':
      return isNotification ? null : rpcResult(id, { tools: TOOLS });

    // Not advertised in capabilities, but some clients probe regardless.
    // An empty list is quieter than an error and costs nothing.
    case 'resources/list':
      return isNotification ? null : rpcResult(id, { resources: [] });
    case 'resources/templates/list':
      return isNotification ? null : rpcResult(id, { resourceTemplates: [] });
    case 'prompts/list':
      return isNotification ? null : rpcResult(id, { prompts: [] });

    case 'tools/call': {
      if (isNotification) return null;
      const name = params && params.name;
      if (!name) return rpcError(id, -32602, 'Invalid params: name is required');
      if (!TOOLS.some((t) => t.name === name)) {
        return rpcError(id, -32602, `Unknown tool: ${name}`);
      }
      try {
        const result = await callTool(name, params.arguments, env);
        return rpcResult(id, result);
      } catch (err) {
        // Tool failures come back as a result with isError, not a protocol
        // error, so the model can see what went wrong and tell the user.
        return rpcResult(id, {
          content: [
            {
              type: 'text',
              text: `Tool ${name} failed: ${err && err.message ? err.message : String(err)}`,
            },
          ],
          isError: true,
        });
      }
    }

    default:
      return isNotification ? null : rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/**
 * This route answers two different media types at one URL, chosen by Accept.
 * Any cache between here and the caller therefore has to key on Accept, or it
 * will hand the cached HTML to a client that asked for the event stream. The
 * HTML variant is the dangerous one, because it is the only cacheable response
 * on the route, so it is the one that would be handed out wrongly.
 */
const VARY_ON_ACCEPT = 'Accept';

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  Vary: VARY_ON_ACCEPT,
};

/**
 * Handle an HTTP request to the MCP endpoint.
 * @param {Request} request
 * @param {object} env  Worker bindings, including DB
 * @returns {Promise<Response>}
 */
export async function handleMcpRequest(request, env) {
  if (!isAllowedOrigin(request.headers.get('Origin'))) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
      status: 403,
      headers: JSON_HEADERS,
    });
  }

  // A person who pasted the connector URL into the address bar instead of into
  // Claude gets a page telling them what to do with it. Sits after the origin
  // guard so that guard still runs first, and ahead of the GET branch below so
  // only a browser preference is diverted: every other GET, including the SSE
  // probe, falls through to the JSON-RPC answer unchanged.
  if (request.method === 'GET' && prefersHtml(request.headers.get('Accept'))) {
    return new Response(renderConnectorNotice(new URL(request.url).origin), {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        // no-transform is load bearing, not a cache tweak. Cloudflare injects
        // the Web Analytics beacon into HTML at the edge, and the privacy
        // statement says /mcp does not load it. That claim survived only
        // because this endpoint never answered as a document. It answers as
        // one now, so the response has to refuse the transform.
        'Cache-Control': 'public, max-age=300, no-transform',
        // Without this, the only cacheable response on the route is also the
        // wrong answer for every other caller: a browser cache holding this
        // page would serve it to the next request on this URL whatever that
        // request asked for, including an SSE probe.
        Vary: VARY_ON_ACCEPT,
      },
    });
  }

  // No server initiated messages, so there is nothing to stream on GET.
  if (request.method === 'GET') {
    return new Response(JSON.stringify(rpcError(null, -32601, 'SSE stream not supported; POST JSON-RPC to this endpoint')), {
      status: 405,
      headers: { ...JSON_HEADERS, Allow: 'POST, OPTIONS' },
    });
  }

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': request.headers.get('Origin') || '*',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, MCP-Protocol-Version, Accept',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify(rpcError(null, -32600, 'Method not allowed')), {
      status: 405,
      headers: { ...JSON_HEADERS, Allow: 'POST, OPTIONS' },
    });
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return new Response(JSON.stringify(rpcError(null, -32700, 'Parse error')), {
      status: 400,
      headers: JSON_HEADERS,
    });
  }

  // Carried by the bodiless 202s too, which do not go through JSON_HEADERS.
  // A 202 is not something a cache should be reusing, but the route either
  // varies on Accept everywhere or the guarantee has a hole in it.
  const corsHeaders = request.headers.get('Origin')
    ? { 'Access-Control-Allow-Origin': request.headers.get('Origin'), Vary: VARY_ON_ACCEPT }
    : { Vary: VARY_ON_ACCEPT };

  // A batch of notifications produces no responses at all, which is a 202.
  if (Array.isArray(payload)) {
    const responses = [];
    for (const message of payload) {
      const response = await handleMessage(message, env);
      if (response) responses.push(response);
    }
    if (!responses.length) {
      return new Response(null, { status: 202, headers: corsHeaders });
    }
    return new Response(JSON.stringify(responses), {
      status: 200,
      headers: { ...JSON_HEADERS, ...corsHeaders },
    });
  }

  const response = await handleMessage(payload, env);
  if (!response) {
    return new Response(null, { status: 202, headers: corsHeaders });
  }
  return new Response(JSON.stringify(response), {
    status: 200,
    headers: { ...JSON_HEADERS, ...corsHeaders },
  });
}
