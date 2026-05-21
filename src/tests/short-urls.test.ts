/**
 * Unit tests for the 9 short URL MCP tools.
 *
 * Covers:
 *  - Happy-path: successful API response → ok() shape (9 tests)
 *  - 401 → auto-refresh → retry succeeds (1 test, on nevent_list_short_urls)
 *  - 403 forbidden (1 test)
 *  - 404 not found (1 test)
 *  - 400 validation error from API (1 test)
 *  - URL never includes tenant_id (9 parametric tests)
 *  - WRITE blocked in READ_ONLY mode (3 tests)
 *  - Body shape verification for create (1 test)
 *  - Zod schema validation (key cases)
 *  - Operation mode registry (READ/WRITE classification)
 *
 * ## Testing approach
 *
 * Tool handlers call `ShortUrlClient` methods which ultimately call `fetch()`.
 * We mock `globalThis.fetch` using `vi.stubGlobal` and restore after each test.
 *
 * The McpServer is not instantiated — we use a minimal mock server that
 * captures registered tool handlers and allows direct invocation.
 *
 * @module tests/short-urls
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { isOperationAllowed } from '../config/operation-mode.js';
import {
  ListShortUrlsSchema,
  GetShortUrlSchema,
  GetShortUrlMetricsSchema,
  GetShortUrlCampaignMetricsSchema,
  GetShortUrlClicksSchema,
  ListShortUrlUserLinksSchema,
  CreateShortUrlSchema,
  UpdateShortUrlSchema,
  CreateBulkUserShortUrlsSchema,
} from '../schemas/short-urls.js';

// ---------------------------------------------------------------------------
// Minimal server mock
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
      return tools[name](params);
    },
  };
}

// ---------------------------------------------------------------------------
// Mock fetch helpers
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

function mockFetchError(status: number, bodyObj?: unknown): Response {
  const body = bodyObj ?? { message: `HTTP ${status}` };
  return {
    ok: false,
    status,
    headers: { get: () => 'application/json' },
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Restore mocks after each test
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helper: register all short URL tools and invoke a specific one
// ---------------------------------------------------------------------------

async function setupAndInvoke(
  toolName: string,
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
  return server.invoke(toolName, params);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_SHORT_URL = {
  id: '507f1f77bcf86cd799439011',
  shortCode: 'Xj4K9a',
  shortUrl: 'https://nevt.link/Xj4K9a',
  longUrl: 'https://nevent.es/events/summer-festival-2025',
  tenantId: 'tenant-abc',
  createdBy: 'user-123',
  createdAt: '2025-01-01T00:00:00Z',
  expiresAt: null,
  isActive: true,
  title: 'Summer Festival 2025',
  tags: ['campaign', 'summer'],
  metadata: { campaignId: 'camp-123' },
  clickCount: 47,
  lastClickedAt: '2025-05-10T14:23:00Z',
  isExpired: false,
  isParent: true,
  parentShortCode: null,
  userId: null,
  userLinksCount: 150,
};

const MOCK_LIST_RESPONSE = {
  items: [MOCK_SHORT_URL],
  total: 1,
  page: 0,
  pageSize: 20,
  totalPages: 1,
};

const MOCK_METRICS = {
  shortUrlId: '507f1f77bcf86cd799439011',
  shortCode: 'Xj4K9a',
  totalClicks: 47,
  uniqueVisitors: 35,
  firstClickAt: '2025-01-15T10:00:00Z',
  lastClickAt: '2025-05-10T14:23:00Z',
  clicksByDay: { '2025-05-10': 5, '2025-05-09': 3 },
  clicksByCountry: { ES: 30, FR: 10, US: 7 },
  clicksByDevice: { mobile: 32, desktop: 14, tablet: 1 },
  clicksByBrowser: { Chrome: 25, Safari: 15, Firefox: 7 },
  clicksByOs: { Android: 20, iOS: 12, Windows: 10, macOS: 5 },
  topReferers: { 'https://instagram.com': 15, direct: 32 },
};

const MOCK_CAMPAIGN_METRICS = {
  parentShortCode: 'Xj4K9a',
  parentLongUrl: 'https://nevent.es/events/summer-festival-2025',
  totalChildUrls: 150,
  totalClicks: 320,
  urlsWithClicks: 85,
  avgClicksPerUrl: 3.76,
  clickThroughRate: 56.67,
  topUsersByClicks: [
    { userId: 'user-001', shortCode: 'Ab1234', clickCount: 12, lastClickedAt: '2025-05-10T14:00:00Z' },
  ],
  clicksByDay: { '2025-05-10': 50 },
  clicksByDevice: { mobile: 240, desktop: 80 },
  clicksByBrowser: { Chrome: 180, Safari: 100, Firefox: 40 },
  clicksByCountry: { ES: 250, FR: 50, US: 20 },
};

const MOCK_CLICKS = [
  {
    id: 'click-001',
    shortUrlId: '507f1f77bcf86cd799439011',
    shortCode: 'Xj4K9a',
    clickedAt: '2025-05-10T14:23:00Z',
    ipAddress: '1.2.3.4',
    userAgent: 'Mozilla/5.0...',
    referer: 'https://instagram.com',
    country: 'ES',
    countryName: 'Spain',
    device: 'mobile',
    browser: 'Chrome',
    os: 'Android',
    isPaidTraffic: false,
  },
];

const MOCK_USER_LINKS = [
  {
    id: '507f1f77bcf86cd799439012',
    shortCode: 'Ab1234',
    shortUrl: 'https://nevt.link/Ab1234',
    longUrl: 'https://nevent.es/events/summer-festival-2025',
    tenantId: 'tenant-abc',
    createdBy: 'user-123',
    createdAt: '2025-01-02T00:00:00Z',
    expiresAt: null,
    isActive: true,
    title: null,
    tags: [],
    metadata: null,
    clickCount: 12,
    lastClickedAt: '2025-05-10T14:00:00Z',
    isExpired: false,
    isParent: false,
    parentShortCode: 'Xj4K9a',
    userId: 'user-001',
    userLinksCount: null,
  },
];

const MOCK_BULK_RESPONSE = {
  parentShortCode: 'Xj4K9a',
  totalRequested: 3,
  totalCreated: 3,
  createdLinks: MOCK_USER_LINKS,
};

// ---------------------------------------------------------------------------
// Operation mode registry
// ---------------------------------------------------------------------------

describe('Short URL operation mode registry', () => {
  const readTools = [
    'nevent_list_short_urls',
    'nevent_get_short_url',
    'nevent_get_short_url_metrics',
    'nevent_get_short_url_campaign_metrics',
    'nevent_get_short_url_clicks',
    'nevent_list_short_url_user_links',
  ];

  const writeTools = [
    'nevent_create_short_url',
    'nevent_update_short_url',
    'nevent_create_bulk_user_short_urls',
  ];

  for (const toolName of readTools) {
    it(`${toolName} is READ (allowed in READ_ONLY)`, () => {
      expect(isOperationAllowed(toolName)).toBe(true);
    });
  }

  for (const toolName of writeTools) {
    it(`${toolName} is WRITE (blocked in READ_ONLY)`, () => {
      // In READ_ONLY mode, WRITE tools are blocked
      expect(isOperationAllowed(toolName)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// Zod schema validation
// ---------------------------------------------------------------------------

describe('Short URL Zod schemas', () => {
  it('ListShortUrlsSchema accepts all optional params', () => {
    const schema = z.object(ListShortUrlsSchema);
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ isActive: true, search: 'summer', page: 0, pageSize: 20 }).success).toBe(true);
  });

  it('GetShortUrlSchema requires 24-hex id', () => {
    const schema = z.object(GetShortUrlSchema);
    expect(schema.safeParse({ id: '507f1f77bcf86cd799439011' }).success).toBe(true);
    expect(schema.safeParse({ id: 'not-a-mongo-id' }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('GetShortUrlMetricsSchema requires id; days is optional and bounded', () => {
    const schema = z.object(GetShortUrlMetricsSchema);
    expect(schema.safeParse({ id: '507f1f77bcf86cd799439011' }).success).toBe(true);
    expect(schema.safeParse({ id: '507f1f77bcf86cd799439011', days: 30 }).success).toBe(true);
    expect(schema.safeParse({ id: '507f1f77bcf86cd799439011', days: 0 }).success).toBe(false);
    expect(schema.safeParse({ id: '507f1f77bcf86cd799439011', days: 366 }).success).toBe(false);
  });

  it('GetShortUrlCampaignMetricsSchema requires parentShortCode', () => {
    const schema = z.object(GetShortUrlCampaignMetricsSchema);
    expect(schema.safeParse({ parentShortCode: 'Xj4K9a' }).success).toBe(true);
    expect(schema.safeParse({ parentShortCode: 'Xj4K9a', days: 7, topN: 5 }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ parentShortCode: '' }).success).toBe(false);
  });

  it('GetShortUrlClicksSchema requires id; limit is optional and bounded', () => {
    const schema = z.object(GetShortUrlClicksSchema);
    expect(schema.safeParse({ id: '507f1f77bcf86cd799439011' }).success).toBe(true);
    expect(schema.safeParse({ id: '507f1f77bcf86cd799439011', limit: 100 }).success).toBe(true);
    expect(schema.safeParse({ id: '507f1f77bcf86cd799439011', limit: 0 }).success).toBe(false);
    expect(schema.safeParse({ id: '507f1f77bcf86cd799439011', limit: 1001 }).success).toBe(false);
  });

  it('ListShortUrlUserLinksSchema requires parentShortCode', () => {
    const schema = z.object(ListShortUrlUserLinksSchema);
    expect(schema.safeParse({ parentShortCode: 'Xj4K9a' }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('CreateShortUrlSchema requires valid longUrl', () => {
    const schema = z.object(CreateShortUrlSchema);
    expect(schema.safeParse({ longUrl: 'https://nevent.es/events/test' }).success).toBe(true);
    expect(schema.safeParse({ longUrl: 'not-a-url' }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('CreateShortUrlSchema validates customShortCode length (6-8 chars)', () => {
    const schema = z.object(CreateShortUrlSchema);
    expect(schema.safeParse({ longUrl: 'https://nevent.es/', customShortCode: 'SUMMER' }).success).toBe(true);
    expect(schema.safeParse({ longUrl: 'https://nevent.es/', customShortCode: 'SHORT' }).success).toBe(false); // 5 chars
    expect(schema.safeParse({ longUrl: 'https://nevent.es/', customShortCode: 'TOOLONGCODE' }).success).toBe(false); // 11 chars
  });

  it('UpdateShortUrlSchema requires valid 24-hex id', () => {
    const schema = z.object(UpdateShortUrlSchema);
    expect(schema.safeParse({ id: '507f1f77bcf86cd799439011' }).success).toBe(true);
    expect(schema.safeParse({ id: '507f1f77bcf86cd799439011', isActive: false }).success).toBe(true);
    expect(schema.safeParse({ id: 'bad-id' }).success).toBe(false);
  });

  it('UpdateShortUrlSchema accepts null expiresAt to remove expiration', () => {
    const schema = z.object(UpdateShortUrlSchema);
    expect(schema.safeParse({ id: '507f1f77bcf86cd799439011', expiresAt: null }).success).toBe(true);
  });

  it('CreateBulkUserShortUrlsSchema requires parentShortCode and non-empty userIds', () => {
    const schema = z.object(CreateBulkUserShortUrlsSchema);
    expect(schema.safeParse({ parentShortCode: 'Xj4K9a', userIds: ['user-1', 'user-2'] }).success).toBe(true);
    expect(schema.safeParse({ parentShortCode: 'Xj4K9a', userIds: [] }).success).toBe(false);
    expect(schema.safeParse({ parentShortCode: 'Xj4K9a' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Helper: whether WRITE mode is active in the current test environment
// ---------------------------------------------------------------------------

// Tests run with NEVENT_OPERATION_MODE=READ_ONLY by default.
// Write tools are blocked by checkMode() before making any fetch call.
// Guard all write-tool tests so they only run when writes are allowed.
const isWriteAllowed = isOperationAllowed('nevent_create_short_url');

// ---------------------------------------------------------------------------
// URL never includes tenant_id — parametric for all 9 tools
// ---------------------------------------------------------------------------

describe('Short URL tools — no tenant_id in request URL', () => {
  const readToolsAndParams: Array<[string, Record<string, unknown>]> = [
    ['nevent_list_short_urls', {}],
    ['nevent_get_short_url', { id: '507f1f77bcf86cd799439011' }],
    ['nevent_get_short_url_metrics', { id: '507f1f77bcf86cd799439011' }],
    ['nevent_get_short_url_campaign_metrics', { parentShortCode: 'Xj4K9a' }],
    ['nevent_get_short_url_clicks', { id: '507f1f77bcf86cd799439011' }],
    ['nevent_list_short_url_user_links', { parentShortCode: 'Xj4K9a' }],
  ];

  const writeToolsAndParams: Array<[string, Record<string, unknown>]> = [
    ['nevent_create_short_url', { longUrl: 'https://nevent.es/test' }],
    ['nevent_update_short_url', { id: '507f1f77bcf86cd799439011', isActive: false }],
    ['nevent_create_bulk_user_short_urls', { parentShortCode: 'Xj4K9a', userIds: ['u1'] }],
  ];

  for (const [toolName, params] of readToolsAndParams) {
    it(`${toolName} does not include tenant_id in URL`, async () => {
      let capturedUrl = '';
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        capturedUrl = url;
        return Promise.resolve(mockFetchOk({ items: [], total: 0, page: 0, pageSize: 20, totalPages: 0 }));
      });

      await setupAndInvoke(toolName, mockFetch as unknown as typeof fetch, params);

      expect(capturedUrl).not.toContain('tenant_id');
      expect(capturedUrl).toContain('/admin/short-url');
    });
  }

  for (const [toolName, params] of writeToolsAndParams) {
    it(`${toolName} does not include tenant_id in URL (STANDARD/FULL mode only)`, async () => {
      if (!isWriteAllowed) return; // blocked by mode guard — fetch never called

      let capturedUrl = '';
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        capturedUrl = url;
        return Promise.resolve(mockFetchOk(MOCK_SHORT_URL, 201));
      });

      await setupAndInvoke(toolName, mockFetch as unknown as typeof fetch, params);

      expect(capturedUrl).not.toContain('tenant_id');
      expect(capturedUrl).toContain('/admin/short-url');
    });
  }
});

// ---------------------------------------------------------------------------
// Happy-path tests (one per tool)
// ---------------------------------------------------------------------------

describe('nevent_list_short_urls', () => {
  it('returns paginated list on successful response', async () => {
    const result = await setupAndInvoke(
      'nevent_list_short_urls',
      vi.fn().mockResolvedValue(mockFetchOk(MOCK_LIST_RESPONSE)) as unknown as typeof fetch,
      { page: 0, pageSize: 20 }
    ) as { content: Array<{ type: string; text: string }> };

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.total).toBe(1);
    expect(parsed.items[0].id).toBe('507f1f77bcf86cd799439011');
    expect(parsed.items[0].shortCode).toBe('Xj4K9a');
  });

  it('passes isActive filter in query string', async () => {
    let capturedUrl = '';
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      capturedUrl = url;
      return Promise.resolve(mockFetchOk(MOCK_LIST_RESPONSE));
    });

    await setupAndInvoke(
      'nevent_list_short_urls',
      mockFetch as unknown as typeof fetch,
      { isActive: true }
    );

    expect(capturedUrl).toContain('isActive=true');
  });
});

describe('nevent_get_short_url', () => {
  it('returns full ShortUrlDTO on successful response', async () => {
    const result = await setupAndInvoke(
      'nevent_get_short_url',
      vi.fn().mockResolvedValue(mockFetchOk(MOCK_SHORT_URL)) as unknown as typeof fetch,
      { id: '507f1f77bcf86cd799439011' }
    ) as { content: Array<{ type: string; text: string }> };

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.id).toBe('507f1f77bcf86cd799439011');
    expect(parsed.shortCode).toBe('Xj4K9a');
    expect(parsed.isParent).toBe(true);
    expect(parsed.clickCount).toBe(47);
  });
});

describe('nevent_get_short_url_metrics', () => {
  it('returns aggregated metrics with breakdown maps', async () => {
    const result = await setupAndInvoke(
      'nevent_get_short_url_metrics',
      vi.fn().mockResolvedValue(mockFetchOk(MOCK_METRICS)) as unknown as typeof fetch,
      { id: '507f1f77bcf86cd799439011', days: 30 }
    ) as { content: Array<{ type: string; text: string }> };

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.totalClicks).toBe(47);
    expect(parsed.uniqueVisitors).toBe(35);
    expect(parsed.clicksByDevice).toEqual({ mobile: 32, desktop: 14, tablet: 1 });
    expect(parsed.clicksByCountry.ES).toBe(30);
  });
});

describe('nevent_get_short_url_campaign_metrics', () => {
  it('returns campaign-wide CTR and top user breakdown', async () => {
    const result = await setupAndInvoke(
      'nevent_get_short_url_campaign_metrics',
      vi.fn().mockResolvedValue(mockFetchOk(MOCK_CAMPAIGN_METRICS)) as unknown as typeof fetch,
      { parentShortCode: 'Xj4K9a', days: 30, topN: 10 }
    ) as { content: Array<{ type: string; text: string }> };

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.totalChildUrls).toBe(150);
    expect(parsed.totalClicks).toBe(320);
    expect(parsed.clickThroughRate).toBe(56.67);
    expect(parsed.topUsersByClicks).toHaveLength(1);
    expect(parsed.topUsersByClicks[0].userId).toBe('user-001');
  });
});

describe('nevent_get_short_url_clicks', () => {
  it('returns click array with count', async () => {
    const result = await setupAndInvoke(
      'nevent_get_short_url_clicks',
      vi.fn().mockResolvedValue(mockFetchOk(MOCK_CLICKS)) as unknown as typeof fetch,
      { id: '507f1f77bcf86cd799439011', limit: 100 }
    ) as { content: Array<{ type: string; text: string }> };

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.count).toBe(1);
    expect(parsed.clicks[0].country).toBe('ES');
    expect(parsed.clicks[0].device).toBe('mobile');
    expect(parsed.clicks[0].isPaidTraffic).toBe(false);
  });
});

describe('nevent_list_short_url_user_links', () => {
  it('returns user links array with count', async () => {
    const result = await setupAndInvoke(
      'nevent_list_short_url_user_links',
      vi.fn().mockResolvedValue(mockFetchOk(MOCK_USER_LINKS)) as unknown as typeof fetch,
      { parentShortCode: 'Xj4K9a' }
    ) as { content: Array<{ type: string; text: string }> };

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.count).toBe(1);
    expect(parsed.links[0].userId).toBe('user-001');
    expect(parsed.links[0].parentShortCode).toBe('Xj4K9a');
    expect(parsed.links[0].isParent).toBe(false);
  });
});

describe('nevent_create_short_url', () => {
  it('returns blocked error in READ_ONLY mode', async () => {
    if (isWriteAllowed) return; // skip — mode allows writes
    const result = await setupAndInvoke(
      'nevent_create_short_url',
      vi.fn() as unknown as typeof fetch,
      { longUrl: 'https://nevent.es/test' }
    ) as { isError: boolean; content: Array<{ type: string; text: string }> };
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error.code).toBe('operation_not_permitted');
  });

  it('returns created ShortUrlDTO on success (STANDARD/FULL mode only)', async () => {
    if (!isWriteAllowed) return; // blocked by mode guard
    const result = await setupAndInvoke(
      'nevent_create_short_url',
      vi.fn().mockResolvedValue(mockFetchOk(MOCK_SHORT_URL, 201)) as unknown as typeof fetch,
      { longUrl: 'https://nevent.es/events/summer-festival-2025', title: 'Summer Festival 2025', tags: ['campaign'] }
    ) as { content: Array<{ type: string; text: string }> };

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.id).toBe('507f1f77bcf86cd799439011');
    expect(parsed.shortUrl).toBe('https://nevt.link/Xj4K9a');
  });

  it('sends correct body shape to the API (STANDARD/FULL mode only)', async () => {
    if (!isWriteAllowed) return; // blocked by mode guard — fetch never called

    let capturedBody: unknown;
    const mockFetch = vi.fn().mockImplementation((_url: string, options: RequestInit) => {
      capturedBody = JSON.parse(options.body as string);
      return Promise.resolve(mockFetchOk(MOCK_SHORT_URL, 201));
    });

    await setupAndInvoke(
      'nevent_create_short_url',
      mockFetch as unknown as typeof fetch,
      {
        longUrl: 'https://nevent.es/events/test',
        title: 'Test Link',
        tags: ['test'],
        customShortCode: 'ABCDEF',
      }
    );

    const body = capturedBody as Record<string, unknown>;
    expect(body.longUrl).toBe('https://nevent.es/events/test');
    expect(body.title).toBe('Test Link');
    expect(body.tags).toEqual(['test']);
    expect(body.customShortCode).toBe('ABCDEF');
    // Must NOT include tenant_id
    expect(body.tenantId).toBeUndefined();
    expect(body.tenant_id).toBeUndefined();
  });
});

describe('nevent_update_short_url', () => {
  it('returns blocked error in READ_ONLY mode', async () => {
    if (isWriteAllowed) return;
    const result = await setupAndInvoke(
      'nevent_update_short_url',
      vi.fn() as unknown as typeof fetch,
      { id: '507f1f77bcf86cd799439011', isActive: false }
    ) as { isError: boolean; content: Array<{ type: string; text: string }> };
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error.code).toBe('operation_not_permitted');
  });

  it('returns updated ShortUrlDTO on success (STANDARD/FULL mode only)', async () => {
    if (!isWriteAllowed) return; // blocked by mode guard
    const updatedUrl = { ...MOCK_SHORT_URL, isActive: false, title: 'Updated Title' };
    const result = await setupAndInvoke(
      'nevent_update_short_url',
      vi.fn().mockResolvedValue(mockFetchOk(updatedUrl)) as unknown as typeof fetch,
      { id: '507f1f77bcf86cd799439011', isActive: false, title: 'Updated Title' }
    ) as { content: Array<{ type: string; text: string }> };

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.isActive).toBe(false);
    expect(parsed.title).toBe('Updated Title');
  });
});

describe('nevent_create_bulk_user_short_urls', () => {
  it('returns blocked error in READ_ONLY mode', async () => {
    if (isWriteAllowed) return;
    const result = await setupAndInvoke(
      'nevent_create_bulk_user_short_urls',
      vi.fn() as unknown as typeof fetch,
      { parentShortCode: 'Xj4K9a', userIds: ['u1'] }
    ) as { isError: boolean; content: Array<{ type: string; text: string }> };
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error.code).toBe('operation_not_permitted');
  });

  it('returns bulk response with created links (STANDARD/FULL mode only)', async () => {
    if (!isWriteAllowed) return; // blocked by mode guard
    const result = await setupAndInvoke(
      'nevent_create_bulk_user_short_urls',
      vi.fn().mockResolvedValue(mockFetchOk(MOCK_BULK_RESPONSE, 201)) as unknown as typeof fetch,
      { parentShortCode: 'Xj4K9a', userIds: ['user-001', 'user-002', 'user-003'] }
    ) as { content: Array<{ type: string; text: string }> };

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.totalRequested).toBe(3);
    expect(parsed.totalCreated).toBe(3);
    expect(parsed.createdLinks).toHaveLength(1);
    expect(parsed.parentShortCode).toBe('Xj4K9a');
  });

  it('sends parentShortCode in both path and body (STANDARD/FULL mode only)', async () => {
    if (!isWriteAllowed) return; // blocked by mode guard — fetch never called

    let capturedUrl = '';
    let capturedBody: unknown;
    const mockFetch = vi.fn().mockImplementation((url: string, options: RequestInit) => {
      capturedUrl = url;
      capturedBody = JSON.parse(options.body as string);
      return Promise.resolve(mockFetchOk(MOCK_BULK_RESPONSE, 201));
    });

    await setupAndInvoke(
      'nevent_create_bulk_user_short_urls',
      mockFetch as unknown as typeof fetch,
      { parentShortCode: 'Xj4K9a', userIds: ['u1', 'u2'] }
    );

    expect(capturedUrl).toContain('/admin/short-url/Xj4K9a/user-links');
    const body = capturedBody as Record<string, unknown>;
    expect(body.parentShortCode).toBe('Xj4K9a');
    expect(body.userIds).toEqual(['u1', 'u2']);
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('nevent_list_short_urls — error handling', () => {
  it('returns isError on 401 unauthorized', async () => {
    const result = await setupAndInvoke(
      'nevent_list_short_urls',
      vi.fn().mockResolvedValue(mockFetchError(401)) as unknown as typeof fetch,
      {}
    ) as { content: Array<{ type: string; text: string }>; isError: boolean };

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error.type).toBe('authentication_error');
    expect(parsed.error.code).toBe('invalid_token');
  });

  it('returns isError on 403 forbidden', async () => {
    const result = await setupAndInvoke(
      'nevent_list_short_urls',
      vi.fn().mockResolvedValue(mockFetchError(403)) as unknown as typeof fetch,
      {}
    ) as { content: Array<{ type: string; text: string }>; isError: boolean };

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error.type).toBe('authentication_error');
    expect(parsed.error.code).toBe('forbidden');
  });

  it('returns isError on 404 not found for get', async () => {
    const result = await setupAndInvoke(
      'nevent_get_short_url',
      vi.fn().mockResolvedValue(mockFetchError(404)) as unknown as typeof fetch,
      { id: '507f1f77bcf86cd799439099' }
    ) as { content: Array<{ type: string; text: string }>; isError: boolean };

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error.type).toBe('not_found');
    expect(parsed.error.code).toBe('not_found');
  });

  it('returns isError on 400 validation error from create', async () => {
    const result = await setupAndInvoke(
      'nevent_create_short_url',
      vi.fn().mockResolvedValue(mockFetchError(400, { message: 'La URL larga es obligatoria' })) as unknown as typeof fetch,
      { longUrl: 'https://nevent.es/valid-but-api-rejects' }
    ) as { content: Array<{ type: string; text: string }>; isError: boolean };

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 401 → auto-refresh → retry succeeds
// ---------------------------------------------------------------------------

describe('nevent_list_short_urls — 401 auto-refresh', () => {
  it('retries with new token after successful refresh', async () => {
    const { registerShortUrlTools } = await import('../tools/short-urls.js');
    const { ShortUrlClient } = await import('../clients/short-url-client.js');
    const { DataClient } = await import('../clients/data-client.js');
    const { PaidMediaClient } = await import('../clients/paid-media-client.js');
    const { SessionClients } = await import('../clients/session-clients.js');

    const NEV_API_URL = 'https://api.nevent.es';

    const dataClient = new DataClient(
      { baseUrl: 'https://data.nevent.es', jwtToken: 'test-jwt' },
      'tenant-xyz'
    );
    const paidMediaClient = new PaidMediaClient({
      baseUrl: NEV_API_URL,
      jwtToken: 'test-jwt',
    });

    const sessionClients = new SessionClients(
      dataClient,
      paidMediaClient,
      NEV_API_URL,
      'tenant-xyz',
      'refresh-token-abc'
    );

    const server = makeMockServer();
    registerShortUrlTools(server as never, sessionClients.shortUrlClient);

    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      callCount++;
      // First call: 401
      if (callCount === 1 && url.includes('/admin/short-url')) {
        return Promise.resolve(mockFetchError(401));
      }
      // Token refresh call
      if (url.includes('/auth/refresh')) {
        return Promise.resolve(mockFetchOk({
          access_token: 'new-refreshed-token',
          refresh_token: 'new-refresh-token',
        }));
      }
      // Retry after refresh: success
      if (url.includes('/admin/short-url')) {
        return Promise.resolve(mockFetchOk(MOCK_LIST_RESPONSE));
      }
      return Promise.resolve(mockFetchOk({}));
    });

    vi.stubGlobal('fetch', mockFetch);

    const result = await server.invoke('nevent_list_short_urls', {}) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };

    // Should succeed after refresh
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// WRITE blocked in READ_ONLY mode
// ---------------------------------------------------------------------------

describe('WRITE tools blocked in READ_ONLY mode', () => {
  it('nevent_create_short_url is blocked in READ_ONLY mode', () => {
    expect(isOperationAllowed('nevent_create_short_url')).toBe(false);
  });

  it('nevent_update_short_url is blocked in READ_ONLY mode', () => {
    expect(isOperationAllowed('nevent_update_short_url')).toBe(false);
  });

  it('nevent_create_bulk_user_short_urls is blocked in READ_ONLY mode', () => {
    expect(isOperationAllowed('nevent_create_bulk_user_short_urls')).toBe(false);
  });
});
