/**
 * Unit tests for `nevent_list_short_url_destinations` (MCP 1.8.0).
 *
 * `GET /admin/short-url/destinations` groups short links by their canonical
 * destination URL instead of listing one row per document. Campaign parents
 * that point at the same destination collapse into a single row with aggregated
 * click and campaign counts, and — unlike `GET /admin/short-url` — the listing
 * INCLUDES system-managed assistant links (read-only).
 *
 * Covers:
 * - Zod schema validation for ListShortUrlDestinationsSchema (origin enum,
 *   pagination bounds)
 * - Request shape:
 *   - Path is /admin/short-url/destinations
 *   - origin / search / page / pageSize forwarded as query params
 *   - Params omitted entirely when not provided (backend defaults apply)
 *   - tenant_id is never sent (tenant comes from the JWT)
 * - Response passthrough of the grouped rows, including members[] and readOnly
 * - 403 surfaces as a structured error
 * - Operation mode: registered as READ (available in READ_ONLY mode)
 *
 * @module tests/short-url-destinations
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { isOperationAllowed } from '../config/operation-mode.js';
import { ListShortUrlDestinationsSchema } from '../schemas/short-urls.js';

const ListDestinationsObject = z.object(ListShortUrlDestinationsSchema);

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

async function setupAndInvoke(
  fetchImpl: typeof fetch,
  params: Record<string, unknown> = {}
) {
  const { registerShortUrlTools } = await import('../tools/short-urls.js');
  const { ShortUrlClient } = await import('../clients/short-url-client.js');

  const client = new ShortUrlClient({
    baseUrl: 'https://api.nevent.es',
    jwtToken: 'test-jwt',
  });

  const server = makeMockServer();
  registerShortUrlTools(server as never, client);
  vi.stubGlobal('fetch', fetchImpl);
  return server.invoke('nevent_list_short_url_destinations', params);
}

function parseToolResult(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

/** Requested URL of the Nth fetch call, as a URL object. */
function requestedUrl(fetchMock: ReturnType<typeof vi.fn>, call = 0): URL {
  return new URL(String(fetchMock.mock.calls[call]![0]));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_DESTINATION_RESPONSE = {
  items: [
    {
      destinationKey: 'campaign-dest:v1:9f2a1c',
      displayUrl: 'https://nevent.es/events/summer-festival-2026',
      title: 'Summer Festival 2026',
      origin: 'CAMPAIGN',
      canonicalShortCode: 'Xj4K9a',
      canonicalId: '507f1f77bcf86cd799439011',
      totalClicks: 1843,
      linksCount: 4,
      campaignsCount: 3,
      lastClickAt: '2026-08-20T18:41:00Z',
      memberShortCodes: ['Xj4K9a', 'Bq7L2m'],
      members: [
        { id: '507f1f77bcf86cd799439011', shortCode: 'Xj4K9a' },
        { id: '507f1f77bcf86cd799439012', shortCode: 'Bq7L2m' },
      ],
      readOnly: true,
    },
  ],
  total: 1,
  page: 0,
  pageSize: 20,
  totalPages: 1,
};

// ---------------------------------------------------------------------------
// ListShortUrlDestinationsSchema
// ---------------------------------------------------------------------------
describe('ListShortUrlDestinationsSchema', () => {
  it('accepts an empty object (all params optional)', () => {
    expect(ListDestinationsObject.safeParse({}).success).toBe(true);
  });

  it.each(['ALL', 'MANUAL', 'CAMPAIGN', 'ASSISTANT'])('accepts origin=%s', (origin) => {
    expect(ListDestinationsObject.safeParse({ origin }).success).toBe(true);
  });

  it('rejects an unknown origin', () => {
    expect(ListDestinationsObject.safeParse({ origin: 'ROBOT' }).success).toBe(false);
  });

  it('rejects a negative page', () => {
    expect(ListDestinationsObject.safeParse({ page: -1 }).success).toBe(false);
  });

  it('rejects a pageSize above 100', () => {
    expect(ListDestinationsObject.safeParse({ pageSize: 101 }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Request shape
// ---------------------------------------------------------------------------
describe('nevent_list_short_url_destinations request shape', () => {
  it('calls GET /admin/short-url/destinations', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockFetchOk(MOCK_DESTINATION_RESPONSE));
    await setupAndInvoke(fetchMock as unknown as typeof fetch);

    const url = requestedUrl(fetchMock);
    expect(url.pathname).toBe('/admin/short-url/destinations');
    const init = fetchMock.mock.calls[0]![1] as RequestInit | undefined;
    expect(init?.method ?? 'GET').toBe('GET');
  });

  it('forwards origin, search, page and pageSize as query params', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockFetchOk(MOCK_DESTINATION_RESPONSE));
    await setupAndInvoke(fetchMock as unknown as typeof fetch, {
      origin: 'CAMPAIGN',
      search: 'festival',
      page: 2,
      pageSize: 50,
    });

    const url = requestedUrl(fetchMock);
    expect(url.searchParams.get('origin')).toBe('CAMPAIGN');
    expect(url.searchParams.get('search')).toBe('festival');
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('pageSize')).toBe('50');
  });

  it('sends no query params when none are provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockFetchOk(MOCK_DESTINATION_RESPONSE));
    await setupAndInvoke(fetchMock as unknown as typeof fetch);

    expect(requestedUrl(fetchMock).search).toBe('');
  });

  it('never sends tenant_id (tenant is resolved from the JWT)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockFetchOk(MOCK_DESTINATION_RESPONSE));
    await setupAndInvoke(fetchMock as unknown as typeof fetch, { origin: 'ALL' });

    expect(String(fetchMock.mock.calls[0]![0])).not.toContain('tenant_id');
  });
});

// ---------------------------------------------------------------------------
// Response handling
// ---------------------------------------------------------------------------
describe('nevent_list_short_url_destinations response handling', () => {
  it('returns the paginated group envelope', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockFetchOk(MOCK_DESTINATION_RESPONSE));
    const result = await setupAndInvoke(fetchMock as unknown as typeof fetch);
    const parsed = parseToolResult(result);

    expect(parsed['total']).toBe(1);
    expect(parsed['totalPages']).toBe(1);
    expect(Array.isArray(parsed['items'])).toBe(true);
  });

  it('preserves the aggregated counters and members of a group', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockFetchOk(MOCK_DESTINATION_RESPONSE));
    const result = await setupAndInvoke(fetchMock as unknown as typeof fetch);
    const items = parseToolResult(result)['items'] as Array<Record<string, unknown>>;
    const row = items[0]!;

    expect(row['totalClicks']).toBe(1843);
    expect(row['linksCount']).toBe(4);
    expect(row['campaignsCount']).toBe(3);
    expect(row['readOnly']).toBe(true);
    expect(row['members']).toHaveLength(2);
  });

  it('surfaces a 403 as an error result', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockFetchOk({ message: 'denied' }, 403));
    const result = await setupAndInvoke(fetchMock as unknown as typeof fetch);

    expect((result as { isError?: boolean }).isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Operation mode
// ---------------------------------------------------------------------------
describe('nevent_list_short_url_destinations operation mode', () => {
  it('is a READ operation, allowed in READ_ONLY mode', () => {
    expect(isOperationAllowed('nevent_list_short_url_destinations')).toBe(true);
  });
});
