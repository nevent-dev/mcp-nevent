/**
 * NEV-1854 criterion 5 — per-principal hourly write limit and principal
 * recorded in the tool-call log, for bearer-passthrough.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  WriteRateLimiter,
  parseWritesPerHour,
  applyWriteRateLimit,
  DEFAULT_WRITES_PER_HOUR,
} from '../tools/write-rate-limit.js';
import { applyLoggingToServer, type ToolCallLogger } from '../tools/logging.js';
import type { DataClient } from '../clients/data-client.js';

const HOUR = 3_600_000;

describe('WriteRateLimiter', () => {
  it('allows up to max in the window and then reports retry-after', () => {
    let now = 1_000_000;
    const l = new WriteRateLimiter(3, HOUR, () => now);
    for (let i = 0; i < 3; i++) expect(l.tryConsume('t:u').allowed).toBe(true);
    const r = l.tryConsume('t:u');
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.retryAfterSeconds).toBe(3600);
    now += HOUR / 2;
    const r2 = l.tryConsume('t:u');
    expect(r2.allowed).toBe(false);
    if (!r2.allowed) expect(r2.retryAfterSeconds).toBe(1800);
  });

  it('frees capacity as the window slides', () => {
    let now = 0;
    const l = new WriteRateLimiter(1, HOUR, () => now);
    expect(l.tryConsume('k').allowed).toBe(true);
    expect(l.tryConsume('k').allowed).toBe(false);
    now = HOUR + 1;
    expect(l.tryConsume('k').allowed).toBe(true);
  });

  it('keeps separate budgets per key (user+tenant)', () => {
    const l = new WriteRateLimiter(1);
    expect(l.tryConsume('t1:u1').allowed).toBe(true);
    expect(l.tryConsume('t1:u2').allowed).toBe(true);
    expect(l.tryConsume('t2:u1').allowed).toBe(true);
    expect(l.tryConsume('t1:u1').allowed).toBe(false);
  });

  it('does not extend the window with rejected attempts', () => {
    let now = 0;
    const l = new WriteRateLimiter(1, HOUR, () => now);
    l.tryConsume('k');
    now = HOUR - 1;
    expect(l.tryConsume('k').allowed).toBe(false);
    now = HOUR + 1;
    expect(l.tryConsume('k').allowed).toBe(true);
  });
});

describe('parseWritesPerHour', () => {
  it('defaults when unset/empty', () => {
    expect(parseWritesPerHour(undefined)).toBe(DEFAULT_WRITES_PER_HOUR);
    expect(parseWritesPerHour('')).toBe(DEFAULT_WRITES_PER_HOUR);
  });
  it('parses a positive integer', () => {
    expect(parseWritesPerHour('12')).toBe(12);
  });
  it('rejects zero, negatives, decimals, junk and absurd values', () => {
    for (const v of ['0', '-1', '1.5', 'abc', '100001']) {
      expect(() => parseWritesPerHour(v), v).toThrow(/MCP_BEARER_PASSTHROUGH_WRITES_PER_HOUR/);
    }
  });
});

type Handler = (p: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;

function fakeServer() {
  const handlers = new Map<string, Handler>();
  const server = {
    tool: (...args: unknown[]) => {
      handlers.set(args[0] as string, args[args.length - 1] as Handler);
    },
  };
  return { server, handlers };
}

describe('applyWriteRateLimit', () => {
  it('limits WRITE/DELETE tools, never READ, and does not run the handler when limited', async () => {
    const { server, handlers } = fakeServer();
    const limiter = new WriteRateLimiter(2);
    applyWriteRateLimit(server as never, limiter, 'tenant-1:user-1');
    const run = vi.fn(async () => ({ content: [{ type: 'text', text: '{}' }] }));
    server.tool('nevent_create_segment', {}, run);
    server.tool('nevent_schedule_campaign', {}, run); // DELETE-classified: counts
    server.tool('nevent_list_segments', {}, run); // READ: never counted

    await handlers.get('nevent_create_segment')!({});
    await handlers.get('nevent_schedule_campaign')!({});
    expect(run).toHaveBeenCalledTimes(2);

    const limited = await handlers.get('nevent_create_segment')!({});
    expect(limited.isError).toBe(true);
    const env = JSON.parse(limited.content[0].text) as { error: { code: string; message: string } };
    expect(env.error.code).toBe('write_rate_limit_exceeded');
    expect(env.error.message).toMatch(/2 write/);
    expect(run).toHaveBeenCalledTimes(2);

    for (let i = 0; i < 5; i++) await handlers.get('nevent_list_segments')!({});
    expect(run).toHaveBeenCalledTimes(7);
  });

  it('shares the budget across servers (sessions) of the same key', async () => {
    const limiter = new WriteRateLimiter(1);
    const a = fakeServer();
    const b = fakeServer();
    applyWriteRateLimit(a.server as never, limiter, 't:u');
    applyWriteRateLimit(b.server as never, limiter, 't:u');
    const run = vi.fn(async () => ({ content: [{ type: 'text', text: '{}' }] }));
    a.server.tool('nevent_create_segment', {}, run);
    b.server.tool('nevent_create_segment', {}, run);
    await a.handlers.get('nevent_create_segment')!({});
    const second = await b.handlers.get('nevent_create_segment')!({});
    expect(second.isError).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('tool-call log records the principal', () => {
  function logged() {
    const calls: Record<string, unknown>[] = [];
    const logger = { logToolCall: (d: Record<string, unknown>) => void calls.push(d), warmUp: async () => {}, close: async () => {} } as unknown as ToolCallLogger;
    return { calls, logger };
  }
  const dataClient = { activeTenantId: 'tenant-1' } as unknown as DataClient;

  it('adds principal_type and the effective tenant, no email or token', async () => {
    const { calls, logger } = logged();
    const { server, handlers } = fakeServer();
    applyLoggingToServer(server as never, logger, dataClient, 'user-1', () => 'sid', {
      principalType: 'HUMAN',
      effectiveTenantId: 'tenant-1',
    });
    server.tool('nevent_list_segments', {}, async () => ({ content: [{ type: 'text', text: '{}' }] }));
    await handlers.get('nevent_list_segments')!({ token: 'secret', name: 'x' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      user_id: 'user-1',
      principal_type: 'HUMAN',
      tenant_id: 'tenant-1',
      tenant_id_active: 'tenant-1',
      tool_name: 'nevent_list_segments',
    });
    expect(JSON.stringify(calls[0])).not.toContain('secret');
    expect(calls[0]).not.toHaveProperty('email');
  });

  it('also records principal_type on handler exceptions and errors', async () => {
    const { calls, logger } = logged();
    const { server, handlers } = fakeServer();
    applyLoggingToServer(server as never, logger, dataClient, 'svc-1', null, {
      principalType: 'SERVICE',
      effectiveTenantId: 'tenant-1',
    });
    server.tool('a', {}, async () => { throw new Error('boom'); });
    server.tool('b', {}, async () => ({ content: [{ type: 'text', text: '{}' }], isError: true }));
    await expect(handlers.get('a')!({})).rejects.toThrow('boom');
    await handlers.get('b')!({});
    expect(calls.map((c) => c['principal_type'])).toEqual(['SERVICE', 'SERVICE']);
  });

  it('leaves OAuth-mode documents unchanged (no principal_type key)', async () => {
    const { calls, logger } = logged();
    const { server, handlers } = fakeServer();
    applyLoggingToServer(server as never, logger, dataClient, 'user-1', null);
    server.tool('x', {}, async () => ({ content: [{ type: 'text', text: '{}' }] }));
    await handlers.get('x')!({});
    expect(calls[0]).not.toHaveProperty('principal_type');
  });
});
