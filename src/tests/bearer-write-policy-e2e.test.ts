/**
 * NEV-1854 — end-to-end wiring: the principal verified by `/auth/me` at
 * `initialize` decides the tool list the session gets over the real HTTP app,
 * and a denied write is rejected without executing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Call-time operation-mode guard: the write tools must be able to execute.
vi.hoisted(() => {
  process.env['NEVENT_OPERATION_MODE'] = 'FULL';
});
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createBearerPassthroughApp, type BearerPassthroughAppResult } from '../transports/http-bearer-passthrough.js';
import { _clearVerificationCacheForTests } from '../auth/session-verifier.js';
import type { BearerWritesMode } from '../config/bearer-passthrough.js';

const SERVICE_KEY = 'k'.repeat(40);

const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const fakeJwt = (name: string) =>
  `${enc({ alg: 'none', typ: 'JWT' })}.${enc({ sub: name, exp: Math.floor(Date.now() / 1000) + 3600 })}.`;

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } },
};

interface Resp { status: number; headers: http.IncomingHttpHeaders; body: string }

function post(port: number, token: string, body: unknown, sid?: string): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1', port, path: '/', method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'X-Nevent-Service-Key': SERVICE_KEY,
          Authorization: `Bearer ${token}`,
          ...(sid ? { 'Mcp-Session-Id': sid } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
      }
    );
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

/** Extracts the JSON-RPC message from an SSE or plain JSON body. */
function rpc(body: string): { result?: any; error?: any } {
  const line = body.split('\n').find((l) => l.startsWith('data:'));
  return JSON.parse(line ? line.slice(5).trim() : body);
}

describe('bearer-passthrough write policy over HTTP', () => {
  let result: BearerPassthroughAppResult;
  let server: http.Server;
  let port: number;
  const identities: Record<string, Record<string, unknown>> = {};
  let sideEffectCalls: string[];

  async function start(writesMode?: BearerWritesMode, writesPerHour?: number) {
    result = await createBearerPassthroughApp({
      port: 0,
      neventApiUrl: 'https://api.nevent.es',
      dataApiUrl: 'https://data.nevent.es',
      serviceKeys: [SERVICE_KEY],
      tokenRateLimitPerMinute: 1000,
      ...(writesMode ? { writesMode } : {}),
      writesStartup: { env: { MCP_BEARER_PASSTHROUGH_WRITES_UNSAFE_NO_GRANT: 'true' }, grantAvailable: false, operationMode: 'FULL' },
      ...(writesPerHour ? { writesPerHour } : {}),
    });
    await new Promise<void>((r) => { server = result.app.listen(0, '127.0.0.1', r); });
    port = (server.address() as AddressInfo).port;
  }

  beforeEach(() => {
    _clearVerificationCacheForTests();
    sideEffectCalls = [];
    for (const k of Object.keys(identities)) delete identities[k];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/auth/me')) {
        const auth = ((init?.headers ?? {}) as Record<string, string>)['Authorization'] ?? '';
        const body = identities[auth.replace(/^Bearer\s+/i, '')];
        return body
          ? ({ ok: true, status: 200, json: async () => body } as Response)
          : ({ ok: false, status: 401, json: async () => ({}) } as Response);
      }
      sideEffectCalls.push(String(url));
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }));
  });

  afterEach(async () => {
    await result.shutdown();
    await new Promise<void>((r) => server.close(() => r()));
    vi.restoreAllMocks();
  });

  async function toolsFor(token: string): Promise<{ sid: string; names: string[] }> {
    const init = await post(port, token, INITIALIZE);
    const sid = init.headers['mcp-session-id'] as string;
    await post(port, token, { jsonrpc: '2.0', method: 'notifications/initialized' }, sid);
    const list = await post(port, token, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, sid);
    const names = (rpc(list.body).result.tools as { name: string }[]).map((t) => t.name).sort();
    return { sid, names };
  }

  const principals = (): { human: string; service: string } => {
    const human = fakeJwt('human');
    const service = fakeJwt('service');
    identities[human] = { id: 'u1', role: 'OWNER', tenantId: 't1', effectiveTenantId: 't1', principalType: 'HUMAN' };
    identities[service] = {
      id: 'svc1', role: 'ADMIN', tenantId: 't1', effectiveTenantId: 't1', principalType: 'SERVICE',
      serviceSession: { sessionId: 's', channel: 'API', scope: 'TENANT', tenantId: 't1' },
    };
    return { human, service };
  };

  it('default (no flag): HUMAN and SERVICE both get READ only', async () => {
    await start();
    const { human, service } = principals();
    const h = await toolsFor(human);
    const s = await toolsFor(service);
    // 38 = READ tools available without MONGODB_URI (46 with it).
    expect(h.names).toHaveLength(38);
    expect(s.names).toEqual(h.names);
    expect(h.names).not.toContain('nevent_create_campaign');
  });

  it('writes=human: HUMAN gets the READ set plus the writes, SERVICE stays READ-only', async () => {
    await start('human');
    const { human, service } = principals();
    const h = await toolsFor(human);
    const s = await toolsFor(service);
    // Without MONGODB_URI the template writes are not registered: 38 READ + 7 writes
    // (the full 46 + 12 = 58 with Mongo is pinned in bearer-write-policy-snapshot.test.ts).
    expect(h.names).toHaveLength(45);
    expect(h.names).toContain('nevent_schedule_campaign');
    expect(h.names).toContain('nevent_create_segment');
    expect(h.names).not.toContain('nevent_upload_image');
    expect(s.names).toHaveLength(38);
    expect(s.names).not.toContain('nevent_create_campaign');
  });

  it('writes=human: a SERVICE session calling a write gets an error and nothing reaches nev-api', async () => {
    await start('human');
    const { service } = principals();
    const { sid } = await toolsFor(service);
    const res = await post(port, service, {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'nevent_create_segment', arguments: { name: 'x' } },
    }, sid);
    const msg = rpc(res.body);
    expect(msg.error ?? msg.result?.isError).toBeTruthy();
    expect(sideEffectCalls).toEqual([]);
  });

  const call = (token: string, sid: string, id: number, name: string, args: Record<string, unknown> = {}) =>
    post(port, token, { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, sid);
  // Schema-valid arguments: the SDK validates BEFORE the handler, and calls
  // rejected for invalid arguments never reach the (counted) handler.
  const SEGMENT_ARGS = {
    name: 'VIP',
    definition: { stanzas: [{ criteria: [{ criterion_id: 'event_attended', operator: 'is', value: 'E1' }] }] },
  };

  it('writes=human: the hourly write limit applies per user to writes only, across sessions', async () => {
    await start('human', 1);
    const { human } = principals();
    const first = await toolsFor(human);
    // Spend the single write of the budget (outcome irrelevant: it is counted).
    await call(human, first.sid, 10, 'nevent_create_segment', SEGMENT_ARGS);
    const limited = rpc((await call(human, first.sid, 11, 'nevent_create_segment', SEGMENT_ARGS)).body);
    const text = limited.result.content[0].text as string;
    expect(limited.result.isError).toBe(true);
    expect(JSON.parse(text).error.code).toBe('write_rate_limit_exceeded');

    // A brand-new session of the same user does not reset the budget.
    const second = await toolsFor(human);
    const again = rpc((await call(human, second.sid, 12, 'nevent_create_segment', SEGMENT_ARGS)).body);
    expect(JSON.parse(again.result.content[0].text).error.code).toBe('write_rate_limit_exceeded');

    // READ is never limited by the write budget.
    const read = rpc((await call(human, second.sid, 13, 'nevent_list_segments')).body);
    const readCode = read.result?.isError ? JSON.parse(read.result.content[0].text).error?.code : undefined;
    expect(readCode).not.toBe('write_rate_limit_exceeded');
  });

  it('writes=human: a call rejected for invalid arguments does not consume the budget', async () => {
    await start('human', 1);
    const { human } = principals();
    const { sid } = await toolsFor(human);
    // Invalid args: rejected by the SDK before the handler -> not counted.
    await call(human, sid, 20, 'nevent_create_segment', {});
    const ok = rpc((await call(human, sid, 21, 'nevent_create_segment', SEGMENT_ARGS)).body);
    const code = ok.result?.isError ? JSON.parse(ok.result.content[0].text).error?.code : undefined;
    expect(code).not.toBe('write_rate_limit_exceeded');
    // That valid call used the only unit of the budget.
    const limited = rpc((await call(human, sid, 22, 'nevent_create_segment', SEGMENT_ARGS)).body);
    expect(JSON.parse(limited.result.content[0].text).error.code).toBe('write_rate_limit_exceeded');
  });
});
