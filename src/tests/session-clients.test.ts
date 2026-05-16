/**
 * Unit tests for SessionClients.
 *
 * Tests cover:
 *  - rotateJwt updates both DataClient and PaidMediaClient jwtTokens
 *  - rotateJwt calls clearAllCaches on DataClient
 *  - rotateJwt updates activeTenantId from JWT claim
 *  - rotateTokens updates refreshToken
 *  - refreshAccessToken calls /auth/refresh and rotates tokens
 *  - refreshAccessToken returns null when no refreshToken stored
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { SessionClients } from '../clients/session-clients.js';
import { DataClient } from '../clients/data-client.js';
import { PaidMediaClient } from '../clients/paid-media-client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDataClient(jwtToken = 'initial-jwt', tenantId?: string): DataClient {
  return new DataClient(
    { baseUrl: 'https://data.nevent.es', jwtToken },
    tenantId
  );
}

function makePaidMediaClient(jwtToken = 'initial-jwt'): PaidMediaClient {
  return new PaidMediaClient({ baseUrl: 'https://api.nevent.es', jwtToken });
}

/**
 * Build a minimal JWT string with the given payload (no signature verification).
 * Uses base64url encoding as expected by our in-memory decoder.
 */
function fakeJwt(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `header.${encoded}.sig`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SessionClients', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('rotateJwt', () => {
    it('updates jwtToken on both clients', () => {
      const dc = makeDataClient('old-jwt');
      const pmc = makePaidMediaClient('old-jwt');
      const sc = new SessionClients(dc, pmc, 'https://api.nevent.es', 'tenant_home');

      const newJwt = fakeJwt({ sub: 'user1', tenantId: 'tenant_new' });
      sc.rotateJwt(newJwt);

      expect((dc as unknown as { jwtToken: string }).jwtToken).toBe(newJwt);
      expect((pmc as unknown as { jwtToken: string }).jwtToken).toBe(newJwt);
    });

    it('calls clearAllCaches on DataClient', () => {
      const dc = makeDataClient('old-jwt');
      const pmc = makePaidMediaClient('old-jwt');
      const sc = new SessionClients(dc, pmc, 'https://api.nevent.es');
      const spy = vi.spyOn(dc, 'clearAllCaches');

      sc.rotateJwt(fakeJwt({ tenantId: 'tenant_xyz' }));

      expect(spy).toHaveBeenCalledOnce();
    });

    it('updates activeTenantId from JWT tenantId claim', () => {
      const dc = makeDataClient('old-jwt', 'tenant_home');
      const pmc = makePaidMediaClient('old-jwt');
      const sc = new SessionClients(dc, pmc, 'https://api.nevent.es');

      sc.rotateJwt(fakeJwt({ tenantId: 'tenant_new' }));

      expect(dc.activeTenantId).toBe('tenant_new');
    });

    it('preserves activeTenantId if JWT has no tenantId claim', () => {
      const dc = makeDataClient('old-jwt', 'tenant_home');
      const pmc = makePaidMediaClient('old-jwt');
      const sc = new SessionClients(dc, pmc, 'https://api.nevent.es');

      // JWT with no tenantId claim
      sc.rotateJwt(fakeJwt({ sub: 'user1' }));

      // Should remain unchanged since no tenantId in new JWT
      expect(dc.activeTenantId).toBe('tenant_home');
    });
  });

  describe('rotateTokens', () => {
    it('updates access token and stores refresh token', () => {
      const dc = makeDataClient('old-jwt');
      const pmc = makePaidMediaClient('old-jwt');
      const sc = new SessionClients(dc, pmc, 'https://api.nevent.es');

      const newAccess = fakeJwt({ tenantId: 'tenant_A' });
      sc.rotateTokens(newAccess, 'new-refresh-token');

      expect((dc as unknown as { jwtToken: string }).jwtToken).toBe(newAccess);
      // refreshToken is private — verify via subsequent refreshAccessToken behavior
      // (covered in refreshAccessToken tests below)
    });
  });

  describe('refreshAccessToken', () => {
    it('returns null when no refresh token stored', async () => {
      const dc = makeDataClient();
      const pmc = makePaidMediaClient();
      const sc = new SessionClients(dc, pmc, 'https://api.nevent.es');

      const result = await sc.refreshAccessToken();
      expect(result).toBeNull();
    });

    it('calls /auth/refresh and rotates tokens on success', async () => {
      const dc = makeDataClient('old-jwt', 'tenant_home');
      const pmc = makePaidMediaClient('old-jwt');
      const sc = new SessionClients(dc, pmc, 'https://api.nevent.es', 'tenant_home');

      const newAccess = fakeJwt({ tenantId: 'tenant_home' });
      const newRefresh = 'refreshed-token-v2';

      // Seed a refresh token via rotateTokens
      sc.rotateTokens(fakeJwt({ tenantId: 'tenant_home' }), 'initial-refresh-token');

      // Mock fetch to simulate successful /auth/refresh response
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: newAccess,
          refresh_token: newRefresh,
        }),
      } as unknown as Response);
      vi.stubGlobal('fetch', mockFetch);

      const result = await sc.refreshAccessToken();

      expect(result).toBe(newAccess);
      expect((dc as unknown as { jwtToken: string }).jwtToken).toBe(newAccess);
      expect((pmc as unknown as { jwtToken: string }).jwtToken).toBe(newAccess);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.nevent.es/auth/refresh',
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('returns null on non-ok HTTP response', async () => {
      const dc = makeDataClient();
      const pmc = makePaidMediaClient();
      const sc = new SessionClients(dc, pmc, 'https://api.nevent.es');
      sc.rotateTokens(fakeJwt({}), 'a-refresh-token');

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
      } as unknown as Response));

      const result = await sc.refreshAccessToken();
      expect(result).toBeNull();
    });

    it('returns null on network error', async () => {
      const dc = makeDataClient();
      const pmc = makePaidMediaClient();
      const sc = new SessionClients(dc, pmc, 'https://api.nevent.es');
      sc.rotateTokens(fakeJwt({}), 'a-refresh-token');

      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network failure')));

      const result = await sc.refreshAccessToken();
      expect(result).toBeNull();
    });
  });

  describe('homeTenantId', () => {
    it('is preserved across JWT rotations', () => {
      const dc = makeDataClient('old-jwt', 'tenant_home');
      const pmc = makePaidMediaClient('old-jwt');
      const sc = new SessionClients(dc, pmc, 'https://api.nevent.es', 'tenant_home');

      sc.rotateJwt(fakeJwt({ tenantId: 'tenant_other' }));

      // homeTenantId should never change
      expect(sc.homeTenantId).toBe('tenant_home');
      // activeTenantId on dataClient changes
      expect(dc.activeTenantId).toBe('tenant_other');
    });
  });

  // ---------------------------------------------------------------------------
  // W2 — auto-refresh on 401 via onUnauthorized callback
  // ---------------------------------------------------------------------------

  describe('auto-refresh on 401 (onUnauthorized wiring)', () => {
    /**
     * Build a mock Response that looks like a fetch Response with the given
     * status and optional JSON body.
     */
    function mockResponse(status: number, body?: unknown): Response {
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => (body !== undefined ? 'application/json' : null) },
        json: async () => body,
        text: async () => '',
      } as unknown as Response;
    }

    it('retries request with new token when 401 + refresh succeeds', async () => {
      const dc = makeDataClient('old-jwt', 'tenant_home');
      const pmc = makePaidMediaClient('old-jwt');
      const newAccess = fakeJwt({ tenantId: 'tenant_home' });

      // Seed a refresh token so refreshAccessToken() can proceed
      const sc = new SessionClients(dc, pmc, 'https://api.nevent.es', 'tenant_home', 'rt-initial');

      // fetch: first call → 401, second call (token refresh) → 200 with new token,
      // third call (retry of original) → 200 with data
      const mockFetch = vi.fn()
        // First: original request → 401
        .mockResolvedValueOnce(mockResponse(401))
        // Second: POST /auth/refresh → success
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          json: async () => ({ access_token: newAccess, refresh_token: 'rt-v2' }),
        } as unknown as Response)
        // Third: retry of original request → 200 with data
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          json: async () => ({ tables: [], count: 0 }),
        } as unknown as Response);

      vi.stubGlobal('fetch', mockFetch);

      const result = await dc.getCapabilities();

      // The retry should have succeeded and returned the data
      expect(result).toEqual({ tables: [], count: 0 });
      // fetch was called 3 times: original + refresh + retry
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('propagates 401 when refresh returns null (no refresh token)', async () => {
      const dc = makeDataClient('old-jwt', 'tenant_home');
      const pmc = makePaidMediaClient('old-jwt');

      // No refresh token → refreshAccessToken() returns null
      const _sc = new SessionClients(dc, pmc, 'https://api.nevent.es', 'tenant_home');

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(401)));

      await expect(dc.getCapabilities()).rejects.toThrow();
      // Only 1 fetch call — no retry since refresh returned null
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    });

    it('does not retry a second time when refreshed token also returns 401', async () => {
      const dc = makeDataClient('old-jwt', 'tenant_home');
      const pmc = makePaidMediaClient('old-jwt');
      const newAccess = fakeJwt({ tenantId: 'tenant_home' });

      const sc = new SessionClients(dc, pmc, 'https://api.nevent.es', 'tenant_home', 'rt-initial');

      const mockFetch = vi.fn()
        // First: original request → 401
        .mockResolvedValueOnce(mockResponse(401))
        // Second: POST /auth/refresh → success (gives us a new token)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          json: async () => ({ access_token: newAccess, refresh_token: 'rt-v2' }),
        } as unknown as Response)
        // Third: retry with new token → still 401 (token is bad)
        .mockResolvedValueOnce(mockResponse(401));

      vi.stubGlobal('fetch', mockFetch);

      // Should reject — no infinite loop
      await expect(dc.getCapabilities()).rejects.toThrow();
      // fetch called exactly 3 times: original + refresh + retry (no further retries)
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('updates jwtToken on both clients after successful refresh', async () => {
      const dc = makeDataClient('old-jwt', 'tenant_home');
      const pmc = makePaidMediaClient('old-jwt');
      const newAccess = fakeJwt({ tenantId: 'tenant_home' });

      const _sc = new SessionClients(dc, pmc, 'https://api.nevent.es', 'tenant_home', 'rt-initial');

      const mockFetch = vi.fn()
        .mockResolvedValueOnce(mockResponse(401))
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          json: async () => ({ access_token: newAccess, refresh_token: 'rt-v2' }),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          json: async () => ({ tables: [], count: 0 }),
        } as unknown as Response);

      vi.stubGlobal('fetch', mockFetch);

      await dc.getCapabilities();

      // Both clients should now carry the refreshed token
      expect((dc as unknown as { jwtToken: string }).jwtToken).toBe(newAccess);
      expect((pmc as unknown as { jwtToken: string }).jwtToken).toBe(newAccess);
    });
  });
});
