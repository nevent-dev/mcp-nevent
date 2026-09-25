/**
 * mcp-nevent follows nev-data-api's analytics contract (nevent-work #74):
 *  - POST /analytics/campaign-report takes { year, month } (monthly report of the tenant);
 *  - analytics BOOLEAN filters use eq/neq with true/false (is_true/is_false are
 *    segmentation operators and /analytics/query rejects them);
 *  - segmentation time_range units are plural (days, weeks, months, years).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { DataClient } from '../clients/data-client.js';
import { CampaignReportSchema, FilterSchema } from '../schemas/analytics.js';
import { NEVENT_MCP_INSTRUCTIONS } from '../server-instructions.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('campaign report contract', () => {
  it('sends { year, month } to POST /analytics/campaign-report', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ Q1: [], errors: [] }),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const client = new DataClient({ baseUrl: 'https://data.nevent.es', jwtToken: 'test-jwt' });
    await client.getCampaignReport(2026, 8);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://data.nevent.es/analytics/campaign-report');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ year: 2026, month: 8 });
  });

  it('the tool schema requires an integer year and a month 1-12', () => {
    const schema = z.object(CampaignReportSchema);
    expect(schema.safeParse({ year: 2026, month: 8 }).success).toBe(true);
    expect(schema.safeParse({ year: 2026, month: 13 }).success).toBe(false);
    expect(schema.safeParse({ campaignId: 'c1' }).success).toBe(false);
  });
});

describe('analytics BOOLEAN rule', () => {
  it('the server instructions ask for eq with true/false, not is_true/is_false', () => {
    expect(NEVENT_MCP_INSTRUCTIONS).not.toMatch(/BOOLEAN fields: use operator "is_true"/);
    expect(NEVENT_MCP_INSTRUCTIONS).toMatch(/BOOLEAN fields: use operator "eq"/);
  });

  it('the analytics filter operator list is the one nev-data-api validates', () => {
    const description = FilterSchema.shape.operator.description ?? '';
    expect(description).not.toMatch(/is_true|is_false|array_contains|\blike\b/);
    expect(description).toMatch(/\bnin\b/);
  });
});
