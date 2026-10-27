/**
 * Tests for the event and campaign health tools (MCP 1.9.0):
 *
 *   nevent_list_events                — nev-api GET /events
 *   nevent_event_sales_provenance     — nev-data-api /events/{id}/overview and /sales-provenance/*
 *   nevent_get_campaign_deliverability — nev-api GET /campaigns/{id}/deliverability/*
 *   nevent_get_campaign_unsubscribes   — nev-api GET /campaigns/{id}/unsubscribes/*
 *
 * All four are READ tools: they must be registered, classified READ in the operation
 * registry, and work in READ_ONLY mode (the default when NEVENT_OPERATION_MODE is unset).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { registerEventTools } from '../tools/events.js';
import { registerCampaignHealthTools } from '../tools/campaign-health.js';
import { DataClient } from '../clients/data-client.js';
import { getToolOperationType } from '../config/operation-mode.js';
import {
  ListEventsSchema,
  EventSalesProvenanceSchema,
  GetCampaignDeliverabilitySchema,
  GetCampaignUnsubscribesSchema,
} from '../schemas/events.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ToolHandler = (params: Record<string, unknown>) => Promise<unknown>;

const API = 'https://api.nevent.es';
const DATA = 'https://data.nevent.es';
const EVENT_ID = '507f1f77bcf86cd799439011';
const CAMPAIGN_ID = 'camp_123';

function makeMockServer() {
  const tools: Record<string, ToolHandler> = {};
  const annotations: Record<string, Record<string, unknown>> = {};
  return {
    annotations,
    tool(name: string, _d: string, _s: unknown, ann: unknown, handler?: ToolHandler) {
      tools[name] = handler ?? (ann as ToolHandler);
      annotations[name] = (handler ? ann : {}) as Record<string, unknown>;
    },
    async invoke(name: string, params: Record<string, unknown> = {}) {
      if (!tools[name]) throw new Error(`Tool "${name}" not registered`);
      return tools[name]!(params);
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    text: () => Promise.resolve(text),
    json: () => Promise.resolve(typeof body === 'string' ? JSON.parse(body) : body),
  } as unknown as Response;
}

function setup(fetchImpl: ReturnType<typeof vi.fn>, jwt = 'test-jwt') {
  const dataClient = new DataClient({ baseUrl: DATA, jwtToken: jwt }, 'tenant-xyz');
  const server = makeMockServer();
  registerEventTools(server as never, dataClient, API);
  registerCampaignHealthTools(server as never, dataClient, API);
  vi.stubGlobal('fetch', fetchImpl);
  return server;
}

function parse(result: unknown): Record<string, unknown> {
  return JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text) as Record<string, unknown>;
}

function errorOf(result: unknown): { type: string; message: string; code: string; param?: string } {
  const r = result as { isError?: boolean };
  expect(r.isError).toBe(true);
  return (parse(result) as { error: { type: string; message: string; code: string; param?: string } }).error;
}

function urlOf(fetchMock: ReturnType<typeof vi.fn>, call = 0): URL {
  return new URL(String(fetchMock.mock.calls[call]![0]));
}

function initOf(fetchMock: ReturnType<typeof vi.fn>, call = 0): RequestInit {
  return fetchMock.mock.calls[call]![1] as RequestInit;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const NEW_TOOLS = [
  'nevent_list_events',
  'nevent_event_sales_provenance',
  'nevent_get_campaign_deliverability',
  'nevent_get_campaign_unsubscribes',
] as const;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------
describe('operation registry', () => {
  it.each(NEW_TOOLS)('%s is classified READ', (name) => {
    expect(getToolOperationType(name)).toBe('READ');
  });

  it.each(NEW_TOOLS)('%s is registered with read-only annotations', (name) => {
    const server = setup(vi.fn());
    expect(server.annotations[name]).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
  });
});

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
describe('schemas', () => {
  const sales = z.object(EventSalesProvenanceSchema);
  const events = z.object(ListEventsSchema);

  it('sales provenance requires a 24-hex event id and from/to', () => {
    expect(sales.safeParse({ event_id: EVENT_ID, from: '2026-01-01', to: '2026-01-31' }).success).toBe(true);
    expect(sales.safeParse({ event_id: 'nope', from: '2026-01-01', to: '2026-01-31' }).success).toBe(false);
    expect(sales.safeParse({ event_id: EVENT_ID, from: '2026-01-01' }).success).toBe(false);
    expect(sales.safeParse({ event_id: EVENT_ID, from: '01/01/2026', to: '2026-01-31' }).success).toBe(false);
  });

  it('sales provenance validates currency, population, dimension and top', () => {
    const base = { event_id: EVENT_ID, from: '2026-01-01', to: '2026-01-31' };
    expect(sales.safeParse({ ...base, currency: 'EUR' }).success).toBe(true);
    expect(sales.safeParse({ ...base, currency: 'NONE' }).success).toBe(true);
    expect(sales.safeParse({ ...base, currency: 'eur' }).success).toBe(false);
    expect(sales.safeParse({ ...base, population: 'ALL_REPORTED' }).success).toBe(true);
    expect(sales.safeParse({ ...base, population: 'EVERYTHING' }).success).toBe(false);
    expect(sales.safeParse({ ...base, dimension: 'marketing', level: 'source' }).success).toBe(true);
    expect(sales.safeParse({ ...base, top: 51 }).success).toBe(false);
  });

  it('list events caps page_size at 100 and rejects negative pages', () => {
    expect(events.safeParse({ page_size: 100 }).success).toBe(true);
    expect(events.safeParse({ page_size: 101 }).success).toBe(false);
    expect(events.safeParse({ page: -1 }).success).toBe(false);
    expect(events.safeParse({ nature: 'TICKETED', order: 'desc' }).success).toBe(true);
    expect(events.safeParse({ sort: 'venue.startDate; drop' }).success).toBe(false);
  });

  it('deliverability and unsubscribes accept only their own views', () => {
    const d = z.object(GetCampaignDeliverabilitySchema);
    const u = z.object(GetCampaignUnsubscribesSchema);
    expect(d.safeParse({ campaign_id: 'c', view: 'bounce_reasons', bounce_type: 'hard' }).success).toBe(true);
    expect(d.safeParse({ campaign_id: 'c', view: 'reasons' }).success).toBe(false);
    expect(d.safeParse({ campaign_id: 'c', bounce_type: 'medium' }).success).toBe(false);
    expect(u.safeParse({ campaign_id: 'c', view: 'reasons' }).success).toBe(true);
    expect(u.safeParse({ campaign_id: 'c', view: 'bounce_reasons' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// nevent_list_events
// ---------------------------------------------------------------------------
describe('nevent_list_events', () => {
  const PAGED = {
    content: [
      {
        id: EVENT_ID,
        name: 'Summer Fest',
        state: 'PUBLISHED',
        active: true,
        startDate: '2026-07-01T20:00:00Z',
        ticketsSold: 120,
        zones: [{ big: 'tree' }],
        tickets: [{ big: 'tree' }],
        experiences: [{ big: 'tree' }],
        tenantId: 'tenant-xyz',
      },
    ],
    totalElements: 31,
    totalPages: 2,
    number: 0,
  };

  it('always sends page and size so nev-api never answers the legacy full dump', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(PAGED));
    const server = setup(fetchMock);

    await server.invoke('nevent_list_events', {});

    const url = urlOf(fetchMock);
    expect(url.origin + url.pathname).toBe(`${API}/events`);
    expect(url.searchParams.get('page')).toBe('0');
    expect(url.searchParams.get('size')).toBe('25');
    expect(initOf(fetchMock).method).toBe('GET');
    expect((initOf(fetchMock).headers as Record<string, string>)['Authorization']).toBe('Bearer test-jwt');
  });

  it('maps snake_case filters to the backend names', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(PAGED));
    const server = setup(fetchMock);

    await server.invoke('nevent_list_events', {
      search: 'summer',
      future: false,
      nature: 'TICKETED',
      active_only: true,
      sort: 'name',
      order: 'desc',
      page: 1,
      page_size: 10,
    });

    const q = urlOf(fetchMock).searchParams;
    expect(q.get('search')).toBe('summer');
    expect(q.get('future')).toBe('false');
    expect(q.get('nature')).toBe('TICKETED');
    expect(q.get('activeOnly')).toBe('true');
    expect(q.get('sort')).toBe('name');
    expect(q.get('order')).toBe('-1');
    expect(q.get('page')).toBe('1');
    expect(q.get('size')).toBe('10');
  });

  it('projects events to compact fields and reports pagination', async () => {
    const server = setup(vi.fn(async () => jsonResponse(PAGED)));

    const result = parse(await server.invoke('nevent_list_events', {}));
    const events = result['events'] as Array<Record<string, unknown>>;

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: EVENT_ID, name: 'Summer Fest', ticketsSold: 120 });
    expect(events[0]).not.toHaveProperty('zones');
    expect(events[0]).not.toHaveProperty('tickets');
    expect(events[0]).not.toHaveProperty('experiences');
    expect(result).toMatchObject({ page: 0, page_size: 25, totalElements: 31, totalPages: 2 });
  });

  it('tolerates a bare array response', async () => {
    const server = setup(vi.fn(async () => jsonResponse([{ id: EVENT_ID, name: 'X' }])));

    const result = parse(await server.invoke('nevent_list_events', {}));

    expect(result['events']).toEqual([{ id: EVENT_ID, name: 'X' }]);
    expect(result['totalElements']).toBe(1);
  });

  it('surfaces a 403 as an authentication error', async () => {
    const server = setup(vi.fn(async () => jsonResponse({}, 403)));
    expect(errorOf(await server.invoke('nevent_list_events', {})).code).toBe('forbidden');
  });

  it('fails clearly without a JWT', async () => {
    const fetchMock = vi.fn();
    const server = setup(fetchMock, '');
    expect(errorOf(await server.invoke('nevent_list_events', {})).code).toBe('missing_token');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// nevent_event_sales_provenance
// ---------------------------------------------------------------------------
describe('nevent_event_sales_provenance', () => {
  const RANGE = { event_id: EVENT_ID, from: '2026-01-01', to: '2026-01-31' };
  const ENVELOPE = { success: true, data: { totals: { grossCents: 1000 } }, timestamp: 't' };

  it('summary (default) calls /sales-provenance/summary on nev-data-api and unwraps data', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(ENVELOPE));
    const server = setup(fetchMock);

    const result = parse(await server.invoke('nevent_event_sales_provenance', RANGE));

    const url = urlOf(fetchMock);
    expect(url.origin + url.pathname).toBe(`${DATA}/events/${EVENT_ID}/sales-provenance/summary`);
    expect(url.searchParams.get('from')).toBe('2026-01-01');
    expect(url.searchParams.get('to')).toBe('2026-01-31');
    expect(initOf(fetchMock).method).toBe('GET');
    expect(result).toEqual({ view: 'summary', event_id: EVENT_ID, data: ENVELOPE.data });
  });

  it('overview uses /events/{id}/overview', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(ENVELOPE));
    const server = setup(fetchMock);

    await server.invoke('nevent_event_sales_provenance', { ...RANGE, view: 'overview' });

    expect(urlOf(fetchMock).pathname).toBe(`/events/${EVENT_ID}/overview`);
  });

  it.each(['daily', 'campaigns'] as const)('%s uses /sales-provenance/%s', async (view) => {
    const fetchMock = vi.fn(async () => jsonResponse(ENVELOPE));
    const server = setup(fetchMock);

    await server.invoke('nevent_event_sales_provenance', { ...RANGE, view });

    expect(urlOf(fetchMock).pathname).toBe(`/events/${EVENT_ID}/sales-provenance/${view}`);
  });

  it('forwards the summary grouping params under the backend names', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(ENVELOPE));
    const server = setup(fetchMock);

    await server.invoke('nevent_event_sales_provenance', {
      ...RANGE,
      tz: 'Europe/Lisbon',
      currency: 'EUR',
      population: 'ALL_REPORTED',
      dimension: 'marketing',
      level: 'medium',
      parent: 'abc_DEF-123',
      top: 5,
      search: 'insta',
    });

    const q = urlOf(fetchMock).searchParams;
    expect(Object.fromEntries(q.entries())).toEqual({
      from: '2026-01-01',
      to: '2026-01-31',
      tz: 'Europe/Lisbon',
      currency: 'EUR',
      population: 'ALL_REPORTED',
      dimension: 'marketing',
      level: 'medium',
      parent: 'abc_DEF-123',
      top: '5',
      search: 'insta',
    });
  });

  it('never sends a tenant id (scope comes from the JWT)', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(ENVELOPE));
    const server = setup(fetchMock);

    await server.invoke('nevent_event_sales_provenance', { ...RANGE, tenant_id: 'other-tenant' });

    const q = urlOf(fetchMock).searchParams;
    expect(q.has('tenant_id')).toBe(false);
    expect(q.has('tenantId')).toBe(false);
  });

  it('rejects params that do not apply to the view, without calling the API', async () => {
    const fetchMock = vi.fn();
    const server = setup(fetchMock);

    const overview = errorOf(
      await server.invoke('nevent_event_sales_provenance', { ...RANGE, view: 'overview', dimension: 'provider' })
    );
    const daily = errorOf(
      await server.invoke('nevent_event_sales_provenance', { ...RANGE, view: 'daily', search: 'x' })
    );

    expect(overview).toMatchObject({ code: 'param_not_applicable', param: 'dimension' });
    expect(daily).toMatchObject({ code: 'param_not_applicable', param: 'search' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('daily refuses the marketing dimension and top above 10', async () => {
    const fetchMock = vi.fn();
    const server = setup(fetchMock);

    const dim = errorOf(
      await server.invoke('nevent_event_sales_provenance', { ...RANGE, view: 'daily', dimension: 'marketing' })
    );
    const top = errorOf(
      await server.invoke('nevent_event_sales_provenance', { ...RANGE, view: 'daily', top: 11 })
    );

    expect(dim.code).toBe('invalid_dimension');
    expect(top.code).toBe('invalid_top');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('summary needs parent for medium/campaign and refuses level on non-marketing dimensions', async () => {
    const fetchMock = vi.fn();
    const server = setup(fetchMock);

    const noParent = errorOf(
      await server.invoke('nevent_event_sales_provenance', { ...RANGE, dimension: 'marketing', level: 'campaign' })
    );
    const wrongDim = errorOf(
      await server.invoke('nevent_event_sales_provenance', { ...RANGE, dimension: 'provider', level: 'source' })
    );

    expect(noParent.code).toBe('parent_required');
    expect(wrongDim.code).toBe('invalid_level');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps an upstream 400 to a structured error that keeps the backend message', async () => {
    const server = setup(
      vi.fn(async () =>
        jsonResponse({ success: false, error: { code: 'INVALID_RANGE', message: 'from debe ser anterior o igual a to' } }, 400)
      )
    );

    const error = errorOf(await server.invoke('nevent_event_sales_provenance', RANGE));

    expect(error.type).toBe('invalid_request');
    expect(error.message).toContain('from debe ser anterior o igual a to');
  });
});

// ---------------------------------------------------------------------------
// nevent_get_campaign_deliverability
// ---------------------------------------------------------------------------
describe('nevent_get_campaign_deliverability', () => {
  const BODY = { sent: 100, delivered: 95, softBounces: 3, hardBounces: 2, complaints: 0 };

  it.each([
    ['summary', 'summary'],
    ['segment_breakdown', 'segment-breakdown'],
  ] as const)('view %s calls /deliverability/%s', async (view, path) => {
    const fetchMock = vi.fn(async () => jsonResponse(BODY));
    const server = setup(fetchMock);

    const result = parse(await server.invoke('nevent_get_campaign_deliverability', { campaign_id: CAMPAIGN_ID, view }));

    expect(urlOf(fetchMock).pathname).toBe(`/campaigns/${CAMPAIGN_ID}/deliverability/${path}`);
    expect(initOf(fetchMock).method).toBe('GET');
    expect(result).toEqual({ view, campaign_id: CAMPAIGN_ID, data: BODY });
  });

  it('defaults to summary', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(BODY));
    const server = setup(fetchMock);

    await server.invoke('nevent_get_campaign_deliverability', { campaign_id: CAMPAIGN_ID });

    expect(urlOf(fetchMock).pathname).toBe(`/campaigns/${CAMPAIGN_ID}/deliverability/summary`);
  });

  it('bounce_reasons sends type=soft|hard', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ reasons: [] }));
    const server = setup(fetchMock);

    await server.invoke('nevent_get_campaign_deliverability', {
      campaign_id: CAMPAIGN_ID,
      view: 'bounce_reasons',
      bounce_type: 'hard',
    });

    const url = urlOf(fetchMock);
    expect(url.pathname).toBe(`/campaigns/${CAMPAIGN_ID}/deliverability/bounce-reasons`);
    expect(url.searchParams.get('type')).toBe('hard');
  });

  it('bounce_reasons without bounce_type is refused locally; bounce_type elsewhere too', async () => {
    const fetchMock = vi.fn();
    const server = setup(fetchMock);

    const missing = errorOf(
      await server.invoke('nevent_get_campaign_deliverability', { campaign_id: CAMPAIGN_ID, view: 'bounce_reasons' })
    );
    const extra = errorOf(
      await server.invoke('nevent_get_campaign_deliverability', { campaign_id: CAMPAIGN_ID, bounce_type: 'soft' })
    );

    expect(missing.code).toBe('bounce_type_required');
    expect(extra.code).toBe('param_not_applicable');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('encodes the campaign id in the path', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(BODY));
    const server = setup(fetchMock);

    await server.invoke('nevent_get_campaign_deliverability', { campaign_id: 'a/b c' });

    expect(String(fetchMock.mock.calls[0]![0])).toContain('/campaigns/a%2Fb%20c/deliverability/summary');
  });

  it('maps 404, 403 and 400 to actionable errors', async () => {
    for (const [status, code] of [
      [404, 'campaign_not_found'],
      [403, 'forbidden'],
      [400, 'invalid_request'],
    ] as const) {
      const server = setup(vi.fn(async () => jsonResponse('not an email campaign', status)));
      const error = errorOf(await server.invoke('nevent_get_campaign_deliverability', { campaign_id: CAMPAIGN_ID }));
      expect(error.code).toBe(code);
    }
  });
});

// ---------------------------------------------------------------------------
// nevent_get_campaign_unsubscribes
// ---------------------------------------------------------------------------
describe('nevent_get_campaign_unsubscribes', () => {
  it.each([
    ['summary', 'summary'],
    ['reasons', 'reasons'],
    ['segment_breakdown', 'segment-breakdown'],
  ] as const)('view %s calls /unsubscribes/%s', async (view, path) => {
    const body = { unsubscribes: 7 };
    const fetchMock = vi.fn(async () => jsonResponse(body));
    const server = setup(fetchMock);

    const result = parse(await server.invoke('nevent_get_campaign_unsubscribes', { campaign_id: CAMPAIGN_ID, view }));

    expect(urlOf(fetchMock).pathname).toBe(`/campaigns/${CAMPAIGN_ID}/unsubscribes/${path}`);
    expect(initOf(fetchMock).method).toBe('GET');
    expect(result).toEqual({ view, campaign_id: CAMPAIGN_ID, data: body });
  });

  it('defaults to summary and sends the bearer token', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    const server = setup(fetchMock);

    await server.invoke('nevent_get_campaign_unsubscribes', { campaign_id: CAMPAIGN_ID });

    expect(urlOf(fetchMock).pathname).toBe(`/campaigns/${CAMPAIGN_ID}/unsubscribes/summary`);
    expect((initOf(fetchMock).headers as Record<string, string>)['Authorization']).toBe('Bearer test-jwt');
  });

  it('maps 404 and 403', async () => {
    const notFound = setup(vi.fn(async () => jsonResponse({}, 404)));
    expect(errorOf(await notFound.invoke('nevent_get_campaign_unsubscribes', { campaign_id: CAMPAIGN_ID })).code).toBe(
      'campaign_not_found'
    );
    const forbidden = setup(vi.fn(async () => jsonResponse({}, 403)));
    expect(errorOf(await forbidden.invoke('nevent_get_campaign_unsubscribes', { campaign_id: CAMPAIGN_ID })).code).toBe(
      'forbidden'
    );
  });

  it('fails clearly without a JWT', async () => {
    const fetchMock = vi.fn();
    const server = setup(fetchMock, '');
    expect(errorOf(await server.invoke('nevent_get_campaign_unsubscribes', { campaign_id: CAMPAIGN_ID })).code).toBe(
      'missing_token'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
