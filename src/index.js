/**
 * DAP Bellwether, Worker entry point.
 *
 * Three jobs:
 *   fetch      serve the MCP endpoint, the landing page and its static assets
 *   assets     icons, manifest and fonts, bundled because a Worker has no disk
 *   scheduled  run the ingest on a cron trigger
 *
 * Dartmouth Advisory Partners. Free to use, no account required. While the
 * paid tier is on, heavy use of the data tools pays per call (payments.js).
 */

import { handleMcp, paymentStoreReady, purgeAllowanceCounts } from './payments.js';
import { purgePaymentClaims } from './claims.js';
import { pricingFor, pricingSummary } from './pricing.js';
import { runIngest } from './ingest.js';
import { countChanges, lastIngestRun, getSourceHealth } from './db.js';
import { enabledSources } from './sources.js';
import { renderLanding } from './landing.js';
import { serveAsset } from './assets.js';

/**
 * Whether this request arrived on the workers.dev fallback rather than the
 * custom domain. Matched on the suffix rather than the exact hostname so a
 * preview or a renamed Worker is covered without anyone remembering to come
 * back and edit a literal.
 *
 * @param {string} hostname
 */
export function isFallbackHost(hostname) {
  return String(hostname).toLowerCase().endsWith('.workers.dev');
}

/**
 * The pricing summary for /health. A tier switched on before its tables exist
 * answers every metered call free, so it reports degraded and says why.
 */
async function paymentsHealth(env) {
  const summary = pricingSummary(pricingFor(env));
  if (summary.status !== 'on' || (await paymentStoreReady(env.DB))) return summary;
  return {
    ...summary,
    status: 'degraded',
    reason: 'The payment tables are missing, so metered calls are answered free. Run npm run db:migrate.',
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/mcp') {
      return handleMcp(request, env, ctx);
    }

    // Icons, manifest and fonts. Checked before the routes below so a static
    // path can never be shadowed by a page route added later.
    const asset = serveAsset(url.pathname);
    if (asset) return asset;

    if (url.pathname === '/health') {
      try {
        const [total, run, health] = await Promise.all([
          countChanges(env.DB),
          lastIngestRun(env.DB),
          getSourceHealth(env.DB),
        ]);
        const active = enabledSources();
        const failing = active.filter((s) => (health[s.id] || {}).consecutive_failures > 0);
        return Response.json({
          status: failing.length === active.length ? 'degraded' : 'ok',
          records: total,
          feedsMonitored: active.length,
          feedsFailing: failing.map((s) => ({
            id: s.id,
            regulator: s.regulator,
            error: (health[s.id] || {}).last_error || null,
          })),
          lastRun: run || null,
          payments: await paymentsHealth(env),
        });
      } catch (err) {
        return Response.json(
          { status: 'error', error: err && err.message ? err.message : String(err) },
          { status: 500 }
        );
      }
    }

    if (url.pathname === '/' || url.pathname === '') {
      const headers = {
        'Content-Type': 'text/html; charset=utf-8',
        // Short, because the coverage list comes from the registry and a
        // corrected or disabled source should reach visitors quickly.
        'Cache-Control': 'public, max-age=300',
      };

      // The fallback host serves the same document as the custom domain, so
      // without this a crawler can index the workers.dev copy and show it to
      // people instead. The canonical tag in the head states the preference;
      // this removes the choice. Scoped to the page rather than applied at the
      // top of fetch on purpose: /mcp and /health are not indexable content in
      // the first place, and assets carry a year long cache, so a header
      // attached to them would outlive any future move to a different host.
      if (isFallbackHost(url.hostname)) {
        headers['X-Robots-Tag'] = 'noindex';
      }

      // The origin is taken from the request so the page advertises whichever
      // hostname the visitor arrived on, custom domain or workers.dev.
      return new Response(renderLanding(url.origin, pricingSummary(pricingFor(env))), { headers });
    }

    return new Response('Not found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    // Allowance counts from a day that has ended are deleted here. The cron's
    // 00:00 UTC run is the first after each day ends, so a count lives about
    // a day. Its own job, so a failed ingest never keeps a count alive.
    ctx.waitUntil(
      Promise.all([purgeAllowanceCounts(env.DB, Date.now()), purgePaymentClaims(env.DB, Date.now())]).catch((err) => {
        console.error(`Bellwether allowance purge failed: ${err && err.message ? err.message : String(err)}`);
      })
    );
    ctx.waitUntil(
      runIngest(env.DB).then((summary) => {
        // Red flags first, then status. This lands in wrangler tail.
        if (summary.failed > 0) {
          const broken = summary.perSource.filter((s) => !s.ok);
          console.error(
            `Bellwether ingest: ${summary.failed} source(s) failed: ` +
              broken.map((s) => `${s.source} (${s.error})`).join('; ')
          );
        }
        console.log(
          `Bellwether ingest complete: ${summary.ok}/${summary.attempted} sources ok, ` +
            `${summary.inserted} new, ${summary.revised} amended, ${summary.unchanged} unchanged.`
        );
      })
    );
  },
};
