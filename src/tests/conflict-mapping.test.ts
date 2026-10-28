/**
 * Tests for the 409 conflict mapping of nev-api write calls.
 *
 *  - `nevent_schedule_campaign`: 409 SENDER_INELIGIBLE (sender gate) becomes an
 *    actionable `sender_ineligible` error and the campaign is not retried.
 *  - `nevent_update_template`: 409 template_edit_conflict (compare-and-set on
 *    template writes) becomes a `template_edit_conflict` error that tells the
 *    caller to re-read and retry, and the tool never retries by itself.
 *
 * Both tools are gated by the operation mode, which is resolved when
 * `operation-mode.ts` is first imported, so each test forces FULL mode and
 * re-imports the modules.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  senderIneligibleEnvelope,
  templateEditConflictEnvelope,
} from '../tools/helpers.js';

type ToolHandler = (params: Record<string, unknown>) => Promise<unknown>;

function makeMockServer() {
  const tools: Record<string, ToolHandler> = {};
  return {
    tool(
      name: string,
      _description: string,
      _schema: unknown,
      annotationsOrHandler: unknown,
      maybeHandler?: ToolHandler
    ) {
      tools[name] = maybeHandler ?? (annotationsOrHandler as ToolHandler);
    },
    async invoke(name: string, params: Record<string, unknown> = {}) {
      return tools[name]!(params);
    },
  };
}

function response(status: number, body: unknown): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    text: () => Promise.resolve(text),
    json: () => Promise.resolve(typeof body === 'string' ? JSON.parse(body) : body),
  } as unknown as Response;
}

function parseError(result: unknown): { type: string; message: string; code: string } {
  const r = result as { isError?: boolean; content: Array<{ text: string }> };
  expect(r.isError).toBe(true);
  return (JSON.parse(r.content[0]!.text) as { error: { type: string; message: string; code: string } }).error;
}

beforeEach(() => {
  vi.stubEnv('NEVENT_OPERATION_MODE', 'FULL');
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------
describe('senderIneligibleEnvelope', () => {
  it('maps a { code: SENDER_INELIGIBLE } body and lists string blockers', () => {
    const env = senderIneligibleEnvelope(
      JSON.stringify({ code: 'SENDER_INELIGIBLE', blockers: ['DOMAIN_NOT_VERIFIED', 'DKIM_PENDING'] })
    );
    expect(env?.error.code).toBe('sender_ineligible');
    expect(env?.error.message).toContain('DOMAIN_NOT_VERIFIED, DKIM_PENDING');
  });

  it('reads blocker labels from object blockers', () => {
    const env = senderIneligibleEnvelope(
      JSON.stringify({ code: 'SENDER_INELIGIBLE', blockers: [{ label: 'SENDER_UNVERIFIED' }] })
    );
    expect(env?.error.message).toContain('SENDER_UNVERIFIED');
  });

  it('also accepts the canonical ApiError shape ({ errorCode })', () => {
    expect(senderIneligibleEnvelope(JSON.stringify({ errorCode: 'SENDER_INELIGIBLE' }))).not.toBeNull();
  });

  it('mentions the AUTO_PAUSED_SENDER_INELIGIBLE status', () => {
    const env = senderIneligibleEnvelope(JSON.stringify({ code: 'SENDER_INELIGIBLE' }));
    expect(env?.error.message).toContain('AUTO_PAUSED_SENDER_INELIGIBLE');
  });

  it('returns null for another 409 code, for non-JSON and for arrays', () => {
    expect(senderIneligibleEnvelope(JSON.stringify({ code: 'something_else' }))).toBeNull();
    expect(senderIneligibleEnvelope('<html>conflict</html>')).toBeNull();
    expect(senderIneligibleEnvelope('[]')).toBeNull();
  });
});

describe('templateEditConflictEnvelope', () => {
  it('maps template_edit_conflict (errorCode form) and says to re-read and retry', () => {
    const env = templateEditConflictEnvelope(
      'a'.repeat(24),
      JSON.stringify({ errorCode: 'template_edit_conflict', retriable: true })
    );
    expect(env?.error.code).toBe('template_edit_conflict');
    expect(env?.error.message).toContain('nevent_get_template');
    expect(env?.error.message).toContain('NOT applied');
  });

  it('returns null for any other body', () => {
    expect(templateEditConflictEnvelope('x', JSON.stringify({ code: 'other' }))).toBeNull();
    expect(templateEditConflictEnvelope('x', 'not json')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// nevent_schedule_campaign
// ---------------------------------------------------------------------------
async function setupSchedule(fetchImpl: ReturnType<typeof vi.fn>) {
  const { registerCampaignActionTools } = await import('../tools/campaign-actions.js');
  const { DataClient } = await import('../clients/data-client.js');
  const dataClient = new DataClient({ baseUrl: 'https://data.nevent.es', jwtToken: 'jwt' }, 'tenant-1');
  const server = makeMockServer();
  registerCampaignActionTools(server as never, dataClient, 'https://api.nevent.es');
  vi.stubGlobal('fetch', fetchImpl);
  return server;
}

describe('nevent_schedule_campaign — 409 SENDER_INELIGIBLE', () => {
  const futureTime = () => new Date(Date.now() + 3_600_000).toISOString();

  it('returns an actionable sender_ineligible error and does not retry', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (!init?.method || init.method === 'GET') {
        return response(200, { id: 'camp_1', name: 'Test', status: 'DRAFT' });
      }
      return response(409, { code: 'SENDER_INELIGIBLE', blockers: ['DOMAIN_NOT_VERIFIED'] });
    });
    const server = await setupSchedule(fetchMock);

    const error = parseError(
      await server.invoke('nevent_schedule_campaign', {
        campaign_id: 'camp_1',
        scheduled_time: futureTime(),
        confirmed: true,
      })
    );

    expect(error.code).toBe('sender_ineligible');
    expect(error.message).toContain('NOT scheduled');
    expect(error.message).toContain('nevent_get_sending_profile');
    expect(error.message).toContain('AUTO_PAUSED_SENDER_INELIGIBLE');
    expect(error.message).toContain('DOMAIN_NOT_VERIFIED');
    // one GET (status check) + one POST (schedule); no automatic retry
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the generic api_error for an unrelated 409', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (!init?.method || init.method === 'GET') {
        return response(200, { id: 'camp_1', name: 'Test', status: 'DRAFT' });
      }
      return response(409, { code: 'OTHER_CONFLICT' });
    });
    const server = await setupSchedule(fetchMock);

    const error = parseError(
      await server.invoke('nevent_schedule_campaign', {
        campaign_id: 'camp_1',
        scheduled_time: futureTime(),
        confirmed: true,
      })
    );

    expect(error.code).toBe('api_error');
    expect(error.message).toContain('HTTP 409');
  });
});

// ---------------------------------------------------------------------------
// nevent_update_template
// ---------------------------------------------------------------------------
async function setupTemplates(fetchImpl: ReturnType<typeof vi.fn>) {
  const { registerTemplateTools } = await import('../tools/templates.js');
  const { DataClient } = await import('../clients/data-client.js');
  const dataClient = new DataClient({ baseUrl: 'https://data.nevent.es', jwtToken: 'jwt' }, 'tenant-1');
  const server = makeMockServer();
  registerTemplateTools(server as never, 'mongodb://stub', dataClient, 'https://api.nevent.es');
  vi.stubGlobal('fetch', fetchImpl);
  return server;
}

describe('nevent_update_template — 409 template_edit_conflict', () => {
  const TEMPLATE_ID = 'a'.repeat(24);

  it('returns template_edit_conflict telling the caller to re-read, with no retry', async () => {
    const fetchMock = vi.fn(async () => response(409, { code: 'template_edit_conflict' }));
    const server = await setupTemplates(fetchMock);

    const error = parseError(
      await server.invoke('nevent_update_template', { template_id: TEMPLATE_ID, name: 'New name' })
    );

    expect(error.code).toBe('template_edit_conflict');
    expect(error.message).toContain('nevent_get_template');
    expect(error.message).toContain(TEMPLATE_ID);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].method).toBe('PUT');
  });

  it('keeps the generic api_error for an unrelated 409', async () => {
    const fetchMock = vi.fn(async () => response(409, { code: 'OTHER_CONFLICT' }));
    const server = await setupTemplates(fetchMock);

    const error = parseError(
      await server.invoke('nevent_update_template', { template_id: TEMPLATE_ID, name: 'New name' })
    );

    expect(error.code).toBe('api_error');
    expect(error.message).toContain('HTTP 409');
  });
});
