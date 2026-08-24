/**
 * Unit tests for the campaign performance tools (MCP 1.8.0):
 *   - nevent_get_campaign_metrics       → GET /campaigns/{id}/metrics
 *   - nevent_list_campaign_recipients   → GET /campaigns/{id}/recipients
 *
 * These read nev-api directly (the operational source of truth for a send),
 * unlike nevent_campaign_report which reads the analytics warehouse via
 * nev-data-api and lags behind by the CDC/dbt pipeline.
 *
 * Covers:
 * - Zod schema validation (campaign_id required, recipient status enum,
 *   pagination bounds)
 * - Request shape: path, method, query params, bearer token
 * - Response passthrough of the CampaignMetrics and PagedResponse envelopes
 * - Error mapping: 404 unknown campaign, 403 forbidden
 * - Operation mode: both registered as READ
 *
 * @module tests/campaign-metrics
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { isOperationAllowed } from '../config/operation-mode.js';
import {
  GetCampaignMetricsSchema,
  ListCampaignRecipientsSchema,
} from '../schemas/campaign-metrics.js';

const GetCampaignMetricsObject = z.object(GetCampaignMetricsSchema);
const ListCampaignRecipientsObject = z.object(ListCampaignRecipientsSchema);

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ToolHandler = (params: Record<string, unknown>) => Promise<unknown>;

function makeMockServer() {
  const tools: Record<string, ToolHandler> = {};
  return {
    tool(
      name: string,
      _description: string,
      _schema: unknown,
      annotationsOrHandler: unknown,
      maybeHandler?: ToolHandler
    ) {
      tools[name] = maybeHandler ?? (annotationsOrHandler as ToolHandler);
    },
    async invoke(name: string, params: Record<string, unknown> = {}) {
      if (!tools[name]) throw new Error(`Tool "${name}" not registered`);
      return tools[name]!(params);
    },
  };
}

function mockFetchOk(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

async function setupTools(fetchImpl: typeof fetch) {
  const { registerCampaignMetricsTools } = await import('../tools/campaign-metrics.js');
  const { DataClient } = await import('../clients/data-client.js');

  const dataClient = new DataClient(
    { baseUrl: 'https://data.nevent.es', jwtToken: 'test-jwt' },
    'tenant-xyz'
  );

  const server = makeMockServer();
  registerCampaignMetricsTools(server as never, dataClient, 'https://api.nevent.es');
  vi.stubGlobal('fetch', fetchImpl);
  return server;
}

function parseToolResult(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

function requestedUrl(fetchMock: ReturnType<typeof vi.fn>, call = 0): URL {
  return new URL(String(fetchMock.mock.calls[call]![0]));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CAMPAIGN_ID = '507f1f77bcf86cd799439011';

const MOCK_METRICS = {
  campaignId: CAMPAIGN_ID,
  campaignName: 'Summer Festival 2026 — Early bird',
  tenantId: 'tenant-xyz',
  sentAt: '2026-08-20T10:00:00Z',
  totalRecipients: 12500,
  totalSent: 12480,
  totalDelivered: 12210,
  totalBounces: 270,
  totalComplaints: 4,
  totalOpens: 8100,
  uniqueOpens: 5400,
  totalClicks: 1450,
  uniqueClicks: 980,
  unsubscribes: 37,
  openRate: 44.23,
  clickRate: 8.03,
  clickToOpenRate: 18.15,
  bounceRate: 2.16,
  unsubscribeRate: 0.3,
  carts: 210,
  purchases: 96,
  revenue: 4320.5,
};

const MOCK_RECIPIENTS = {
  content: [
    { userId: 'u1', name: 'Ada Lovelace', email: 'ada@example.com', status: 'CLICKED' },
    { userId: 'u2', name: 'Alan Turing', email: 'alan@example.com', status: 'OPENED' },
  ],
  page: 0,
  size: 25,
  totalElements: 2,
  totalPages: 1,
};

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
describe('GetCampaignMetricsSchema', () => {
  it('accepts a campaign id', () => {
    expect(GetCampaignMetricsObject.safeParse({ campaign_id: CAMPAIGN_ID }).success).toBe(true);
  });

  it('rejects a missing campaign id', () => {
    expect(GetCampaignMetricsObject.safeParse({}).success).toBe(false);
  });

  it('rejects an empty campaign id', () => {
    expect(GetCampaignMetricsObject.safeParse({ campaign_id: '' }).success).toBe(false);
  });
});

describe('ListCampaignRecipientsSchema', () => {
  it('accepts just a campaign id', () => {
    expect(ListCampaignRecipientsObject.safeParse({ campaign_id: CAMPAIGN_ID }).success).toBe(true);
  });

  it.each(['SCHEDULED', 'DELIVERED', 'OPENED', 'CLICKED', 'BOUNCES', 'UNSUBSCRIBES'])(
    'accepts status=%s',
    (status) => {
      expect(
        ListCampaignRecipientsObject.safeParse({ campaign_id: CAMPAIGN_ID, status }).success
      ).toBe(true);
    }
  );

  it('rejects an unknown status', () => {
    expect(
      ListCampaignRecipientsObject.safeParse({ campaign_id: CAMPAIGN_ID, status: 'SHRUGGED' })
        .success
    ).toBe(false);
  });

  it('rejects a page_size above 100', () => {
    expect(
      ListCampaignRecipientsObject.safeParse({ campaign_id: CAMPAIGN_ID, page_size: 101 }).success
    ).toBe(false);
  });

  it('rejects a negative page', () => {
    expect(
      ListCampaignRecipientsObject.safeParse({ campaign_id: CAMPAIGN_ID, page: -1 }).success
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// nevent_get_campaign_metrics
// ---------------------------------------------------------------------------
describe('nevent_get_campaign_metrics', () => {
  it('GETs /campaigns/{id}/metrics', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockFetchOk(MOCK_METRICS));
    const server = await setupTools(fetchMock as unknown as typeof fetch);

    await server.invoke('nevent_get_campaign_metrics', { campaign_id: CAMPAIGN_ID });

    const url = requestedUrl(fetchMock);
    expect(url.pathname).toBe(`/campaigns/${CAMPAIGN_ID}/metrics`);
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe('GET');
  });

  it('sends the bearer token from the DataClient', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockFetchOk(MOCK_METRICS));
    const server = await setupTools(fetchMock as unknown as typeof fetch);

    await server.invoke('nevent_get_campaign_metrics', { campaign_id: CAMPAIGN_ID });

    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-jwt');
  });

  it('url-encodes the campaign id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockFetchOk(MOCK_METRICS));
    const server = await setupTools(fetchMock as unknown as typeof fetch);

    await server.invoke('nevent_get_campaign_metrics', { campaign_id: 'a/b c' });

    expect(String(fetchMock.mock.calls[0]![0])).toContain('/campaigns/a%2Fb%20c/metrics');
  });

  it('returns the full metrics envelope including conversion counters', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockFetchOk(MOCK_METRICS));
    const server = await setupTools(fetchMock as unknown as typeof fetch);

    const result = await server.invoke('nevent_get_campaign_metrics', { campaign_id: CAMPAIGN_ID });
    const parsed = parseToolResult(result);

    expect(parsed['uniqueOpens']).toBe(5400);
    expect(parsed['openRate']).toBe(44.23);
    expect(parsed['revenue']).toBe(4320.5);
  });

  it('surfaces a 404 as a structured not_found error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockFetchOk({ message: 'nope' }, 404));
    const server = await setupTools(fetchMock as unknown as typeof fetch);

    const result = await server.invoke('nevent_get_campaign_metrics', { campaign_id: CAMPAIGN_ID });

    expect((result as { isError?: boolean }).isError).toBe(true);
    const error = parseToolResult(result)['error'] as Record<string, unknown>;
    expect(error['code']).toBe('campaign_not_found');
  });

  it('surfaces a 403 as a forbidden error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockFetchOk({ message: 'denied' }, 403));
    const server = await setupTools(fetchMock as unknown as typeof fetch);

    const result = await server.invoke('nevent_get_campaign_metrics', { campaign_id: CAMPAIGN_ID });
    const error = parseToolResult(result)['error'] as Record<string, unknown>;

    expect(error['code']).toBe('forbidden');
  });
});

// ---------------------------------------------------------------------------
// nevent_list_campaign_recipients
// ---------------------------------------------------------------------------
describe('nevent_list_campaign_recipients', () => {
  it('GETs /campaigns/{id}/recipients', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockFetchOk(MOCK_RECIPIENTS));
    const server = await setupTools(fetchMock as unknown as typeof fetch);

    await server.invoke('nevent_list_campaign_recipients', { campaign_id: CAMPAIGN_ID });

    expect(requestedUrl(fetchMock).pathname).toBe(`/campaigns/${CAMPAIGN_ID}/recipients`);
  });

  it('maps status, search and pagination to backend query params', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockFetchOk(MOCK_RECIPIENTS));
    const server = await setupTools(fetchMock as unknown as typeof fetch);

    await server.invoke('nevent_list_campaign_recipients', {
      campaign_id: CAMPAIGN_ID,
      status: 'CLICKED',
      search: 'ada',
      page: 1,
      page_size: 50,
    });

    const url = requestedUrl(fetchMock);
    expect(url.searchParams.get('status')).toBe('CLICKED');
    expect(url.searchParams.get('search')).toBe('ada');
    expect(url.searchParams.get('page')).toBe('1');
    // nev-api names the page-size param `size`, not `pageSize`.
    expect(url.searchParams.get('size')).toBe('50');
  });

  it('forwards the segment filter as segmentId', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockFetchOk(MOCK_RECIPIENTS));
    const server = await setupTools(fetchMock as unknown as typeof fetch);

    await server.invoke('nevent_list_campaign_recipients', {
      campaign_id: CAMPAIGN_ID,
      segment_id: 'seg_42',
    });

    expect(requestedUrl(fetchMock).searchParams.get('segmentId')).toBe('seg_42');
  });

  it('sends no query params when only the campaign id is given', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockFetchOk(MOCK_RECIPIENTS));
    const server = await setupTools(fetchMock as unknown as typeof fetch);

    await server.invoke('nevent_list_campaign_recipients', { campaign_id: CAMPAIGN_ID });

    expect(requestedUrl(fetchMock).search).toBe('');
  });

  it('returns the paged recipient envelope', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockFetchOk(MOCK_RECIPIENTS));
    const server = await setupTools(fetchMock as unknown as typeof fetch);

    const result = await server.invoke('nevent_list_campaign_recipients', {
      campaign_id: CAMPAIGN_ID,
    });
    const parsed = parseToolResult(result);

    expect(parsed['totalElements']).toBe(2);
    expect(parsed['content']).toHaveLength(2);
  });

  it('surfaces a 404 as a structured not_found error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockFetchOk({ message: 'nope' }, 404));
    const server = await setupTools(fetchMock as unknown as typeof fetch);

    const result = await server.invoke('nevent_list_campaign_recipients', {
      campaign_id: CAMPAIGN_ID,
    });

    expect((result as { isError?: boolean }).isError).toBe(true);
    const error = parseToolResult(result)['error'] as Record<string, unknown>;
    expect(error['code']).toBe('campaign_not_found');
  });
});

// ---------------------------------------------------------------------------
// Operation mode
// ---------------------------------------------------------------------------
describe('campaign performance tools operation mode', () => {
  it.each(['nevent_get_campaign_metrics', 'nevent_list_campaign_recipients'])(
    '%s is a READ operation allowed in READ_ONLY mode',
    (tool) => {
      expect(isOperationAllowed(tool)).toBe(true);
    }
  );
});
