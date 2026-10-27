/**
 * NEV-1848 (a): per-OAuth-client read-only restriction.
 *
 * Covers the pure policy (client identification + tool allowlist) and the
 * real MCP behaviour over an in-memory transport: a restricted client can
 * neither list nor call write / delete / tenant tools, even by name; a normal
 * client is unchanged.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  getClientRestrictionPolicy,
  hasClientRestrictions,
  isReadOnlyClient,
  isToolAllowedForReadOnlyClient,
  resolveToolFilterForClient,
} from '../config/client-restrictions.js';
import { getToolOperationType } from '../config/operation-mode.js';
import { createNeventServer, getToolCount } from '../server.js';
import { DataClient } from '../clients/data-client.js';
import { PaidMediaClient } from '../clients/paid-media-client.js';
import { SessionClients } from '../clients/session-clients.js';

const HELPBOT_URI = 'https://support.nevent.ai/helpbot/oauth/callback';

describe('client restriction policy', () => {
  it('is empty when no env var is set (no behaviour change for anyone)', () => {
    const policy = getClientRestrictionPolicy({});
    expect(hasClientRestrictions(policy)).toBe(false);
    expect(isReadOnlyClient({ client_id: 'x', redirect_uris: [HELPBOT_URI] }, policy)).toBe(false);
  });

  it('restricts a client whose redirect_uri starts with a configured prefix', () => {
    const policy = getClientRestrictionPolicy({
      MCP_READONLY_REDIRECT_PREFIXES: ' https://support.nevent.ai/helpbot/ , https://other.example/bot/ ',
    });
    expect(isReadOnlyClient({ client_id: 'a', redirect_uris: [HELPBOT_URI] }, policy)).toBe(true);
    expect(isReadOnlyClient({ client_id: 'a', redirect_uris: [new URL('https://other.example/bot/cb')] }, policy)).toBe(true);
  });

  it('restricts when ANY registered redirect_uri matches', () => {
    const policy = getClientRestrictionPolicy({ MCP_READONLY_REDIRECT_PREFIXES: 'https://support.nevent.ai/helpbot/' });
    expect(
      isReadOnlyClient({ client_id: 'a', redirect_uris: ['https://claude.ai/api/mcp/auth_callback', HELPBOT_URI] }, policy)
    ).toBe(true);
  });

  it('does not restrict other clients (claude.ai, lookalike hosts)', () => {
    const policy = getClientRestrictionPolicy({ MCP_READONLY_REDIRECT_PREFIXES: 'https://support.nevent.ai/helpbot/' });
    for (const uri of [
      'https://claude.ai/api/mcp/auth_callback',
      'https://support.nevent.ai.evil.com/helpbot/cb',
      'https://support.nevent.ai/other/cb',
      'http://localhost:3000/callback',
    ]) {
      expect(isReadOnlyClient({ client_id: 'c', redirect_uris: [uri] }, policy)).toBe(false);
    }
    expect(isReadOnlyClient({ client_id: 'c' }, policy)).toBe(false);
  });

  it('restricts by exact client_id', () => {
    const policy = getClientRestrictionPolicy({ MCP_READONLY_CLIENT_IDS: 'bot-1, bot-2' });
    expect(isReadOnlyClient({ client_id: 'bot-2', redirect_uris: [] }, policy)).toBe(true);
    expect(isReadOnlyClient({ client_id: 'bot-3', redirect_uris: [] }, policy)).toBe(false);
  });
});

describe('resolveToolFilterForClient', () => {
  const rules = getClientRestrictionPolicy({ MCP_READONLY_REDIRECT_PREFIXES: 'https://support.nevent.ai/helpbot/' });
  const none = getClientRestrictionPolicy({});

  it('no rules: undefined and the client is never loaded', async () => {
    let calls = 0;
    const f = await resolveToolFilterForClient('c', async () => { calls++; return undefined; }, none);
    expect(f).toBeUndefined();
    expect(calls).toBe(0);
  });

  it('helpbot client gets the read-only filter; claude.ai client gets none', async () => {
    const bot = await resolveToolFilterForClient('bot', async () => ({ client_id: 'bot', redirect_uris: [HELPBOT_URI] }), rules);
    expect(bot).toBe(isToolAllowedForReadOnlyClient);
    const claude = await resolveToolFilterForClient('c', async () => ({ client_id: 'c', redirect_uris: ['https://claude.ai/cb'] }), rules);
    expect(claude).toBeUndefined();
  });

  it('fail-closed when the client is unknown, missing or the lookup throws', async () => {
    expect(await resolveToolFilterForClient('x', async () => undefined, rules)).toBe(isToolAllowedForReadOnlyClient);
    expect(await resolveToolFilterForClient(undefined, async () => undefined, rules)).toBe(isToolAllowedForReadOnlyClient);
    expect(await resolveToolFilterForClient('x', async () => { throw new Error('mongo down'); }, rules)).toBe(isToolAllowedForReadOnlyClient);
  });
});

describe('read-only tool allowlist', () => {
  it('allows READ tools and denies WRITE / DELETE tools', () => {
    expect(isToolAllowedForReadOnlyClient('nevent_list_campaigns')).toBe(true);
    expect(isToolAllowedForReadOnlyClient('nevent_segment_preview')).toBe(true);
    expect(isToolAllowedForReadOnlyClient('nevent_help')).toBe(true);
    for (const t of [
      'nevent_create_campaign', 'nevent_schedule_campaign', 'nevent_create_segment',
      'nevent_update_template', 'nevent_send_test_template', 'nevent_upload_image',
      'nevent_delete_image', 'nevent_create_short_url',
    ]) {
      expect(isToolAllowedForReadOnlyClient(t), t).toBe(false);
    }
  });

  it('denies tenant tools and PII segment export even though they are classified READ', () => {
    for (const t of ['nevent_list_tenants', 'nevent_switch_tenant', 'nevent_reset_tenant', 'nevent_segment_execute']) {
      expect(isToolAllowedForReadOnlyClient(t), t).toBe(false);
    }
  });

  it('is fail-closed: an unclassified tool is denied', () => {
    expect(getToolOperationType('nevent_brand_new_tool')).toBeUndefined();
    expect(isToolAllowedForReadOnlyClient('nevent_brand_new_tool')).toBe(false);
  });
});

function buildServer(toolFilter?: (n: string) => boolean) {
  const dataClient = new DataClient({ baseUrl: 'http://stub', jwtToken: 'stub' });
  const paid = new PaidMediaClient({ baseUrl: 'http://stub', jwtToken: 'stub' });
  return createNeventServer({
    dataClient,
    neventApiUrl: 'http://stub',
    mongoUri: 'mongodb://stub',
    paidMediaClient: paid,
    sessionClients: new SessionClients(dataClient, paid, 'http://stub'),
    enableToolCallLogging: false,
    toolFilter,
  });
}

const clients: Client[] = [];
async function connect(toolFilter?: (n: string) => boolean): Promise<Client> {
  const server = buildServer(toolFilter);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  clients.push(client);
  return client;
}
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

describe('restricted session over MCP', () => {
  it('lists only READ, non-tenant tools', async () => {
    const client = await connect(isToolAllowedForReadOnlyClient);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) {
      expect(getToolOperationType(n), n).toBe('READ');
      expect(isToolAllowedForReadOnlyClient(n), n).toBe(true);
    }
    for (const hidden of [
      'nevent_create_campaign', 'nevent_schedule_campaign', 'nevent_delete_image',
      'nevent_list_tenants', 'nevent_switch_tenant', 'nevent_reset_tenant', 'nevent_segment_execute',
    ]) {
      expect(names).not.toContain(hidden);
    }
    expect(names).toContain('nevent_list_campaigns');
  });

  it('rejects tools/call by name for write, delete, tenant and unknown tools', async () => {
    const client = await connect(isToolAllowedForReadOnlyClient);
    for (const name of [
      'nevent_create_campaign', 'nevent_schedule_campaign', 'nevent_delete_image',
      'nevent_switch_tenant', 'nevent_list_tenants', 'nevent_reset_tenant', 'nevent_brand_new_tool',
    ]) {
      let rejected = false;
      try {
        const res = await client.callTool({ name, arguments: {} });
        rejected = res.isError === true;
      } catch {
        rejected = true;
      }
      expect(rejected, name).toBe(true);
    }
  });

  it('getToolCount honours the filter', () => {
    const base = { hasNeventApiUrl: true, hasMongoUri: true, hasPaidMediaClient: true, hasShortUrlClient: true };
    const all = getToolCount(base);
    const restricted = getToolCount({ ...base, toolFilter: isToolAllowedForReadOnlyClient });
    expect(restricted).toBeLessThan(all);
    expect(restricted).toBeGreaterThan(0);
  });
});

describe('normal session over MCP (regression)', () => {
  it('still lists write and tenant tools', async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const present of ['nevent_create_campaign', 'nevent_schedule_campaign', 'nevent_switch_tenant', 'nevent_list_tenants', 'nevent_segment_execute']) {
      expect(names).toContain(present);
    }
  });
});

describe('tool classification completeness', () => {
  it('every registered tool is classified, so none is silently hidden from or exposed to restricted clients', async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    const unclassified = names.filter((n) => getToolOperationType(n) === undefined);
    expect(unclassified).toEqual([]);
  });
});
