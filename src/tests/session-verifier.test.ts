/**
 * Unit tests for `verifySession()` (`src/auth/session-verifier.ts`) — JWT
 * verification for `bearer-passthrough` mode by introspection against
 * nev-api's `GET /auth/me`.
 *
 * Covers:
 *  - 200 → resolves with the caller's identity.
 *  - 401 → rejects with `SessionVerificationError` (fail-closed).
 *  - Network error / timeout → rejects with `SessionVerificationError`
 *    (fail-closed — no permissive fallback when nev-api is unreachable).
 *  - Caching: a second call within the TTL does not re-fetch; the cache
 *    never serves an entry past the token's own `exp` claim, even if the
 *    60s TTL window has not elapsed.
 *  - The request never carries the token as a cache key that could leak via
 *    a naive log of the cache (verified indirectly: cache keys are SHA-256
 *    hex digests, never equal to the raw token).
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import {
  verifySession,
  resolveScopeTenantId,
  SessionVerificationError,
  NEGATIVE_CACHE_TTL_MS,
  MAX_CACHE_ENTRIES,
  _cacheSizesForTests,
  _clearVerificationCacheForTests,
} from '../auth/session-verifier.js';

const NEVENT_API_URL = 'https://api.nevent.es';

/** Builds an unsigned (alg=none) JWT-shaped string carrying the given payload. */
function makeFakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.`;
}

function mockFetchOk(body: Record<string, unknown>) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response;
}

function mockFetchError(status: number) {
  return {
    ok: false,
    status,
    json: async () => ({ message: `HTTP ${status}` }),
  } as Response;
}

describe('verifySession', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    _clearVerificationCacheForTests();
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('resolves with the caller identity on 200', async () => {
    const token = makeFakeJwt({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) + 3600 });
    mockFetch.mockResolvedValue(
      mockFetchOk({ id: 'user-1', email: 'promoter@example.com', tenantId: 'tenant-1', role: 'OWNER' })
    );

    const session = await verifySession(token, NEVENT_API_URL);

    expect(session).toEqual({
      userId: 'user-1',
      email: 'promoter@example.com',
      name: undefined,
      role: 'OWNER',
      tenantId: 'tenant-1',
      principalType: 'HUMAN',
      effectiveTenantId: undefined,
      serviceSession: undefined,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.nevent.es/auth/me');
    expect((options.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${token}`);
  });

  it('rejects with SessionVerificationError on 401 (invalid/expired token)', async () => {
    const token = makeFakeJwt({ sub: 'user-1' });
    mockFetch.mockResolvedValue(mockFetchError(401));

    await expect(verifySession(token, NEVENT_API_URL)).rejects.toThrow(SessionVerificationError);
    await expect(verifySession(token, NEVENT_API_URL)).rejects.toThrow(/401/);
  });

  it('rejects with SessionVerificationError on 403', async () => {
    const token = makeFakeJwt({ sub: 'user-1' });
    mockFetch.mockResolvedValue(mockFetchError(403));

    await expect(verifySession(token, NEVENT_API_URL)).rejects.toThrow(SessionVerificationError);
  });

  it('fails closed on a network error (no permissive fallback)', async () => {
    const token = makeFakeJwt({ sub: 'user-1' });
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(verifySession(token, NEVENT_API_URL)).rejects.toThrow(SessionVerificationError);
  });

  it('fails closed on a timeout (AbortError)', async () => {
    const token = makeFakeJwt({ sub: 'user-1' });
    const abortError = new Error('The operation was aborted');
    abortError.name = 'TimeoutError';
    mockFetch.mockRejectedValue(abortError);

    await expect(verifySession(token, NEVENT_API_URL)).rejects.toThrow(SessionVerificationError);
  });

  it('rejects when the response is missing an id, even on 200', async () => {
    const token = makeFakeJwt({ sub: 'user-1' });
    mockFetch.mockResolvedValue(mockFetchOk({ email: 'no-id@example.com' }));

    await expect(verifySession(token, NEVENT_API_URL)).rejects.toThrow(SessionVerificationError);
  });

  it('does not use the raw token as the cache key (SHA-256 hex digest instead)', () => {
    const token = makeFakeJwt({ sub: 'user-1' });
    const expectedHash = createHash('sha256').update(token).digest('hex');
    expect(expectedHash).not.toBe(token);
    expect(expectedHash).toMatch(/^[0-9a-f]{64}$/);
  });

  describe('caching', () => {
    it('serves a cached result within the TTL without re-fetching', async () => {
      const token = makeFakeJwt({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) + 3600 });
      mockFetch.mockResolvedValue(mockFetchOk({ id: 'user-1', tenantId: 'tenant-1' }));

      const first = await verifySession(token, NEVENT_API_URL);
      const second = await verifySession(token, NEVENT_API_URL);

      expect(first).toEqual(second);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('re-fetches after the 60s TTL elapses', async () => {
      vi.useFakeTimers();
      const token = makeFakeJwt({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) + 3600 });
      mockFetch.mockResolvedValue(mockFetchOk({ id: 'user-1', tenantId: 'tenant-1' }));

      await verifySession(token, NEVENT_API_URL);
      vi.advanceTimersByTime(61_000);
      await verifySession(token, NEVENT_API_URL);

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('never serves a cache entry past the token\'s own exp, even within the 60s TTL window', async () => {
      vi.useFakeTimers();
      const nowSec = Math.floor(Date.now() / 1000);
      // Token expires in 5s — far shorter than the 60s cache TTL.
      const token = makeFakeJwt({ sub: 'user-1', exp: nowSec + 5 });
      mockFetch.mockResolvedValue(mockFetchOk({ id: 'user-1', tenantId: 'tenant-1' }));

      await verifySession(token, NEVENT_API_URL);
      // Advance past the token's own exp (6s) but well within the 60s TTL.
      vi.advanceTimersByTime(6_000);
      // Second call must hit nev-api again (this time it legitimately 401s,
      // exactly as a real expired token would) instead of being served from
      // a stale "valid" cache entry.
      mockFetch.mockResolvedValue(mockFetchError(401));

      await expect(verifySession(token, NEVENT_API_URL)).rejects.toThrow(SessionVerificationError);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('two different tokens are cached independently', async () => {
      const tokenA = makeFakeJwt({ sub: 'user-a', exp: Math.floor(Date.now() / 1000) + 3600 });
      const tokenB = makeFakeJwt({ sub: 'user-b', exp: Math.floor(Date.now() / 1000) + 3600 });
      mockFetch
        .mockResolvedValueOnce(mockFetchOk({ id: 'user-a', tenantId: 'tenant-a' }))
        .mockResolvedValueOnce(mockFetchOk({ id: 'user-b', tenantId: 'tenant-b' }));

      const sessionA = await verifySession(tokenA, NEVENT_API_URL);
      const sessionB = await verifySession(tokenB, NEVENT_API_URL);

      expect(sessionA.userId).toBe('user-a');
      expect(sessionB.userId).toBe('user-b');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });
});

describe('verifySession — principalType / effectiveTenantId / serviceSession', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    _clearVerificationCacheForTests();
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const serviceBody = {
    id: 'svc-user',
    email: 'agent@service.nevent.invalid',
    role: 'ADMIN',
    tenantId: 'tenant-session',
    principalType: 'SERVICE',
    effectiveTenantId: 'tenant-session',
    serviceSession: { sessionId: 'sess-1', channel: 'API', scope: 'TENANT', tenantId: 'tenant-session', label: 'x' },
  };

  it('treats a response without principalType as HUMAN (older nev-api)', async () => {
    const token = makeFakeJwt({ sub: 'u' });
    mockFetch.mockResolvedValue(mockFetchOk({ id: 'u', tenantId: 't-1' }));

    const session = await verifySession(token, NEVENT_API_URL);

    expect(session.principalType).toBe('HUMAN');
    expect(resolveScopeTenantId(session)).toBe('t-1');
  });

  it('accepts a SERVICE principal and exposes its session context', async () => {
    const token = makeFakeJwt({ sub: 'svc-user' });
    mockFetch.mockResolvedValue(mockFetchOk(serviceBody));

    const session = await verifySession(token, NEVENT_API_URL);

    expect(session.principalType).toBe('SERVICE');
    expect(session.effectiveTenantId).toBe('tenant-session');
    expect(session.serviceSession).toEqual({
      sessionId: 'sess-1',
      channel: 'API',
      scope: 'TENANT',
      tenantId: 'tenant-session',
    });
  });

  it('uses effectiveTenantId over tenantId when they differ (hierarchical admin navigating a child tenant)', async () => {
    const token = makeFakeJwt({ sub: 'admin-1' });
    mockFetch.mockResolvedValue(
      mockFetchOk({ id: 'admin-1', role: 'ADMIN', tenantId: 'parent', effectiveTenantId: 'child', principalType: 'HUMAN' })
    );

    const session = await verifySession(token, NEVENT_API_URL);

    expect(session.tenantId).toBe('parent');
    expect(resolveScopeTenantId(session)).toBe('child');
  });

  it('falls back to tenantId when effectiveTenantId is absent', () => {
    expect(resolveScopeTenantId({ userId: 'u', principalType: 'HUMAN', tenantId: 'only' })).toBe('only');
    expect(resolveScopeTenantId({ userId: 'u', principalType: 'HUMAN' })).toBeUndefined();
  });

  it('rejects an unknown principalType (fail-closed)', async () => {
    const token = makeFakeJwt({ sub: 'u' });
    mockFetch.mockResolvedValue(mockFetchOk({ id: 'u', principalType: 'ROBOT', effectiveTenantId: 't' }));

    await expect(verifySession(token, NEVENT_API_URL)).rejects.toThrow(SessionVerificationError);
    await expect(verifySession(token, NEVENT_API_URL)).rejects.toThrow(/principalType/);
  });

  it('rejects a SERVICE principal without effectiveTenantId (no tenant lock possible)', async () => {
    const token = makeFakeJwt({ sub: 'svc-user' });
    mockFetch.mockResolvedValue(mockFetchOk({ ...serviceBody, effectiveTenantId: undefined, tenantId: 'x' }));

    await expect(verifySession(token, NEVENT_API_URL)).rejects.toThrow(/effectiveTenantId/);
  });

  it('caches a HUMAN verification for the full window but a SERVICE one for far less', async () => {
    vi.useFakeTimers();
    const farFuture = Math.floor(Date.now() / 1000) + 3600;

    const humanToken = makeFakeJwt({ sub: 'u', exp: farFuture });
    const serviceToken = makeFakeJwt({ sub: 'svc-user', exp: farFuture });
    mockFetch.mockImplementation(async (_url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>)['Authorization'];
      return auth.endsWith(serviceToken) ? mockFetchOk(serviceBody) : mockFetchOk({ id: 'u', tenantId: 't-1' });
    });

    await verifySession(humanToken, NEVENT_API_URL);
    await verifySession(serviceToken, NEVENT_API_URL);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(30_000);
    await verifySession(humanToken, NEVENT_API_URL); // still cached (60s)
    expect(mockFetch).toHaveBeenCalledTimes(2);
    await verifySession(serviceToken, NEVENT_API_URL); // revalidated (10s)
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});

describe('verifySession — caches, 5xx handling, scope and tenant rules', () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  const okBody = (id: string) => ({ id, tenantId: 't-1', principalType: 'HUMAN' });

  beforeEach(() => {
    _clearVerificationCacheForTests();
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('marks 5xx, network errors and unparseable answers as "unavailable" and 401/403 as "rejected"', async () => {
    const kindOf = async (setup: () => void): Promise<string | undefined> => {
      _clearVerificationCacheForTests();
      setup();
      try {
        await verifySession(makeFakeJwt({ sub: 'u' }), NEVENT_API_URL);
      } catch (e) {
        return (e as SessionVerificationError).kind;
      }
      return undefined;
    };
    expect(await kindOf(() => mockFetch.mockResolvedValue(mockFetchError(503)))).toBe('unavailable');
    expect(await kindOf(() => mockFetch.mockResolvedValue(mockFetchError(429)))).toBe('unavailable');
    expect(await kindOf(() => mockFetch.mockRejectedValue(new Error('ECONNRESET')))).toBe('unavailable');
    expect(await kindOf(() => mockFetch.mockResolvedValue(mockFetchError(401)))).toBe('rejected');
    expect(await kindOf(() => mockFetch.mockResolvedValue(mockFetchError(403)))).toBe('rejected');
  });

  it('negatively caches a 401 for ~5 s, then asks nev-api again; 5xx is never negatively cached', async () => {
    vi.useFakeTimers();
    const token = makeFakeJwt({ sub: 'u' });

    mockFetch.mockResolvedValue(mockFetchError(401));
    await expect(verifySession(token, NEVENT_API_URL)).rejects.toThrow(/401/);
    await expect(verifySession(token, NEVENT_API_URL)).rejects.toThrow(/401/);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(NEGATIVE_CACHE_TTL_MS + 1);
    mockFetch.mockResolvedValue(mockFetchOk(okBody('u')));
    await expect(verifySession(token, NEVENT_API_URL)).resolves.toMatchObject({ userId: 'u' });
    expect(mockFetch).toHaveBeenCalledTimes(2);

    _clearVerificationCacheForTests();
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(mockFetchError(503));
    await expect(verifySession(token, NEVENT_API_URL)).rejects.toThrow();
    await expect(verifySession(token, NEVENT_API_URL)).rejects.toThrow();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('bounds both caches at MAX_CACHE_ENTRIES (oldest evicted first)', async () => {
    mockFetch.mockImplementation(async (_u: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>)['Authorization'];
      return auth.includes('bad') ? mockFetchError(401) : mockFetchOk(okBody('u'));
    });

    for (let i = 0; i < MAX_CACHE_ENTRIES + 25; i++) {
      await verifySession(makeFakeJwt({ sub: `u${i}`, exp: Math.floor(Date.now() / 1000) + 3600 }), NEVENT_API_URL);
      await verifySession(`bad.${i}.x`, NEVENT_API_URL).catch(() => undefined);
    }
    const sizes = _cacheSizesForTests();
    expect(sizes.verified).toBeLessThanOrEqual(MAX_CACHE_ENTRIES);
    expect(sizes.rejected).toBeLessThanOrEqual(MAX_CACHE_ENTRIES);
    expect(sizes.verified).toBeGreaterThan(MAX_CACHE_ENTRIES - 5);
  });

  it('purges expired entries before evicting live ones when the cap is hit', async () => {
    vi.useFakeTimers();
    mockFetch.mockResolvedValue(mockFetchOk(okBody('u')));
    const exp = () => Math.floor(Date.now() / 1000) + 3600;

    for (let i = 0; i < MAX_CACHE_ENTRIES; i++) {
      await verifySession(makeFakeJwt({ sub: `old${i}`, exp: exp() }), NEVENT_API_URL);
    }
    expect(_cacheSizesForTests().verified).toBe(MAX_CACHE_ENTRIES);

    vi.advanceTimersByTime(61_000); // every entry is now expired
    const fresh = makeFakeJwt({ sub: 'fresh', exp: exp() });
    await verifySession(fresh, NEVENT_API_URL);
    expect(_cacheSizesForTests().verified).toBe(1);
    mockFetch.mockClear();
    await verifySession(fresh, NEVENT_API_URL);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refuses a SERVICE session with PLATFORM scope, or with no scope', async () => {
    const svc = (scope?: string) => ({
      id: 's',
      principalType: 'SERVICE',
      tenantId: 't-1',
      effectiveTenantId: 't-1',
      serviceSession: scope ? { scope, tenantId: 't-1' } : {},
    });
    mockFetch.mockResolvedValue(mockFetchOk(svc('PLATFORM')));
    await expect(verifySession(makeFakeJwt({ sub: 'a' }), NEVENT_API_URL)).rejects.toThrow(/scope is not TENANT/);
    mockFetch.mockResolvedValue(mockFetchOk(svc()));
    await expect(verifySession(makeFakeJwt({ sub: 'b' }), NEVENT_API_URL)).rejects.toThrow(/scope is not TENANT/);
    mockFetch.mockResolvedValue(mockFetchOk(svc('TENANT')));
    await expect(verifySession(makeFakeJwt({ sub: 'c' }), NEVENT_API_URL)).resolves.toMatchObject({
      principalType: 'SERVICE',
    });
  });

  it('refuses a SERVICE session whose session tenant disagrees with the effective tenant', async () => {
    mockFetch.mockResolvedValue(
      mockFetchOk({
        id: 's',
        principalType: 'SERVICE',
        effectiveTenantId: 't-1',
        serviceSession: { scope: 'TENANT', tenantId: 't-2' },
      })
    );
    await expect(verifySession(makeFakeJwt({ sub: 'a' }), NEVENT_API_URL)).rejects.toThrow(/tenant mismatch/);
  });

  it('refuses a response with no tenant at all (fail-closed, no JWT-claim fallback)', async () => {
    const token = makeFakeJwt({ sub: 'u', tenantId: 'claim-tenant' });
    mockFetch.mockResolvedValue(mockFetchOk({ id: 'u', principalType: 'HUMAN' }));
    await expect(verifySession(token, NEVENT_API_URL)).rejects.toThrow(/no tenant/);
  });
});
