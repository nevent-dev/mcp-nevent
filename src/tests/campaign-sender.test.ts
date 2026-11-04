/**
 * nevent-work#323 — the sender of each email campaign.
 *
 *  - `nevent_create_campaign` passes `sender_identity_id` to nev-api as
 *    `senderIdentityId`, and omits it when not given (nev-api then uses the
 *    organization's default sender).
 *  - A 409 `CAMPAIGN_SENDER_UNAVAILABLE` from create or schedule becomes an
 *    actionable `sender_unavailable` error.
 *  - `nevent_get_sending_profile` lists the senders a campaign can use and the
 *    default one (`campaignSenders`, nev-api `GET /sender-identities/campaign-options`).
 *
 * The write tools are gated by the operation mode, resolved when
 * `operation-mode.ts` is first imported: each test forces FULL and re-imports.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { campaignSenderUnavailableEnvelope } from '../tools/helpers.js';
import { CreateCampaignSchema } from '../schemas/campaign-actions.js';
import { campaignSenders } from '../tools/deliverability.js';
import { z } from 'zod';

type ToolHandler = (params: Record<string, unknown>) => Promise<unknown>;

function makeMockServer() {
  const tools: Record<string, ToolHandler> = {};
  return {
    tool(name: string, _d: string, _s: unknown, annotationsOrHandler: unknown, maybeHandler?: ToolHandler) {
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

async function setupCampaignTools(fetchImpl: ReturnType<typeof vi.fn>) {
  const { registerCampaignActionTools } = await import('../tools/campaign-actions.js');
  const { DataClient } = await import('../clients/data-client.js');
  const dataClient = new DataClient({ baseUrl: 'https://data.nevent.es', jwtToken: 'jwt' }, 'tenant-323');
  const server = makeMockServer();
  registerCampaignActionTools(server as never, dataClient, 'https://api.nevent.es');
  vi.stubGlobal('fetch', fetchImpl);
  return server;
}

const UNAVAILABLE = { code: 'CAMPAIGN_SENDER_UNAVAILABLE', senderIdentityId: 'kala', reason: 'NOT_ACTIVE' };

beforeEach(() => {
  vi.stubEnv('NEVENT_OPERATION_MODE', 'FULL');
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('CreateCampaignSchema — sender_identity_id', () => {
  const schema = z.object(CreateCampaignSchema);

  it('accepts a sender identity id and leaves it optional', () => {
    expect(schema.safeParse({ name: 'N', channel: 'EMAIL_ONLY', sender_identity_id: '6aeaecbbf11e06692582e9ad' })
      .success).toBe(true);
    expect(schema.safeParse({ name: 'N', channel: 'EMAIL_ONLY' }).success).toBe(true);
  });

  it('rejects an empty sender identity id', () => {
    expect(schema.safeParse({ name: 'N', channel: 'EMAIL_ONLY', sender_identity_id: '' }).success).toBe(false);
  });
});

describe('campaignSenderUnavailableEnvelope', () => {
  it('maps the 409 with its reason and points to nevent_get_sending_profile', () => {
    const env = campaignSenderUnavailableEnvelope(JSON.stringify(UNAVAILABLE));
    expect(env?.error.code).toBe('sender_unavailable');
    expect(env?.error.message).toContain('NOT_ACTIVE');
    expect(env?.error.message).toContain('kala');
    expect(env?.error.message).toContain('nevent_get_sending_profile');
  });

  it('returns null for any other body', () => {
    expect(campaignSenderUnavailableEnvelope(JSON.stringify({ code: 'SENDER_INELIGIBLE' }))).toBeNull();
    expect(campaignSenderUnavailableEnvelope('not json')).toBeNull();
  });
});

describe('nevent_create_campaign — sender of the campaign', () => {
  it('sends senderIdentityId when sender_identity_id is given', async () => {
    const fetchMock = vi.fn(async () => response(201, { id: 'camp_1', name: 'N', status: 'DRAFT' }));
    const server = await setupCampaignTools(fetchMock);

    await server.invoke('nevent_create_campaign', {
      name: 'N', channel: 'EMAIL_ONLY', email_subject: 'S', sender_identity_id: 'kala',
    });

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.senderIdentityId).toBe('kala');
  });

  it('omits senderIdentityId without sender_identity_id (nev-api uses the default sender)', async () => {
    const fetchMock = vi.fn(async () => response(201, { id: 'camp_1', name: 'N', status: 'DRAFT' }));
    const server = await setupCampaignTools(fetchMock);

    await server.invoke('nevent_create_campaign', { name: 'N', channel: 'EMAIL_ONLY', email_subject: 'S' });

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).not.toHaveProperty('senderIdentityId');
  });

  it('turns a 409 CAMPAIGN_SENDER_UNAVAILABLE into sender_unavailable', async () => {
    const fetchMock = vi.fn(async () => response(409, UNAVAILABLE));
    const server = await setupCampaignTools(fetchMock);

    const error = parseError(await server.invoke('nevent_create_campaign', {
      name: 'N', channel: 'EMAIL_ONLY', email_subject: 'S', sender_identity_id: 'kala',
    }));

    expect(error.code).toBe('sender_unavailable');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('nevent_schedule_campaign — 409 CAMPAIGN_SENDER_UNAVAILABLE', () => {
  it('returns sender_unavailable (the draft whose sender was retired asks for another one)', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (!init?.method || init.method === 'GET') {
        return response(200, { id: 'camp_1', name: 'N', status: 'DRAFT' });
      }
      return response(409, { ...UNAVAILABLE, reason: 'RETIRED' });
    });
    const server = await setupCampaignTools(fetchMock);

    const error = parseError(await server.invoke('nevent_schedule_campaign', {
      campaign_id: 'camp_1', scheduled_time: new Date(Date.now() + 3_600_000).toISOString(), confirmed: true,
    }));

    expect(error.code).toBe('sender_unavailable');
    expect(error.message).toContain('RETIRED');
    // n1: schedule has no sender_identity_id to omit; it says what the caller can do instead.
    expect(error.message).not.toContain('omit sender_identity_id');
    expect(error.message).toContain('campaign editor');
  });
});

describe('nevent_send_test_template — campaign_id', () => {
  async function setupTemplateTools(fetchImpl: ReturnType<typeof vi.fn>) {
    const { registerTemplateTools } = await import('../tools/templates.js');
    const { DataClient } = await import('../clients/data-client.js');
    const { PaidMediaClient } = await import('../clients/paid-media-client.js');
    const { SessionClients } = await import('../clients/session-clients.js');
    const dataClient = new DataClient({ baseUrl: 'https://data.nevent.es', jwtToken: 'jwt' }, 'tenant-323');
    const sessionClients = new SessionClients(dataClient,
      new PaidMediaClient({ baseUrl: 'https://api.nevent.es', jwtToken: 'jwt' }), 'https://api.nevent.es', 'tenant-323');
    const server = makeMockServer();
    registerTemplateTools(server as never, 'mongodb://localhost:27017', dataClient, 'https://api.nevent.es',
      sessionClients.templateClient);
    vi.stubGlobal('fetch', fetchImpl);
    return server;
  }

  const sent = (fetchMock: ReturnType<typeof vi.fn>) =>
    JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string) as Record<string, unknown>;

  it('sends campaignId to POST /templates/{id}/test when campaign_id is given', async () => {
    const fetchMock = vi.fn(async () => response(200, { success: true, sentTo: ['qa@example.com'] }));
    const server = await setupTemplateTools(fetchMock);

    await server.invoke('nevent_send_test_template', {
      template_id: 'tpl', emails: ['qa@example.com'], campaign_id: 'camp_1',
    });

    expect(String(fetchMock.mock.calls[0]![0])).toContain('/templates/tpl/test');
    expect(sent(fetchMock)['campaignId']).toBe('camp_1');
  });

  it('omits campaignId without campaign_id (the default sender, as before)', async () => {
    const fetchMock = vi.fn(async () => response(200, { success: true, sentTo: ['qa@example.com'] }));
    const server = await setupTemplateTools(fetchMock);

    await server.invoke('nevent_send_test_template', { template_id: 'tpl', emails: ['qa@example.com'] });

    expect(sent(fetchMock)).not.toHaveProperty('campaignId');
  });
});

describe('campaignSenders (nevent_get_sending_profile → senders)', () => {
  const OPTIONS = {
    enabled: true,
    resolution: 'IDENTITY',
    defaultIdentityId: 'harry',
    senders: [
      { identityId: 'harry', state: 'ACTIVE', default: true, selectable: true, displayName: 'Harry Sinfónico',
        fromEmail: 'hola@marketing.harrysinfonico.com', domain: 'marketing.harrysinfonico.com',
        evaluation: { purpose: 'PREVIEW', blockers: [], warnings: [{ code: 'REPLY_TO_UNRECEIVABLE' }] } },
      { identityId: 'kala', state: 'DRAFT', default: false, selectable: false, displayName: 'Kala Beach',
        fromEmail: 'hola@kalabeach.es', domain: 'kalabeach.es',
        evaluation: { purpose: 'ACTIVATION', blockers: [{ code: 'NOT_VERIFIED_FOR_SENDING' }], warnings: [] } },
    ],
  };

  it('lists the senders, the default and why one is not selectable, from campaign-options', async () => {
    const fetchMock = vi.fn(async () => response(200, OPTIONS));

    const senders = await campaignSenders('https://api.nevent.es', 'jwt', fetchMock as unknown as typeof fetch);

    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.nevent.es/sender-identities/campaign-options');
    expect((fetchMock.mock.calls[0]![1] as RequestInit).headers).toEqual({ Authorization: 'Bearer jwt' });
    expect(senders.perCampaign).toBe(true);
    expect(senders.defaultIdentityId).toBe('harry');
    expect(senders.senders.map((s) => [s.identityId, s.default, s.selectable])).toEqual([
      ['harry', true, true], ['kala', false, false],
    ]);
    expect(senders.senders[0]!.warnings).toEqual(['REPLY_TO_UNRECEIVABLE']);
    expect(senders.senders[1]!.blockers).toEqual(['NOT_VERIFIED_FOR_SENDING']);
  });

  it('reports perCampaign=false where nev-api does not choose the sender per campaign', async () => {
    const fetchMock = vi.fn(async () => response(200, { enabled: false, resolution: 'LEGACY', senders: [] }));
    const senders = await campaignSenders('https://api.nevent.es', 'jwt', fetchMock as unknown as typeof fetch);
    expect(senders).toEqual({ perCampaign: false, defaultIdentityId: null, senders: [] });
  });

  it('never throws: an HTTP error, a network failure or no token are reported in the section', async () => {
    const failing = vi.fn(async () => response(503, 'down'));
    expect((await campaignSenders('https://api.nevent.es', 'jwt', failing as unknown as typeof fetch)).error)
      .toBe('HTTP 503');
    const broken = vi.fn(async () => { throw new TypeError('fetch failed'); });
    expect((await campaignSenders('https://api.nevent.es', 'jwt', broken as unknown as typeof fetch)).error)
      .toBe('TypeError');
    expect((await campaignSenders('https://api.nevent.es', '', vi.fn() as unknown as typeof fetch)).error)
      .toBe('missing_token');
  });
});
