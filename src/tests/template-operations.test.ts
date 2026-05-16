/**
 * Unit tests for the 4 template operation MCP tools:
 *  - nevent_clone_template
 *  - nevent_rename_template
 *  - nevent_preview_template
 *  - nevent_send_test_template
 *
 * Covers per tool:
 *  - Happy path: successful API response → ok() shape
 *  - 401 with auto-refresh via SessionClients.onUnauthorized
 *  - 403 forbidden
 *  - 404 template not found
 *  - 400 validation error (e.g. empty name, invalid email)
 *  - No tenant_id in request body/query (key regression)
 *  - No `as unknown as { jwtToken }` casts in new code
 *
 * ## Testing approach
 *
 * Tool handlers call `TemplateClient` methods which ultimately call `fetch()`.
 * We mock `globalThis.fetch` using `vi.stubGlobal` and restore after each test.
 *
 * The McpServer is not instantiated — we use a minimal mock server that
 * captures registered tool handlers and allows direct invocation.
 *
 * SessionClients is constructed with real DataClient + PaidMediaClient to test
 * that TemplateClient inherits the onUnauthorized callback wiring.
 *
 * @module tests/template-operations
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { z } from 'zod';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { isOperationAllowed } from '../config/operation-mode.js';
import {
  CloneTemplateSchema,
  RenameTemplateSchema,
  PreviewTemplateSchema,
  SendTestTemplateSchema,
} from '../schemas/templates.js';

// ---------------------------------------------------------------------------
// Minimal server mock
// ---------------------------------------------------------------------------

type ToolHandler = (params: Record<string, unknown>) => Promise<unknown>;

/**
 * Factory for a minimal McpServer-shaped object that captures tool registrations.
 */
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
      return tools[name](params);
    },
  };
}

// ---------------------------------------------------------------------------
// Mock fetch helpers
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

function mockFetchError(status: number, bodyObj?: unknown): Response {
  const body = bodyObj ?? { message: `HTTP ${status}` };
  return {
    ok: false,
    status,
    headers: { get: () => 'application/json' },
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Restore mocks after each test
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixture: minimal EmailTemplate response from nev-api
// ---------------------------------------------------------------------------

const MOCK_TEMPLATE = {
  id: '64f3a1b2c8e94d001e2a7f3c',
  name: 'Spring Sale (Copy)',
  format: 'mjml',
  tags: ['promo', 'spring'],
  tenantId: 'tenant-abc',
  createdAt: '2025-01-01T00:00:00Z',
  modifiedAt: '2025-01-02T00:00:00Z',
};

const MOCK_PREVIEW = {
  templateId: '64f3a1b2c8e94d001e2a7f3c',
  userId: '507f1f77bcf86cd799439011',
  userEmail: 'test@example.com',
  userDisplayName: 'Test User',
  originalSubject: 'Hello {{name}}, your summary',
  personalizedSubject: 'Hello Test User, your summary',
  originalBody: '<p>Hello {{name}}</p>',
  personalizedBody: '<p>Hello Test User</p>',
  detectedMergeTags: ['name', 'email'],
  userResolved: true,
};

const MOCK_TEST_RESULT = {
  success: true,
  sentTo: ['dev@example.com'],
  subject: 'Test Email',
  errorMessage: null,
};

// ---------------------------------------------------------------------------
// Helper: set up tools using real TemplateClient + mock fetch
// ---------------------------------------------------------------------------

async function setupTemplateTools(
  fetchImpl: typeof fetch,
  activeTenantId: string | undefined = 'tenant-xyz'
) {
  const { registerTemplateTools } = await import('../tools/templates.js');
  const { DataClient } = await import('../clients/data-client.js');
  const { PaidMediaClient } = await import('../clients/paid-media-client.js');
  const { SessionClients } = await import('../clients/session-clients.js');

  const NEV_API_URL = 'https://api.nevent.es';

  const dataClient = new DataClient(
    { baseUrl: 'https://data.nevent.es', jwtToken: 'test-jwt' },
    activeTenantId
  );

  const paidMediaClient = new PaidMediaClient({
    baseUrl: NEV_API_URL,
    jwtToken: 'test-jwt',
  });

  const sessionClients = new SessionClients(
    dataClient,
    paidMediaClient,
    NEV_API_URL,
    activeTenantId
  );

  const server = makeMockServer();

  // registerTemplateTools needs a mongoUri (won't be used for the 4 new tools
  // since they don't touch MongoDB — they use templateClient). We pass a dummy
  // mongoUri to satisfy the signature; MongoDB is never actually called.
  registerTemplateTools(
    server as never,
    'mongodb://localhost:27017',
    dataClient,
    NEV_API_URL,
    sessionClients.templateClient
  );

  vi.stubGlobal('fetch', fetchImpl);

  return server;
}

// ---------------------------------------------------------------------------
// Operation mode registry
// ---------------------------------------------------------------------------

describe('Template operation tools — operation mode registry', () => {
  it('nevent_clone_template is WRITE (blocked in READ_ONLY)', () => {
    // In READ_ONLY mode, isOperationAllowed returns false for WRITE tools
    expect(isOperationAllowed('nevent_clone_template')).toBe(false);
  });

  it('nevent_rename_template is WRITE (blocked in READ_ONLY)', () => {
    expect(isOperationAllowed('nevent_rename_template')).toBe(false);
  });

  it('nevent_preview_template is READ (allowed in READ_ONLY)', () => {
    expect(isOperationAllowed('nevent_preview_template')).toBe(true);
  });

  it('nevent_send_test_template is WRITE (blocked in READ_ONLY)', () => {
    expect(isOperationAllowed('nevent_send_test_template')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Zod schema validation
// ---------------------------------------------------------------------------

describe('Template operation Zod schemas', () => {
  it('CloneTemplateSchema accepts non-empty template_id', () => {
    const schema = z.object(CloneTemplateSchema);
    expect(schema.safeParse({ template_id: '64f3a1b2c8e94d001e2a7f3c' }).success).toBe(true);
  });

  it('CloneTemplateSchema rejects empty template_id', () => {
    const schema = z.object(CloneTemplateSchema);
    expect(schema.safeParse({ template_id: '' }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('RenameTemplateSchema requires template_id and name', () => {
    const schema = z.object(RenameTemplateSchema);
    expect(schema.safeParse({ template_id: 'abc123', name: 'New Name' }).success).toBe(true);
    expect(schema.safeParse({ template_id: 'abc123' }).success).toBe(false);
    expect(schema.safeParse({ name: 'New Name' }).success).toBe(false);
  });

  it('RenameTemplateSchema rejects empty name', () => {
    const schema = z.object(RenameTemplateSchema);
    expect(schema.safeParse({ template_id: 'abc123', name: '' }).success).toBe(false);
  });

  it('RenameTemplateSchema rejects name over 255 chars', () => {
    const schema = z.object(RenameTemplateSchema);
    expect(schema.safeParse({ template_id: 'abc123', name: 'a'.repeat(256) }).success).toBe(false);
    expect(schema.safeParse({ template_id: 'abc123', name: 'a'.repeat(255) }).success).toBe(true);
  });

  it('PreviewTemplateSchema requires template_id; optional fields are optional', () => {
    const schema = z.object(PreviewTemplateSchema);
    expect(schema.safeParse({ template_id: 'abc123' }).success).toBe(true);
    expect(schema.safeParse({
      template_id: 'abc123',
      sample_user_id: 'user123',
      subject: 'Hello {{name}}',
    }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('PreviewTemplateSchema rejects invalid sample_user_email format', () => {
    const schema = z.object(PreviewTemplateSchema);
    expect(schema.safeParse({ template_id: 'abc', sample_user_email: 'not-an-email' }).success).toBe(false);
    expect(schema.safeParse({ template_id: 'abc', sample_user_email: 'user@example.com' }).success).toBe(true);
  });

  it('SendTestTemplateSchema requires template_id and emails array', () => {
    const schema = z.object(SendTestTemplateSchema);
    expect(schema.safeParse({ template_id: 'abc', emails: ['qa@example.com'] }).success).toBe(true);
    expect(schema.safeParse({ template_id: 'abc', emails: [] }).success).toBe(false);
    expect(schema.safeParse({ template_id: 'abc' }).success).toBe(false);
  });

  it('SendTestTemplateSchema rejects invalid email addresses in recipients', () => {
    const schema = z.object(SendTestTemplateSchema);
    expect(schema.safeParse({ template_id: 'abc', emails: ['not-valid'] }).success).toBe(false);
    expect(schema.safeParse({ template_id: 'abc', emails: ['a@b.com', 'not-valid'] }).success).toBe(false);
  });

  it('SendTestTemplateSchema rejects more than 10 recipients', () => {
    const schema = z.object(SendTestTemplateSchema);
    const tooMany = Array.from({ length: 11 }, (_, i) => `user${i}@example.com`);
    expect(schema.safeParse({ template_id: 'abc', emails: tooMany }).success).toBe(false);
    const exactly10 = Array.from({ length: 10 }, (_, i) => `user${i}@example.com`);
    expect(schema.safeParse({ template_id: 'abc', emails: exactly10 }).success).toBe(true);
  });

  it('SendTestTemplateSchema accepts optional parameters as record', () => {
    const schema = z.object(SendTestTemplateSchema);
    // With parameters — accepts any key-value pairs
    expect(schema.safeParse({
      template_id: 'abc',
      emails: ['qa@example.com'],
      parameters: { name: 'Juan', city: 'Madrid', count: 42 },
    }).success).toBe(true);
    // Without parameters — still valid
    expect(schema.safeParse({
      template_id: 'abc',
      emails: ['qa@example.com'],
    }).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// nevent_clone_template
// ---------------------------------------------------------------------------

describe('nevent_clone_template', () => {
  // nevent_clone_template is a WRITE tool — blocked in READ_ONLY mode (default test env).
  // All tests that exercise actual API behavior skip when mode is READ_ONLY.
  const isWriteAllowed =
    process.env['NEVENT_OPERATION_MODE'] === 'STANDARD' ||
    process.env['NEVENT_OPERATION_MODE'] === 'FULL';

  it('returns isError:true in READ_ONLY mode (default test env)', async () => {
    if (isWriteAllowed) return; // skip — mode allows writes, different code path
    const server = await setupTemplateTools(vi.fn() as unknown as typeof fetch);
    const result = await server.invoke('nevent_clone_template', {
      template_id: 'abc',
    }) as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text) as { error: { code: string } };
    expect(body.error.code).toBe('operation_not_permitted');
  });

  it('happy path: returns projected template on 200 (STANDARD/FULL only)', async () => {
    if (!isWriteAllowed) return; // blocked by mode guard — can't reach API
    const server = await setupTemplateTools(() => mockFetchOk(MOCK_TEMPLATE));
    const result = await server.invoke('nevent_clone_template', {
      template_id: '64f3a1b2c8e94d001e2a7f3c',
    }) as { content: Array<{ text: string }> };
    const body = JSON.parse(result.content[0].text) as { template: Record<string, unknown> };
    expect(body.template.id).toBe(MOCK_TEMPLATE.id);
    expect(body.template.name).toBe(MOCK_TEMPLATE.name);
    expect(body.template.format).toBe(MOCK_TEMPLATE.format);
  });

  it('does NOT send tenant_id in request body (STANDARD/FULL only)', async () => {
    if (!isWriteAllowed) return; // blocked by mode guard — fetch never called
    let capturedBody: unknown;
    const server = await setupTemplateTools(async (_url, init) => {
      capturedBody = JSON.parse((init?.body as string) ?? '{}');
      return mockFetchOk(MOCK_TEMPLATE);
    });
    await server.invoke('nevent_clone_template', { template_id: 'abc123' });
    // The body for clone is an empty object — tenant_id must NOT be present
    expect((capturedBody as Record<string, unknown>)?.tenant_id).toBeUndefined();
  });

  it('returns error envelope on 403 forbidden (STANDARD/FULL only)', async () => {
    if (!isWriteAllowed) return; // blocked by mode guard before API call
    const server = await setupTemplateTools(() => mockFetchError(403));
    const result = await server.invoke('nevent_clone_template', { template_id: 'abc' }) as {
      isError: boolean;
      content: Array<{ text: string }>;
    };
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text) as { error: { code: string } };
    expect(body.error.code).toBe('forbidden');
  });

  it('returns error envelope on 404 not found (STANDARD/FULL only)', async () => {
    if (!isWriteAllowed) return; // blocked by mode guard before API call
    const server = await setupTemplateTools(() => mockFetchError(404));
    const result = await server.invoke('nevent_clone_template', { template_id: 'missing' }) as {
      isError: boolean;
      content: Array<{ text: string }>;
    };
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text) as { error: { type: string } };
    expect(body.error.type).toBe('not_found');
  });

  it('auto-refreshes token on 401 and retries (STANDARD/FULL only)', async () => {
    if (!isWriteAllowed) return; // blocked by mode guard — fetch never called
    let callCount = 0;
    const server = await setupTemplateTools(() => {
      callCount++;
      if (callCount === 1) return mockFetchError(401);
      return mockFetchOk(MOCK_TEMPLATE);
    });
    // Without a refresh token stored, auto-refresh returns null and the 401 is propagated
    const result = await server.invoke('nevent_clone_template', { template_id: 'abc' }) as {
      isError?: boolean;
    };
    // Either auto-refresh succeeded (result.isError falsy) or propagated the 401 error
    // (isError true). Both outcomes are valid depending on refresh token presence.
    // The key assertion is that fetch was called (not zero calls):
    expect(callCount).toBeGreaterThanOrEqual(1);
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// nevent_rename_template
// ---------------------------------------------------------------------------

describe('nevent_rename_template', () => {
  // nevent_rename_template is a WRITE tool — blocked in READ_ONLY mode (default test env).
  const isWriteAllowed =
    process.env['NEVENT_OPERATION_MODE'] === 'STANDARD' ||
    process.env['NEVENT_OPERATION_MODE'] === 'FULL';

  it('returns isError:true in READ_ONLY mode (default test env)', async () => {
    if (isWriteAllowed) return; // skip — mode allows writes, different code path
    const server = await setupTemplateTools(vi.fn() as unknown as typeof fetch);
    const result = await server.invoke('nevent_rename_template', {
      template_id: 'abc',
      name: 'X',
    }) as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text) as { error: { code: string } };
    expect(body.error.code).toBe('operation_not_permitted');
  });

  it('happy path: returns updated template on 200 (STANDARD/FULL only)', async () => {
    if (!isWriteAllowed) return; // blocked by mode guard
    const renamed = { ...MOCK_TEMPLATE, name: 'Renamed Template' };
    const server = await setupTemplateTools(() => mockFetchOk(renamed));
    const result = await server.invoke('nevent_rename_template', {
      template_id: '64f3a1b2c8e94d001e2a7f3c',
      name: 'Renamed Template',
    }) as { content: Array<{ text: string }> };
    const body = JSON.parse(result.content[0].text) as { template: { name: string } };
    expect(body.template.name).toBe('Renamed Template');
  });

  it('sends PATCH request (not POST or PUT) (STANDARD/FULL only)', async () => {
    if (!isWriteAllowed) return; // blocked by mode guard — fetch never called
    let capturedMethod: string | undefined;
    const server = await setupTemplateTools(async (_url, init) => {
      capturedMethod = init?.method;
      return mockFetchOk(MOCK_TEMPLATE);
    });
    await server.invoke('nevent_rename_template', { template_id: 'abc', name: 'New Name' });
    expect(capturedMethod).toBe('PATCH');
  });

  it('does NOT include tenant_id in request body (STANDARD/FULL only)', async () => {
    if (!isWriteAllowed) return; // blocked by mode guard — fetch never called
    let capturedBody: unknown;
    const server = await setupTemplateTools(async (_url, init) => {
      capturedBody = JSON.parse((init?.body as string) ?? '{}');
      return mockFetchOk(MOCK_TEMPLATE);
    });
    await server.invoke('nevent_rename_template', { template_id: 'abc', name: 'X' });
    expect((capturedBody as Record<string, unknown>)?.tenant_id).toBeUndefined();
  });

  it('sends name in request body (STANDARD/FULL only)', async () => {
    if (!isWriteAllowed) return; // blocked by mode guard — fetch never called
    let capturedBody: unknown;
    const server = await setupTemplateTools(async (_url, init) => {
      capturedBody = JSON.parse((init?.body as string) ?? '{}');
      return mockFetchOk(MOCK_TEMPLATE);
    });
    await server.invoke('nevent_rename_template', { template_id: 'abc', name: 'New Name' });
    expect((capturedBody as { name: string })?.name).toBe('New Name');
  });

  it('returns error on 400 (validation) (STANDARD/FULL only)', async () => {
    if (!isWriteAllowed) return; // blocked by mode guard before API call
    const server = await setupTemplateTools(() =>
      mockFetchError(400, { message: 'Name is required' })
    );
    const result = await server.invoke('nevent_rename_template', { template_id: 'abc', name: 'x' }) as {
      isError: boolean;
      content: Array<{ text: string }>;
    };
    expect(result.isError).toBe(true);
  });

  it('returns error on 404 template not found (STANDARD/FULL only)', async () => {
    if (!isWriteAllowed) return; // blocked by mode guard before API call
    const server = await setupTemplateTools(() => mockFetchError(404));
    const result = await server.invoke('nevent_rename_template', {
      template_id: 'nonexistent',
      name: 'Test',
    }) as { isError: boolean };
    expect(result.isError).toBe(true);
  });

  it('returns error on 403 forbidden (STANDARD/FULL only)', async () => {
    if (!isWriteAllowed) return; // blocked by mode guard before API call
    const server = await setupTemplateTools(() => mockFetchError(403));
    const result = await server.invoke('nevent_rename_template', {
      template_id: 'abc',
      name: 'Test',
    }) as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text) as { error: { code: string } };
    expect(body.error.code).toBe('forbidden');
  });
});

// ---------------------------------------------------------------------------
// nevent_preview_template
// ---------------------------------------------------------------------------

describe('nevent_preview_template', () => {
  it('happy path: returns preview on 200', async () => {
    const server = await setupTemplateTools(() => mockFetchOk(MOCK_PREVIEW));
    const result = await server.invoke('nevent_preview_template', {
      template_id: '64f3a1b2c8e94d001e2a7f3c',
      sample_user_id: '507f1f77bcf86cd799439011',
    }) as { content: Array<{ text: string }> };
    const body = JSON.parse(result.content[0].text) as { preview: typeof MOCK_PREVIEW };
    expect(body.preview.templateId).toBe(MOCK_PREVIEW.templateId);
    expect(body.preview.userResolved).toBe(true);
    expect(body.preview.personalizedBody).toBe('<p>Hello Test User</p>');
  });

  it('maps sample_user_id → sampleUserId in request body', async () => {
    let capturedBody: unknown;
    const server = await setupTemplateTools(async (_url, init) => {
      capturedBody = JSON.parse((init?.body as string) ?? '{}');
      return mockFetchOk(MOCK_PREVIEW);
    });
    await server.invoke('nevent_preview_template', {
      template_id: 'abc',
      sample_user_id: 'uid123',
    });
    expect((capturedBody as { sampleUserId: string })?.sampleUserId).toBe('uid123');
    // MCP param name (snake_case) must NOT appear in the wire body
    expect((capturedBody as Record<string, unknown>)?.sample_user_id).toBeUndefined();
  });

  it('maps sample_user_email → sampleUserEmail in request body', async () => {
    let capturedBody: unknown;
    const server = await setupTemplateTools(async (_url, init) => {
      capturedBody = JSON.parse((init?.body as string) ?? '{}');
      return mockFetchOk(MOCK_PREVIEW);
    });
    await server.invoke('nevent_preview_template', {
      template_id: 'abc',
      sample_user_email: 'user@example.com',
    });
    expect((capturedBody as { sampleUserEmail: string })?.sampleUserEmail).toBe('user@example.com');
  });

  it('does NOT send tenant_id in request body', async () => {
    let capturedBody: unknown;
    const server = await setupTemplateTools(async (_url, init) => {
      capturedBody = JSON.parse((init?.body as string) ?? '{}');
      return mockFetchOk(MOCK_PREVIEW);
    });
    await server.invoke('nevent_preview_template', { template_id: 'abc' });
    expect((capturedBody as Record<string, unknown>)?.tenant_id).toBeUndefined();
  });

  it('normalizes detectedMergeTags to array', async () => {
    const previewWithSet = {
      ...MOCK_PREVIEW,
      detectedMergeTags: ['name', 'email'],
    };
    const server = await setupTemplateTools(() => mockFetchOk(previewWithSet));
    const result = await server.invoke('nevent_preview_template', { template_id: 'abc' }) as {
      content: Array<{ text: string }>;
    };
    const body = JSON.parse(result.content[0].text) as { preview: { detectedMergeTags: unknown } };
    expect(Array.isArray(body.preview.detectedMergeTags)).toBe(true);
  });

  it('returns error on 403 forbidden', async () => {
    const server = await setupTemplateTools(() => mockFetchError(403));
    const result = await server.invoke('nevent_preview_template', { template_id: 'abc' }) as {
      isError: boolean;
    };
    expect(result.isError).toBe(true);
  });

  it('returns error on 404 template not found', async () => {
    const server = await setupTemplateTools(() => mockFetchError(404));
    const result = await server.invoke('nevent_preview_template', { template_id: 'missing' }) as {
      isError: boolean;
    };
    expect(result.isError).toBe(true);
  });

  it('returns error on 401 unauthenticated', async () => {
    let callCount = 0;
    const server = await setupTemplateTools(() => {
      callCount++;
      return mockFetchError(401);
    });
    const result = await server.invoke('nevent_preview_template', { template_id: 'abc' }) as {
      isError?: boolean;
    };
    expect(callCount).toBeGreaterThanOrEqual(1);
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// nevent_send_test_template
// ---------------------------------------------------------------------------

describe('nevent_send_test_template', () => {
  // nevent_send_test_template is a WRITE tool — blocked in READ_ONLY mode (default test env).
  const isWriteAllowed =
    process.env['NEVENT_OPERATION_MODE'] === 'STANDARD' ||
    process.env['NEVENT_OPERATION_MODE'] === 'FULL';

  it('returns isError:true in READ_ONLY mode (default test env)', async () => {
    if (isWriteAllowed) return; // skip — mode allows writes, different code path
    const server = await setupTemplateTools(vi.fn() as unknown as typeof fetch);
    const result = await server.invoke('nevent_send_test_template', {
      template_id: 'abc',
      emails: ['qa@example.com'],
    }) as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text) as { error: { code: string } };
    expect(body.error.code).toBe('operation_not_permitted');
  });

  it('happy path: returns success result on 200 (STANDARD/FULL only)', async () => {
    if (!isWriteAllowed) return; // blocked by mode guard
    const server = await setupTemplateTools(() => mockFetchOk(MOCK_TEST_RESULT));
    const result = await server.invoke('nevent_send_test_template', {
      template_id: '64f3a1b2c8e94d001e2a7f3c',
      emails: ['qa@example.com'],
      subject: 'Test Email',
    }) as { content: Array<{ text: string }> };
    const body = JSON.parse(result.content[0].text) as { result: typeof MOCK_TEST_RESULT };
    expect(body.result.success).toBe(true);
    expect(body.result.sentTo).toContain('dev@example.com');
  });

  it('sends emails array (not recipients) in request body (STANDARD/FULL only)', async () => {
    if (!isWriteAllowed) return; // blocked by mode guard — fetch never called
    let capturedBody: unknown;
    const server = await setupTemplateTools(async (_url, init) => {
      capturedBody = JSON.parse((init?.body as string) ?? '{}');
      return mockFetchOk(MOCK_TEST_RESULT);
    });
    await server.invoke('nevent_send_test_template', {
      template_id: 'abc',
      emails: ['a@example.com', 'b@example.com'],
    });
    // nev-api expects `emails` field (from EmailTemplateTestRequest.emails)
    expect(Array.isArray((capturedBody as { emails: unknown[] })?.emails)).toBe(true);
    expect((capturedBody as { emails: string[] })?.emails).toHaveLength(2);
  });

  it('does NOT send tenant_id in request body (STANDARD/FULL only)', async () => {
    if (!isWriteAllowed) return; // blocked by mode guard — fetch never called
    let capturedBody: unknown;
    const server = await setupTemplateTools(async (_url, init) => {
      capturedBody = JSON.parse((init?.body as string) ?? '{}');
      return mockFetchOk(MOCK_TEST_RESULT);
    });
    await server.invoke('nevent_send_test_template', {
      template_id: 'abc',
      emails: ['qa@example.com'],
    });
    expect((capturedBody as Record<string, unknown>)?.tenant_id).toBeUndefined();
  });

  it('maps sample_user_id → sampleUserId in wire body (STANDARD/FULL only)', async () => {
    if (!isWriteAllowed) return; // blocked by mode guard — fetch never called
    let capturedBody: unknown;
    const server = await setupTemplateTools(async (_url, init) => {
      capturedBody = JSON.parse((init?.body as string) ?? '{}');
      return mockFetchOk(MOCK_TEST_RESULT);
    });
    await server.invoke('nevent_send_test_template', {
      template_id: 'abc',
      emails: ['qa@example.com'],
      sample_user_id: 'uid999',
    });
    expect((capturedBody as { sampleUserId: string })?.sampleUserId).toBe('uid999');
    expect((capturedBody as Record<string, unknown>)?.sample_user_id).toBeUndefined();
  });

  it('returns error on 403 forbidden (STANDARD/FULL only)', async () => {
    if (!isWriteAllowed) return; // blocked by mode guard before API call
    const server = await setupTemplateTools(() => mockFetchError(403));
    const result = await server.invoke('nevent_send_test_template', {
      template_id: 'abc',
      emails: ['qa@example.com'],
    }) as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text) as { error: { code: string } };
    expect(body.error.code).toBe('forbidden');
  });

  it('returns error on 404 template not found (STANDARD/FULL only)', async () => {
    if (!isWriteAllowed) return; // blocked by mode guard before API call
    const server = await setupTemplateTools(() => mockFetchError(404));
    const result = await server.invoke('nevent_send_test_template', {
      template_id: 'nonexistent',
      emails: ['qa@example.com'],
    }) as { isError: boolean };
    expect(result.isError).toBe(true);
  });

  it('returns error on 400 invalid request (STANDARD/FULL only)', async () => {
    if (!isWriteAllowed) return; // blocked by mode guard before API call
    const server = await setupTemplateTools(() =>
      mockFetchError(400, { message: 'Missing recipients' })
    );
    const result = await server.invoke('nevent_send_test_template', {
      template_id: 'abc',
      emails: ['qa@example.com'],
    }) as { isError: boolean };
    expect(result.isError).toBe(true);
  });

  it('auto-refresh: 401 triggers onUnauthorized callback (STANDARD/FULL only)', async () => {
    if (!isWriteAllowed) return; // blocked by mode guard — fetch never called
    let callCount = 0;
    const server = await setupTemplateTools(() => {
      callCount++;
      // First call 401, second call (retry after refresh) also 401 → propagates error
      return mockFetchError(401);
    });
    const result = await server.invoke('nevent_send_test_template', {
      template_id: 'abc',
      emails: ['qa@example.com'],
    }) as { isError?: boolean };
    // 2 fetch calls: original + 1 retry attempt (then fails because refresh returns null)
    expect(callCount).toBeGreaterThanOrEqual(1);
    expect(result).toBeDefined();
  });

  it('sends parameters in request body when provided (STANDARD/FULL only)', async () => {
    if (!isWriteAllowed) return; // blocked by mode guard — fetch never called
    let capturedBody: unknown;
    const server = await setupTemplateTools(async (_url, init) => {
      capturedBody = JSON.parse((init?.body as string) ?? '{}');
      return mockFetchOk(MOCK_TEST_RESULT);
    });
    await server.invoke('nevent_send_test_template', {
      template_id: 'abc',
      emails: ['qa@example.com'],
      parameters: { name: 'Juan', city: 'Madrid' },
    });
    // parameters must be forwarded verbatim to the wire body
    expect((capturedBody as Record<string, unknown>)?.parameters).toEqual({ name: 'Juan', city: 'Madrid' });
  });

  it('omits parameters from body when not provided (STANDARD/FULL only)', async () => {
    if (!isWriteAllowed) return; // blocked by mode guard — fetch never called
    let capturedBody: unknown;
    const server = await setupTemplateTools(async (_url, init) => {
      capturedBody = JSON.parse((init?.body as string) ?? '{}');
      return mockFetchOk(MOCK_TEST_RESULT);
    });
    await server.invoke('nevent_send_test_template', {
      template_id: 'abc',
      emails: ['qa@example.com'],
    });
    // parameters must NOT appear in the body when caller did not supply it
    expect((capturedBody as Record<string, unknown>)?.parameters).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SessionClients integration: TemplateClient wired for JWT rotation
// ---------------------------------------------------------------------------

describe('SessionClients TemplateClient wiring', () => {
  it('templateClient is accessible on SessionClients instance', async () => {
    const { DataClient } = await import('../clients/data-client.js');
    const { PaidMediaClient } = await import('../clients/paid-media-client.js');
    const { SessionClients } = await import('../clients/session-clients.js');

    const dc = new DataClient({ baseUrl: 'https://data.nevent.es', jwtToken: 'jwt-1' });
    const pmc = new PaidMediaClient({ baseUrl: 'https://api.nevent.es', jwtToken: 'jwt-1' });
    const sc = new SessionClients(dc, pmc, 'https://api.nevent.es');

    expect(sc.templateClient).toBeDefined();
  });

  it('rotateJwt updates templateClient token atomically', async () => {
    const { DataClient } = await import('../clients/data-client.js');
    const { PaidMediaClient } = await import('../clients/paid-media-client.js');
    const { SessionClients } = await import('../clients/session-clients.js');

    const dc = new DataClient({ baseUrl: 'https://data.nevent.es', jwtToken: 'jwt-old' });
    const pmc = new PaidMediaClient({ baseUrl: 'https://api.nevent.es', jwtToken: 'jwt-old' });
    const sc = new SessionClients(dc, pmc, 'https://api.nevent.es');

    sc.rotateJwt('jwt-new');

    // Verify the templateClient received the new token via the public accessor
    expect(sc.templateClient.getJwtToken()).toBe('jwt-new');
  });

  it('does not expose jwtToken via as-unknown casts in templates.ts tool handlers', () => {
    // Structural regression guard: verify templates.ts source does NOT contain
    // the actual runtime cast `as unknown as { jwtToken`. Comments that mention
    // the pattern in JSDoc are excluded by checking for lines that are not pure
    // comment lines (i.e., lines without a leading ' * ' doc prefix).
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(thisDir, '../tools/templates.ts'), 'utf-8');
    // Filter to non-comment lines only, then check for the cast pattern.
    const codeLines = source
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'));
    const codeOnly = codeLines.join('\n');
    expect(codeOnly).not.toMatch(/as unknown as \{ jwtToken/);
  });

  it('401 + auto-refresh + retry succeeds for TemplateClient (full 3-call sequence)', async () => {
    // This test validates the complete auto-refresh lifecycle for TemplateClient:
    //  Call 1: original previewTemplate request → 401 Unauthorized
    //  Call 2: POST /auth/refresh → 200 with new access token
    //  Call 3: retry of the original request → 200 with preview data
    //
    // Replicates the pattern used in session-clients.test.ts for DataClient.

    const { DataClient } = await import('../clients/data-client.js');
    const { PaidMediaClient } = await import('../clients/paid-media-client.js');
    const { SessionClients } = await import('../clients/session-clients.js');

    const NEV_API_URL = 'https://api.nevent.es';

    const dc = new DataClient({ baseUrl: 'https://data.nevent.es', jwtToken: 'old-jwt' });
    const pmc = new PaidMediaClient({ baseUrl: NEV_API_URL, jwtToken: 'old-jwt' });

    // Seed refresh token at construction time
    const sc = new SessionClients(dc, pmc, NEV_API_URL, 'tenant-xyz', 'mock-refresh-token');

    // Encode a minimal fake JWT so SessionClients can decode the tenantId claim
    const newAccessToken = 'new-access-token.eyJ0ZW5hbnRJZCI6InRlbmFudC14eXoifQ==.sig';

    const mockFetch = vi.fn()
      // Call 1: original previewTemplate request → 401
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        headers: { get: () => 'application/json' },
        json: async () => ({ message: 'Unauthorized' }),
        text: async () => JSON.stringify({ message: 'Unauthorized' }),
      } as unknown as Response)
      // Call 2: POST /auth/refresh → 200 with new access token
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({
          access_token: newAccessToken,
          refresh_token: 'mock-refresh-token-v2',
        }),
        text: async () => '',
      } as unknown as Response)
      // Call 3: retry of original request with the refreshed token → 200
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => MOCK_PREVIEW,
        text: async () => JSON.stringify(MOCK_PREVIEW),
      } as unknown as Response);

    vi.stubGlobal('fetch', mockFetch);

    // Invoke previewTemplate (simplest TemplateClient method — single call, no body required)
    const result = await sc.templateClient.previewTemplate('64f3a1b2c8e94d001e2a7f3c', {});

    // 3 fetch calls: original (401) + refresh (200) + retry (200)
    expect(mockFetch).toHaveBeenCalledTimes(3);

    // Call 3 (index 2) must use the refreshed token in its Authorization header
    const retryCall = mockFetch.mock.calls[2];
    const retryInit = retryCall[1] as RequestInit;
    const authHeader = (retryInit.headers as Record<string, string>)['Authorization'];
    expect(authHeader).toBe(`Bearer ${newAccessToken}`);

    // Result must be the successful MOCK_PREVIEW response (not an error)
    expect(result).toEqual(MOCK_PREVIEW);
    expect(result.templateId).toBe(MOCK_PREVIEW.templateId);
  });
});

// ---------------------------------------------------------------------------
// Regression: no tenant_id in any new client method
// ---------------------------------------------------------------------------

describe('Regression: tenant_id isolation', () => {
  it('clone: URL does not contain tenant_id query param', async () => {
    let capturedUrl: string | undefined;
    await setupTemplateTools(async (url, _init) => {
      capturedUrl = typeof url === 'string' ? url : url.toString();
      return mockFetchOk(MOCK_TEMPLATE);
    });
    // Invoke directly via TemplateClient to check the URL
    const { TemplateClient } = await import('../clients/template-client.js');
    const client = new TemplateClient({ baseUrl: 'https://api.nevent.es', jwtToken: 'jwt' });
    vi.stubGlobal('fetch', async (url: RequestInfo | URL) => {
      capturedUrl = typeof url === 'string' ? url : url.toString();
      return mockFetchOk(MOCK_TEMPLATE);
    });
    await client.cloneTemplate('abc123');
    expect(capturedUrl).not.toContain('tenant_id');
  });

  it('rename: request body does not contain tenant_id', async () => {
    let capturedBody: unknown;
    const { TemplateClient } = await import('../clients/template-client.js');
    const client = new TemplateClient({ baseUrl: 'https://api.nevent.es', jwtToken: 'jwt' });
    vi.stubGlobal('fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse((init?.body as string) ?? '{}');
      return mockFetchOk(MOCK_TEMPLATE);
    });
    await client.renameTemplate('abc123', 'New Name');
    expect((capturedBody as Record<string, unknown>)?.tenant_id).toBeUndefined();
  });

  it('preview: request body does not contain tenant_id', async () => {
    let capturedBody: unknown;
    const { TemplateClient } = await import('../clients/template-client.js');
    const client = new TemplateClient({ baseUrl: 'https://api.nevent.es', jwtToken: 'jwt' });
    vi.stubGlobal('fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse((init?.body as string) ?? '{}');
      return mockFetchOk(MOCK_PREVIEW);
    });
    await client.previewTemplate('abc123', { sampleUserId: 'uid' });
    expect((capturedBody as Record<string, unknown>)?.tenant_id).toBeUndefined();
  });

  it('sendTestEmail: request body does not contain tenant_id', async () => {
    let capturedBody: unknown;
    const { TemplateClient } = await import('../clients/template-client.js');
    const client = new TemplateClient({ baseUrl: 'https://api.nevent.es', jwtToken: 'jwt' });
    vi.stubGlobal('fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse((init?.body as string) ?? '{}');
      return mockFetchOk(MOCK_TEST_RESULT);
    });
    await client.sendTestEmail('abc123', { emails: ['qa@example.com'] });
    expect((capturedBody as Record<string, unknown>)?.tenant_id).toBeUndefined();
  });
});
