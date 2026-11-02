/**
 * The OpenAPI 3.1 description of the JSON API, served at /openapi.json.
 *
 * Built from the same lists the API and the gate read (API_ENDPOINTS, the tool
 * schemas, the price), so the description cannot promise a parameter or a
 * price the service does not have. A test checks every path here against the
 * router.
 */

import { CATEGORIES, JURISDICTION_CODES } from './tools.js';
import { PRICE } from './pricing.js';

const ORIGIN = 'https://bellwether.dap.solutions';

const PAYMENT =
  `Priced from the first call at ${PRICE} in USDC on Base, paid per call with x402 v2 (exact scheme) through DAP Agent Payments: ` +
  'call without payment, read the price from the PAYMENT-REQUIRED header of the 402, and call again with a signed payment in PAYMENT-SIGNATURE. ' +
  'The answer is released after the payment settles, with the settlement record in PAYMENT-RESPONSE. A request refused before or after payment is never charged. ' +
  'A licensed institution sends its DAP licence key instead and is invoiced for what it used.';

const jurisdiction = {
  name: 'jurisdiction',
  in: 'query',
  required: false,
  description: 'Restrict to one jurisdiction.',
  schema: { type: 'string', enum: JURISDICTION_CODES },
};
const limit = (fallback) => ({
  name: 'limit',
  in: 'query',
  required: false,
  description: 'Maximum records to return.',
  schema: { type: 'integer', minimum: 1, maximum: 100, default: fallback },
});

const recordSchema = {
  type: 'object',
  required: ['id', 'regulator', 'jurisdiction', 'category', 'title', 'published_at', 'first_collected_at', 'revision'],
  properties: {
    id: { type: 'string', pattern: '^[0-9a-f]{32}$' },
    regulator: { type: 'string' },
    jurisdiction: { type: 'string', enum: JURISDICTION_CODES },
    category: { type: 'string', enum: CATEGORIES },
    title: { type: 'string' },
    summary: { type: ['string', 'null'] },
    url: { type: ['string', 'null'], format: 'uri' },
    published_at: {
      type: ['string', 'null'],
      description: 'The publication date the regulator gave. Null when the source publishes none: collection time is never put in its place.',
    },
    first_collected_at: { type: 'string', format: 'date-time' },
    last_confirmed_at: { type: 'string', format: 'date-time' },
    revision: { type: 'integer', minimum: 1, description: 'Above 1 when the record was amended after first collection.' },
  },
};

const listSchema = {
  type: 'object',
  required: ['count', 'records'],
  properties: {
    count: { type: 'integer' },
    records: { type: 'array', items: { $ref: '#/components/schemas/Record' } },
    coverage_note: { type: 'string' },
    notice: { type: 'string' },
  },
};

const errorSchema = {
  type: 'object',
  required: ['error'],
  properties: { error: { type: 'string' }, message: { type: 'string' } },
};

const priced = {
  '400': { description: 'The request was refused before any payment. Never charged.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
  '401': { description: 'A DAP licence key was sent and is not recognized or has been revoked.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
  '402': {
    description: 'Payment required. The x402 v2 price is in the PAYMENT-REQUIRED header (base64 JSON) and repeated in the body.',
    headers: { 'PAYMENT-REQUIRED': { schema: { type: 'string' } } },
    content: { 'application/json': { schema: { type: 'object' } } },
  },
  '503': { description: 'The payment service or licence check is unavailable. Nothing was charged. Retry shortly.' },
};

const paidHeaders = {
  'PAYMENT-RESPONSE': { description: 'The x402 settlement record, base64 JSON. Present on a paid answer.', schema: { type: 'string' } },
};

const security = [{}, { licenceKey: [] }, { licenceKeyHeader: [] }];

export function openApiDocument() {
  return {
    openapi: '3.1.0',
    info: {
      title: 'DAP Bellwether API',
      version: '1.0.0',
      summary: 'Publications from financial regulators in Canada, the US, the UK and the EU, as JSON.',
      description:
        'The records behind the DAP Bellwether connector, for agents and systems that call HTTP rather than MCP. ' +
        'The same records are free for people through the connector at https://bellwether.dap.solutions/mcp. ' +
        `${PAYMENT} This is a public information service. It is not legal or compliance advice.`,
      termsOfService: 'https://dap.solutions/terms/api/',
      contact: { name: 'Dartmouth Advisory Partners', email: 'bsibeth@dap.solutions', url: ORIGIN },
    },
    servers: [{ url: ORIGIN }],
    externalDocs: { description: 'DAP Agent Payments', url: 'https://dap.solutions/solutions/systems/agent-payments/' },
    security,
    paths: {
      '/api/search': {
        get: {
          operationId: 'searchRegulatoryChanges',
          summary: 'Search publications by keyword, jurisdiction, regulator, category or date.',
          description: `Most recent first. Dated records rank above undated ones. ${PRICE} per call.`,
          parameters: [
            { name: 'query', in: 'query', required: false, description: 'Keywords matched against title and summary.', schema: { type: 'string', minLength: 1, maxLength: 200 } },
            jurisdiction,
            { name: 'regulator', in: 'query', required: false, description: 'Short name, for example OSFI, SEC, FCA, ESMA.', schema: { type: 'string', maxLength: 20 } },
            { name: 'category', in: 'query', required: false, description: 'Publication type.', schema: { type: 'string', enum: CATEGORIES } },
            { name: 'since', in: 'query', required: false, description: 'ISO 8601 date or timestamp, inclusive. A year, month or date alone starts at the beginning of that period in UTC. A time without a zone is UTC.', schema: { type: 'string' } },
            { name: 'until', in: 'query', required: false, description: 'ISO 8601 date or timestamp, inclusive. A year, month or date alone runs to the end of that period in UTC. A time without a zone is UTC.', schema: { type: 'string' } },
            limit(20),
          ],
          responses: {
            '200': { description: 'Matching records.', headers: paidHeaders, content: { 'application/json': { schema: listSchema } } },
            ...priced,
          },
        },
      },
      '/api/recent': {
        get: {
          operationId: 'recentRegulatoryChanges',
          summary: 'The newest publications across every covered regulator.',
          description: `Newest first. ${PRICE} per call.`,
          parameters: [
            jurisdiction,
            { name: 'days', in: 'query', required: false, description: 'Look back this many days.', schema: { type: 'integer', minimum: 1, maximum: 365, default: 14 } },
            limit(25),
          ],
          responses: {
            '200': { description: 'Recent records.', headers: paidHeaders, content: { 'application/json': { schema: listSchema } } },
            ...priced,
          },
        },
      },
      '/api/change': {
        get: {
          operationId: 'getRegulatoryChange',
          summary: 'One record in full, with every revision observed since first collection.',
          description: `${PRICE} per call. A record that does not exist answers 404 and is never charged.`,
          parameters: [{ name: 'id', in: 'query', required: true, description: 'Record id from a search or recent result.', schema: { type: 'string', pattern: '^[0-9a-f]{32}$' } }],
          responses: {
            '200': {
              description: 'The record and its revisions, oldest first.',
              headers: paidHeaders,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['record', 'revisions'],
                    properties: {
                      record: { $ref: '#/components/schemas/Record' },
                      revisions: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            revision: { type: 'integer' },
                            observed_at: { type: 'string', format: 'date-time' },
                            title: { type: ['string', 'null'] },
                            summary: { type: ['string', 'null'] },
                            url: { type: ['string', 'null'] },
                          },
                        },
                      },
                      notice: { type: 'string' },
                    },
                  },
                },
              },
            },
            '404': { description: 'No record with that id. Never charged.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            ...priced,
          },
        },
      },
      '/api/coverage': {
        get: {
          operationId: 'listCoverage',
          summary: 'Every regulator and feed monitored, and how fresh each one is. Free.',
          security: [{}],
          responses: { '200': { description: 'Coverage.', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
    },
    components: {
      schemas: { Record: recordSchema, Error: errorSchema },
      securitySchemes: {
        licenceKey: {
          type: 'http',
          scheme: 'bearer',
          description: 'A DAP licence key (dapk_...), issued to an institution under a licence and invoiced by usage. Contact bsibeth@dap.solutions.',
        },
        licenceKeyHeader: { type: 'apiKey', in: 'header', name: 'X-API-Key', description: 'The same DAP licence key, for platforms that set an API key header.' },
      },
    },
  };
}
