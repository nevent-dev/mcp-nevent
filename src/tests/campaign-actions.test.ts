/**
 * Unit tests for campaign action tools (NEV-1585 / NEV-1668 / NEV-1669 / NEV-1671).
 *
 * Covers:
 * - Zod schema validation for CreateCampaignSchema and ScheduleCampaignSchema
 * - HTTP request shape produced by nevent_schedule_campaign:
 *   - Method must be POST (not PATCH) — regression for NEV-1668
 *   - URL must be /campaigns/{id}/actions/schedule — regression for NEV-1668
 *   - Body must contain only { scheduledTime } (no status field) — regression for NEV-1668
 * - HTTP request shape for nevent_create_campaign (POST /campaigns)
 * - Channel enum fix (NEV-1669):
 *   - All 11 CommunicationChannel values accepted by schema
 *   - Invalid channel values rejected by Zod
 *   - Legacy aliases EMAIL/SMS/WHATSAPP mapped to _ONLY variants in the payload
 * - UTM tracking support (NEV-1669):
 *   - Without UTMs: payload does NOT include utmTracking
 *   - With one UTM: payload includes utmTracking with that field
 *   - With all UTMs: payload includes all fields
 *   - utm_custom_params serialised correctly as object
 * - reply_to support (NEV-1671):
 *   - Valid email → accepted by schema and included in payload as `replyTo`
 *   - Absent → NOT included in payload (no null, no undefined key)
 *   - Invalid format (non-email) → Zod rejects
 *   - Exceeds 254 chars → Zod rejects
 *
 * ## Operation mode
 *
 * nevent_create_campaign requires STANDARD mode (WRITE operation).
 * nevent_schedule_campaign requires FULL mode (DELETE-equivalent operation).
 * Tests that exercise real fetch calls are gated with `isFullModeAllowed`.
 * The default test env has no NEVENT_OPERATION_MODE set (READ_ONLY), so
 * HTTP shape tests run only when NEVENT_OPERATION_MODE=FULL.
 *
 * To run HTTP shape tests:
 *   NEVENT_OPERATION_MODE=FULL npx vitest run src/tests/campaign-actions.test.ts
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { isOperationAllowed } from '../config/operation-mode.js';
import { CreateCampaignSchema, ScheduleCampaignSchema, CHANNEL_ALIAS_MAP } from '../schemas/campaign-actions.js';

// ---------------------------------------------------------------------------
// Schema helpers
// ---------------------------------------------------------------------------
const CreateCampaignObject = z.object(CreateCampaignSchema);
const ScheduleCampaignObject = z.object(ScheduleCampaignSchema);

// ---------------------------------------------------------------------------
// Operation mode flags
// ---------------------------------------------------------------------------
const isWriteAllowed =
  process.env['NEVENT_OPERATION_MODE'] === 'STANDARD' ||
  process.env['NEVENT_OPERATION_MODE'] === 'FULL';

const isFullModeAllowed = process.env['NEVENT_OPERATION_MODE'] === 'FULL';

// ---------------------------------------------------------------------------
// Restore mocks after each test
// ---------------------------------------------------------------------------
afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Mock response helpers
// ---------------------------------------------------------------------------

function mockFetchOk(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Tool setup helper
// ---------------------------------------------------------------------------

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
      if (!tools[name]) throw new Error(`Tool "${name}" not registered`);
      return tools[name]!(params);
    },
  };
}

async function setupCampaignTools(fetchImpl: typeof fetch, activeTenantId = 'tenant-xyz') {
  const { registerCampaignActionTools } = await import('../tools/campaign-actions.js');
  const { DataClient } = await import('../clients/data-client.js');

  const dataClient = new DataClient(
    { baseUrl: 'https://data.nevent.es', jwtToken: 'test-jwt' },
    activeTenantId
  );

  const server = makeMockServer();
  registerCampaignActionTools(server as never, dataClient, 'https://api.nevent.es');

  vi.stubGlobal('fetch', fetchImpl);

  return server;
}

// ---------------------------------------------------------------------------
// CreateCampaignSchema
// ---------------------------------------------------------------------------
describe('CreateCampaignSchema', () => {
  it('accepts minimal valid EMAIL campaign', () => {
    const result = CreateCampaignObject.safeParse({
      name: 'Test Campaign',
      channel: 'EMAIL',
      email_subject: 'Hello world',
    });
    expect(result.success).toBe(true);
  });

  it('accepts minimal valid SMS campaign', () => {
    const result = CreateCampaignObject.safeParse({
      name: 'SMS Campaign',
      channel: 'SMS',
      message: 'Your code is 1234',
    });
    expect(result.success).toBe(true);
  });

  it('accepts minimal valid WHATSAPP campaign', () => {
    const result = CreateCampaignObject.safeParse({
      name: 'WA Campaign',
      channel: 'WHATSAPP',
      message: 'Hola!',
    });
    expect(result.success).toBe(true);
  });

  it('accepts full EMAIL campaign with all optional fields', () => {
    const result = CreateCampaignObject.safeParse({
      name: 'Full Campaign',
      channel: 'EMAIL',
      email_subject: 'Big sale',
      email_body: '<p>Hi!</p>',
      preview_text: 'Incredible deals inside',
      from_name: 'Nevent Team',
      segment_ids: ['seg_1', 'seg_2'],
      template_id: 'tpl_abc',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing name', () => {
    const result = CreateCampaignObject.safeParse({ channel: 'EMAIL', email_subject: 'Hi' });
    expect(result.success).toBe(false);
  });

  it('rejects missing channel', () => {
    const result = CreateCampaignObject.safeParse({ name: 'Campaign', email_subject: 'Hi' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid channel value', () => {
    const result = CreateCampaignObject.safeParse({ name: 'Campaign', channel: 'PUSH' });
    expect(result.success).toBe(false);
  });

  it('does not expose a status field in schema (status is hardcoded in handler)', () => {
    expect(Object.keys(CreateCampaignSchema)).not.toContain('status');
  });
});

// ---------------------------------------------------------------------------
// ScheduleCampaignSchema
// ---------------------------------------------------------------------------
describe('ScheduleCampaignSchema', () => {
  const futureDate = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  it('accepts valid campaign_id, scheduled_time, and confirmed=true', () => {
    const result = ScheduleCampaignObject.safeParse({
      campaign_id: 'camp_abc123',
      scheduled_time: futureDate,
      confirmed: true,
    });
    expect(result.success).toBe(true);
  });

  it('rejects confirmed=false (must be literal true)', () => {
    const result = ScheduleCampaignObject.safeParse({
      campaign_id: 'camp_abc123',
      scheduled_time: futureDate,
      confirmed: false,
    });
    expect(result.success).toBe(false);
  });

  it('rejects confirmed missing', () => {
    const result = ScheduleCampaignObject.safeParse({
      campaign_id: 'camp_abc123',
      scheduled_time: futureDate,
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing campaign_id', () => {
    const result = ScheduleCampaignObject.safeParse({
      scheduled_time: futureDate,
      confirmed: true,
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty campaign_id', () => {
    const result = ScheduleCampaignObject.safeParse({
      campaign_id: '',
      scheduled_time: futureDate,
      confirmed: true,
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid scheduled_time format (not ISO 8601 with offset)', () => {
    const result = ScheduleCampaignObject.safeParse({
      campaign_id: 'camp_abc123',
      scheduled_time: '29/05/2026 10:00',
      confirmed: true,
    });
    expect(result.success).toBe(false);
  });

  it('does not expose a status field in schema (status transition is backend responsibility)', () => {
    expect(Object.keys(ScheduleCampaignSchema)).not.toContain('status');
  });
});

// ---------------------------------------------------------------------------
// Operation mode registry
// ---------------------------------------------------------------------------
describe('Campaign action tools — operation mode registry', () => {
  it('nevent_create_campaign is WRITE (blocked in READ_ONLY)', () => {
    expect(isOperationAllowed('nevent_create_campaign')).toBe(isWriteAllowed);
  });

  it('nevent_schedule_campaign is DELETE-equivalent (FULL only)', () => {
    expect(isOperationAllowed('nevent_schedule_campaign')).toBe(isFullModeAllowed);
  });
});

// ---------------------------------------------------------------------------
// nevent_schedule_campaign — operation mode guard
// ---------------------------------------------------------------------------
describe('nevent_schedule_campaign — operation mode guard', () => {
  it('returns operation_not_permitted error in READ_ONLY mode (default test env)', async () => {
    if (isFullModeAllowed) return; // skip — mode allows scheduling, different code path
    const server = await setupCampaignTools(vi.fn() as unknown as typeof fetch);
    const futureDate = new Date(Date.now() + 3600_000).toISOString();
    const result = await server.invoke('nevent_schedule_campaign', {
      campaign_id: 'camp_123',
      scheduled_time: futureDate,
      confirmed: true,
    }) as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0]!.text) as { error: { code: string } };
    expect(body.error.code).toBe('operation_not_permitted');
  });
});

// ---------------------------------------------------------------------------
// nevent_schedule_campaign — HTTP request shape (NEV-1668 regression)
//
// These tests validate that the tool uses the correct endpoint:
//   POST /campaigns/{id}/actions/schedule   with body { scheduledTime }
// instead of the previously broken:
//   PATCH /campaigns/{id}                   with body { status: 'SCHEDULED', scheduledTime }
// ---------------------------------------------------------------------------
describe('nevent_schedule_campaign — HTTP request shape (NEV-1668 regression)', () => {
  it('uses POST method (not PATCH) for schedule action (FULL mode only)', async () => {
    if (!isFullModeAllowed) return; // blocked by mode guard — fetch never called
    const capturedCalls: Array<{ url: string; method: string | undefined }> = [];
    const server = await setupCampaignTools(async (url, init) => {
      capturedCalls.push({ url: String(url), method: init?.method });
      // First call: GET /campaigns/{id} for status check → DRAFT
      if (!init?.method || init.method === 'GET') {
        return mockFetchOk({ id: 'camp_123', name: 'Test', status: 'DRAFT' });
      }
      // Second call: schedule action → SCHEDULED
      return mockFetchOk({ id: 'camp_123', name: 'Test', status: 'SCHEDULED' });
    });

    const futureTime = new Date(Date.now() + 3600_000).toISOString();
    await server.invoke('nevent_schedule_campaign', {
      campaign_id: 'camp_123',
      scheduled_time: futureTime,
      confirmed: true,
    });

    const scheduleCall = capturedCalls.find(c => c.url.includes('/actions/schedule'));
    expect(scheduleCall).toBeDefined();
    expect(scheduleCall!.method).toBe('POST');
  });

  it('calls /campaigns/{id}/actions/schedule subroute (not root /campaigns/{id}) (FULL mode only)', async () => {
    if (!isFullModeAllowed) return;
    const capturedUrls: string[] = [];
    const server = await setupCampaignTools(async (url, init) => {
      capturedUrls.push(String(url));
      if (!init?.method || init.method === 'GET') {
        return mockFetchOk({ id: 'camp_123', name: 'Test', status: 'DRAFT' });
      }
      return mockFetchOk({ id: 'camp_123', name: 'Test', status: 'SCHEDULED' });
    });

    const futureTime = new Date(Date.now() + 3600_000).toISOString();
    await server.invoke('nevent_schedule_campaign', {
      campaign_id: 'camp_123',
      scheduled_time: futureTime,
      confirmed: true,
    });

    expect(capturedUrls).toContain('https://api.nevent.es/campaigns/camp_123/actions/schedule');
  });

  it('sends only { scheduledTime } in body — no status field (FULL mode only)', async () => {
    if (!isFullModeAllowed) return;
    let scheduleBody: Record<string, unknown> | null = null;
    const server = await setupCampaignTools(async (url, init) => {
      if (!init?.method || init.method === 'GET') {
        return mockFetchOk({ id: 'camp_123', name: 'Test', status: 'DRAFT' });
      }
      scheduleBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return mockFetchOk({ id: 'camp_123', name: 'Test', status: 'SCHEDULED' });
    });

    const futureTime = new Date(Date.now() + 3600_000).toISOString();
    await server.invoke('nevent_schedule_campaign', {
      campaign_id: 'camp_123',
      scheduled_time: futureTime,
      confirmed: true,
    });

    expect(scheduleBody).not.toBeNull();
    expect(scheduleBody).toHaveProperty('scheduledTime');
    expect(scheduleBody).not.toHaveProperty('status');
  });

  it('passes scheduled_time value as scheduledTime in request body (FULL mode only)', async () => {
    if (!isFullModeAllowed) return;
    let scheduleBody: Record<string, unknown> | null = null;
    const server = await setupCampaignTools(async (url, init) => {
      if (!init?.method || init.method === 'GET') {
        return mockFetchOk({ id: 'camp_123', name: 'Test', status: 'DRAFT' });
      }
      scheduleBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return mockFetchOk({ id: 'camp_123', name: 'Test', status: 'SCHEDULED' });
    });

    const futureTime = new Date(Date.now() + 3600_000).toISOString();
    await server.invoke('nevent_schedule_campaign', {
      campaign_id: 'camp_123',
      scheduled_time: futureTime,
      confirmed: true,
    });

    expect(scheduleBody!['scheduledTime']).toBe(futureTime);
  });
});

// ---------------------------------------------------------------------------
// nevent_create_campaign — HTTP request shape
// ---------------------------------------------------------------------------
describe('nevent_create_campaign — HTTP request shape', () => {
  it('returns operation_not_permitted in READ_ONLY mode (default test env)', async () => {
    if (isWriteAllowed) return; // skip if mode allows writes
    const server = await setupCampaignTools(vi.fn() as unknown as typeof fetch);
    const result = await server.invoke('nevent_create_campaign', {
      name: 'My Campaign',
      channel: 'EMAIL',
      email_subject: 'Hello!',
    }) as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0]!.text) as { error: { code: string } };
    expect(body.error.code).toBe('operation_not_permitted');
  });

  it('uses POST to /campaigns (STANDARD/FULL mode only)', async () => {
    if (!isWriteAllowed) return;
    let capturedUrl = '';
    let capturedMethod = '';
    const server = await setupCampaignTools(async (url, init) => {
      capturedUrl = String(url);
      capturedMethod = init?.method ?? '';
      return mockFetchOk({ id: 'camp_new', name: 'My Campaign', status: 'DRAFT', channel: 'EMAIL' }, 201);
    });

    await server.invoke('nevent_create_campaign', {
      name: 'My Campaign',
      channel: 'EMAIL',
      email_subject: 'Hello!',
    });

    expect(capturedMethod).toBe('POST');
    expect(capturedUrl).toBe('https://api.nevent.es/campaigns');
  });

  it('always sends status=DRAFT in payload (STANDARD/FULL mode only)', async () => {
    if (!isWriteAllowed) return;
    let capturedBody: Record<string, unknown> | null = null;
    const server = await setupCampaignTools(async (url, init) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return mockFetchOk({ id: 'camp_new', name: 'My Campaign', status: 'DRAFT', channel: 'EMAIL' }, 201);
    });

    await server.invoke('nevent_create_campaign', {
      name: 'My Campaign',
      channel: 'EMAIL',
      email_subject: 'Hello!',
    });

    expect(capturedBody!['status']).toBe('DRAFT');
  });
});

// ---------------------------------------------------------------------------
// NEV-1669: channel enum fix
// ---------------------------------------------------------------------------

describe('CreateCampaignSchema — channel enum (NEV-1669)', () => {
  // All 11 canonical CommunicationChannel values must be accepted by Zod.
  const validChannels = [
    'EMAIL_ONLY',
    'SMS_ONLY',
    'WHATSAPP_ONLY',
    'PUSH_ONLY',
    'EMAIL_AND_SMS',
    'EMAIL_AND_WHATSAPP',
    'PUSH_AND_SMS',
    'PUSH_AND_WHATSAPP',
    'SMS_AND_WHATSAPP',
    'ALL_CHANNELS',
    'OMNICHANNEL',
  ] as const;

  for (const channel of validChannels) {
    it(`accepts canonical channel value "${channel}"`, () => {
      const result = z.object(CreateCampaignSchema).safeParse({
        name: 'Test Campaign',
        channel,
        // Provide required fields for channels that need them
        ...(channel.includes('EMAIL') || channel === 'EMAIL_ONLY' ? { email_subject: 'Subject' } : {}),
        message: 'Test message',
      });
      expect(result.success).toBe(true);
    });
  }

  // Legacy aliases must also be accepted (backward compat).
  it('accepts legacy alias "EMAIL" (backward compat)', () => {
    const result = z.object(CreateCampaignSchema).safeParse({
      name: 'Legacy EMAIL',
      channel: 'EMAIL',
      email_subject: 'Subject',
    });
    expect(result.success).toBe(true);
  });

  it('accepts legacy alias "SMS" (backward compat)', () => {
    const result = z.object(CreateCampaignSchema).safeParse({
      name: 'Legacy SMS',
      channel: 'SMS',
      message: 'Hi!',
    });
    expect(result.success).toBe(true);
  });

  it('accepts legacy alias "WHATSAPP" (backward compat)', () => {
    const result = z.object(CreateCampaignSchema).safeParse({
      name: 'Legacy WA',
      channel: 'WHATSAPP',
      message: 'Hi!',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid channel value "NOT_A_CHANNEL"', () => {
    const result = z.object(CreateCampaignSchema).safeParse({
      name: 'Bad Channel',
      channel: 'NOT_A_CHANNEL',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid channel value "PUSH" (not in enum)', () => {
    const result = z.object(CreateCampaignSchema).safeParse({
      name: 'Push only',
      channel: 'PUSH',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty string as channel', () => {
    const result = z.object(CreateCampaignSchema).safeParse({
      name: 'Empty channel',
      channel: '',
    });
    expect(result.success).toBe(false);
  });
});

describe('CHANNEL_ALIAS_MAP — backward compatibility mapping (NEV-1669)', () => {
  it('maps EMAIL → EMAIL_ONLY', () => {
    expect(CHANNEL_ALIAS_MAP['EMAIL']).toBe('EMAIL_ONLY');
  });

  it('maps SMS → SMS_ONLY', () => {
    expect(CHANNEL_ALIAS_MAP['SMS']).toBe('SMS_ONLY');
  });

  it('maps WHATSAPP → WHATSAPP_ONLY', () => {
    expect(CHANNEL_ALIAS_MAP['WHATSAPP']).toBe('WHATSAPP_ONLY');
  });

  it('canonical values are NOT in the alias map (no double-mapping)', () => {
    expect(CHANNEL_ALIAS_MAP['EMAIL_ONLY']).toBeUndefined();
    expect(CHANNEL_ALIAS_MAP['SMS_ONLY']).toBeUndefined();
    expect(CHANNEL_ALIAS_MAP['WHATSAPP_ONLY']).toBeUndefined();
  });
});

describe('nevent_create_campaign — channel payload (NEV-1669, STANDARD/FULL mode)', () => {
  // Each test uses a unique tenant ID to avoid rate limiter collisions across
  // tests that share the same in-memory rateLimits Map.
  it('sends EMAIL_ONLY when channel=EMAIL (legacy alias resolved)', async () => {
    if (!isWriteAllowed) return;
    let capturedBody: Record<string, unknown> | null = null;
    const server = await setupCampaignTools(async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return mockFetchOk({ id: 'c1', name: 'Test', status: 'DRAFT', channel: 'EMAIL_ONLY' }, 201);
    }, 'tenant-ch-email');

    await server.invoke('nevent_create_campaign', {
      name: 'Test',
      channel: 'EMAIL',
      email_subject: 'Hi',
    });

    expect(capturedBody!['channel']).toBe('EMAIL_ONLY');
  });

  it('sends SMS_ONLY when channel=SMS (legacy alias resolved)', async () => {
    if (!isWriteAllowed) return;
    let capturedBody: Record<string, unknown> | null = null;
    const server = await setupCampaignTools(async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return mockFetchOk({ id: 'c2', name: 'Test', status: 'DRAFT', channel: 'SMS_ONLY' }, 201);
    }, 'tenant-ch-sms');

    await server.invoke('nevent_create_campaign', {
      name: 'Test',
      channel: 'SMS',
      message: 'Hi!',
    });

    expect(capturedBody!['channel']).toBe('SMS_ONLY');
  });

  it('sends WHATSAPP_ONLY when channel=WHATSAPP (legacy alias resolved)', async () => {
    if (!isWriteAllowed) return;
    let capturedBody: Record<string, unknown> | null = null;
    const server = await setupCampaignTools(async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return mockFetchOk({ id: 'c3', name: 'Test', status: 'DRAFT', channel: 'WHATSAPP_ONLY' }, 201);
    }, 'tenant-ch-wa');

    await server.invoke('nevent_create_campaign', {
      name: 'Test',
      channel: 'WHATSAPP',
      message: 'Hola!',
    });

    expect(capturedBody!['channel']).toBe('WHATSAPP_ONLY');
  });

  it('sends EMAIL_AND_SMS unchanged (canonical value, no mapping)', async () => {
    if (!isWriteAllowed) return;
    let capturedBody: Record<string, unknown> | null = null;
    const server = await setupCampaignTools(async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return mockFetchOk({ id: 'c4', name: 'Test', status: 'DRAFT', channel: 'EMAIL_AND_SMS' }, 201);
    }, 'tenant-ch-multi');

    await server.invoke('nevent_create_campaign', {
      name: 'Test',
      channel: 'EMAIL_AND_SMS',
      email_subject: 'Subject',
      message: 'Hi!',
    });

    expect(capturedBody!['channel']).toBe('EMAIL_AND_SMS');
  });
});

// ---------------------------------------------------------------------------
// NEV-1669: UTM tracking support
// ---------------------------------------------------------------------------

describe('CreateCampaignSchema — UTM fields (NEV-1669)', () => {
  it('accepts all optional UTM fields', () => {
    const result = z.object(CreateCampaignSchema).safeParse({
      name: 'UTM Test',
      channel: 'EMAIL_ONLY',
      email_subject: 'Subject',
      utm_source: 'nevent',
      utm_medium: 'email',
      utm_campaign: 'summer-sale',
      utm_content: 'header-cta',
      utm_term: 'festival+tickets',
      utm_custom_params: { ref: 'promo2026', variant: 'A' },
    });
    expect(result.success).toBe(true);
  });

  it('parses without any UTM fields (all optional)', () => {
    const result = z.object(CreateCampaignSchema).safeParse({
      name: 'No UTM',
      channel: 'EMAIL_ONLY',
      email_subject: 'Subject',
    });
    expect(result.success).toBe(true);
    const data = result.data!;
    expect(data.utm_source).toBeUndefined();
    expect(data.utm_medium).toBeUndefined();
    expect(data.utm_campaign).toBeUndefined();
    expect(data.utm_content).toBeUndefined();
    expect(data.utm_term).toBeUndefined();
    expect(data.utm_custom_params).toBeUndefined();
  });

  it('rejects utm_source longer than 100 chars', () => {
    const result = z.object(CreateCampaignSchema).safeParse({
      name: 'Too long UTM',
      channel: 'EMAIL_ONLY',
      email_subject: 'Subject',
      utm_source: 'a'.repeat(101),
    });
    expect(result.success).toBe(false);
  });

  it('rejects utm_custom_params with non-string values', () => {
    const result = z.object(CreateCampaignSchema).safeParse({
      name: 'Bad custom params',
      channel: 'EMAIL_ONLY',
      email_subject: 'Subject',
      utm_custom_params: { key: 123 },
    });
    expect(result.success).toBe(false);
  });
});

describe('nevent_create_campaign — UTM payload (NEV-1669, STANDARD/FULL mode)', () => {
  // Each test uses a unique tenant ID to avoid rate limiter collisions.

  it('does NOT include utmTracking when no UTM fields provided', async () => {
    if (!isWriteAllowed) return;
    let capturedBody: Record<string, unknown> | null = null;
    const server = await setupCampaignTools(async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return mockFetchOk({ id: 'u1', name: 'Test', status: 'DRAFT', channel: 'EMAIL_ONLY' }, 201);
    }, 'tenant-utm-none');

    await server.invoke('nevent_create_campaign', {
      name: 'No UTM',
      channel: 'EMAIL_ONLY',
      email_subject: 'Hello',
    });

    expect(capturedBody).not.toBeNull();
    expect(capturedBody).not.toHaveProperty('utmTracking');
  });

  it('includes utmTracking with source when only utm_source provided', async () => {
    if (!isWriteAllowed) return;
    let capturedBody: Record<string, unknown> | null = null;
    const server = await setupCampaignTools(async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return mockFetchOk({ id: 'u2', name: 'Test', status: 'DRAFT', channel: 'EMAIL_ONLY' }, 201);
    }, 'tenant-utm-source');

    await server.invoke('nevent_create_campaign', {
      name: 'Source only',
      channel: 'EMAIL_ONLY',
      email_subject: 'Hello',
      utm_source: 'nevent',
    });

    expect(capturedBody).toHaveProperty('utmTracking');
    const utm = capturedBody!['utmTracking'] as Record<string, unknown>;
    expect(utm['source']).toBe('nevent');
    expect(utm['medium']).toBeUndefined();
    expect(utm['campaign']).toBeUndefined();
  });

  it('includes all UTM fields when all provided', async () => {
    if (!isWriteAllowed) return;
    let capturedBody: Record<string, unknown> | null = null;
    const server = await setupCampaignTools(async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return mockFetchOk({ id: 'u3', name: 'Test', status: 'DRAFT', channel: 'EMAIL_ONLY' }, 201);
    }, 'tenant-utm-all');

    await server.invoke('nevent_create_campaign', {
      name: 'All UTMs',
      channel: 'EMAIL_ONLY',
      email_subject: 'Hello',
      utm_source: 'nevent',
      utm_medium: 'email',
      utm_campaign: 'summer-sale',
      utm_content: 'header-cta',
      utm_term: 'festival+tickets',
      utm_custom_params: { ref: 'promo2026', variant: 'A' },
    });

    expect(capturedBody).toHaveProperty('utmTracking');
    const utm = capturedBody!['utmTracking'] as Record<string, unknown>;
    expect(utm['source']).toBe('nevent');
    expect(utm['medium']).toBe('email');
    expect(utm['campaign']).toBe('summer-sale');
    expect(utm['content']).toBe('header-cta');
    expect(utm['term']).toBe('festival+tickets');
    expect(utm['customParams']).toEqual({ ref: 'promo2026', variant: 'A' });
  });

  it('serialises utm_custom_params as an object (not array)', async () => {
    if (!isWriteAllowed) return;
    let capturedBody: Record<string, unknown> | null = null;
    const server = await setupCampaignTools(async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return mockFetchOk({ id: 'u4', name: 'Test', status: 'DRAFT', channel: 'EMAIL_ONLY' }, 201);
    }, 'tenant-utm-params');

    await server.invoke('nevent_create_campaign', {
      name: 'Custom params',
      channel: 'EMAIL_ONLY',
      email_subject: 'Hello',
      utm_custom_params: { a: '1', b: '2' },
    });

    expect(capturedBody).toHaveProperty('utmTracking');
    const utm = capturedBody!['utmTracking'] as Record<string, unknown>;
    const params = utm['customParams'];
    expect(Array.isArray(params)).toBe(false);
    expect(typeof params).toBe('object');
    expect(params).toEqual({ a: '1', b: '2' });
  });

  it('does NOT include utmTracking when utm_custom_params is empty object', async () => {
    // An empty customParams object should not trigger utmTracking inclusion
    // because the handler checks Object.keys().length > 0 for customParams
    // AND Object.keys(utmTracking).length > 0 for the wrapper.
    if (!isWriteAllowed) return;
    let capturedBody: Record<string, unknown> | null = null;
    const server = await setupCampaignTools(async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return mockFetchOk({ id: 'u5', name: 'Test', status: 'DRAFT', channel: 'EMAIL_ONLY' }, 201);
    }, 'tenant-utm-empty');

    await server.invoke('nevent_create_campaign', {
      name: 'Empty params',
      channel: 'EMAIL_ONLY',
      email_subject: 'Hello',
      utm_custom_params: {},
    });

    expect(capturedBody).not.toHaveProperty('utmTracking');
  });
});

// ---------------------------------------------------------------------------
// NEV-1671: reply_to schema validation
// ---------------------------------------------------------------------------

describe('CreateCampaignSchema — reply_to (NEV-1671)', () => {
  it('accepts a valid reply_to email address', () => {
    const result = z.object(CreateCampaignSchema).safeParse({
      name: 'Reply Test',
      channel: 'EMAIL_ONLY',
      email_subject: 'Subject',
      reply_to: 'replies@company.com',
    });
    expect(result.success).toBe(true);
    expect(result.data?.reply_to).toBe('replies@company.com');
  });

  it('accepts campaign without reply_to (field is optional)', () => {
    const result = z.object(CreateCampaignSchema).safeParse({
      name: 'No Reply',
      channel: 'EMAIL_ONLY',
      email_subject: 'Subject',
    });
    expect(result.success).toBe(true);
    expect(result.data?.reply_to).toBeUndefined();
  });

  it('rejects reply_to with invalid email format', () => {
    const result = z.object(CreateCampaignSchema).safeParse({
      name: 'Bad Reply',
      channel: 'EMAIL_ONLY',
      email_subject: 'Subject',
      reply_to: 'not-an-email',
    });
    expect(result.success).toBe(false);
  });

  it('rejects reply_to exceeding 254 characters', () => {
    // 249-char local part + @x.com (6 chars) = 255 chars total → must fail
    const longLocal = 'a'.repeat(249);
    const address = `${longLocal}@x.com`;
    expect(address).toHaveLength(255); // sanity-check the test string itself
    const result = z.object(CreateCampaignSchema).safeParse({
      name: 'Too Long Reply',
      channel: 'EMAIL_ONLY',
      email_subject: 'Subject',
      reply_to: address,
    });
    expect(result.success).toBe(false);
  });

  it('accepts reply_to exactly at 254 character limit', () => {
    // 248-char local part + @x.com (6 chars) = 254 chars total (boundary — must pass)
    const borderLocal = 'a'.repeat(248);
    const address = `${borderLocal}@x.com`;
    expect(address).toHaveLength(254); // sanity-check the test string itself
    const result = z.object(CreateCampaignSchema).safeParse({
      name: 'Boundary Reply',
      channel: 'EMAIL_ONLY',
      email_subject: 'Subject',
      reply_to: address,
    });
    // Note: some email validators also reject very long local parts (>64 chars per RFC 5321).
    // Zod's .email() uses a lenient regex so this passes the format check.
    // The operative constraint here is .max(254); a 255-char address must fail (see previous test).
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// NEV-1671: reply_to payload wiring
// ---------------------------------------------------------------------------

describe('nevent_create_campaign — reply_to payload (NEV-1671, STANDARD/FULL mode)', () => {
  it('includes replyTo in payload when reply_to is provided', async () => {
    if (!isWriteAllowed) return;
    let capturedBody: Record<string, unknown> | null = null;
    const server = await setupCampaignTools(async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return mockFetchOk({ id: 'r1', name: 'Test', status: 'DRAFT', channel: 'EMAIL_ONLY' }, 201);
    }, 'tenant-reply-present');

    await server.invoke('nevent_create_campaign', {
      name: 'Reply Campaign',
      channel: 'EMAIL_ONLY',
      email_subject: 'Hello',
      reply_to: 'support@company.com',
    });

    expect(capturedBody).not.toBeNull();
    expect(capturedBody).toHaveProperty('replyTo', 'support@company.com');
  });

  it('does NOT include replyTo in payload when reply_to is absent', async () => {
    if (!isWriteAllowed) return;
    let capturedBody: Record<string, unknown> | null = null;
    const server = await setupCampaignTools(async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return mockFetchOk({ id: 'r2', name: 'Test', status: 'DRAFT', channel: 'EMAIL_ONLY' }, 201);
    }, 'tenant-reply-absent');

    await server.invoke('nevent_create_campaign', {
      name: 'No Reply Campaign',
      channel: 'EMAIL_ONLY',
      email_subject: 'Hello',
    });

    expect(capturedBody).not.toBeNull();
    expect(capturedBody).not.toHaveProperty('replyTo');
  });

  it('replyTo value in payload matches the provided reply_to string exactly', async () => {
    if (!isWriteAllowed) return;
    let capturedBody: Record<string, unknown> | null = null;
    const server = await setupCampaignTools(async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return mockFetchOk({ id: 'r3', name: 'Test', status: 'DRAFT', channel: 'EMAIL_ONLY' }, 201);
    }, 'tenant-reply-value');

    const replyAddress = 'marketing-replies@festival.com';
    await server.invoke('nevent_create_campaign', {
      name: 'Exact Reply',
      channel: 'EMAIL_ONLY',
      email_subject: 'Hello',
      reply_to: replyAddress,
    });

    expect(capturedBody!['replyTo']).toBe(replyAddress);
  });
});
