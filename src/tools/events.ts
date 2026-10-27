/**
 * Event MCP tools — 2 read tools (MCP 1.9.0).
 *
 *  1. nevent_list_events             — nev-api GET /events
 *  2. nevent_event_sales_provenance  — nev-data-api event sales provenance
 *                                       (overview / summary / daily / campaigns views)
 *
 * ## Tenant scope
 *
 * Neither tool takes a tenant parameter. nev-api resolves the tenant of `GET /events`
 * from the JWT, and nev-data-api scopes sales provenance to the JWT's selected tenant
 * and its descendants; a query string can never widen it. Switch tenant with
 * `nevent_switch_tenant`, which re-issues the JWT.
 *
 * ## One tool with a `view` instead of one tool per endpoint
 *
 * The four provenance endpoints share the same event, date range, currency and
 * population filters and are meant to be read together (overview, then summary, then
 * the daily series). A single tool keeps the tool list short for the model.
 *
 * Both tools are READ operations — available in every operation mode.
 *
 * @module tools/events
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DataClient } from '../clients/data-client.js';
import { ok, err, toErrorEnvelope, checkMode } from './helpers.js';
import { TIMEOUTS } from '../config/timeouts.js';
import {
  ListEventsSchema,
  EventSalesProvenanceSchema,
  LIST_EVENTS_DEFAULT_SIZE,
  SALES_DAILY_DIMENSIONS,
  SALES_DAILY_MAX_TOP,
  type SalesProvenanceView,
} from '../schemas/events.js';
import type { NeventErrorEnvelope } from '../types/common.js';
import type { QueryParamValue } from '../types/common.js';

const READ_ONLY_ANNOTATIONS_BASE = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

const MISSING_TOKEN_ENVELOPE: NeventErrorEnvelope = {
  error: {
    type: 'authentication_error',
    message: 'No JWT token available. Authentication is required to read events.',
    code: 'missing_token',
  },
};

// ---------------------------------------------------------------------------
// Event projection
// ---------------------------------------------------------------------------

/** Fields kept from each event; the full DTO also carries every zone, ticket and experience. */
const EVENT_LIST_FIELDS = [
  'id',
  'name',
  'state',
  'active',
  'url',
  'startDate',
  'endDate',
  'ticketsSold',
  'ticketsAvailable',
  'ticketsNumber',
  'location',
  'tenantId',
  'tenantName',
] as const;

function projectEvent(raw: unknown): Record<string, unknown> {
  const source = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of EVENT_LIST_FIELDS) {
    if (source[field] !== undefined) out[field] = source[field];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sales provenance parameter rules
// ---------------------------------------------------------------------------

/** Query params every view accepts (nev-data-api `parseCommon`). */
const COMMON_PARAMS = ['from', 'to', 'tz', 'currency', 'population'] as const;

/** Extra params per view; anything else the caller sets is rejected, not ignored. */
const VIEW_EXTRA_PARAMS: Record<SalesProvenanceView, readonly string[]> = {
  overview: [],
  campaigns: [],
  summary: ['dimension', 'level', 'parent', 'top', 'search'],
  daily: ['dimension', 'top'],
};

function invalidRequest(message: string, code: string, param?: string): NeventErrorEnvelope {
  return { error: { type: 'invalid_request', message, code, ...(param ? { param } : {}) } };
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

/**
 * Register the 2 event MCP tools.
 *
 * @param server       - The `McpServer` instance to register tools on.
 * @param dataClient   - The session's `DataClient` (JWT access and nev-data-api calls).
 * @param neventApiUrl - Base URL of nev-api, e.g. `https://api.nevent.es`.
 */
export function registerEventTools(
  server: McpServer,
  dataClient: DataClient,
  neventApiUrl: string
): void {

  // -------------------------------------------------------------------------
  // Tool 1: nevent_list_events
  // -------------------------------------------------------------------------
  server.tool(
    'nevent_list_events',
    'List the events of the active tenant, one page at a time (nev-api GET /events). Use it to find an event ID before reading its sales with nevent_event_sales_provenance, or to look an event up by name. By default it returns upcoming events ordered by start date; pass future=false for past events, search for text on the name, nature=TICKETED for events with ticket sales, active_only=true to hide inactive ones. Returns { events, page, page_size, totalElements, totalPages }: each event carries id, name, state, active, url, startDate, endDate, ticketsSold, ticketsAvailable, ticketsNumber, location, tenantId and tenantName. Zones, ticket types and experiences are left out to keep the response small. Always paginated (default 25 per page, max 100): request the next page with page+1 while page+1 < totalPages. Scoped to the active tenant by the session JWT; use nevent_switch_tenant to change it.',
    ListEventsSchema,
    { title: 'List events', ...READ_ONLY_ANNOTATIONS_BASE },
    async (params) => {
      const denied = checkMode('nevent_list_events');
      if (denied) return err(denied);

      try {
        const jwtToken = dataClient.getJwtToken();
        if (!jwtToken) return err(MISSING_TOKEN_ENVELOPE);

        const page = params.page ?? 0;
        const size = params.page_size ?? LIST_EVENTS_DEFAULT_SIZE;

        // page and size are ALWAYS sent: with none of page/size/sort/order/search nev-api
        // switches to a legacy format that returns every event with its full ticket tree.
        const query = new URLSearchParams();
        query.set('page', String(page));
        query.set('size', String(size));
        if (params.future !== undefined) query.set('future', String(params.future));
        if (params.search !== undefined) query.set('search', params.search);
        if (params.nature !== undefined) query.set('nature', params.nature);
        if (params.active_only !== undefined) query.set('activeOnly', String(params.active_only));
        if (params.sort !== undefined) query.set('sort', params.sort);
        if (params.order !== undefined) query.set('order', params.order === 'desc' ? '-1' : '1');

        const response = await fetch(`${neventApiUrl}/events?${query.toString()}`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${jwtToken}`,
          },
          signal: AbortSignal.timeout(TIMEOUTS.LONG_MS),
        });

        if (!response.ok) {
          const body = await response.text();
          return err({
            error: {
              type: response.status === 401 || response.status === 403 ? 'authentication_error' : 'api_error',
              message:
                response.status === 401 || response.status === 403
                  ? 'Access denied while listing events. The session token may be expired or lack permission.'
                  : `Failed to list events: HTTP ${response.status}. ${body}`,
              code:
                response.status === 401 ? 'unauthorized' : response.status === 403 ? 'forbidden' : 'api_error',
            },
          });
        }

        const raw = (await response.json()) as unknown;
        const record = (raw !== null && typeof raw === 'object' && !Array.isArray(raw)
          ? raw
          : {}) as Record<string, unknown>;
        const content: unknown[] = Array.isArray(raw)
          ? raw
          : Array.isArray(record['content'])
            ? (record['content'] as unknown[])
            : [];

        return ok({
          events: content.map(projectEvent),
          page: typeof record['number'] === 'number' ? record['number'] : page,
          page_size: size,
          totalElements: typeof record['totalElements'] === 'number' ? record['totalElements'] : content.length,
          totalPages: typeof record['totalPages'] === 'number' ? record['totalPages'] : 1,
        });
      } catch (caught) {
        return err(toErrorEnvelope(caught));
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool 2: nevent_event_sales_provenance
  // -------------------------------------------------------------------------
  server.tool(
    'nevent_event_sales_provenance',
    'Where the ticket sales of ONE event come from (nev-data-api, analytics warehouse). Pick the event with nevent_list_events (TICKETED events), then choose a view. summary (default): sales grouped by dimension — provider, distribution channel, purchase channel, promo code or marketing (UTM source > medium > campaign; drill down with level + parent, copying the group key from the previous response); returns the top groups and an «Otros» bucket. daily: day-by-day series stacked by one dimension (provider | distribution | purchaseChannel | promoCode). campaigns: sales attributed to Nevent campaigns through tracking links. overview: totals, coverage and freshness of each block — read it first to know how much of the data carries provenance. from and to (YYYY-MM-DD, purchase days in tz, default Europe/Madrid) are required. Currencies are never added together: omit currency for one block per currency, or pass EUR. population defaults to SETTLED_SALES (settled sales); ALL_REPORTED includes refunded purchases and is NOT collected revenue. Amounts are the gross reported by the source, never net. Provenance fields can be missing: coverage and «unknown» buckets are part of the answer, do not present them as zero or as organic. The data is a warehouse (lags the sale by the pipeline); the view reports its freshness. Scoped to the active tenant and its descendants by the session JWT.',
    EventSalesProvenanceSchema,
    { title: 'Event sales provenance', ...READ_ONLY_ANNOTATIONS_BASE },
    async (params) => {
      const denied = checkMode('nevent_event_sales_provenance');
      if (denied) return err(denied);

      const view: SalesProvenanceView = params.view ?? 'summary';
      const values = params as Record<string, unknown>;

      // Reject params the chosen view ignores, so the model learns instead of reading
      // an answer that silently did not honour its filter.
      const allowed = new Set<string>([...COMMON_PARAMS, ...VIEW_EXTRA_PARAMS[view]]);
      for (const name of ['tz', 'currency', 'population', 'dimension', 'level', 'parent', 'top', 'search']) {
        if (values[name] !== undefined && !allowed.has(name)) {
          return err(
            invalidRequest(
              `"${name}" does not apply to view "${view}". ` +
                `Applicable optional params: ${[...allowed].filter((p) => p !== 'from' && p !== 'to').join(', ') || 'none'}.`,
              'param_not_applicable',
              name
            )
          );
        }
      }

      if (view === 'daily') {
        if (
          params.dimension !== undefined &&
          !(SALES_DAILY_DIMENSIONS as readonly string[]).includes(params.dimension)
        ) {
          return err(
            invalidRequest(
              `view "daily" accepts dimension ${SALES_DAILY_DIMENSIONS.join(' | ')}; "marketing" is only available in view "summary".`,
              'invalid_dimension',
              'dimension'
            )
          );
        }
        if (params.top !== undefined && params.top > SALES_DAILY_MAX_TOP) {
          return err(
            invalidRequest(`view "daily" accepts top 1-${SALES_DAILY_MAX_TOP}.`, 'invalid_top', 'top')
          );
        }
      }

      if (view === 'summary') {
        const marketing = (params.dimension ?? 'marketing') === 'marketing';
        if (!marketing && (params.level !== undefined || params.parent !== undefined)) {
          return err(
            invalidRequest('level and parent only apply to dimension=marketing.', 'invalid_level', 'level')
          );
        }
        if (marketing && (params.level ?? 'source') === 'source' && params.parent !== undefined) {
          return err(
            invalidRequest(
              'parent does not apply to level=source (the top level). Use level=medium or level=campaign with the key of the group one level up.',
              'invalid_parent',
              'parent'
            )
          );
        }
        if (marketing && params.level !== undefined && params.level !== 'source' && params.parent === undefined) {
          return err(
            invalidRequest(
              `level=${params.level} needs parent: the key of the group one level up, copied from a previous summary response.`,
              'parent_required',
              'parent'
            )
          );
        }
      }

      try {
        const query: Record<string, QueryParamValue> = { from: params.from, to: params.to };
        if (params.tz !== undefined) query['tz'] = params.tz;
        if (params.currency !== undefined) query['currency'] = params.currency;
        if (params.population !== undefined) query['population'] = params.population;
        if (view === 'summary' || view === 'daily') {
          if (params.dimension !== undefined) query['dimension'] = params.dimension;
          if (params.top !== undefined) query['top'] = params.top;
        }
        if (view === 'summary') {
          if (params.level !== undefined) query['level'] = params.level;
          if (params.parent !== undefined) query['parent'] = params.parent;
          if (params.search !== undefined) query['search'] = params.search;
        }

        const data = await dataClient.getEventSalesProvenance(params.event_id, view, query);
        return ok({ view, event_id: params.event_id, data });
      } catch (caught) {
        return err(toErrorEnvelope(caught));
      }
    }
  );
}
