/**
 * Tool surface for DAP Bellwether.
 *
 * Every tool carries a title and readOnlyHint, which the Connectors Directory
 * requires and will reject a submission for missing. openWorldHint is false
 * because the tools read our own store, not the open internet.
 *
 * There is no write tool and no auth, by design. The whole surface is public
 * regulatory material, so there is nothing here to protect and nothing a user
 * can damage.
 */

import { JURISDICTIONS, SOURCES, enabledSources } from './sources.js';
import { searchChanges, getChange, getSourceHealth, countChanges, lastIngestRun } from './db.js';

export const JURISDICTION_CODES = Object.keys(JURISDICTIONS);
export const CATEGORIES = ['rules', 'enforcement', 'guidance', 'news'];

const DATE_INPUT = /^(\d{4})-(\d{2})-(\d{2})(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?)?$/;

/**
 * A since or until bound as the store writes times (toISOString, UTC with
 * milliseconds), so the text comparison in searchChanges is a time
 * comparison. A date alone covers the whole UTC day: since starts at its
 * first millisecond, until ends at its last. A time without a zone is read
 * as UTC. Returns null for anything that is not a real date.
 *
 * @param {unknown} value
 * @param {'since'|'until'} edge
 * @returns {string|null}
 */
export function dateBound(value, edge) {
  if (typeof value !== 'string') return null;
  const m = DATE_INPUT.exec(value);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) return null;
  if (!m[4]) return edge === 'until' ? `${m[1]}-${m[2]}-${m[3]}T23:59:59.999Z` : `${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z`;
  const ms = Date.parse(m[7] ? value : `${value}Z`);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

export const TOOLS = [
  {
    name: 'search_regulatory_changes',
    title: 'Search regulatory changes',
    description:
      'Search regulatory publications collected from financial regulators in Canada, the United States, the United Kingdom and the European Union. Use for questions about what a regulator has published on a topic, or what has changed in a date range. Returns the most recent matches first.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Keywords matched against title and summary, for example "liquidity" or "crypto-asset".',
        },
        jurisdiction: {
          type: 'string',
          enum: JURISDICTION_CODES,
          description: 'Restrict to one jurisdiction.',
        },
        regulator: {
          type: 'string',
          description: 'Restrict to one regulator by short name, for example OSFI, SEC, FCA, ESMA.',
        },
        category: {
          type: 'string',
          enum: CATEGORIES,
          description: 'Restrict to a publication type.',
        },
        since: {
          type: 'string',
          description: 'ISO 8601 date or timestamp. Only items published on or after this.',
        },
        until: {
          type: 'string',
          description: 'ISO 8601 date or timestamp. Only items published on or before this.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          default: 20,
          description: 'Maximum records to return.',
        },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Search regulatory changes', readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'recent_regulatory_changes',
    title: 'Recent regulatory changes',
    description:
      'List the most recent regulatory publications across all covered regulators, newest first. Use when asked what is new, what happened this week, or for a general catch up rather than a specific topic.',
    inputSchema: {
      type: 'object',
      properties: {
        jurisdiction: { type: 'string', enum: JURISDICTION_CODES, description: 'Restrict to one jurisdiction.' },
        days: {
          type: 'integer',
          minimum: 1,
          maximum: 365,
          default: 14,
          description: 'Look back this many days.',
        },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 25, description: 'Maximum records to return.' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Recent regulatory changes', readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'get_regulatory_change',
    title: 'Get a regulatory change with its revision history',
    description:
      'Retrieve one record in full, including every revision observed since it was first seen. Use this to answer whether a document was amended after publication and what moved. The id comes from a search or recent result.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Record id from a search or recent result.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Get a regulatory change with its revision history',
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'list_coverage',
    title: 'List regulators and coverage status',
    description:
      'List every regulator and feed being monitored, with when each was last collected successfully and how fresh the data is. Use to answer what this connector covers, or to check whether a jurisdiction is being watched before relying on an absence of results.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'List regulators and coverage status', readOnlyHint: true, openWorldHint: false },
  },
];

/**
 * Render one record for a chat response. Compact, and always with the link.
 *
 * The date is never coalesced silently. Some regulators, ESMA among them, ship
 * items with no date element at all, and the store falls back to when we first
 * collected the record so ordering and range filters still work. Printing that
 * fallback as a bare date would put our collection time where the regulator's
 * publication time belongs, which is a claim we cannot support and precisely
 * the thing this connector exists to get right. An undated record says so, in
 * every result, not only when someone thinks to call list_coverage.
 */
function formatChange(row) {
  const date = row.published_at
    ? row.published_at.slice(0, 10)
    : row.first_seen_at
      ? `first collected ${row.first_seen_at.slice(0, 10)}, publication date not provided by source`
      : 'date unknown';
  const lines = [
    `${row.regulator} (${row.jurisdiction}) | ${date} | ${row.category}`,
    row.title,
  ];
  if (row.summary) lines.push(row.summary);
  if (row.url) lines.push(row.url);
  if (row.revision > 1) {
    lines.push(`Amended since first publication: revision ${row.revision}.`);
  }
  lines.push(`id: ${row.id}`);
  return lines.join('\n');
}

function textResult(text) {
  return { content: [{ type: 'text', text }] };
}

function errorResult(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * Execute a tool call.
 * @returns {Promise<object>} an MCP CallToolResult
 */
export async function callTool(name, args, env) {
  const db = env.DB;
  const input = args || {};

  switch (name) {
    case 'search_regulatory_changes': {
      const bounds = {};
      for (const edge of ['since', 'until']) {
        if (input[edge] === undefined || input[edge] === null || input[edge] === '') continue;
        bounds[edge] = dateBound(input[edge], edge);
        if (bounds[edge] === null) {
          return errorResult(`${edge} must be an ISO 8601 date or timestamp, for example 2026-10-01.`);
        }
      }
      const rows = await searchChanges(db, {
        query: input.query,
        jurisdiction: input.jurisdiction,
        regulator: input.regulator,
        category: input.category,
        since: bounds.since,
        until: bounds.until,
        limit: input.limit || 20,
      });
      if (!rows.length) {
        return textResult(
          'No matching records. Note that coverage begins from when this service first collected each source, so older material may not be present. Use list_coverage to see what is monitored.'
        );
      }
      return textResult(
        `${rows.length} record(s), most recent first.\n\n${rows.map(formatChange).join('\n\n')}`
      );
    }

    case 'recent_regulatory_changes': {
      const days = input.days || 14;
      const since = new Date(Date.now() - days * 86400000).toISOString();
      const rows = await searchChanges(db, {
        jurisdiction: input.jurisdiction,
        since,
        limit: input.limit || 25,
      });
      if (!rows.length) {
        return textResult(`No records in the last ${days} days for the requested scope.`);
      }
      return textResult(
        `${rows.length} record(s) from the last ${days} days, most recent first.\n\n${rows
          .map(formatChange)
          .join('\n\n')}`
      );
    }

    case 'get_regulatory_change': {
      if (!input.id) return errorResult('An id is required. Get one from a search or recent result.');
      const record = await getChange(db, input.id);
      if (!record) return errorResult(`No record with id ${input.id}.`);

      const parts = [formatChange(record), '', `First seen: ${record.first_seen_at}`, `Last confirmed: ${record.last_seen_at}`];
      if (record.revisions.length > 1) {
        parts.push('', 'Revision history, oldest first:');
        for (const rev of record.revisions) {
          parts.push(`  r${rev.revision} observed ${rev.observed_at}`);
          parts.push(`    title: ${rev.title || '(none)'}`);
          if (rev.summary) parts.push(`    summary: ${rev.summary}`);
        }
      } else {
        parts.push('', 'No amendments observed since first collection.');
      }
      return textResult(parts.join('\n'));
    }

    case 'list_coverage': {
      const health = await getSourceHealth(db);
      const total = await countChanges(db);
      const lastRun = await lastIngestRun(db);
      const active = enabledSources();

      const byJurisdiction = {};
      for (const source of active) {
        const h = health[source.id] || {};
        const status = h.last_ok_at
          ? `last collected ${h.last_ok_at.slice(0, 16).replace('T', ' ')} UTC`
          : 'not yet collected';
        const failing =
          h.consecutive_failures > 0 ? ` (failing, ${h.consecutive_failures} consecutive)` : '';
        (byJurisdiction[source.jurisdiction] ||= []).push(
          `  ${source.regulator}: ${source.name}, ${status}${failing}`
        );
      }

      const lines = [`Monitoring ${active.length} feeds across ${Object.keys(byJurisdiction).length} jurisdictions. ${total} records held.`];
      if (lastRun) {
        lines.push(
          `Last collection run finished ${lastRun.finished_at.slice(0, 16).replace('T', ' ')} UTC: ${lastRun.sources_ok} succeeded, ${lastRun.sources_failed} failed, ${lastRun.inserted} new, ${lastRun.revised} amended.`
        );
      }
      lines.push('');
      for (const code of Object.keys(byJurisdiction).sort()) {
        lines.push(`${JURISDICTIONS[code] || code}:`);
        lines.push(...byJurisdiction[code]);
      }

      const disabled = SOURCES.filter((s) => !s.enabled);
      if (disabled.length) {
        lines.push('', `Not currently monitored: ${disabled.map((s) => `${s.regulator} ${s.name}`).join(', ')}.`);
      }
      return textResult(lines.join('\n'));
    }

    default:
      return errorResult(`Unknown tool: ${name}`);
  }
}
