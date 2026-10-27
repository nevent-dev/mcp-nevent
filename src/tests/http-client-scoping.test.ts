/**
 * NEV-1848 wiring tests for `createHttpApp`: per-client tool restriction at
 * session creation and session-to-client binding. MongoDB is replaced by an
 * in-memory stub; everything else (Express app, SDK auth middleware, token
 * verification, MCP transport, tool registration) is real.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const registeredClients = new Map<string, { client_id: string; redirect_uris: string[] }>();
let failClientLookup = false;

vi.mock('../auth/oauth-stores.js', () => ({
  createOAuthStores: async () => ({
    clients: {
      getClient: async (id: string) => {
        if (failClientLookup) throw new Error('mongo down');
        return registeredClients.get(id);
      },
      registerClient: async (c: unknown) => c,
    },
    authCodes: {},
    refreshTokens: {},
    mongoClient: { close: async () => undefined },
  }),
}));

// Tool-call logging would open a MongoDB connection; it is irrelevant here.
vi.mock('../tools/logging.js', () => ({
  createToolCallLogger: () => ({ warmUp: async () => undefined }),
  applyLoggingToServer: () => undefined,
}));

import { createHttpApp } from '../transports/http.js';
import { TokenService } from '../auth/token-service.js';
import { clearClientLookupCache } from '../config/client-restrictions.js';

const SECRET = 'wiring-test-secret-wiring-test-secret';
const HELPBOT_PREFIX = 'https://support.nevent.ai/helpbot/';
const WRITE_TOOLS = ['nevent_create_campaign', 'nevent_schedule_campaign', 'nevent_create_segment', 'nevent_delete_image'];
const TENANT_TOOLS = ['nevent_list_tenants', 'nevent_switch_tenant', 'nevent_reset_tenant'];

let server: Server;
let baseUrl: string;
let shutdown: () => Promise<void>;

function tokenFor(clientId: string): string {
  return new TokenService(SECRET).generateAccessToken({
    userId: 'user-1', email: 'u@nevent.es', role: 'ADMIN', tenantId: 't1', clientId, scopes: ['mcp:tools'],
  }).accessToken;
}

async function connect(clientId: string): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
    requestInit: { headers: { Authorization: `Bearer ${tokenFor(clientId)}` } },
  });
  const client = new Client({ name: 'wiring-test', version: '0.0.0' });
  await client.connect(transport);
  return { client, transport };
}

beforeAll(async () => {
  const result = await createHttpApp({
    port: 0,
    mcpServerUrl: new URL('http://localhost'),
    jwtSecret: SECRET,
    mongoUri: 'mongodb://stub',
    neventApiUrl: 'http://stub-nev-api',
    dataApiUrl: 'http://stub-data-api',
  });
  shutdown = result.shutdown;
  await new Promise<void>((resolve) => {
    server = result.app.listen(0, '127.0.0.1', () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

afterAll(async () => {
  await shutdown();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const open: Client[] = [];
beforeEach(() => {
  registeredClients.clear();
  registeredClients.set('bot', { client_id: 'bot', redirect_uris: [`${HELPBOT_PREFIX}oauth/callback`] });
  registeredClients.set('claude', { client_id: 'claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] });
  failClientLookup = false;
  clearClientLookupCache();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.allSettled(open.splice(0).map((c) => c.close()));
});

async function listNames(clientId: string): Promise<string[]> {
  const { client } = await connect(clientId);
  open.push(client);
  return (await client.listTools()).tools.map((t) => t.name);
}

describe('createHttpApp — restricted client session', () => {
  beforeEach(() => vi.stubEnv('MCP_READONLY_REDIRECT_PREFIXES', HELPBOT_PREFIX));

  it('helpbot client: tools/list shows no write, delete or tenant tools but keeps read tools', async () => {
    const names = await listNames('bot');
    for (const t of [...WRITE_TOOLS, ...TENANT_TOOLS]) expect(names, t).not.toContain(t);
    expect(names).toContain('nevent_list_campaigns');
    expect(names).toContain('nevent_segment_execute');
  });

  it('helpbot client: calling a write tool by name is rejected', async () => {
    const { client } = await connect('bot');
    open.push(client);
    let rejected = false;
    try {
      const res = await client.callTool({ name: 'nevent_create_campaign', arguments: {} });
      rejected = res.isError === true;
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });

  it('another client (claude.ai) is unchanged even while rules are configured', async () => {
    const names = await listNames('claude');
    for (const t of [...WRITE_TOOLS, ...TENANT_TOOLS]) expect(names, t).toContain(t);
  });

  it('fail-closed: an unknown client id, or a failing lookup, gets read-only tools', async () => {
    let names = await listNames('ghost');
    expect(names).not.toContain('nevent_create_campaign');
    clearClientLookupCache();
    failClientLookup = true;
    names = await listNames('claude');
    expect(names).not.toContain('nevent_create_campaign');
    expect(names).toContain('nevent_list_campaigns');
  });
});

describe('createHttpApp — no restriction variables (regression)', () => {
  it('every client, including the helpbot one, sees the full tool set and the client store is not consulted', async () => {
    failClientLookup = true; // would restrict everyone if a lookup happened
    const botNames = await listNames('bot');
    const claudeNames = await listNames('claude');
    expect(botNames).toEqual(claudeNames);
    for (const t of [...WRITE_TOOLS, ...TENANT_TOOLS]) expect(claudeNames, t).toContain(t);
  });
});

describe('createHttpApp — session binding', () => {
  it('returns 403 on POST, GET and DELETE when the token belongs to another client', async () => {
    const { client, transport } = await connect('claude');
    open.push(client);
    const sessionId = transport.sessionId!;
    expect(sessionId).toBeTruthy();

    const intruder = {
      Authorization: `Bearer ${tokenFor('bot')}`,
      'Mcp-Session-Id': sessionId,
    };
    const post = await fetch(baseUrl, {
      method: 'POST',
      headers: { ...intruder, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list' }),
    });
    expect(post.status).toBe(403);

    const get = await fetch(baseUrl, { method: 'GET', headers: { ...intruder, Accept: 'text/event-stream' } });
    expect(get.status).toBe(403);

    const del = await fetch(baseUrl, { method: 'DELETE', headers: intruder });
    expect(del.status).toBe(403);

    // The owner is unaffected and the session is still alive after the failed attempts.
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
  });
});
