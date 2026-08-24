/**
 * Unit tests for `nevent_quote_campaign` (MCP 1.8.0).
 *
 * `POST /campaigns/quote` is a read-only pre-flight quote: it returns the credit
 * cost, available credits, shortfall, recipient count and the eligible-audience
 * estimate for a given channel + segment selection. It never debits and never
 * sends, so the tool is registered as a READ operation and must work in
 * READ_ONLY mode — that is the whole point: an agent should be able to check
 * affordability before calling `nevent_schedule_campaign`.
 *
 * Covers:
 * - Zod schema validation for QuoteCampaignSchema (channel enum, segment_ids,
 *   transactional default)
 * - HTTP request shape:
 *   - Method must be POST
 *   - URL must be `${neventApiUrl}/campaigns/quote`
 *   - Body maps snake_case params to the backend camelCase contract
 *     (`channel`, `segmentIds`, `transactional`)
 *   - Legacy channel aliases (EMAIL/SMS/WHATSAPP) are mapped to the _ONLY
 *     variants, same as nevent_create_campaign (NEV-1669)
 * - Response passthrough: the CampaignQuoteResponse envelope reaches the caller
 *   intact, including a null `audience` block
 * - 402 handling: an insufficient-credit response surfaces as a structured error
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { QuoteCampaignSchema } from '../schemas/campaign-actions.js';

const QuoteCampaignObject = z.object(QuoteCampaignSchema);

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers (mirrors src/tests/campaign-actions.test.ts)
// ---------------------------------------------------------------------------

function mockFetchOk(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

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

async function setupCampaignTools(fetchImpl: typeof fetch, activeTenantId = 'tenant-xyz') {
  const { registerCampaignActionTools } = await import('../tools/campaign-actions.js');
  const { DataClient } = await import('../clients/data-client.js');

  const dataClient = new DataClient(
    { baseUrl: 'https://data.nevent.es', jwtToken: 'test-jwt' },
    activeTenantId
  );

  const server = makeMockServer();
  registerCampaignActionTools(server as never, dataClient, 'https://api.nevent.es');

  vi.stubGlobal('fetch', fetchImpl);

  return server;
}

/** Parse the JSON text payload out of an MCP tool response. */
function parseToolResult(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

/** A realistic CampaignQuoteResponse as returned by nev-api. */
const QUOTE_RESPONSE = {
  cost: 1250.0,
  available: 5000.0,
  missing: 0.0,
  recipientCount: 1250,
  affordable: true,
  blocked: false,
  unlimited: false,
  audience: {
    uniqueAudience: 1400,
    estimatedEligible: { email: 1250, sms: 980 },
    eligibleAnyChannel: 1300,
    emailExclusions: { no_email: 90, invalid_email: 12, opt_out: 48, unknown: 0 },
    computedAt: '2026-08-24T09:00:00Z',
    dataAsOf: '2026-08-24T06:00:00Z',
  },
};

// ---------------------------------------------------------------------------
// QuoteCampaignSchema
// ---------------------------------------------------------------------------
describe('QuoteCampaignSchema', () => {
  it('accepts a channel with no segments', () => {
    const result = QuoteCampaignObject.safeParse({ channel: 'EMAIL_ONLY' });
    expect(result.success).toBe(true);
  });

  it('accepts a channel with segment ids', () => {
    const result = QuoteCampaignObject.safeParse({
      channel: 'EMAIL_AND_SMS',
      segment_ids: ['seg_1', 'seg_2'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts transactional=true', () => {
    const result = QuoteCampaignObject.safeParse({
      channel: 'EMAIL_ONLY',
      transactional: true,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a missing channel', () => {
    const result = QuoteCampaignObject.safeParse({ segment_ids: ['seg_1'] });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown channel value', () => {
    const result = QuoteCampaignObject.safeParse({ channel: 'CARRIER_PIGEON' });
    expect(result.success).toBe(false);
  });

  it('rejects more than 20 segments (backend cannot compute the audience block)', () => {
    const result = QuoteCampaignObject.safeParse({
      channel: 'EMAIL_ONLY',
      segment_ids: Array.from({ length: 21 }, (_, i) => `seg_${i}`),
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// nevent_quote_campaign — HTTP shape
// ---------------------------------------------------------------------------
describe('nevent_quote_campaign HTTP shape', () => {
  it('POSTs to /campaigns/quote', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockFetchOk(QUOTE_RESPONSE));
    const server = await setupCampaignTools(fetchMock as unknown as typeof fetch);

    await server.invoke('nevent_quote_campaign', {
      channel: 'EMAIL_ONLY',
      segment_ids: ['seg_1'],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.nevent.es/campaigns/quote');
    expect((init as RequestInit).method).toBe('POST');
  });

  it('maps segment_ids to segmentIds in the body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockFetchOk(QUOTE_RESPONSE));
    const server = await setupCampaignTools(fetchMock as unknown as typeof fetch);

    await server.invoke('nevent_quote_campaign', {
      channel: 'EMAIL_ONLY',
      segment_ids: ['seg_1', 'seg_2'],
    });

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
    expect(body['segmentIds']).toEqual(['seg_1', 'seg_2']);
  });

  it('maps the legacy EMAIL alias to EMAIL_ONLY', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockFetchOk(QUOTE_RESPONSE));
    const server = await setupCampaignTools(fetchMock as unknown as typeof fetch);

    await server.invoke('nevent_quote_campaign', { channel: 'EMAIL' });

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
    expect(body['channel']).toBe('EMAIL_ONLY');
  });

  it('sends transactional=true when requested', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockFetchOk(QUOTE_RESPONSE));
    const server = await setupCampaignTools(fetchMock as unknown as typeof fetch);

    await server.invoke('nevent_quote_campaign', {
      channel: 'EMAIL_ONLY',
      transactional: true,
    });

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
    expect(body['transactional']).toBe(true);
  });

  it('omits transactional from the body when not provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockFetchOk(QUOTE_RESPONSE));
    const server = await setupCampaignTools(fetchMock as unknown as typeof fetch);

    await server.invoke('nevent_quote_campaign', { channel: 'EMAIL_ONLY' });

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
    expect('transactional' in body).toBe(false);
  });

  it('sends the bearer token from the DataClient', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockFetchOk(QUOTE_RESPONSE));
    const server = await setupCampaignTools(fetchMock as unknown as typeof fetch);

    await server.invoke('nevent_quote_campaign', { channel: 'EMAIL_ONLY' });

    const [, init] = fetchMock.mock.calls[0]!;
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-jwt');
  });
});

// ---------------------------------------------------------------------------
// nevent_quote_campaign — response handling
// ---------------------------------------------------------------------------
describe('nevent_quote_campaign response handling', () => {
  it('returns the full quote envelope to the caller', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockFetchOk(QUOTE_RESPONSE));
    const server = await setupCampaignTools(fetchMock as unknown as typeof fetch);

    const result = await server.invoke('nevent_quote_campaign', { channel: 'EMAIL_ONLY' });
    const parsed = parseToolResult(result);

    expect(parsed['cost']).toBe(1250);
    expect(parsed['available']).toBe(5000);
    expect(parsed['affordable']).toBe(true);
    expect(parsed['recipientCount']).toBe(1250);
  });

  it('preserves the audience estimate block', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockFetchOk(QUOTE_RESPONSE));
    const server = await setupCampaignTools(fetchMock as unknown as typeof fetch);

    const result = await server.invoke('nevent_quote_campaign', { channel: 'EMAIL_ONLY' });
    const audience = parseToolResult(result)['audience'] as Record<string, unknown>;

    expect(audience['uniqueAudience']).toBe(1400);
    expect(audience['estimatedEligible']).toEqual({ email: 1250, sms: 980 });
  });

  it('passes through a null audience block without crashing', async () => {
    const withoutAudience = { ...QUOTE_RESPONSE, audience: null };
    const fetchMock = vi.fn().mockResolvedValue(mockFetchOk(withoutAudience));
    const server = await setupCampaignTools(fetchMock as unknown as typeof fetch);

    const result = await server.invoke('nevent_quote_campaign', {
      channel: 'EMAIL_AND_WHATSAPP',
    });
    const parsed = parseToolResult(result);

    expect(parsed['audience']).toBeNull();
    expect(parsed['cost']).toBe(1250);
  });

  it('surfaces a 403 as a structured authentication error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockFetchOk({ message: 'nope' }, 403));
    const server = await setupCampaignTools(fetchMock as unknown as typeof fetch);

    const result = await server.invoke('nevent_quote_campaign', { channel: 'EMAIL_ONLY' });

    expect((result as { isError?: boolean }).isError).toBe(true);
    const error = parseToolResult(result)['error'] as Record<string, unknown>;
    expect(error['code']).toBe('forbidden');
  });

  it('surfaces a 404 (campaign segments not found) as a structured error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockFetchOk({ message: 'missing' }, 404));
    const server = await setupCampaignTools(fetchMock as unknown as typeof fetch);

    const result = await server.invoke('nevent_quote_campaign', { channel: 'EMAIL_ONLY' });

    expect((result as { isError?: boolean }).isError).toBe(true);
    const error = parseToolResult(result)['error'] as Record<string, unknown>;
    expect(error['code']).toBe('api_error');
  });
});
