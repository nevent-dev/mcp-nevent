/**
 * Unit tests for campaign action tools (NEV-1585 / NEV-1668).
 *
 * Covers:
 * - Zod schema validation for CreateCampaignSchema and ScheduleCampaignSchema
 * - HTTP request shape produced by nevent_schedule_campaign:
 *   - Method must be POST (not PATCH) — regression for NEV-1668
 *   - URL must be /campaigns/{id}/actions/schedule — regression for NEV-1668
 *   - Body must contain only { scheduledTime } (no status field) — regression for NEV-1668
 * - HTTP request shape for nevent_create_campaign (POST /campaigns)
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
import { CreateCampaignSchema, ScheduleCampaignSchema } from '../schemas/campaign-actions.js';

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
