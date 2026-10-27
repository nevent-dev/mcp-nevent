/**
 * NEV-1848 (b): refresh-token revalidation against nev-api and maximum chain
 * lifetime, plus a regression of the normal authorization-code -> refresh flow.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InvalidGrantError, ServerError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { NeventOAuthProvider, parseRefreshMaxLifetimeDays, parseRefreshRevalidateMode, type RefreshRevalidateMode } from '../auth/oauth-provider.js';
import { TokenService } from '../auth/token-service.js';
import type { AuthCodeDocument, OAuthStores, RefreshTokenDocument } from '../auth/oauth-stores.js';

const SECRET = 'test-secret-test-secret-test-secret-32';
const DAY = 24 * 60 * 60 * 1000;

const HELPBOT_PREFIX = 'https://support.nevent.ai/helpbot/';
/** Restricted client (matches MCP_READONLY_REDIRECT_PREFIXES) — revalidated by default. */
const client = { client_id: 'client-1', redirect_uris: [`${HELPBOT_PREFIX}oauth/callback`] } as unknown as OAuthClientInformationFull;
/** Any other client (claude.ai) — NOT revalidated by default. */
const normalClient = { client_id: 'client-1', redirect_uris: ['https://claude.ai/cb'] } as unknown as OAuthClientInformationFull;

function makeStores() {
  const refresh = new Map<string, RefreshTokenDocument>();
  const codes = new Map<string, AuthCodeDocument>();
  const stores = {
    clients: {},
    authCodes: {
      find: async (c: string) => codes.get(c),
      consume: async (c: string) => { codes.delete(c); },
      save: async (d: AuthCodeDocument) => { codes.set(d.code, d); },
    },
    refreshTokens: {
      find: async (t: string) => refresh.get(t),
      consume: async (t: string) => refresh.delete(t),
      save: async (d: RefreshTokenDocument) => { refresh.set(d.token, d); },
      findNeventAccessTokenByUserId: async () => undefined,
    },
  } as unknown as OAuthStores;
  return { stores, refresh, codes };
}

function makeProvider(stores: OAuthStores, refreshMaxLifetimeDays?: number, refreshRevalidate?: RefreshRevalidateMode) {
  return new NeventOAuthProvider({
    stores,
    tokenService: new TokenService(SECRET),
    neventApiUrl: 'https://api.test',
    mcpServerUrl: new URL('https://mcp.test'),
    refreshMaxLifetimeDays,
    refreshRevalidate,
  });
}

function refreshDoc(over: Partial<RefreshTokenDocument> = {}): RefreshTokenDocument {
  return {
    token: 'rt-1', accessToken: 'old', clientId: 'client-1', scopes: ['mcp:tools'],
    userId: 'user-1', email: 'u@nevent.es', role: 'ADMIN', tenantId: 't1',
    createdAt: new Date(), ...over,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('MCP_READONLY_REDIRECT_PREFIXES', HELPBOT_PREFIX);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const ok = (id = 'user-1') => new Response(JSON.stringify({ id }), { status: 200 });

describe('exchangeRefreshToken — user revalidation', () => {
  it('active user: refresh succeeds and calls GET /auth/me with the new MCP access token', async () => {
    const { stores, refresh } = makeStores();
    refresh.set('rt-1', refreshDoc());
    fetchMock.mockResolvedValue(ok());

    const tokens = await makeProvider(stores).exchangeRefreshToken(client, 'rt-1');

    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();
    expect(tokens.refresh_token).not.toBe('rt-1');
    expect(refresh.has('rt-1')).toBe(false); // rotated
    expect(refresh.has(tokens.refresh_token!)).toBe(true);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/auth/me');
    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${tokens.access_token}`);
    // The token sent is a valid MCP access token for that user.
    expect(new TokenService(SECRET).verifyAccessToken(tokens.access_token).sub).toBe('user-1');
  });

  it.each([401, 404])('nev-api answers %i: invalid_grant and refresh token revoked', async (status) => {
    const { stores, refresh } = makeStores();
    refresh.set('rt-1', refreshDoc());
    fetchMock.mockResolvedValue(new Response('{}', { status }));

    await expect(makeProvider(stores).exchangeRefreshToken(client, 'rt-1')).rejects.toBeInstanceOf(InvalidGrantError);
    expect(refresh.size).toBe(0);
  });

  it('/auth/me returns a different user id: invalid_grant and revoked', async () => {
    const { stores, refresh } = makeStores();
    refresh.set('rt-1', refreshDoc());
    fetchMock.mockResolvedValue(ok('someone-else'));

    await expect(makeProvider(stores).exchangeRefreshToken(client, 'rt-1')).rejects.toBeInstanceOf(InvalidGrantError);
    expect(refresh.size).toBe(0);
  });

  it.each([
    ['network error', () => Promise.reject(new TypeError('fetch failed'))],
    ['timeout', () => Promise.reject(Object.assign(new Error('t'), { name: 'TimeoutError' }))],
    ['500', () => Promise.resolve(new Response('', { status: 500 }))],
    ['503', () => Promise.resolve(new Response('', { status: 503 }))],
    ['403', () => Promise.resolve(new Response('', { status: 403 }))],
    ['429', () => Promise.resolve(new Response('', { status: 429 }))],
  ])('nev-api unavailable (%s): transient server_error, token NOT revoked, no tokens issued', async (_n, impl) => {
    const { stores, refresh } = makeStores();
    refresh.set('rt-1', refreshDoc());
    fetchMock.mockImplementation(impl);

    const p = makeProvider(stores).exchangeRefreshToken(client, 'rt-1');
    await expect(p).rejects.toBeInstanceOf(ServerError);
    expect(refresh.size).toBe(1);
    expect(refresh.has('rt-1')).toBe(true);
  });

  it('after a transient failure the same refresh token can be retried successfully', async () => {
    const { stores, refresh } = makeStores();
    refresh.set('rt-1', refreshDoc());
    const provider = makeProvider(stores);

    fetchMock.mockResolvedValueOnce(new Response('', { status: 503 }));
    await expect(provider.exchangeRefreshToken(client, 'rt-1')).rejects.toBeInstanceOf(ServerError);

    fetchMock.mockResolvedValueOnce(ok());
    const tokens = await provider.exchangeRefreshToken(client, 'rt-1');
    expect(tokens.refresh_token).toBeTruthy();
  });
});

describe('exchangeRefreshToken — MCP_REFRESH_REVALIDATE modes', () => {
  async function run(c: OAuthClientInformationFull, mode?: RefreshRevalidateMode, nevApiStatus = 401) {
    const { stores, refresh } = makeStores();
    refresh.set('rt-1', refreshDoc());
    fetchMock.mockResolvedValue(new Response('{}', { status: nevApiStatus }));
    const result = await makeProvider(stores, undefined, mode).exchangeRefreshToken(c, 'rt-1').then(
      (t) => ({ ok: true as const, t }),
      (e: unknown) => ({ ok: false as const, e })
    );
    return { result, refresh };
  }

  it('default (restricted): a normal client is NOT revalidated, even if nev-api would reject', async () => {
    const { result } = await run(normalClient);
    expect(result.ok).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('default (restricted): a restricted client IS revalidated and revoked on 401', async () => {
    const { result, refresh } = await run(client);
    expect(result.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(refresh.size).toBe(0);
  });

  it('all: a normal client is revalidated', async () => {
    const { result, refresh } = await run(normalClient, 'all');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.e).toBeInstanceOf(InvalidGrantError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(refresh.size).toBe(0);
  });

  it('off: nobody is revalidated, not even a restricted client', async () => {
    const { result } = await run(client, 'off');
    expect(result.ok).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('403 is transient in every mode that revalidates: server_error, token kept', async () => {
    for (const [c, mode] of [[client, undefined], [normalClient, 'all']] as const) {
      fetchMock.mockClear();
      const { result, refresh } = await run(c, mode, 403);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.e).toBeInstanceOf(ServerError);
      expect(refresh.has('rt-1')).toBe(true);
    }
  });

  it('the maximum chain lifetime applies in every mode, including off and normal clients', async () => {
    for (const mode of ['restricted', 'all', 'off'] as const) {
      const { stores, refresh } = makeStores();
      refresh.set('rt-1', refreshDoc({ chainCreatedAt: new Date(Date.now() - 91 * DAY) }));
      await expect(makeProvider(stores, undefined, mode).exchangeRefreshToken(normalClient, 'rt-1')).rejects.toBeInstanceOf(InvalidGrantError);
      expect(refresh.size).toBe(0);
    }
  });

  it('parseRefreshRevalidateMode: default restricted, invalid falls back', () => {
    expect(parseRefreshRevalidateMode(undefined)).toBe('restricted');
    expect(parseRefreshRevalidateMode('')).toBe('restricted');
    expect(parseRefreshRevalidateMode('ALL')).toBe('all');
    expect(parseRefreshRevalidateMode(' off ')).toBe('off');
    expect(parseRefreshRevalidateMode('restricted')).toBe('restricted');
    expect(parseRefreshRevalidateMode('nope')).toBe('restricted');
  });
});

describe('exchangeRefreshToken — maximum chain lifetime', () => {
  it('past the maximum lifetime: invalid_grant, revoked, nev-api not even called', async () => {
    const { stores, refresh } = makeStores();
    refresh.set('rt-1', refreshDoc({
      createdAt: new Date(Date.now() - 1 * DAY),
      chainCreatedAt: new Date(Date.now() - 91 * DAY),
    }));

    await expect(makeProvider(stores).exchangeRefreshToken(client, 'rt-1')).rejects.toBeInstanceOf(InvalidGrantError);
    expect(refresh.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('within the maximum lifetime: refresh works even if the chain is old', async () => {
    const { stores, refresh } = makeStores();
    refresh.set('rt-1', refreshDoc({ chainCreatedAt: new Date(Date.now() - 89 * DAY) }));
    fetchMock.mockResolvedValue(ok());
    await expect(makeProvider(stores).exchangeRefreshToken(client, 'rt-1')).resolves.toBeTruthy();
  });

  it('configurable maximum lifetime', async () => {
    const { stores, refresh } = makeStores();
    refresh.set('rt-1', refreshDoc({ chainCreatedAt: new Date(Date.now() - 8 * DAY) }));
    await expect(makeProvider(stores, 7).exchangeRefreshToken(client, 'rt-1')).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it('legacy document without chainCreatedAt counts from its createdAt', async () => {
    const { stores, refresh } = makeStores();
    refresh.set('rt-old', refreshDoc({ token: 'rt-old', createdAt: new Date(Date.now() - 100 * DAY) }));
    await expect(makeProvider(stores).exchangeRefreshToken(client, 'rt-old')).rejects.toBeInstanceOf(InvalidGrantError);

    refresh.set('rt-new', refreshDoc({ token: 'rt-new', createdAt: new Date(Date.now() - 5 * DAY) }));
    fetchMock.mockResolvedValue(ok());
    const tokens = await makeProvider(stores).exchangeRefreshToken(client, 'rt-new');
    // First rotation of a legacy doc pins the chain start to its createdAt.
    const next = refresh.get(tokens.refresh_token!)!;
    expect(Date.now() - next.chainCreatedAt!.getTime()).toBeGreaterThan(4.9 * DAY);
    expect(Date.now() - next.chainCreatedAt!.getTime()).toBeLessThan(5.1 * DAY);
  });

  it('chainCreatedAt is inherited unchanged across successive rotations', async () => {
    const { stores, refresh } = makeStores();
    const start = new Date(Date.now() - 30 * DAY);
    refresh.set('rt-1', refreshDoc({ chainCreatedAt: start }));
    fetchMock.mockImplementation(() => Promise.resolve(ok()));
    const provider = makeProvider(stores);

    const t1 = await provider.exchangeRefreshToken(client, 'rt-1');
    const t2 = await provider.exchangeRefreshToken(client, t1.refresh_token!);
    const doc2 = refresh.get(t2.refresh_token!)!;
    expect(doc2.chainCreatedAt!.getTime()).toBe(start.getTime());
    expect(doc2.createdAt.getTime()).toBeGreaterThan(start.getTime()); // sliding TTL field still moves
  });
});

describe('exchangeRefreshToken — atomic rotation', () => {
  it('two concurrent refreshes with the same token: exactly one succeeds', async () => {
    const { stores, refresh } = makeStores();
    refresh.set('rt-1', refreshDoc());
    // Both requests get past find() + revalidation before either consumes.
    fetchMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return ok();
    });
    const provider = makeProvider(stores);

    const results = await Promise.allSettled([
      provider.exchangeRefreshToken(client, 'rt-1'),
      provider.exchangeRefreshToken(client, 'rt-1'),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(InvalidGrantError);
    // Only one new refresh token was stored.
    expect(refresh.size).toBe(1);
  });

  it('a token that was already consumed cannot be replayed', async () => {
    const { stores, refresh } = makeStores();
    refresh.set('rt-1', refreshDoc());
    fetchMock.mockResolvedValue(ok());
    const provider = makeProvider(stores);
    await provider.exchangeRefreshToken(client, 'rt-1');
    await expect(provider.exchangeRefreshToken(client, 'rt-1')).rejects.toThrow();
  });
});

describe('parseRefreshMaxLifetimeDays', () => {
  it('parses valid values and falls back on unset / invalid', () => {
    expect(parseRefreshMaxLifetimeDays(undefined)).toBeUndefined();
    expect(parseRefreshMaxLifetimeDays('')).toBeUndefined();
    expect(parseRefreshMaxLifetimeDays('45')).toBe(45);
    expect(parseRefreshMaxLifetimeDays('abc')).toBeUndefined();
    expect(parseRefreshMaxLifetimeDays('0')).toBeUndefined();
    expect(parseRefreshMaxLifetimeDays('-3')).toBeUndefined();
  });
});

describe('OAuth flow regression', () => {
  it('authorization code -> tokens -> refresh keeps working and starts the chain', async () => {
    const { stores, refresh, codes } = makeStores();
    codes.set('code-1', {
      code: 'code-1', clientId: 'client-1', userId: 'user-1', email: 'u@nevent.es', role: 'ADMIN',
      tenantId: 't1', scopes: ['mcp:tools'], redirectUri: 'https://claude.ai/cb', codeChallenge: 'x',
      neventAccessToken: 'nev-token', createdAt: new Date(),
    } as unknown as AuthCodeDocument);
    const provider = makeProvider(stores);

    const first = await provider.exchangeAuthorizationCode(normalClient, 'code-1');
    expect(codes.size).toBe(0);
    const doc = refresh.get(first.refresh_token!)!;
    expect(doc.chainCreatedAt).toBeInstanceOf(Date);
    expect(fetchMock).not.toHaveBeenCalled(); // no nev-api call on the code exchange

    const second = await provider.exchangeRefreshToken(normalClient, first.refresh_token!);
    expect(second.token_type).toBe('bearer');
    expect(refresh.get(second.refresh_token!)!.chainCreatedAt!.getTime()).toBe(doc.chainCreatedAt!.getTime());

    expect(fetchMock).not.toHaveBeenCalled(); // normal clients are not revalidated by default

    const claims = await provider.verifyAccessToken(second.access_token);
    expect(claims.clientId).toBe('client-1');
  });

  it('a refresh token issued to another client is still rejected', async () => {
    const { stores, refresh } = makeStores();
    refresh.set('rt-1', refreshDoc({ clientId: 'someone-else' }));
    await expect(makeProvider(stores).exchangeRefreshToken(normalClient, 'rt-1')).rejects.toThrow(/not issued to this client/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
