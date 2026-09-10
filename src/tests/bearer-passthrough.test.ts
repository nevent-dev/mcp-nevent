/**
 * Unit tests for `bearer-passthrough` HTTP auth mode.
 *
 * Covers:
 *  - `isToolAllowedInBearerPassthrough`: READ tools allowed, WRITE/DELETE
 *    tools denied, explicitly excluded tools denied, unknown tools denied
 *    (fail-closed).
 *  - `createNeventServer({ toolFilter })`: only the allowed subset is
 *    actually registered on the McpServer — excluded/WRITE/DELETE tools are
 *    absent from the tool registry entirely (i.e. absent from `tools/list`),
 *    not merely denied at call time.
 *  - `decodeJwtClaims`: two different tokens decode to independent claims —
 *    the building block that guarantees two bearer-passthrough sessions
 *    started with different JWTs never share a `DataClient` / tenant.
 *  - Session isolation: replaying the exact client-construction sequence
 *    `http-bearer-passthrough.ts` uses per session shows that two sessions
 *    built from different JWTs get distinct client instances scoped to
 *    distinct tenants.
 *
 * These are unit/white-box tests (no live HTTP server, no MongoDB) —
 * consistent with the rest of this suite's approach to `transports/http.ts`
 * (see `public-discovery.test.ts` / `anon-session-fixes.test.ts`), which also
 * avoids standing up a live server or a real MCP protocol handshake.
 */

import { describe, it, expect } from 'vitest';
import {
  isToolAllowedInBearerPassthrough,
  EXCLUDED_TOOLS_BEARER_PASSTHROUGH,
} from '../config/bearer-passthrough.js';
import { getToolOperationType } from '../config/operation-mode.js';
import { createNeventServer } from '../server.js';
import { DataClient } from '../clients/data-client.js';
import { PaidMediaClient } from '../clients/paid-media-client.js';
import { SessionClients } from '../clients/session-clients.js';
import { decodeJwtClaims } from '../transports/http-bearer-passthrough.js';

// ---------------------------------------------------------------------------
// isToolAllowedInBearerPassthrough
// ---------------------------------------------------------------------------

describe('isToolAllowedInBearerPassthrough', () => {
  it('allows a plain READ tool', () => {
    expect(isToolAllowedInBearerPassthrough('nevent_analytics_query')).toBe(true);
    expect(isToolAllowedInBearerPassthrough('nevent_list_segments')).toBe(true);
    expect(isToolAllowedInBearerPassthrough('nevent_list_campaigns')).toBe(true);
  });

  it('denies WRITE tools', () => {
    expect(isToolAllowedInBearerPassthrough('nevent_create_segment')).toBe(false);
    expect(isToolAllowedInBearerPassthrough('nevent_create_campaign')).toBe(false);
    expect(isToolAllowedInBearerPassthrough('nevent_upload_image')).toBe(false);
  });

  it('denies DELETE tools', () => {
    expect(isToolAllowedInBearerPassthrough('nevent_schedule_campaign')).toBe(false);
    expect(isToolAllowedInBearerPassthrough('nevent_delete_image')).toBe(false);
    expect(isToolAllowedInBearerPassthrough('nevent_reset_tenant')).toBe(false);
  });

  it('denies every explicitly excluded tool', () => {
    // Most exclusions (segment_execute, list_tenants, switch_tenant) are
    // classified READ and would otherwise be allowed — the exclusion list is
    // what blocks them. nevent_reset_tenant is excluded AND classified
    // DELETE, so it is blocked by both mechanisms independently.
    for (const excluded of EXCLUDED_TOOLS_BEARER_PASSTHROUGH) {
      expect(isToolAllowedInBearerPassthrough(excluded)).toBe(false);
    }
    expect(getToolOperationType('nevent_segment_execute')).toBe('READ');
    expect(getToolOperationType('nevent_list_tenants')).toBe('READ');
    expect(getToolOperationType('nevent_switch_tenant')).toBe('READ');
    expect(getToolOperationType('nevent_reset_tenant')).toBe('DELETE');
    expect(EXCLUDED_TOOLS_BEARER_PASSTHROUGH).toContain('nevent_segment_execute');
    expect(EXCLUDED_TOOLS_BEARER_PASSTHROUGH).toContain('nevent_list_tenants');
    expect(EXCLUDED_TOOLS_BEARER_PASSTHROUGH).toContain('nevent_switch_tenant');
    expect(EXCLUDED_TOOLS_BEARER_PASSTHROUGH).toContain('nevent_reset_tenant');
  });

  it('denies an unknown/unclassified tool (fail-closed)', () => {
    expect(isToolAllowedInBearerPassthrough('some_unknown_future_tool')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createNeventServer({ toolFilter }) — registration-time enforcement
// ---------------------------------------------------------------------------

/** Reads the SDK's internal tool registry (same technique as `getToolCount`). */
function registeredToolNames(server: ReturnType<typeof createNeventServer>): string[] {
  const internal = server as unknown as { _registeredTools: Record<string, unknown> };
  return Object.keys(internal._registeredTools);
}

describe('createNeventServer — bearer-passthrough toolFilter', () => {
  function buildFilteredServer() {
    const stubDataClient = new DataClient({ baseUrl: 'http://stub', jwtToken: 'stub' });
    const stubPaidMediaClient = new PaidMediaClient({ baseUrl: 'http://stub', jwtToken: 'stub' });
    const sessionClients = new SessionClients(stubDataClient, stubPaidMediaClient, 'http://stub');
    return createNeventServer({
      dataClient: stubDataClient,
      neventApiUrl: 'http://stub',
      paidMediaClient: stubPaidMediaClient,
      sessionClients,
      toolFilter: isToolAllowedInBearerPassthrough,
    });
  }

  it('registers only tools classified READ', () => {
    const server = buildFilteredServer();
    const names = registeredToolNames(server);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(getToolOperationType(name)).toBe('READ');
    }
  });

  it('never registers an excluded tool, even though it is classified READ', () => {
    const server = buildFilteredServer();
    const names = registeredToolNames(server);
    for (const excluded of EXCLUDED_TOOLS_BEARER_PASSTHROUGH) {
      expect(names).not.toContain(excluded);
    }
  });

  it('never registers a WRITE or DELETE tool (absent from tools/list, not merely denied at call time)', () => {
    const server = buildFilteredServer();
    const names = registeredToolNames(server);
    expect(names).not.toContain('nevent_create_segment');
    expect(names).not.toContain('nevent_update_segment');
    expect(names).not.toContain('nevent_create_campaign');
    expect(names).not.toContain('nevent_schedule_campaign');
    expect(names).not.toContain('nevent_upload_image');
    expect(names).not.toContain('nevent_delete_image');
  });

  it('still registers ordinary READ tools', () => {
    const server = buildFilteredServer();
    const names = registeredToolNames(server);
    expect(names).toContain('nevent_analytics_query');
    expect(names).toContain('nevent_list_segments');
    expect(names).toContain('nevent_get_segment');
  });

  it('without a toolFilter, the excluded/WRITE tools ARE registered (regression guard: filter is opt-in)', () => {
    const stubDataClient = new DataClient({ baseUrl: 'http://stub', jwtToken: 'stub' });
    const stubPaidMediaClient = new PaidMediaClient({ baseUrl: 'http://stub', jwtToken: 'stub' });
    const sessionClients = new SessionClients(stubDataClient, stubPaidMediaClient, 'http://stub');
    const server = createNeventServer({
      dataClient: stubDataClient,
      neventApiUrl: 'http://stub',
      paidMediaClient: stubPaidMediaClient,
      sessionClients,
      // no toolFilter — OAuth / stdio behaviour, unchanged.
    });
    const names = registeredToolNames(server);
    expect(names).toContain('nevent_create_segment');
    expect(names).toContain('nevent_list_tenants');
    expect(names).toContain('nevent_reset_tenant');
  });
});

// ---------------------------------------------------------------------------
// decodeJwtClaims
// ---------------------------------------------------------------------------

/** Builds an unsigned (alg=none) JWT-shaped string carrying the given payload. */
function makeFakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.`;
}

describe('decodeJwtClaims', () => {
  it('extracts sub and tenantId from a well-formed token', () => {
    const token = makeFakeJwt({ sub: 'user-1', tenantId: 'tenant-1' });
    expect(decodeJwtClaims(token)).toEqual({ sub: 'user-1', tenantId: 'tenant-1' });
  });

  it('falls back to activeTenantId when tenantId is absent', () => {
    const token = makeFakeJwt({ sub: 'user-1', activeTenantId: 'tenant-2' });
    expect(decodeJwtClaims(token)).toEqual({ sub: 'user-1', tenantId: 'tenant-2' });
  });

  it('two distinct tokens decode to two distinct, independent claim sets', () => {
    const tokenA = makeFakeJwt({ sub: 'promoter-a', tenantId: 'tenant-a' });
    const tokenB = makeFakeJwt({ sub: 'promoter-b', tenantId: 'tenant-b' });

    const claimsA = decodeJwtClaims(tokenA);
    const claimsB = decodeJwtClaims(tokenB);

    expect(claimsA).toEqual({ sub: 'promoter-a', tenantId: 'tenant-a' });
    expect(claimsB).toEqual({ sub: 'promoter-b', tenantId: 'tenant-b' });
    expect(claimsA).not.toEqual(claimsB);
  });

  it('returns an empty object for a malformed token instead of throwing', () => {
    expect(decodeJwtClaims('not-a-jwt')).toEqual({});
    expect(decodeJwtClaims('')).toEqual({});
    expect(() => decodeJwtClaims('not.valid-base64url!!!.sig')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Session isolation — two JWTs never share a client or tenant
//
// This replays the exact per-session client-construction sequence used in
// `createBearerPassthroughApp`'s POST / initialize handler (see
// `src/transports/http-bearer-passthrough.ts`), without needing a live HTTP
// server or a real MCP protocol handshake.
// ---------------------------------------------------------------------------

describe('bearer-passthrough session isolation', () => {
  it('two sessions built from different JWTs get distinct clients scoped to distinct tenants', () => {
    const jwtA = makeFakeJwt({ sub: 'promoter-a', tenantId: 'tenant-a' });
    const jwtB = makeFakeJwt({ sub: 'promoter-b', tenantId: 'tenant-b' });

    function buildSession(jwt: string) {
      const { tenantId } = decodeJwtClaims(jwt);
      const dataClient = new DataClient({ baseUrl: 'https://data.nevent.es', jwtToken: jwt }, tenantId);
      const paidMediaClient = new PaidMediaClient({ baseUrl: 'https://api.nevent.es', jwtToken: jwt });
      const sessionClients = new SessionClients(dataClient, paidMediaClient, 'https://api.nevent.es', tenantId);
      return { dataClient, paidMediaClient, sessionClients };
    }

    const sessionA = buildSession(jwtA);
    const sessionB = buildSession(jwtB);

    // Distinct instances — no shared client object between sessions.
    expect(sessionA.dataClient).not.toBe(sessionB.dataClient);
    expect(sessionA.paidMediaClient).not.toBe(sessionB.paidMediaClient);
    expect(sessionA.sessionClients).not.toBe(sessionB.sessionClients);
    expect(sessionA.sessionClients.dataClient).not.toBe(sessionB.sessionClients.dataClient);

    // Distinct tenant scoping — derived independently from each JWT.
    expect(sessionA.dataClient.activeTenantId).toBe('tenant-a');
    expect(sessionB.dataClient.activeTenantId).toBe('tenant-b');
    expect(sessionA.dataClient.activeTenantId).not.toBe(sessionB.dataClient.activeTenantId);

    // Distinct bearer tokens — each client only ever holds its own JWT.
    expect(sessionA.dataClient.getJwtToken()).toBe(jwtA);
    expect(sessionB.dataClient.getJwtToken()).toBe(jwtB);
    expect(sessionA.dataClient.getJwtToken()).not.toBe(sessionB.dataClient.getJwtToken());

    // Rotating one session's token (e.g. an internal token refresh) must
    // never affect the other session.
    sessionA.sessionClients.rotateJwt('rotated-token-a');
    expect(sessionA.dataClient.getJwtToken()).toBe('rotated-token-a');
    expect(sessionB.dataClient.getJwtToken()).toBe(jwtB);
  });
});
