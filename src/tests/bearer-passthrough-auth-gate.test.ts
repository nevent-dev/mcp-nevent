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

function getHealth(port: number): Promise<{ activeSessions: number }> {
  return new Promise((resolve, reject) => {
    http
      .get({ hostname: '127.0.0.1', port, path: '/health' }, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(JSON.parse(data)));
      })
      .on('error', reject);
  });
}

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
    });

    await new Promise<void>((resolve) => {
      server = result.app.listen(0, '127.0.0.1', resolve);
    });
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await result.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.restoreAllMocks();
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

  it('fails closed and creates no session when /auth/me times out / errors', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    const res = await rawRequest(port, {
      method: 'POST',
      headers: { Authorization: 'Bearer some.token.here' },
      body: INITIALIZE_BODY,
    });

    expect(res.status).toBe(401);
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
});
