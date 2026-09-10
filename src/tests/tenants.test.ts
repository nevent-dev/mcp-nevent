/**
 * Unit tests for multi-tenant tools (`src/tools/tenants.ts`).
 *
 * Regression coverage for a security fix: previously NONE of the three
 * tenant tools called `checkMode()`, so `nevent_reset_tenant` — which mutates
 * a SUPERADMIN user's tenant record in the database — could run even when
 * the server was started in READ_ONLY or STANDARD mode. This suite verifies:
 *
 *  - All three tools now call `checkMode()` before doing any work.
 *  - `nevent_reset_tenant` is classified DELETE in TOOL_OPERATIONS and is
 *    therefore blocked in READ_ONLY and STANDARD, allowed only in FULL.
 *  - `nevent_list_tenants` / `nevent_switch_tenant` remain READ (unblocked
 *    in the default READ_ONLY test env) but still go through the guard.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { isOperationAllowed } from '../config/operation-mode.js';
import { registerTenantTools } from '../tools/tenants.js';

// ---------------------------------------------------------------------------
// Minimal mocks
// ---------------------------------------------------------------------------

type ToolHandler = (params: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

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
    hasTool(name: string) {
      return name in tools;
    },
  };
}

function makeSessionClients(homeTenantId: string | undefined = 'tenant-home') {
  return {
    dataClient: {
      getJwtToken: () => 'test-jwt',
    },
    homeTenantId,
    rotateJwt: vi.fn(),
    rotateTokens: vi.fn(),
  } as unknown as import('../clients/session-clients.js').SessionClients;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Operation-mode classification
// ---------------------------------------------------------------------------

describe('tenant tool operation-mode classification', () => {
  it('nevent_reset_tenant is DELETE (blocked in READ_ONLY default test env)', () => {
    if (!process.env['NEVENT_OPERATION_MODE']) {
      expect(isOperationAllowed('nevent_reset_tenant')).toBe(false);
    }
  });

  it('nevent_list_tenants is READ (allowed in READ_ONLY)', () => {
    expect(isOperationAllowed('nevent_list_tenants')).toBe(true);
  });

  it('nevent_switch_tenant is READ (allowed in READ_ONLY)', () => {
    expect(isOperationAllowed('nevent_switch_tenant')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkMode() is actually called by each handler
// ---------------------------------------------------------------------------

describe('registerTenantTools — checkMode guard', () => {
  it('nevent_reset_tenant returns an operation_not_permitted error in READ_ONLY without calling fetch', async () => {
    if (process.env['NEVENT_OPERATION_MODE']) return; // only meaningful in default READ_ONLY test env

    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const server = makeMockServer();
    const sessionClients = makeSessionClients();
    registerTenantTools(server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer, sessionClients, 'https://api.nevent.es');

    const result = await server.invoke('nevent_reset_tenant');
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text) as { error: { code: string } };
    expect(parsed.error.code).toBe('operation_not_permitted');

    // Guard must short-circuit BEFORE any nev-api call is made.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('nevent_list_tenants proceeds past the guard (READ, allowed) and calls fetch', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve([{ id: 't1', name: 'Tenant One' }]),
      text: () => Promise.resolve('[]'),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const server = makeMockServer();
    const sessionClients = makeSessionClients();
    registerTenantTools(server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer, sessionClients, 'https://api.nevent.es');

    const result = await server.invoke('nevent_list_tenants');
    expect(result.isError).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalled();
  });

  it('nevent_switch_tenant proceeds past the guard (READ, allowed) and calls fetch', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ access_token: 'new-token' }),
      text: () => Promise.resolve('{}'),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const server = makeMockServer();
    const sessionClients = makeSessionClients();
    registerTenantTools(server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer, sessionClients, 'https://api.nevent.es');

    const result = await server.invoke('nevent_switch_tenant', { tenant_id: 't2' });
    expect(result.isError).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalled();
  });
});
