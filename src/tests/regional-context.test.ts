/**
 * Unit tests for `nevent_get_regional_settings` (`src/tools/regional-context.ts`, nevent-work#279 L8).
 *
 * The tool is read only and scoped to the session's own organization: no input, the tenant comes from the session
 * JWT, and the output carries only the four effective values (no other organization's id or name).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { isOperationAllowed } from '../config/operation-mode.js';
import { registerRegionalContextTools, toRegionalSettings } from '../tools/regional-context.js';

type ToolHandler = (params: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

function makeMockServer() {
  const tools: Record<string, { schema: unknown; annotations: unknown; handler: ToolHandler }> = {};
  return {
    tool(name: string, _description: string, schema: unknown, annotations: unknown, handler: ToolHandler) {
      tools[name] = { schema, annotations, handler };
    },
    get: (name: string) => tools[name],
    invoke: (name: string, params: Record<string, unknown> = {}) => tools[name].handler(params),
  };
}

function makeSessionClients(activeTenantId: string | undefined) {
  return {
    dataClient: { getJwtToken: () => 'session-jwt', activeTenantId },
  } as unknown as import('../clients/session-clients.js').SessionClients;
}

/** nev-api's RegionalContextView, with the parts the tool must not pass on. */
const view = (flagEnabled: boolean) => ({
  tenantId: 'tenant-mx',
  own: { operatingCountry: 'MX', timeZone: null, reportingCurrency: null, communicationLanguage: null },
  effective: {
    operatingCountry: { value: 'MX', source: 'OWN', fromTenantId: null, fromTenantName: null, discarded: null },
    timeZone: { value: 'America/Mexico_City', source: 'MARKET_DEFAULT', fromTenantId: null, fromTenantName: null, discarded: null },
    reportingCurrency: { value: 'MXN', source: 'INHERITED', fromTenantId: 'parent-1', fromTenantName: 'Parent Group', discarded: null },
    communicationLanguage: { value: 'es', source: 'PLATFORM_DEFAULT', fromTenantId: null, fromTenantName: null, discarded: null },
  },
  flagEnabled,
  market: { country: 'MX' },
  eligibleMarkets: [],
  scheduledCampaigns: [{ campaignId: 'c1', name: 'Presale', scheduledTimeUtc: '2026-11-05T10:00:00' }],
  affectedDescendants: [{ tenantId: 'child-1', name: 'Child Brand', inheritedFields: ['TIME_ZONE'] }],
  catalogVersion: 3,
  sendingWindow: null,
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('nevent_get_regional_settings', () => {
  it('is READ, read-only and takes no input', () => {
    expect(isOperationAllowed('nevent_get_regional_settings')).toBe(true);
    const server = makeMockServer();
    registerRegionalContextTools(server as never, makeSessionClients('tenant-mx'), 'https://api.example');
    const tool = server.get('nevent_get_regional_settings');
    expect(tool.schema).toEqual({});
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });

  it("reads the session's own organization with the session token, whatever the input says", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(json(view(true)));
    vi.stubGlobal('fetch', fetchSpy);
    const server = makeMockServer();
    registerRegionalContextTools(server as never, makeSessionClients('tenant-mx'), 'https://api.example');

    await server.invoke('nevent_get_regional_settings', { tenant_id: 'someone-else' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example/tenants/tenant-mx/regional-context');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer session-jwt');
  });

  it('returns the four effective values and whether they are in use, and nothing about other organizations', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(view(true))));
    const server = makeMockServer();
    registerRegionalContextTools(server as never, makeSessionClients('tenant-mx'), 'https://api.example');

    const result = await server.invoke('nevent_get_regional_settings');

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({
      tenant_id: 'tenant-mx',
      in_use: true,
      reporting_currency: { value: 'MXN', source: 'INHERITED' },
      time_zone: { value: 'America/Mexico_City', source: 'MARKET_DEFAULT' },
      operating_country: { value: 'MX', source: 'OWN' },
      communication_language: { value: 'es', source: 'PLATFORM_DEFAULT' },
    });
    expect(result.content[0].text).not.toMatch(/Parent Group|parent-1|Child Brand|child-1|Presale/);
  });

  it('says in_use false while the organization has not adopted them', () => {
    expect(toRegionalSettings(view(false)).in_use).toBe(false);
  });

  it('fills a missing field as UNSET', () => {
    const settings = toRegionalSettings({ tenantId: 't', flagEnabled: true, effective: { timeZone: null } });
    expect(settings.time_zone).toEqual({ value: null, source: 'UNSET' });
    expect(settings.reporting_currency).toEqual({ value: null, source: 'UNSET' });
  });

  it('a role without access gets forbidden', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ message: 'no' }, 403)));
    const server = makeMockServer();
    registerRegionalContextTools(server as never, makeSessionClients('tenant-mx'), 'https://api.example');

    const result = await server.invoke('nevent_get_regional_settings');

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error.code).toBe('forbidden');
  });

  it('a session without an organization fails without calling nev-api', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const server = makeMockServer();
    registerRegionalContextTools(server as never, makeSessionClients(undefined), 'https://api.example');

    const result = await server.invoke('nevent_get_regional_settings');

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error.code).toBe('no_active_tenant');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
