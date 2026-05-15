/**
 * Unit tests for the 11 paid media MCP tools.
 *
 * Covers:
 *  - Happy-path: successful API response → ok() shape
 *  - Feature gate: 404 from gated endpoint → feature_gate_not_enrolled error
 *  - Generic errors: network errors, 403, 500
 *  - Schema validation: provider enum, required fields, date format
 *  - Operation mode: all tools are READ (allowed in READ_ONLY)
 *
 * ## Testing approach
 *
 * Tool handlers call `PaidMediaClient` methods which ultimately call `fetch()`.
 * We mock `globalThis.fetch` using `vi.stubGlobal` and restore after each test.
 *
 * The McpServer is not instantiated — we use a minimal mock server that
 * captures registered tool handlers and allows direct invocation.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { isOperationAllowed } from '../config/operation-mode.js';
import {
  AdsStatusSchema,
  AdsHealthSchema,
  ListPaidCampaignsSchema,
  GetPaidCampaignInsightsSchema,
  AdsAttributionSchema,
  ListPaidAdGroupsSchema,
  GetPaidAdGroupInsightsSchema,
  GetPaidAdGroupComparativeStatsSchema,
  GetPaidAdGroupTargetingSchema,
  ListPaidAdsSchema,
  GetPaidAdCreativeSchema,
} from '../schemas/paid-media.js';

// ---------------------------------------------------------------------------
// Minimal server mock
// ---------------------------------------------------------------------------

type ToolHandler = (params: Record<string, unknown>) => Promise<unknown>;

/**
 * Factory for a minimal McpServer-shaped object that captures tool registrations.
 */
function makeMockServer() {
  const tools: Record<string, ToolHandler> = {};
  return {
    tool(name: string, _description: string, _schema: unknown, annotationsOrHandler: unknown, maybeHandler?: ToolHandler) {
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
// Helper: register and invoke a single paid media tool
// ---------------------------------------------------------------------------

async function setupAndInvoke(
  toolName: string,
  fetchImpl: typeof fetch,
  params: Record<string, unknown> = {}
) {
  const { registerPaidMediaTools } = await import('../tools/paid-media.js');
  const { PaidMediaClient } = await import('../clients/paid-media-client.js');

  const client = new PaidMediaClient({
    baseUrl: 'https://api.nevent.es',
    jwtToken: 'test-jwt',
  });

  const server = makeMockServer();
  registerPaidMediaTools(server as never, client);
  vi.stubGlobal('fetch', fetchImpl);
  return server.invoke(toolName, params);
}

// ---------------------------------------------------------------------------
// Operation mode registry
// ---------------------------------------------------------------------------

describe('Paid media operation mode registry', () => {
  const readTools = [
    'nevent_paid_ads_status',
    'nevent_paid_ads_health',
    'nevent_list_paid_campaigns',
    'nevent_get_paid_campaign_insights',
    'nevent_paid_attribution',
    'nevent_list_paid_ad_groups',
    'nevent_get_paid_ad_group_insights',
    'nevent_get_paid_ad_group_comparative_stats',
    'nevent_get_paid_ad_group_targeting',
    'nevent_list_paid_ads',
    'nevent_get_paid_ad_creative',
  ];

  for (const toolName of readTools) {
    it(`${toolName} is READ (allowed in READ_ONLY)`, () => {
      expect(isOperationAllowed(toolName)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Schema validation tests
// ---------------------------------------------------------------------------

describe('Paid media Zod schemas', () => {
  it('AdsStatusSchema accepts valid provider', () => {
    const schema = z.object(AdsStatusSchema);
    expect(schema.safeParse({ provider: 'meta' }).success).toBe(true);
    expect(schema.safeParse({ provider: 'google' }).success).toBe(true);
    expect(schema.safeParse({ provider: 'tiktok' }).success).toBe(true);
  });

  it('AdsStatusSchema rejects invalid provider', () => {
    const schema = z.object(AdsStatusSchema);
    expect(schema.safeParse({ provider: 'linkedin' }).success).toBe(false);
    expect(schema.safeParse({ provider: 'twitter' }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('AdsHealthSchema accepts all valid providers', () => {
    const schema = z.object(AdsHealthSchema);
    for (const provider of ['meta', 'google', 'tiktok']) {
      expect(schema.safeParse({ provider }).success).toBe(true);
    }
  });

  it('GetPaidCampaignInsightsSchema requires provider and campaignId', () => {
    const schema = z.object(GetPaidCampaignInsightsSchema);
    // Valid
    expect(schema.safeParse({ provider: 'meta', campaignId: 'camp_123' }).success).toBe(true);
    // With optional dates
    expect(schema.safeParse({
      provider: 'meta',
      campaignId: 'camp_123',
      from: '2024-01-01',
      to: '2024-01-31',
    }).success).toBe(true);
    // Missing campaignId
    expect(schema.safeParse({ provider: 'meta' }).success).toBe(false);
    // Empty campaignId
    expect(schema.safeParse({ provider: 'meta', campaignId: '' }).success).toBe(false);
    // Invalid date format
    expect(schema.safeParse({ provider: 'meta', campaignId: 'c1', from: '2024/01/01' }).success).toBe(false);
    expect(schema.safeParse({ provider: 'meta', campaignId: 'c1', from: '01-01-2024' }).success).toBe(false);
  });

  it('GetPaidCampaignInsightsSchema accepts valid yyyy-MM-dd date strings', () => {
    const schema = z.object(GetPaidCampaignInsightsSchema);
    expect(schema.safeParse({
      provider: 'google',
      campaignId: 'c1',
      from: '2024-01-01',
      to: '2024-12-31',
    }).success).toBe(true);
  });

  it('ListPaidAdGroupsSchema makes campaignId optional', () => {
    const schema = z.object(ListPaidAdGroupsSchema);
    // Without campaignId
    expect(schema.safeParse({ provider: 'tiktok' }).success).toBe(true);
    // With campaignId
    expect(schema.safeParse({ provider: 'tiktok', campaignId: 'c123' }).success).toBe(true);
    // Empty campaignId rejected
    expect(schema.safeParse({ provider: 'tiktok', campaignId: '' }).success).toBe(false);
  });

  it('ListPaidAdsSchema makes both filters optional', () => {
    const schema = z.object(ListPaidAdsSchema);
    expect(schema.safeParse({ provider: 'meta' }).success).toBe(true);
    expect(schema.safeParse({ provider: 'meta', campaignId: 'c1' }).success).toBe(true);
    expect(schema.safeParse({ provider: 'meta', adGroupId: 'ag1' }).success).toBe(true);
    expect(schema.safeParse({ provider: 'meta', campaignId: 'c1', adGroupId: 'ag1' }).success).toBe(true);
  });

  it('GetPaidAdCreativeSchema requires adId', () => {
    const schema = z.object(GetPaidAdCreativeSchema);
    expect(schema.safeParse({ provider: 'meta', adId: 'ad_123' }).success).toBe(true);
    expect(schema.safeParse({ provider: 'meta' }).success).toBe(false);
    expect(schema.safeParse({ provider: 'meta', adId: '' }).success).toBe(false);
  });

  it('GetPaidAdGroupComparativeStatsSchema requires adGroupId', () => {
    const schema = z.object(GetPaidAdGroupComparativeStatsSchema);
    expect(schema.safeParse({ provider: 'meta', adGroupId: 'ag1' }).success).toBe(true);
    expect(schema.safeParse({ provider: 'meta' }).success).toBe(false);
  });

  it('GetPaidAdGroupTargetingSchema requires adGroupId', () => {
    const schema = z.object(GetPaidAdGroupTargetingSchema);
    expect(schema.safeParse({ provider: 'meta', adGroupId: 'ag1' }).success).toBe(true);
    expect(schema.safeParse({ provider: 'meta' }).success).toBe(false);
  });

  it('AdsAttributionSchema only requires provider', () => {
    const schema = z.object(AdsAttributionSchema);
    expect(schema.safeParse({ provider: 'meta' }).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// nevent_paid_ads_status
// ---------------------------------------------------------------------------

describe('nevent_paid_ads_status', () => {
  it('returns connection status on successful API response', async () => {
    const mockStatus = {
      connected: true,
      provider: 'meta',
      accountId: 'act_123456',
      accountName: 'Nevent Meta Account',
      lastSyncAt: '2026-05-15T10:00:00Z',
    };

    const result = await setupAndInvoke(
      'nevent_paid_ads_status',
      vi.fn().mockResolvedValue(mockFetchOk(mockStatus)) as unknown as typeof fetch,
      { provider: 'meta' }
    ) as { content: Array<{ type: string; text: string }> };

    expect(result.content).toHaveLength(1);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.connected).toBe(true);
    expect(parsed.provider).toBe('meta');
    expect(parsed.accountId).toBe('act_123456');
  });

  it('returns isError:true on 401 unauthorized', async () => {
    const result = await setupAndInvoke(
      'nevent_paid_ads_status',
      vi.fn().mockResolvedValue(mockFetchError(401)) as unknown as typeof fetch,
      { provider: 'meta' }
    ) as { content: Array<{ type: string; text: string }>; isError: boolean };

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error.type).toBe('authentication_error');
    expect(parsed.error.code).toBe('invalid_token');
  });

  it('returns isError:true on 403 forbidden', async () => {
    const result = await setupAndInvoke(
      'nevent_paid_ads_status',
      vi.fn().mockResolvedValue(mockFetchError(403)) as unknown as typeof fetch,
      { provider: 'google' }
    ) as { content: Array<{ type: string; text: string }>; isError: boolean };

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error.type).toBe('authentication_error');
    expect(parsed.error.code).toBe('forbidden');
  });

  it('returns isError:true on network error', async () => {
    const result = await setupAndInvoke(
      'nevent_paid_ads_status',
      vi.fn().mockRejectedValue(new Error('Network failure')) as unknown as typeof fetch,
      { provider: 'tiktok' }
    ) as { content: Array<{ type: string; text: string }>; isError: boolean };

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error.code).toBe('network_error');
  });
});

// ---------------------------------------------------------------------------
// nevent_paid_ads_health (feature gate 404 test)
// ---------------------------------------------------------------------------

describe('nevent_paid_ads_health', () => {
  it('returns health response on successful API response', async () => {
    const mockHealth = {
      provider: 'meta',
      tenantId: 'tenant_abc',
      lastSuccessfulSyncAt: '2026-05-15T08:00:00Z',
      lastSuccessfulInsightsAt: '2026-05-15T08:00:00Z',
      throttle: { isThrottled: false, nextAttemptAt: null, reason: null, lastAccountUtilPct: 45, consecutiveHits: 0 },
      featureGate: { isInsightsEnabled: true, isInTenantAllowlist: true },
      tier: 'STANDARD',
      backfillEnabled: true,
    };

    const result = await setupAndInvoke(
      'nevent_paid_ads_health',
      vi.fn().mockResolvedValue(mockFetchOk(mockHealth)) as unknown as typeof fetch,
      { provider: 'meta' }
    ) as { content: Array<{ type: string; text: string }> };

    expect(result.content).toHaveLength(1);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.provider).toBe('meta');
    expect(parsed.featureGate.isInTenantAllowlist).toBe(true);
    expect(parsed.throttle.isThrottled).toBe(false);
  });

  it('returns feature_gate_not_enrolled error on 404', async () => {
    const result = await setupAndInvoke(
      'nevent_paid_ads_health',
      vi.fn().mockResolvedValue(mockFetchError(404)) as unknown as typeof fetch,
      { provider: 'meta' }
    ) as { content: Array<{ type: string; text: string }>; isError: boolean };

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error.code).toBe('feature_gate_not_enrolled');
    expect(parsed.error.message).toContain('meta');
    expect(parsed.error.message).toContain('pilot');
  });

  it('returns feature_gate_not_enrolled with provider name in message', async () => {
    const result = await setupAndInvoke(
      'nevent_paid_ads_health',
      vi.fn().mockResolvedValue(mockFetchError(404)) as unknown as typeof fetch,
      { provider: 'google' }
    ) as { content: Array<{ type: string; text: string }>; isError: boolean };

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error.message).toContain('google');
  });
});

// ---------------------------------------------------------------------------
// nevent_list_paid_campaigns
// ---------------------------------------------------------------------------

describe('nevent_list_paid_campaigns', () => {
  it('returns campaigns with count on successful API response', async () => {
    const mockCampaigns = [
      {
        id: 'camp_1',
        provider: 'meta',
        name: 'Nevent Summer Campaign',
        status: 'ACTIVE',
        objective: 'CONVERSIONS',
        budget: { amount: 5000, currency: 'EUR' },
        budgetType: 'DAILY',
        lastSyncedAt: '2026-05-15T09:00:00Z',
      },
      {
        id: 'camp_2',
        provider: 'meta',
        name: 'Spring Retargeting',
        status: 'PAUSED',
        objective: 'REACH',
        budget: { amount: 2000, currency: 'EUR' },
        budgetType: 'LIFETIME',
        lastSyncedAt: '2026-05-14T18:00:00Z',
      },
    ];

    const result = await setupAndInvoke(
      'nevent_list_paid_campaigns',
      vi.fn().mockResolvedValue(mockFetchOk(mockCampaigns)) as unknown as typeof fetch,
      { provider: 'meta' }
    ) as { content: Array<{ type: string; text: string }> };

    expect(result.content).toHaveLength(1);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.count).toBe(2);
    expect(parsed.campaigns).toHaveLength(2);
    expect(parsed.campaigns[0].id).toBe('camp_1');
    expect(parsed.campaigns[0].name).toBe('Nevent Summer Campaign');
  });

  it('returns empty list with count=0 when no campaigns', async () => {
    const result = await setupAndInvoke(
      'nevent_list_paid_campaigns',
      vi.fn().mockResolvedValue(mockFetchOk([])) as unknown as typeof fetch,
      { provider: 'tiktok' }
    ) as { content: Array<{ type: string; text: string }> };

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.count).toBe(0);
    expect(parsed.campaigns).toEqual([]);
  });

  it('returns isError:true on 500 error', async () => {
    const result = await setupAndInvoke(
      'nevent_list_paid_campaigns',
      vi.fn().mockResolvedValue(mockFetchError(500)) as unknown as typeof fetch,
      { provider: 'google' }
    ) as { content: Array<{ type: string; text: string }>; isError: boolean };

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error.type).toBe('api_error');
  });
});

// ---------------------------------------------------------------------------
// nevent_get_paid_campaign_insights (feature gate 404 test)
// ---------------------------------------------------------------------------

describe('nevent_get_paid_campaign_insights', () => {
  it('returns insights rows with count on successful API response', async () => {
    const mockRows = [
      {
        entityId: 'camp_1',
        providerId: 'meta_camp_id',
        level: 'CAMPAIGN',
        date: '2026-05-10T00:00:00Z',
        spend: 123.45,
        currency: 'EUR',
        impressions: 5000,
        reach: 4200,
        frequency: 1.19,
        clicks: 210,
        ctr: 0.042,
        cpm: 24.69,
        cpc: 0.588,
        results: 15,
        costPerResult: 8.23,
        pixelRoas: 3.2,
        hookRate: null,
        engagementCount: 80,
        engagementRate: 1.6,
        video3sViews: null,
        videoThruPlay: null,
        videoP25Pct: null,
        videoP50Pct: null,
        videoP75Pct: null,
        videoP100Pct: null,
      },
    ];

    const result = await setupAndInvoke(
      'nevent_get_paid_campaign_insights',
      vi.fn().mockResolvedValue(mockFetchOk(mockRows)) as unknown as typeof fetch,
      { provider: 'meta', campaignId: 'camp_1' }
    ) as { content: Array<{ type: string; text: string }> };

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.count).toBe(1);
    expect(parsed.rows[0].entityId).toBe('camp_1');
    expect(parsed.rows[0].spend).toBe(123.45);
    expect(parsed.rows[0].ctr).toBe(0.042);
  });

  it('passes from and to as query params when provided', async () => {
    let capturedUrl = '';
    const fetchSpy = vi.fn().mockImplementation((url: string) => {
      capturedUrl = url;
      return Promise.resolve(mockFetchOk([]));
    });

    await setupAndInvoke(
      'nevent_get_paid_campaign_insights',
      fetchSpy as unknown as typeof fetch,
      { provider: 'meta', campaignId: 'camp_1', from: '2024-01-01', to: '2024-01-31' }
    );

    expect(capturedUrl).toContain('from=2024-01-01');
    expect(capturedUrl).toContain('to=2024-01-31');
  });

  it('does not pass from/to params when omitted', async () => {
    let capturedUrl = '';
    const fetchSpy = vi.fn().mockImplementation((url: string) => {
      capturedUrl = url;
      return Promise.resolve(mockFetchOk([]));
    });

    await setupAndInvoke(
      'nevent_get_paid_campaign_insights',
      fetchSpy as unknown as typeof fetch,
      { provider: 'meta', campaignId: 'camp_1' }
    );

    expect(capturedUrl).not.toContain('from=');
    expect(capturedUrl).not.toContain('to=');
  });

  it('returns feature_gate_not_enrolled error on 404', async () => {
    const result = await setupAndInvoke(
      'nevent_get_paid_campaign_insights',
      vi.fn().mockResolvedValue(mockFetchError(404)) as unknown as typeof fetch,
      { provider: 'tiktok', campaignId: 'camp_1' }
    ) as { content: Array<{ type: string; text: string }>; isError: boolean };

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error.code).toBe('feature_gate_not_enrolled');
    expect(parsed.error.message).toContain('tiktok');
  });
});

// ---------------------------------------------------------------------------
// nevent_paid_attribution
// ---------------------------------------------------------------------------

describe('nevent_paid_attribution', () => {
  it('returns attribution list with count on success', async () => {
    const mockAttribution = [
      {
        campaignId: 'camp_1',
        provider: 'meta',
        campaignName: 'Summer Tickets Campaign',
        status: 'ACTIVE',
        utmCampaigns: ['summer_2026', 'summer_tickets'],
        ticketsSold: 142,
        revenue: 8520,
        budget: { amount: 3000, currency: 'EUR' },
        budgetType: 'DAILY',
      },
    ];

    const result = await setupAndInvoke(
      'nevent_paid_attribution',
      vi.fn().mockResolvedValue(mockFetchOk(mockAttribution)) as unknown as typeof fetch,
      { provider: 'meta' }
    ) as { content: Array<{ type: string; text: string }> };

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.count).toBe(1);
    expect(parsed.attribution[0].ticketsSold).toBe(142);
    expect(parsed.attribution[0].revenue).toBe(8520);
    expect(parsed.attribution[0].utmCampaigns).toContain('summer_2026');
  });
});

// ---------------------------------------------------------------------------
// nevent_list_paid_ad_groups
// ---------------------------------------------------------------------------

describe('nevent_list_paid_ad_groups', () => {
  it('returns ad groups with count on success', async () => {
    const mockAdGroups = [
      {
        id: 'ag_1',
        provider: 'meta',
        campaignId: 'camp_1',
        name: 'Retargeting - Website Visitors',
        status: 'ACTIVE',
        lastSyncedAt: '2026-05-15T09:00:00Z',
      },
    ];

    const result = await setupAndInvoke(
      'nevent_list_paid_ad_groups',
      vi.fn().mockResolvedValue(mockFetchOk(mockAdGroups)) as unknown as typeof fetch,
      { provider: 'meta' }
    ) as { content: Array<{ type: string; text: string }> };

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.count).toBe(1);
    expect(parsed.adGroups[0].id).toBe('ag_1');
  });

  it('passes campaignId as query param when provided', async () => {
    let capturedUrl = '';
    const fetchSpy = vi.fn().mockImplementation((url: string) => {
      capturedUrl = url;
      return Promise.resolve(mockFetchOk([]));
    });

    await setupAndInvoke(
      'nevent_list_paid_ad_groups',
      fetchSpy as unknown as typeof fetch,
      { provider: 'meta', campaignId: 'camp_xyz' }
    );

    expect(capturedUrl).toContain('campaignId=camp_xyz');
  });

  it('does not pass campaignId when omitted', async () => {
    let capturedUrl = '';
    const fetchSpy = vi.fn().mockImplementation((url: string) => {
      capturedUrl = url;
      return Promise.resolve(mockFetchOk([]));
    });

    await setupAndInvoke(
      'nevent_list_paid_ad_groups',
      fetchSpy as unknown as typeof fetch,
      { provider: 'meta' }
    );

    expect(capturedUrl).not.toContain('campaignId');
  });
});

// ---------------------------------------------------------------------------
// nevent_get_paid_ad_group_insights (feature gate 404 test)
// ---------------------------------------------------------------------------

describe('nevent_get_paid_ad_group_insights', () => {
  it('returns insights rows on success', async () => {
    const mockRows = [
      {
        entityId: 'ag_1',
        providerId: 'meta_ag_id',
        level: 'ADSET',
        date: '2026-05-10T00:00:00Z',
        spend: 45.0,
        currency: 'EUR',
        impressions: 2000,
        reach: 1800,
        clicks: 88,
        ctr: 0.044,
        cpm: 22.5,
        cpc: 0.511,
        results: 6,
        costPerResult: 7.5,
        pixelRoas: 2.8,
        hookRate: null,
        engagementCount: 32,
        engagementRate: 1.6,
        frequency: 1.11,
        video3sViews: null,
        videoThruPlay: null,
        videoP25Pct: null,
        videoP50Pct: null,
        videoP75Pct: null,
        videoP100Pct: null,
      },
    ];

    const result = await setupAndInvoke(
      'nevent_get_paid_ad_group_insights',
      vi.fn().mockResolvedValue(mockFetchOk(mockRows)) as unknown as typeof fetch,
      { provider: 'meta', adGroupId: 'ag_1' }
    ) as { content: Array<{ type: string; text: string }> };

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.count).toBe(1);
    expect(parsed.rows[0].level).toBe('ADSET');
  });

  it('returns feature_gate_not_enrolled error on 404', async () => {
    const result = await setupAndInvoke(
      'nevent_get_paid_ad_group_insights',
      vi.fn().mockResolvedValue(mockFetchError(404)) as unknown as typeof fetch,
      { provider: 'google', adGroupId: 'ag_1' }
    ) as { content: Array<{ type: string; text: string }>; isError: boolean };

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error.code).toBe('feature_gate_not_enrolled');
    expect(parsed.error.message).toContain('google');
  });
});

// ---------------------------------------------------------------------------
// nevent_get_paid_ad_group_comparative_stats (feature gate 404 test)
// ---------------------------------------------------------------------------

describe('nevent_get_paid_ad_group_comparative_stats', () => {
  it('returns comparative stats on success', async () => {
    const mockStats = {
      adGroupId: 'ag_1',
      campaignId: 'camp_1',
      siblingsInCampaign: 2,
      costPerResult: { value: 7.5, campaignMean: 9.2, ratioVsMean: 0.815 },
      cpm: { value: 22.5, campaignMean: 25.0, ratioVsMean: 0.9 },
      frequency: { value: 1.11, campaignMean: 1.25, ratioVsMean: 0.888 },
      ctr: { value: 0.044, campaignMean: 0.038, ratioVsMean: 1.158 },
    };

    const result = await setupAndInvoke(
      'nevent_get_paid_ad_group_comparative_stats',
      vi.fn().mockResolvedValue(mockFetchOk(mockStats)) as unknown as typeof fetch,
      { provider: 'meta', adGroupId: 'ag_1' }
    ) as { content: Array<{ type: string; text: string }> };

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.adGroupId).toBe('ag_1');
    expect(parsed.siblingsInCampaign).toBe(2);
    expect(parsed.costPerResult.ratioVsMean).toBe(0.815);
  });

  it('returns feature_gate_not_enrolled error on 404', async () => {
    const result = await setupAndInvoke(
      'nevent_get_paid_ad_group_comparative_stats',
      vi.fn().mockResolvedValue(mockFetchError(404)) as unknown as typeof fetch,
      { provider: 'meta', adGroupId: 'ag_1' }
    ) as { content: Array<{ type: string; text: string }>; isError: boolean };

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error.code).toBe('feature_gate_not_enrolled');
  });
});

// ---------------------------------------------------------------------------
// nevent_get_paid_ad_group_targeting (feature gate 404 test)
// ---------------------------------------------------------------------------

describe('nevent_get_paid_ad_group_targeting', () => {
  it('returns targeting detail on success', async () => {
    const mockTargeting = {
      adSetId: 'ag_1',
      ageRange: '25-54',
      genders: 'ALL',
      geoSummary: {
        countries: ['ES', 'PT'],
        cities: [],
        regions: [],
        zips: [],
        places: [],
        locationTypes: ['home'],
      },
      topInterests: [{ id: 'i1', name: 'Events' }, { id: 'i2', name: 'Music' }],
      totalInterests: 5,
      topBehaviors: [],
      totalBehaviors: 0,
      placements: ['facebook', 'instagram'],
      automaticPlacements: false,
      advantagePlus: {
        advantageAudience: false,
        expandAge: false,
        expandGender: false,
        expandGeo: false,
      },
      customAudiences: [],
      excludedCustomAudiences: [],
      bidStrategy: 'LOWEST_COST_WITHOUT_CAP',
      promotedObject: { pixelId: 'px_123', pageId: null, customEventType: 'PURCHASE' },
      targetingSyncedAt: '2026-05-15T08:00:00Z',
    };

    const result = await setupAndInvoke(
      'nevent_get_paid_ad_group_targeting',
      vi.fn().mockResolvedValue(mockFetchOk(mockTargeting)) as unknown as typeof fetch,
      { provider: 'meta', adGroupId: 'ag_1' }
    ) as { content: Array<{ type: string; text: string }> };

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.adSetId).toBe('ag_1');
    expect(parsed.ageRange).toBe('25-54');
    expect(parsed.topInterests).toHaveLength(2);
    expect(parsed.geoSummary.countries).toContain('ES');
  });

  it('returns feature_gate_not_enrolled error on 404', async () => {
    const result = await setupAndInvoke(
      'nevent_get_paid_ad_group_targeting',
      vi.fn().mockResolvedValue(mockFetchError(404)) as unknown as typeof fetch,
      { provider: 'tiktok', adGroupId: 'ag_1' }
    ) as { content: Array<{ type: string; text: string }>; isError: boolean };

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error.code).toBe('feature_gate_not_enrolled');
    expect(parsed.error.message).toContain('tiktok');
  });
});

// ---------------------------------------------------------------------------
// nevent_list_paid_ads
// ---------------------------------------------------------------------------

describe('nevent_list_paid_ads', () => {
  it('returns ads with count on success', async () => {
    const mockAds = [
      {
        id: 'ad_1',
        provider: 'meta',
        campaignId: 'camp_1',
        adGroupId: 'ag_1',
        name: 'Ad variant A',
        status: 'ACTIVE',
        utmSource: 'facebook',
        utmMedium: 'cpc',
        utmCampaign: 'summer_2026',
        utmContainsMacros: true,
        lastSyncedAt: '2026-05-15T09:00:00Z',
      },
    ];

    const result = await setupAndInvoke(
      'nevent_list_paid_ads',
      vi.fn().mockResolvedValue(mockFetchOk(mockAds)) as unknown as typeof fetch,
      { provider: 'meta' }
    ) as { content: Array<{ type: string; text: string }> };

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.count).toBe(1);
    expect(parsed.ads[0].utmSource).toBe('facebook');
    expect(parsed.ads[0].utmContainsMacros).toBe(true);
  });

  it('passes campaignId and adGroupId as query params when provided', async () => {
    let capturedUrl = '';
    const fetchSpy = vi.fn().mockImplementation((url: string) => {
      capturedUrl = url;
      return Promise.resolve(mockFetchOk([]));
    });

    await setupAndInvoke(
      'nevent_list_paid_ads',
      fetchSpy as unknown as typeof fetch,
      { provider: 'meta', campaignId: 'c1', adGroupId: 'ag1' }
    );

    expect(capturedUrl).toContain('campaignId=c1');
    expect(capturedUrl).toContain('adGroupId=ag1');
  });
});

// ---------------------------------------------------------------------------
// nevent_get_paid_ad_creative (feature gate 404 test)
// ---------------------------------------------------------------------------

describe('nevent_get_paid_ad_creative', () => {
  it('returns creative detail on success', async () => {
    const mockCreative = {
      adId: 'ad_1',
      body: 'Tickets now available for Primavera Sound 2026!',
      title: 'Primavera Sound 2026',
      description: 'Early bird tickets on sale',
      callToAction: 'SHOP_NOW',
      clickUrl: 'https://nevent.es/events/ps2026',
      utmSource: 'facebook',
      utmMedium: 'cpc',
      utmCampaign: 'ps2026_launch',
      imageUrl: 'https://s3.amazonaws.com/... (pre-signed, TTL 1h)',
      videoUrl: null,
      videoThumbnailUrl: null,
      videoThumbnailHdUrl: null,
      previewShareableLink: 'https://fb.com/ads/preview/...',
      hasDca: false,
      dca: null,
    };

    const result = await setupAndInvoke(
      'nevent_get_paid_ad_creative',
      vi.fn().mockResolvedValue(mockFetchOk(mockCreative)) as unknown as typeof fetch,
      { provider: 'meta', adId: 'ad_1' }
    ) as { content: Array<{ type: string; text: string }> };

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.adId).toBe('ad_1');
    expect(parsed.body).toContain('Primavera Sound');
    expect(parsed.hasDca).toBe(false);
    expect(parsed.dca).toBeNull();
  });

  it('returns feature_gate_not_enrolled error on 404', async () => {
    const result = await setupAndInvoke(
      'nevent_get_paid_ad_creative',
      vi.fn().mockResolvedValue(mockFetchError(404)) as unknown as typeof fetch,
      { provider: 'meta', adId: 'ad_1' }
    ) as { content: Array<{ type: string; text: string }>; isError: boolean };

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error.code).toBe('feature_gate_not_enrolled');
    expect(parsed.error.message).toContain('meta');
    expect(parsed.error.message).toContain('pilot');
  });

  it('returns isError:true on 500 error (not feature gate)', async () => {
    const result = await setupAndInvoke(
      'nevent_get_paid_ad_creative',
      vi.fn().mockResolvedValue(mockFetchError(500)) as unknown as typeof fetch,
      { provider: 'meta', adId: 'ad_1' }
    ) as { content: Array<{ type: string; text: string }>; isError: boolean };

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error.type).toBe('api_error');
    // Crucially, NOT a feature gate error
    expect(parsed.error.code).not.toBe('feature_gate_not_enrolled');
  });
});

// ---------------------------------------------------------------------------
// GET /api/ads/{provider}/... URL construction (no tenant_id param)
// ---------------------------------------------------------------------------

describe('URL construction — no tenant_id param', () => {
  it('nevent_paid_ads_status does not include tenant_id in URL', async () => {
    let capturedUrl = '';
    const fetchSpy = vi.fn().mockImplementation((url: string) => {
      capturedUrl = url;
      return Promise.resolve(mockFetchOk({}));
    });

    await setupAndInvoke(
      'nevent_paid_ads_status',
      fetchSpy as unknown as typeof fetch,
      { provider: 'meta' }
    );

    expect(capturedUrl).not.toContain('tenant_id');
  });

  it('nevent_list_paid_campaigns URL includes provider in path', async () => {
    let capturedUrl = '';
    const fetchSpy = vi.fn().mockImplementation((url: string) => {
      capturedUrl = url;
      return Promise.resolve(mockFetchOk([]));
    });

    await setupAndInvoke(
      'nevent_list_paid_campaigns',
      fetchSpy as unknown as typeof fetch,
      { provider: 'tiktok' }
    );

    expect(capturedUrl).toContain('/api/ads/tiktok/campaigns');
    expect(capturedUrl).not.toContain('tenant_id');
  });

  it('nevent_get_paid_campaign_insights URL encodes campaignId in path', async () => {
    let capturedUrl = '';
    const fetchSpy = vi.fn().mockImplementation((url: string) => {
      capturedUrl = url;
      return Promise.resolve(mockFetchOk([]));
    });

    await setupAndInvoke(
      'nevent_get_paid_campaign_insights',
      fetchSpy as unknown as typeof fetch,
      { provider: 'google', campaignId: 'campaign/with spaces' }
    );

    // The campaignId should be URL-encoded in the path
    expect(capturedUrl).not.toContain('campaign/with spaces');
    expect(capturedUrl).not.toContain('tenant_id');
  });
});
