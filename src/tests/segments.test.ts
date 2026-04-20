/**
 * Unit tests for Sprint 2 segment management tools.
 *
 * Tests cover:
 *  - nevent_list_segments: successful response, empty list, API error
 *  - nevent_create_segment: successful create, READ_ONLY block, API error
 *  - nevent_update_segment: successful update, READ_ONLY block, missing fields error,
 *    segment not found error
 *  - operation-mode registry: Sprint 2 tools are correctly registered
 *  - Schema validation: CreateSegmentSchema, UpdateSegmentSchema, ListSegmentsSchema
 *
 * ## Testing approach
 *
 * Since the segment tools call nev-api via `fetch()` we mock `globalThis.fetch`
 * using `vi.stubGlobal`. Each test restores the original after completion via
 * `afterEach`.
 *
 * The `McpServer` from the SDK does not need to be instantiated — we test
 * `registerSegmentTools` by passing a minimal mock server that captures
 * registered tool handlers. This avoids standing up a real MCP server.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { isOperationAllowed } from '../config/operation-mode.js';

// ---------------------------------------------------------------------------
// Minimal DataClient mock
// ---------------------------------------------------------------------------

/**
 * Factory for a minimal DataClient-shaped object that satisfies the
 * `registerSegmentTools` interface without requiring the full class.
 *
 * @param jwtToken - JWT to return from the `jwtToken` private property.
 * @param activeTenantId - Optional active tenant ID.
 */
function makeDataClient(jwtToken = 'test-jwt', activeTenantId?: string) {
  return {
    jwtToken,
    activeTenantId,
    setActiveTenant(id: string | undefined) {
      this.activeTenantId = id;
    },
  } as unknown as import('../clients/data-client.js').DataClient;
}

// ---------------------------------------------------------------------------
// Minimal McpServer mock
// ---------------------------------------------------------------------------

type ToolHandler = (params: Record<string, unknown>) => Promise<unknown>;

/**
 * Factory for a minimal McpServer-shaped object that captures tool registrations.
 * Allows tests to invoke tool handlers directly without the full SDK overhead.
 */
function makeMockServer() {
  const tools: Record<string, ToolHandler> = {};
  return {
    // Accept both 4-arg (name, description, schema, handler) and
    // 5-arg (name, description, schema, annotations, handler) signatures.
    tool(name: string, _description: string, _schema: unknown, annotationsOrHandler: unknown, maybeHandler?: ToolHandler) {
      tools[name] = maybeHandler ?? (annotationsOrHandler as ToolHandler);
    },
    /** Invoke a registered tool handler by name. */
    async invoke(name: string, params: Record<string, unknown> = {}) {
      if (!tools[name]) throw new Error(`Tool "${name}" not registered`);
      return tools[name](params);
    },
  };
}

// ---------------------------------------------------------------------------
// Helper to build a mock fetch Response
// ---------------------------------------------------------------------------

function mockFetchOk(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function mockFetchError(status: number, body: string): Response {
  return {
    ok: false,
    status,
    text: () => Promise.resolve(body),
    json: () => Promise.reject(new Error('not JSON')),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Restore fetch after each test
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Operation mode registry — Sprint 2 tools
// ---------------------------------------------------------------------------

describe('Sprint 2 operation-mode registry', () => {
  it('nevent_list_segments is READ (allowed in READ_ONLY)', () => {
    expect(isOperationAllowed('nevent_list_segments')).toBe(true);
  });

  it('nevent_create_segment is WRITE (blocked in READ_ONLY default test env)', () => {
    // Default test env is READ_ONLY, so WRITE tools are blocked
    if (!process.env['NEVENT_OPERATION_MODE']) {
      expect(isOperationAllowed('nevent_create_segment')).toBe(false);
    }
  });

  it('nevent_update_segment is WRITE (blocked in READ_ONLY default test env)', () => {
    if (!process.env['NEVENT_OPERATION_MODE']) {
      expect(isOperationAllowed('nevent_update_segment')).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// nevent_list_segments
// ---------------------------------------------------------------------------

describe('nevent_list_segments', () => {
  async function registerAndList(
    fetchImpl: typeof fetch,
    activeTenantId?: string
  ) {
    const { registerSegmentTools } = await import('../tools/segments.js');
    const server = makeMockServer();
    const client = makeDataClient('test-jwt', activeTenantId);
    registerSegmentTools(server as never, client, 'https://api.nevent.es');
    vi.stubGlobal('fetch', fetchImpl);
    return server.invoke('nevent_list_segments');
  }

  it('returns segments list with count on successful API response (plain array)', async () => {
    const segments = [
      { id: 'seg1', name: 'VIP fans', estimatedCount: 1500, status: 'ACTIVE', createdAt: '2025-01-01T00:00:00Z' },
      { id: 'seg2', name: 'New subscribers', estimatedCount: 300, status: 'ACTIVE', createdAt: '2025-02-01T00:00:00Z' },
    ];

    const result = await registerAndList(
      vi.fn().mockResolvedValue(mockFetchOk(segments)) as unknown as typeof fetch
    ) as { content: Array<{ type: string; text: string }> };

    expect(result.content).toHaveLength(1);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.count).toBe(2);
    expect(parsed.segments).toHaveLength(2);
    expect(parsed.segments[0].id).toBe('seg1');
    expect(parsed.segments[0].name).toBe('VIP fans');
  });

  it('normalizes Spring Page envelope response', async () => {
    const springResponse = {
      content: [{ id: 'seg1', name: 'Test segment' }],
      totalElements: 1,
      totalPages: 1,
      number: 0,
    };

    const result = await registerAndList(
      vi.fn().mockResolvedValue(mockFetchOk(springResponse)) as unknown as typeof fetch
    ) as { content: Array<{ type: string; text: string }> };

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.count).toBe(1);
    expect(parsed.segments[0].id).toBe('seg1');
  });

  it('normalizes segments-envelope response', async () => {
    const envelopeResponse = {
      segments: [{ id: 'seg1', name: 'Test segment' }],
      total: 1,
    };

    const result = await registerAndList(
      vi.fn().mockResolvedValue(mockFetchOk(envelopeResponse)) as unknown as typeof fetch
    ) as { content: Array<{ type: string; text: string }> };

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.count).toBe(1);
  });

  it('returns empty list with count=0 when tenant has no segments', async () => {
    const result = await registerAndList(
      vi.fn().mockResolvedValue(mockFetchOk([])) as unknown as typeof fetch
    ) as { content: Array<{ type: string; text: string }> };

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.count).toBe(0);
    expect(parsed.segments).toEqual([]);
  });

  it('includes tenant_id query param when activeTenantId is set', async () => {
    let capturedUrl = '';
    const fetchSpy = vi.fn().mockImplementation((url: string) => {
      capturedUrl = url;
      return Promise.resolve(mockFetchOk([]));
    });

    await registerAndList(fetchSpy as unknown as typeof fetch, 'tenant_xyz');

    expect(capturedUrl).toContain('tenant_id=tenant_xyz');
  });

  it('does not include tenant_id when activeTenantId is not set', async () => {
    let capturedUrl = '';
    const fetchSpy = vi.fn().mockImplementation((url: string) => {
      capturedUrl = url;
      return Promise.resolve(mockFetchOk([]));
    });

    await registerAndList(fetchSpy as unknown as typeof fetch, undefined);

    expect(capturedUrl).not.toContain('tenant_id');
  });

  it('returns isError:true on 403 Forbidden', async () => {
    const result = await registerAndList(
      vi.fn().mockResolvedValue(mockFetchError(403, 'Forbidden')) as unknown as typeof fetch
    ) as { content: Array<{ type: string; text: string }>; isError: boolean };

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error.type).toBe('authentication_error');
    expect(parsed.error.code).toBe('forbidden');
  });

  it('returns isError:true on 500 API error', async () => {
    const result = await registerAndList(
      vi.fn().mockResolvedValue(mockFetchError(500, 'Internal Server Error')) as unknown as typeof fetch
    ) as { content: Array<{ type: string; text: string }>; isError: boolean };

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error.type).toBe('api_error');
  });

  it('returns isError:true on network error', async () => {
    const result = await registerAndList(
      vi.fn().mockRejectedValue(new Error('Network failure')) as unknown as typeof fetch
    ) as { content: Array<{ type: string; text: string }>; isError: boolean };

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error.code).toBe('unexpected_error');
  });

  it('projects only allowed fields from raw segment record', async () => {
    const rawSegment = {
      id: 'seg1',
      name: 'Test',
      estimatedCount: 42,
      status: 'ACTIVE',
      lastExecutedAt: '2025-03-01T00:00:00Z',
      createdAt: '2025-01-01T00:00:00Z',
      createdBy: 'admin',
      isLegacy: false,
      internalField: 'should-not-appear',
      mongoMeta: { __v: 0 },
    };

    const result = await registerAndList(
      vi.fn().mockResolvedValue(mockFetchOk([rawSegment])) as unknown as typeof fetch
    ) as { content: Array<{ type: string; text: string }> };

    const parsed = JSON.parse(result.content[0].text);
    const seg = parsed.segments[0];
    expect(seg.id).toBe('seg1');
    expect(seg.estimatedCount).toBe(42);
    expect(seg.lastExecutedAt).toBe('2025-03-01T00:00:00Z');
    expect(seg.isLegacy).toBe(false);
    // Internal fields must not leak
    expect(seg.internalField).toBeUndefined();
    expect(seg.mongoMeta).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// nevent_create_segment
// ---------------------------------------------------------------------------

describe('nevent_create_segment', () => {
  const validDefinition = {
    stanzas: [
      {
        criteria: [
          { type: 'behavior', criterion_id: 'event_attended', operator: 'eq', value: 'EVENT_1' },
        ],
      },
    ],
  };

  async function registerAndCreate(
    fetchImpl: typeof fetch,
    params: Record<string, unknown> = {}
  ) {
    const { registerSegmentTools } = await import('../tools/segments.js');
    const server = makeMockServer();
    const client = makeDataClient('test-jwt', 'tenant_abc');
    registerSegmentTools(server as never, client, 'https://api.nevent.es');
    vi.stubGlobal('fetch', fetchImpl);
    return server.invoke('nevent_create_segment', {
      name: 'Test segment',
      definition: validDefinition,
      ...params,
    });
  }

  it('returns isError:true in READ_ONLY mode (default test env)', async () => {
    if (process.env['NEVENT_OPERATION_MODE']) return; // skip if mode is overridden

    const result = await registerAndCreate(
      vi.fn() as unknown as typeof fetch
    ) as { content: Array<{ type: string; text: string }>; isError: boolean };

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error.code).toBe('operation_not_permitted');
    expect(parsed.error.message).toContain('STANDARD');
  });

  it('returns created segment on successful POST (if STANDARD/FULL mode)', async () => {
    if (!process.env['NEVENT_OPERATION_MODE'] || process.env['NEVENT_OPERATION_MODE'] === 'READ_ONLY') {
      return; // can't test this in READ_ONLY — tool is blocked
    }

    const createdSegment = {
      segment: {
        id: 'new-seg-id',
        name: 'Test segment',
        status: 'ACTIVE',
        createdAt: '2026-04-15T00:00:00Z',
        createdBy: 'mcp-agent',
      },
    };

    const result = await registerAndCreate(
      vi.fn().mockResolvedValue(mockFetchOk(createdSegment)) as unknown as typeof fetch
    ) as { content: Array<{ type: string; text: string }> };

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.segment.id).toBe('new-seg-id');
    expect(parsed.segment.name).toBe('Test segment');
  });
});

// ---------------------------------------------------------------------------
// nevent_update_segment
// ---------------------------------------------------------------------------

describe('nevent_update_segment', () => {
  async function registerAndUpdate(
    fetchImpl: typeof fetch,
    params: Record<string, unknown> = {}
  ) {
    const { registerSegmentTools } = await import('../tools/segments.js');
    const server = makeMockServer();
    const client = makeDataClient('test-jwt', 'tenant_abc');
    registerSegmentTools(server as never, client, 'https://api.nevent.es');
    vi.stubGlobal('fetch', fetchImpl);
    return server.invoke('nevent_update_segment', params);
  }

  it('returns isError:true in READ_ONLY mode (default test env)', async () => {
    if (process.env['NEVENT_OPERATION_MODE']) return; // skip if mode is overridden

    const result = await registerAndUpdate(
      vi.fn() as unknown as typeof fetch,
      { segment_id: 'seg1', name: 'New name' }
    ) as { content: Array<{ type: string; text: string }>; isError: boolean };

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error.code).toBe('operation_not_permitted');
  });

  it('returns isError:true when neither name nor definition is provided (STANDARD/FULL)', async () => {
    if (!process.env['NEVENT_OPERATION_MODE'] || process.env['NEVENT_OPERATION_MODE'] === 'READ_ONLY') {
      return; // blocked by mode guard — can't reach the field validation
    }

    const result = await registerAndUpdate(
      vi.fn() as unknown as typeof fetch,
      { segment_id: 'seg1' }
    ) as { content: Array<{ type: string; text: string }>; isError: boolean };

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error.code).toBe('missing_update_fields');
  });

  it('returns not_found error on 404 response (STANDARD/FULL)', async () => {
    if (!process.env['NEVENT_OPERATION_MODE'] || process.env['NEVENT_OPERATION_MODE'] === 'READ_ONLY') {
      return;
    }

    const result = await registerAndUpdate(
      vi.fn().mockResolvedValue(mockFetchError(404, 'Not found')) as unknown as typeof fetch,
      { segment_id: 'nonexistent', name: 'New name' }
    ) as { content: Array<{ type: string; text: string }>; isError: boolean };

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error.type).toBe('not_found');
    expect(parsed.error.code).toBe('segment_not_found');
  });
});

// ---------------------------------------------------------------------------
// Schema validation tests
// ---------------------------------------------------------------------------

describe('Segment Zod schemas', () => {
  it('ListSegmentsSchema is empty object (no required params)', async () => {
    const { ListSegmentsSchema } = await import('../schemas/segments.js');
    expect(ListSegmentsSchema).toEqual({});
  });

  it('CreateSegmentSchema requires name and definition', async () => {
    const { CreateSegmentSchema } = await import('../schemas/segments.js');
    const { z } = await import('zod');
    const schema = z.object(CreateSegmentSchema);

    // Valid input (without type — type is optional now)
    const validResult = schema.safeParse({
      name: 'My segment',
      definition: { stanzas: [{ criteria: [{ criterion_id: 'x', operator: 'eq', value: 'v' }] }] },
    });
    expect(validResult.success).toBe(true);

    // Missing name (stanzas min 1)
    const noNameResult = schema.safeParse({
      definition: { stanzas: [{ criteria: [{ criterion_id: 'x', operator: 'eq', value: 'v' }] }] },
    });
    expect(noNameResult.success).toBe(false);

    // Empty name string rejected by min(1)
    const emptyNameResult = schema.safeParse({
      name: '',
      definition: { stanzas: [{ criteria: [{ criterion_id: 'x', operator: 'eq', value: 'v' }] }] },
    });
    expect(emptyNameResult.success).toBe(false);

    // Missing definition
    const noDefResult = schema.safeParse({ name: 'Test' });
    expect(noDefResult.success).toBe(false);

    // With optional description
    const withDesc = schema.safeParse({
      name: 'My segment',
      definition: { stanzas: [{ criteria: [{ criterion_id: 'x', operator: 'eq', value: 'v' }] }] },
      description: 'Optional description',
    });
    expect(withDesc.success).toBe(true);
    if (withDesc.success) {
      expect(withDesc.data.description).toBe('Optional description');
    }
  });

  it('UpdateSegmentSchema requires segment_id', async () => {
    const { UpdateSegmentSchema } = await import('../schemas/segments.js');
    const { z } = await import('zod');
    const schema = z.object(UpdateSegmentSchema);

    // Missing segment_id
    const noIdResult = schema.safeParse({ name: 'New name' });
    expect(noIdResult.success).toBe(false);

    // Valid with only segment_id and name
    const withNameResult = schema.safeParse({ segment_id: '64f3a1b2c8e94d001e2a7f3c', name: 'New name' });
    expect(withNameResult.success).toBe(true);

    // Valid with only segment_id (name/definition are both optional in Zod)
    const onlyIdResult = schema.safeParse({ segment_id: '64f3a1b2c8e94d001e2a7f3c' });
    expect(onlyIdResult.success).toBe(true);

    // Invalid ObjectId format (too short) rejected by regex
    const shortIdResult = schema.safeParse({ segment_id: 'abc123' });
    expect(shortIdResult.success).toBe(false);

    // Empty segment_id rejected by min(1)
    const emptyIdResult = schema.safeParse({ segment_id: '' });
    expect(emptyIdResult.success).toBe(false);
  });
});
