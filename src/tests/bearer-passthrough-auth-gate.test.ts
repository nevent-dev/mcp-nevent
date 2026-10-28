/**
 * Integration tests for the `verifyIntrospectedSession` gate in
 * `createBearerPassthroughApp()` (`src/transports/http-bearer-passthrough.ts`).
 *
 * Unlike `bearer-passthrough.test.ts` (which white-box-tests the tool
 * filter, `decodeJwtClaims`, and client isolation without a live server),
 * these tests stand up a real Express server via `createBearerPassthroughApp`
 * and issue real HTTP requests with Node's built-in `http` client — because
 * the property under test ("a request is rejected before it ever reaches
 * session/tool dispatch") is specifically about middleware ORDER on the real
 * app, which a white-box mirror of the logic cannot demonstrate.
 *
 * `globalThis.fetch` is stubbed to control nev-api's `/auth/me` response —
 * it is ONLY used by `verifySession()`'s outbound call, never by the test's
 * own client requests (those use `node:http` directly, so they cannot be
 * intercepted by the same stub).
 *
 * Covers:
 *  - No `Authorization` header → 401, no nev-api call made.
 *  - `/auth/me` returns 401 (invalid/expired token) → the MCP request is
 *    rejected 401 and no session is created (`activeSessions` stays empty,
 *    observed via `/health`).
 *  - `/auth/me` network error / timeout → fail-closed 401, no session
 *    created.
 *  - A request carrying an unknown `Mcp-Session-Id` is STILL rejected 401
 *    on an unverified token — proving the verification gate runs before the
 *    "does this session exist?" branch, i.e. before any tool or `tools/list`
 *    dispatch could occur for it.
 *  - `/auth/me` returns 200 → the `initialize` request is let through to
 *    session dispatch (verified indirectly: it does NOT receive the gate's
 *    401 response) and a session is registered (`activeSessions` becomes 1,
 *    observed via `/health`).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createBearerPassthroughApp,
  type BearerPassthroughAppResult,
} from '../transports/http-bearer-passthrough.js';
import { _clearVerificationCacheForTests } from '../auth/session-verifier.js';

/** Builds an unsigned (alg=none) JWT-shaped string carrying the given payload. */
function fakeJwt(payload: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'none', typ: 'JWT' })}.${enc(payload)}.`;
}

// ---------------------------------------------------------------------------
// Test HTTP client (node:http — independent of the stubbed global fetch)
// ---------------------------------------------------------------------------

interface RawResponse {
  status: number;
  body: string;
}

function rawRequest(
  port: number,
  options: { method: string; headers?: Record<string, string>; body?: unknown }
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const payload = options.body !== undefined ? JSON.stringify(options.body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/',
        method: options.method,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...KEY_HEADER,
          ...options.headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Result of the app under test; `/health` no longer exposes the session count. */
let currentResult: BearerPassthroughAppResult;

async function getHealth(_port: number): Promise<{ activeSessions: number }> {
  return { activeSessions: currentResult.activeSessionCount() };
}

function getHealthPublic(port: number): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    http
      .get({ hostname: '127.0.0.1', port, path: '/health' }, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }));
      })
      .on('error', reject);
  });
}

const SERVICE_KEY = 'k'.repeat(40);
const PREVIOUS_KEY = 'p'.repeat(40);
const KEY_HEADER = { 'X-Nevent-Service-Key': SERVICE_KEY };

const INITIALIZE_BODY = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' },
  },
};

function mockFetchOk(body: Record<string, unknown>) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function mockFetchError(status: number) {
  return { ok: false, status, json: async () => ({ message: `HTTP ${status}` }) } as Response;
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

describe('bearer-passthrough auth gate (integration)', () => {
  let result: BearerPassthroughAppResult;
  let server: http.Server;
  let port: number;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    _clearVerificationCacheForTests();
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    result = await createBearerPassthroughApp({
      port: 0,
      neventApiUrl: 'https://api.nevent.es',
      dataApiUrl: 'https://data.nevent.es',
      serviceKeys: [SERVICE_KEY, PREVIOUS_KEY],
      tokenRateLimitPerMinute: 1000,
    });

    await new Promise<void>((resolve) => {
      server = result.app.listen(0, '127.0.0.1', resolve);
    });
    port = (server.address() as AddressInfo).port;
    currentResult = result;
  });

  afterEach(async () => {
    await result.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.restoreAllMocks();
  });

  it('fails closed with 503 when /auth/me answers 5xx, and 401 only for an explicit rejection', async () => {
    mockFetch.mockResolvedValue(mockFetchError(502));
    const down = await rawRequest(port, {
      method: 'POST',
      headers: { Authorization: 'Bearer some.token.here' },
      body: INITIALIZE_BODY,
    });
    expect(down.status).toBe(503);
    expect((await getHealth(port)).activeSessions).toBe(0);
  });

  it('rejects a request with no Authorization header, without calling nev-api', async () => {
    const res = await rawRequest(port, { method: 'POST', body: INITIALIZE_BODY });

    expect(res.status).toBe(401);
    expect(mockFetch).not.toHaveBeenCalled();
    expect((await getHealth(port)).activeSessions).toBe(0);
  });

  it('rejects initialize when /auth/me returns 401, and creates no session', async () => {
    mockFetch.mockResolvedValue(mockFetchError(401));

    const res = await rawRequest(port, {
      method: 'POST',
      headers: { Authorization: 'Bearer invalid.token.here' },
      body: INITIALIZE_BODY,
    });

    expect(res.status).toBe(401);
    const parsed = JSON.parse(res.body) as { error: { message: string } };
    expect(parsed.error.message).toMatch(/invalid, expired, or unverifiable/i);
    expect((await getHealth(port)).activeSessions).toBe(0);
  });

  it('fails closed with 503 (not 401) and creates no session when /auth/me is unreachable', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    const res = await rawRequest(port, {
      method: 'POST',
      headers: { Authorization: 'Bearer some.token.here' },
      body: INITIALIZE_BODY,
    });

    expect(res.status).toBe(503);
    expect((await getHealth(port)).activeSessions).toBe(0);
  });

  it('rejects a request carrying an unknown session id when the token is unverified — the gate runs before session-existence dispatch', async () => {
    mockFetch.mockResolvedValue(mockFetchError(401));

    const res = await rawRequest(port, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer invalid.token.here',
        'Mcp-Session-Id': 'not-a-real-session-id',
      },
      body: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    });

    // Must be OUR verification-gate 401, not the transport's generic
    // "Bad Request: No valid session ID provided" 400 — proving the token
    // is checked before the code ever asks "does this session exist?".
    expect(res.status).toBe(401);
    const parsed = JSON.parse(res.body) as { error: { code: number; message: string } };
    expect(parsed.error.code).toBe(-32001);
    expect((await getHealth(port)).activeSessions).toBe(0);
  });

  it('lets a verified initialize request through to session dispatch and registers a session', async () => {
    mockFetch.mockResolvedValue(mockFetchOk({ id: 'user-1', tenantId: 'tenant-1', email: 'promoter@example.com' }));

    const res = await rawRequest(port, {
      method: 'POST',
      headers: { Authorization: 'Bearer valid.token.here' },
      body: INITIALIZE_BODY,
    });

    // Not the gate's 401 — the request reached the MCP transport.
    expect(res.status).not.toBe(401);
    expect((await getHealth(port)).activeSessions).toBe(1);
  });

  it('lets a verified SERVICE session through and registers a session', async () => {
    mockFetch.mockResolvedValue(
      mockFetchOk({
        id: 'svc-user',
        email: 'agent@service.nevent.invalid',
        role: 'ADMIN',
        tenantId: 'tenant-session',
        principalType: 'SERVICE',
        effectiveTenantId: 'tenant-session',
        serviceSession: { sessionId: 's1', channel: 'API', scope: 'TENANT', tenantId: 'tenant-session' },
      })
    );

    const res = await rawRequest(port, {
      method: 'POST',
      headers: { Authorization: 'Bearer service.token.here' },
      body: INITIALIZE_BODY,
    });

    expect(res.status).not.toBe(401);
    expect((await getHealth(port)).activeSessions).toBe(1);
  });

  it('rejects a SERVICE session that carries no effectiveTenantId, creating no session', async () => {
    mockFetch.mockResolvedValue(
      mockFetchOk({ id: 'svc-user', tenantId: 'x', principalType: 'SERVICE' })
    );

    const res = await rawRequest(port, {
      method: 'POST',
      headers: { Authorization: 'Bearer service.token.here' },
      body: INITIALIZE_BODY,
    });

    expect(res.status).toBe(401);
    expect((await getHealth(port)).activeSessions).toBe(0);
  });

  it('rejects an unknown principalType, creating no session', async () => {
    mockFetch.mockResolvedValue(mockFetchOk({ id: 'u', principalType: 'ROBOT', effectiveTenantId: 't' }));

    const res = await rawRequest(port, {
      method: 'POST',
      headers: { Authorization: 'Bearer weird.token.here' },
      body: INITIALIZE_BODY,
    });

    expect(res.status).toBe(401);
    expect((await getHealth(port)).activeSessions).toBe(0);
  });
});


describe('bearer-passthrough service key + verification rules (integration)', () => {
  let result: BearerPassthroughAppResult;
  let server: http.Server;
  let port: number;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    _clearVerificationCacheForTests();
    mockFetch = vi.fn(async () =>
      mockFetchOk({ id: 'user-1', tenantId: 'tenant-1', effectiveTenantId: 'tenant-1', principalType: 'HUMAN' })
    );
    vi.stubGlobal('fetch', mockFetch);
    result = await createBearerPassthroughApp({
      port: 0,
      neventApiUrl: 'https://api.nevent.es',
      dataApiUrl: 'https://data.nevent.es',
      serviceKeys: [SERVICE_KEY, PREVIOUS_KEY],
      tokenRateLimitPerMinute: 3,
    });
    await new Promise<void>((resolve) => {
      server = result.app.listen(0, '127.0.0.1', resolve);
    });
    port = (server.address() as AddressInfo).port;
    currentResult = result;
  });

  afterEach(async () => {
    await result.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.restoreAllMocks();
  });

  /** Request WITHOUT the default service-key header (caller controls it). */
  function send(headers: Record<string, string>, body: unknown = INITIALIZE_BODY): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
        }
      );
      req.on('error', reject);
      req.write(JSON.stringify(body));
      req.end();
    });
  }

  it('rejects a missing service key with a detail-free 401 and never calls nev-api', async () => {
    const res = await send({ Authorization: 'Bearer valid.token.here' });

    expect(res.status).toBe(401);
    expect(JSON.parse(res.body).error.message).toBe('Unauthorized.');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects a wrong service key (same status and body as a missing one) and never calls nev-api', async () => {
    const missing = await send({ Authorization: 'Bearer valid.token.here' });
    const wrong = await send({ Authorization: 'Bearer valid.token.here', 'X-Nevent-Service-Key': 'x'.repeat(40) });
    const short = await send({ Authorization: 'Bearer valid.token.here', 'X-Nevent-Service-Key': 'k' });

    for (const res of [wrong, short]) {
      expect(res.status).toBe(401);
      expect(res.body).toBe(missing.body);
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('checks the service key before the bearer header (no key + no bearer -> still the generic 401)', async () => {
    const res = await send({});
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body).error.message).toBe('Unauthorized.');
  });

  it('accepts the current key and the previous key (rotation window)', async () => {
    const current = await send({ Authorization: 'Bearer a.b.c', 'X-Nevent-Service-Key': SERVICE_KEY });
    const previous = await send({ Authorization: 'Bearer d.e.f', 'X-Nevent-Service-Key': PREVIOUS_KEY });
    expect(current.status).not.toBe(401);
    expect(previous.status).not.toBe(401);
    expect((await getHealth(port)).activeSessions).toBe(2);
  });

  it('rejects a SERVICE session with PLATFORM scope (only TENANT is accepted)', async () => {
    mockFetch.mockResolvedValue(
      mockFetchOk({
        id: 'svc-user',
        principalType: 'SERVICE',
        tenantId: 't1',
        effectiveTenantId: 't1',
        serviceSession: { sessionId: 's', channel: 'API', scope: 'PLATFORM', tenantId: 't1' },
      })
    );
    const res = await send({ Authorization: 'Bearer svc.platform.token', ...KEY_HEADER });
    expect(res.status).toBe(401);
    expect((await getHealth(port)).activeSessions).toBe(0);
  });

  it('rejects any session for which nev-api reports no tenant (no JWT-claim fallback)', async () => {
    const jwtWithTenantClaim = fakeJwt({ sub: 'user-1', tenantId: 'tenant-from-claim', exp: Math.floor(Date.now() / 1000) + 600 });
    mockFetch.mockResolvedValue(mockFetchOk({ id: 'user-1', principalType: 'HUMAN' }));

    const res = await send({ Authorization: `Bearer ${jwtWithTenantClaim}`, ...KEY_HEADER });

    expect(res.status).toBe(401);
    expect((await getHealth(port)).activeSessions).toBe(0);
  });

  it('rate-limits per token: one noisy token gets 429 while another token is unaffected', async () => {
    const noisy = { Authorization: 'Bearer noisy.token.aaa', ...KEY_HEADER };
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await send(noisy, { jsonrpc: '2.0', id: i, method: 'ping' })).status);
    expect(statuses.slice(0, 3)).not.toContain(429);
    expect(statuses.slice(3)).toEqual([429, 429]);

    const other = await send({ Authorization: 'Bearer quiet.token.bbb', ...KEY_HEADER });
    expect(other.status).not.toBe(429);
  });

  it('serves a minimal /health (status, version, commitSha) and nothing else, without a key', async () => {
    const { status, body } = await getHealthPublic(port);
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['commitSha', 'status', 'version']);
    expect(body['status']).toBe('ok');
  });

  it('rejects an anonymous request before parsing its body: malformed JSON without a key is a 401, not a 400', async () => {
    const res = await new Promise<RawResponse>((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port, path: '/', method: 'POST', headers: { 'Content-Type': 'application/json' } },
        (r) => {
          let d = '';
          r.on('data', (c) => (d += c));
          r.on('end', () => resolve({ status: r.statusCode ?? 0, body: d }));
        }
      );
      req.on('error', reject);
      req.end('{not json');
    });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body).error.message).toBe('Unauthorized.');
  });

  it('answers malformed JSON from an authorised caller with a clean JSON-RPC parse error', async () => {
    const res = await new Promise<RawResponse>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...KEY_HEADER, Authorization: 'Bearer a.b.c' },
        },
        (r) => {
          let d = '';
          r.on('data', (c) => (d += c));
          r.on('end', () => resolve({ status: r.statusCode ?? 0, body: d }));
        }
      );
      req.on('error', reject);
      req.end('{not json');
    });
    expect(res.status).toBe(400);
    const parsed = JSON.parse(res.body) as { jsonrpc: string; error: { code: number } };
    expect(parsed.error.code).toBe(-32700);
    expect(res.body).not.toMatch(/<html|at .*\.js/i);
  });

  it('does not call /auth/me again for a token nev-api just rejected (negative cache)', async () => {
    mockFetch.mockResolvedValue(mockFetchError(401));
    const headers = { Authorization: 'Bearer bad.token.zzz', ...KEY_HEADER };

    const first = await send(headers);
    const second = await send(headers);

    expect([first.status, second.status]).toEqual([401, 401]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Session binding (principal + tenant) and token rotation
// ---------------------------------------------------------------------------

interface RawResponseH extends RawResponse {
  headers: http.IncomingHttpHeaders;
}

function rawRequestH(
  port: number,
  options: { method: string; headers?: Record<string, string>; body?: unknown }
): Promise<RawResponseH> {
  return new Promise((resolve, reject) => {
    const payload = options.body !== undefined ? JSON.stringify(options.body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/',
        method: options.method,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...KEY_HEADER,
          ...options.headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers }));
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('bearer-passthrough session binding (integration)', () => {
  let result: BearerPassthroughAppResult;
  let server: http.Server;
  let port: number;
  let mockFetch: ReturnType<typeof vi.fn>;

  /** token -> /auth/me body; any other /auth/me call is a 401. */
  let identities: Record<string, Record<string, unknown>>;
  /** Authorization headers seen on calls to /events (the downstream tool call). */
  let eventsAuth: string[];

  beforeEach(async () => {
    _clearVerificationCacheForTests();
    identities = {};
    eventsAuth = [];
    mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
      const auth = ((init?.headers ?? {}) as Record<string, string>)['Authorization'] ?? '';
      const token = auth.replace(/^Bearer\s+/i, '');
      if (String(url).endsWith('/auth/me')) {
        const body = identities[token];
        return body ? mockFetchOk(body) : mockFetchError(401);
      }
      if (String(url).includes('/events')) eventsAuth.push(auth);
      return mockFetchOk({ content: [], totalElements: 0, totalPages: 0 });
    });
    vi.stubGlobal('fetch', mockFetch);

    result = await createBearerPassthroughApp({
      port: 0,
      neventApiUrl: 'https://api.nevent.es',
      dataApiUrl: 'https://data.nevent.es',
      serviceKeys: [SERVICE_KEY, PREVIOUS_KEY],
      tokenRateLimitPerMinute: 1000,
    });
    await new Promise<void>((resolve) => {
      server = result.app.listen(0, '127.0.0.1', resolve);
    });
    port = (server.address() as AddressInfo).port;
    currentResult = result;
  });

  afterEach(async () => {
    await result.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.restoreAllMocks();
  });

  async function openSession(token: string): Promise<string> {
    const res = await rawRequestH(port, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: INITIALIZE_BODY,
    });
    const sid = res.headers['mcp-session-id'];
    expect(typeof sid).toBe('string');
    return sid as string;
  }

  function listEvents(sid: string, token: string): Promise<RawResponseH> {
    return rawRequestH(port, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Mcp-Session-Id': sid },
      body: { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'nevent_list_events', arguments: {} } },
    });
  }

  const NOW = Math.floor(Date.now() / 1000);
  /** Fake JWT with a given lifetime; the name makes tokens distinct. */
  const jwt = (name: string, ttlSec = 3600): string => fakeJwt({ sub: name, n: name, exp: NOW + ttlSec });

  /** Memoised so the same name always yields the same token string. */
  const tokens = new Map<string, string>();
  const T = (name: string, ttlSec = 3600): string => {
    const key = `${name}:${ttlSec}`;
    if (!tokens.has(key)) tokens.set(key, jwt(name, ttlSec));
    return tokens.get(key)!;
  };

  const human = (id: string, tenant: string) => ({
    id,
    role: 'OWNER',
    tenantId: tenant,
    effectiveTenantId: tenant,
    principalType: 'HUMAN',
  });

  it('rejects a foreign session driven by another user\'s valid token (403, nothing dispatched)', async () => {
    identities[T('tok-a')] = human('user-a', 'tenant-1');
    identities[T('tok-b')] = human('user-b', 'tenant-1');
    const sid = await openSession(T('tok-a'));

    const res = await listEvents(sid, T('tok-b'));

    expect(res.status).toBe(403);
    expect(eventsAuth).toEqual([]);
  });

  it('rejects the same user presenting a token for a different effective tenant', async () => {
    identities[T('tok-t1')] = human('user-a', 'tenant-1');
    identities[T('tok-t2')] = human('user-a', 'tenant-2');
    const sid = await openSession(T('tok-t1'));

    const res = await listEvents(sid, T('tok-t2'));

    expect(res.status).toBe(403);
    expect(eventsAuth).toEqual([]);
  });

  it('rejects GET and DELETE on a foreign session too', async () => {
    identities[T('tok-a')] = human('user-a', 'tenant-1');
    identities[T('tok-b')] = human('user-b', 'tenant-1');
    const sid = await openSession(T('tok-a'));

    for (const method of ['GET', 'DELETE']) {
      const res = await rawRequestH(port, {
        method,
        headers: { Authorization: `Bearer ${T('tok-b')}`, 'Mcp-Session-Id': sid },
      });
      expect(res.status, method).toBe(403);
    }
    expect((await getHealth(port)).activeSessions).toBe(1);
  });

  it('rejects a service token of the same tenant against a human session (principal type mismatch)', async () => {
    identities[T('tok-a')] = human('user-a', 'tenant-1');
    identities[T('tok-svc')] = {
      id: 'user-a',
      principalType: 'SERVICE',
      tenantId: 'tenant-1',
      effectiveTenantId: 'tenant-1',
      serviceSession: { sessionId: 'S', channel: 'API', scope: 'TENANT', tenantId: 'tenant-1' },
    };
    const sid = await openSession(T('tok-a'));

    expect((await listEvents(sid, T('tok-svc'))).status).toBe(403);
  });

  it('uses the original token while the same token is presented', async () => {
    identities[T('tok-a')] = human('user-a', 'tenant-1');
    const sid = await openSession(T('tok-a'));

    const res = await listEvents(sid, T('tok-a'));

    expect(res.status).toBe(200);
    expect(eventsAuth).toEqual([`Bearer ${T('tok-a')}`]);
  });

  it('accepts the same principal with a new valid token and uses the new token downstream', async () => {
    identities[T('tok-old')] = human('user-a', 'tenant-1');
    identities[T('tok-new', 7200)] = human('user-a', 'tenant-1');
    const sid = await openSession(T('tok-old'));

    const res = await listEvents(sid, T('tok-new', 7200));

    expect(res.status).toBe(200);
    expect(eventsAuth).toEqual([`Bearer ${T('tok-new', 7200)}`]);
  });

  it('does not roll a session back to an older token of the same principal (rotate only to a longer-lived one)', async () => {
    identities[T('tok-long', 7200)] = human('user-a', 'tenant-1');
    identities[T('tok-short', 600)] = human('user-a', 'tenant-1');
    const sid = await openSession(T('tok-long', 7200));

    const res = await listEvents(sid, T('tok-short', 600));

    expect(res.status).toBe(200);
    expect(eventsAuth).toEqual([`Bearer ${T('tok-long', 7200)}`]);
  });

  it('accepts a re-minted service session (new token, same technical user and tenant) and rotates to it', async () => {
    const svc = {
      id: 'svc-user',
      principalType: 'SERVICE',
      tenantId: 'tenant-1',
      effectiveTenantId: 'tenant-1',
      serviceSession: { sessionId: 'S1', channel: 'API', scope: 'TENANT', tenantId: 'tenant-1' },
    };
    identities[T('svc-1')] = svc;
    identities[T('svc-2', 7200)] = { ...svc, serviceSession: { ...svc.serviceSession, sessionId: 'S2' } };
    const sid = await openSession(T('svc-1'));

    const res = await listEvents(sid, T('svc-2', 7200));

    expect(res.status).toBe(200);
    expect(eventsAuth).toEqual([`Bearer ${T('svc-2', 7200)}`]);
  });

  it('rejects an invalid new token on an existing session before binding (401, token not rotated)', async () => {
    identities[T('tok-a')] = human('user-a', 'tenant-1');
    const sid = await openSession(T('tok-a'));

    const res = await listEvents(sid, T('tok-unknown'));
    expect(res.status).toBe(401);

    await listEvents(sid, T('tok-a'));
    expect(eventsAuth).toEqual([`Bearer ${T('tok-a')}`]);
  });
});
