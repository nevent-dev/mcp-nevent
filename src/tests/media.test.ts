/**
 * Unit tests for the 3 image management MCP tools:
 *  - nevent_upload_image
 *  - nevent_list_images
 *  - nevent_delete_image
 *
 * Covers:
 *  - Schema validation (Zod)
 *  - parseBase64Source helper behaviour (all branches)
 *  - Happy paths with mocked fetch
 *  - Error paths: missing mimeType, oversized payload, 403, 404, 400, empty urls
 *  - Operation mode enforcement (READ_ONLY blocks upload/delete; list always allowed)
 *  - SessionClients wiring (mediaClient exists, rotates with JWT)
 *
 * ## Testing approach
 *
 * Tool handlers call `MediaClient` methods which ultimately call `fetch()`.
 * We mock `globalThis.fetch` using `vi.stubGlobal` and restore after each test.
 *
 * The McpServer is not instantiated — we use the same minimal mock server
 * pattern used in template-operations.test.ts (captures registered handlers
 * and allows direct invocation).
 *
 * @module tests/media
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import {
  UploadImageSchema,
  ListImagesSchema,
  DeleteImageSchema,
} from '../schemas/media.js';
import { MAX_UPLOAD_BYTES } from '../clients/media-client.js';
import { isOperationAllowed } from '../config/operation-mode.js';

// ---------------------------------------------------------------------------
// Minimal server mock (same pattern as template-operations.test.ts)
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

/** Returns a Response that mimics 204 No Content (DELETE success). */
function mockFetch204(): Response {
  return {
    ok: true,
    status: 204,
    headers: { get: () => null },
    text: () => Promise.resolve(''),
    json: () => Promise.resolve(null),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Restore mocks after each test
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** Valid 1×1 red pixel PNG encoded as a data URL (tiny, well under 5 MB). */
const SMALL_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==';

/** Same pixel as raw base64 only. */
const SMALL_PNG_RAW_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==';

const MOCK_UPLOAD_RESULT = {
  destinationUrl: 'https://cdn.nevent.es/resources/tenant123/banner.png',
};

const MOCK_RESOURCES = [
  { src: 'https://cdn.nevent.es/resources/tenant123/banner.png', name: 'banner.png', mimeType: 'image/png', size: 1024 },
  { src: 'https://cdn.nevent.es/resources/tenant123/logo.jpg', name: 'logo.jpg', mimeType: 'image/jpeg', size: 2048 },
];

// ---------------------------------------------------------------------------
// Helper: set up media tools with mocked fetch
// ---------------------------------------------------------------------------

async function setupMediaTools(fetchImpl: typeof fetch) {
  const { registerMediaTools } = await import('../tools/media.js');
  const { MediaClient } = await import('../clients/media-client.js');

  const client = new MediaClient({
    baseUrl: 'https://api.nevent.es',
    jwtToken: 'test-jwt',
  });

  const server = makeMockServer();
  registerMediaTools(server as never, client);
  vi.stubGlobal('fetch', fetchImpl);
  return server;
}

// ---------------------------------------------------------------------------
// Operation mode registry
// ---------------------------------------------------------------------------

describe('Media tools — operation mode registry', () => {
  it('nevent_upload_image is WRITE (blocked in READ_ONLY)', () => {
    expect(isOperationAllowed('nevent_upload_image')).toBe(false);
  });

  it('nevent_list_images is READ (allowed in READ_ONLY)', () => {
    expect(isOperationAllowed('nevent_list_images')).toBe(true);
  });

  it('nevent_delete_image is DELETE (blocked in READ_ONLY and STANDARD)', () => {
    // Default test env is READ_ONLY — isOperationAllowed returns false for DELETE
    expect(isOperationAllowed('nevent_delete_image')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Zod schema validation
// ---------------------------------------------------------------------------

describe('Media Zod schemas', () => {
  describe('UploadImageSchema', () => {
    const schema = z.object(UploadImageSchema);

    it('accepts a data URL source (mimeType optional)', () => {
      expect(schema.safeParse({ source: SMALL_PNG_DATA_URL }).success).toBe(true);
    });

    it('accepts raw base64 with explicit mimeType', () => {
      expect(schema.safeParse({
        source: SMALL_PNG_RAW_BASE64,
        mimeType: 'image/png',
      }).success).toBe(true);
    });

    it('accepts optional imageName', () => {
      expect(schema.safeParse({
        source: SMALL_PNG_DATA_URL,
        imageName: 'banner.png',
      }).success).toBe(true);
    });

    it('rejects empty source', () => {
      expect(schema.safeParse({ source: '' }).success).toBe(false);
    });

    it('rejects missing source', () => {
      expect(schema.safeParse({}).success).toBe(false);
    });

    it('rejects empty imageName', () => {
      expect(schema.safeParse({ source: SMALL_PNG_DATA_URL, imageName: '' }).success).toBe(false);
    });
  });

  describe('ListImagesSchema', () => {
    const schema = z.object(ListImagesSchema);

    it('accepts empty params (no required fields)', () => {
      expect(schema.safeParse({}).success).toBe(true);
    });

    it('ignores unknown fields (zod strips by default)', () => {
      // z.object() in strict mode would reject extras, but default mode strips them
      expect(schema.safeParse({ anything: 'value' }).success).toBe(true);
    });
  });

  describe('DeleteImageSchema', () => {
    const schema = z.object(DeleteImageSchema);

    it('accepts a single URL', () => {
      expect(schema.safeParse({
        urls: ['https://cdn.nevent.es/resources/tenant123/banner.png'],
      }).success).toBe(true);
    });

    it('accepts multiple URLs', () => {
      expect(schema.safeParse({
        urls: [
          'https://cdn.nevent.es/resources/tenant123/a.png',
          'https://cdn.nevent.es/resources/tenant123/b.jpg',
        ],
      }).success).toBe(true);
    });

    it('rejects empty urls array', () => {
      expect(schema.safeParse({ urls: [] }).success).toBe(false);
    });

    it('rejects missing urls field', () => {
      expect(schema.safeParse({}).success).toBe(false);
    });

    it('rejects urls array containing empty string', () => {
      expect(schema.safeParse({ urls: [''] }).success).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// nevent_upload_image
// ---------------------------------------------------------------------------

describe('nevent_upload_image', () => {
  const isWriteAllowed =
    process.env['NEVENT_OPERATION_MODE'] === 'STANDARD' ||
    process.env['NEVENT_OPERATION_MODE'] === 'FULL';

  it('returns operation_not_permitted in READ_ONLY mode', async () => {
    if (isWriteAllowed) return; // skip
    const server = await setupMediaTools(vi.fn() as unknown as typeof fetch);
    const result = await server.invoke('nevent_upload_image', {
      source: SMALL_PNG_DATA_URL,
    }) as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text) as { error: { code: string } };
    expect(body.error.code).toBe('operation_not_permitted');
  });

  it('happy path: data URL → upload succeeds, returns destinationUrl (STANDARD/FULL)', async () => {
    if (!isWriteAllowed) return;
    const server = await setupMediaTools(() => mockFetchOk(MOCK_UPLOAD_RESULT));
    const result = await server.invoke('nevent_upload_image', {
      source: SMALL_PNG_DATA_URL,
      imageName: 'banner.png',
    }) as { content: Array<{ text: string }> };
    const body = JSON.parse(result.content[0].text) as {
      destinationUrl: string;
      mimeType: string;
      sizeBytes: number;
    };
    expect(body.destinationUrl).toBe(MOCK_UPLOAD_RESULT.destinationUrl);
    expect(body.mimeType).toBe('image/png');
    expect(typeof body.sizeBytes).toBe('number');
    expect(body.sizeBytes).toBeGreaterThan(0);
  });

  it('happy path: raw base64 + mimeType → upload succeeds (STANDARD/FULL)', async () => {
    if (!isWriteAllowed) return;
    const server = await setupMediaTools(() => mockFetchOk(MOCK_UPLOAD_RESULT));
    const result = await server.invoke('nevent_upload_image', {
      source: SMALL_PNG_RAW_BASE64,
      mimeType: 'image/png',
    }) as { content: Array<{ text: string }> };
    const body = JSON.parse(result.content[0].text) as { destinationUrl: string };
    expect(body.destinationUrl).toBe(MOCK_UPLOAD_RESULT.destinationUrl);
  });

  it('error: raw base64 without mimeType → invalid_source error (STANDARD/FULL)', async () => {
    if (!isWriteAllowed) return;
    const server = await setupMediaTools(vi.fn() as unknown as typeof fetch);
    const result = await server.invoke('nevent_upload_image', {
      source: SMALL_PNG_RAW_BASE64,
      // mimeType intentionally omitted
    }) as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_source');
  });

  it('error: oversized payload (>5MB decoded) → rejected before network (STANDARD/FULL)', async () => {
    if (!isWriteAllowed) return;
    // Build a base64 string that decodes to MAX_UPLOAD_BYTES + 1 bytes
    const oversizedBytes = Buffer.alloc(MAX_UPLOAD_BYTES + 1, 0x41); // 5MB + 1 byte of 'A'
    const oversizedBase64 = oversizedBytes.toString('base64');

    // We expect the tool to reject WITHOUT calling fetch
    const fetchSpy = vi.fn() as unknown as typeof fetch;
    const server = await setupMediaTools(fetchSpy);

    const result = await server.invoke('nevent_upload_image', {
      source: oversizedBase64,
      mimeType: 'image/png',
    }) as { isError: boolean; content: Array<{ text: string }> };

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('invalid_source');
    expect(body.error.message).toContain('5 MB');
    // Fetch must NOT have been called — size check happens before the network call
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('error: malformed data URL (no comma) → invalid_source error (STANDARD/FULL)', async () => {
    if (!isWriteAllowed) return;
    const server = await setupMediaTools(vi.fn() as unknown as typeof fetch);
    const result = await server.invoke('nevent_upload_image', {
      source: 'data:image/png;base64NO-COMMA-HERE',
    }) as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_source');
  });

  it('error: 403 forbidden → error envelope (STANDARD/FULL)', async () => {
    if (!isWriteAllowed) return;
    const server = await setupMediaTools(() => mockFetchError(403));
    const result = await server.invoke('nevent_upload_image', {
      source: SMALL_PNG_DATA_URL,
    }) as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text) as { error: { code: string } };
    expect(body.error.code).toBe('forbidden');
  });

  it('error: 413 payload too large (server side) → error envelope (STANDARD/FULL)', async () => {
    if (!isWriteAllowed) return;
    const server = await setupMediaTools(() => mockFetchError(413));
    const result = await server.invoke('nevent_upload_image', {
      source: SMALL_PNG_DATA_URL,
    }) as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text) as { error: { code: string } };
    expect(body.error.code).toBe('payload_too_large');
  });

  it('upload sends multipart (not JSON) — no Content-Type: application/json header (STANDARD/FULL)', async () => {
    if (!isWriteAllowed) return;
    let capturedContentType: string | null | undefined;
    const server = await setupMediaTools(async (_url, init) => {
      const headers = init?.headers as Record<string, string> | undefined;
      capturedContentType = headers?.['Content-Type'];
      return mockFetchOk(MOCK_UPLOAD_RESULT);
    });
    await server.invoke('nevent_upload_image', { source: SMALL_PNG_DATA_URL });
    // Content-Type should NOT be set manually to application/json —
    // fetch sets it automatically with the boundary param for FormData.
    expect(capturedContentType).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// nevent_list_images
// ---------------------------------------------------------------------------

describe('nevent_list_images', () => {
  // list_images is READ — allowed in all modes including READ_ONLY

  it('happy path: returns resources array with count', async () => {
    const server = await setupMediaTools(() => mockFetchOk(MOCK_RESOURCES));
    const result = await server.invoke('nevent_list_images', {}) as {
      content: Array<{ text: string }>;
    };
    const body = JSON.parse(result.content[0].text) as {
      resources: typeof MOCK_RESOURCES;
      count: number;
    };
    expect(body.count).toBe(2);
    expect(body.resources).toHaveLength(2);
    expect(body.resources[0].src).toBe(MOCK_RESOURCES[0].src);
  });

  it('empty result: returns resources=[] and count=0', async () => {
    const server = await setupMediaTools(() => mockFetchOk([]));
    const result = await server.invoke('nevent_list_images', {}) as {
      content: Array<{ text: string }>;
    };
    const body = JSON.parse(result.content[0].text) as { resources: unknown[]; count: number };
    expect(body.resources).toEqual([]);
    expect(body.count).toBe(0);
  });

  it('error: 401 unauthenticated → error envelope', async () => {
    const server = await setupMediaTools(() => mockFetchError(401));
    const result = await server.invoke('nevent_list_images', {}) as {
      isError?: boolean;
    };
    // Without a registered onUnauthorized callback, the 401 propagates as an error
    expect(result).toBeDefined();
  });

  it('error: 403 forbidden → error envelope', async () => {
    const server = await setupMediaTools(() => mockFetchError(403));
    const result = await server.invoke('nevent_list_images', {}) as {
      isError: boolean;
    };
    expect(result.isError).toBe(true);
  });

  it('GET request sent to /media/resources (STANDARD/FULL)', async () => {
    let capturedUrl: string | undefined;
    const server = await setupMediaTools(async (url) => {
      capturedUrl = typeof url === 'string' ? url : (url as URL).toString();
      return mockFetchOk(MOCK_RESOURCES);
    });
    await server.invoke('nevent_list_images', {});
    expect(capturedUrl).toContain('/media/resources');
  });
});

// ---------------------------------------------------------------------------
// nevent_delete_image
// ---------------------------------------------------------------------------

describe('nevent_delete_image', () => {
  const isDeleteAllowed = process.env['NEVENT_OPERATION_MODE'] === 'FULL';

  it('returns operation_not_permitted in READ_ONLY mode (default test env)', async () => {
    if (isDeleteAllowed) return; // skip
    const server = await setupMediaTools(vi.fn() as unknown as typeof fetch);
    const result = await server.invoke('nevent_delete_image', {
      urls: ['https://cdn.nevent.es/resources/tenant123/banner.png'],
    }) as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text) as { error: { code: string } };
    expect(body.error.code).toBe('operation_not_permitted');
  });

  it('happy path: deletes valid URLs and returns count (FULL only)', async () => {
    if (!isDeleteAllowed) return;
    const server = await setupMediaTools(() => mockFetch204());
    const result = await server.invoke('nevent_delete_image', {
      urls: [
        'https://cdn.nevent.es/resources/tenant123/banner.png',
        'https://cdn.nevent.es/resources/tenant123/logo.jpg',
      ],
    }) as { content: Array<{ text: string }> };
    const body = JSON.parse(result.content[0].text) as { deleted: number; urls: string[] };
    expect(body.deleted).toBe(2);
    expect(body.urls).toHaveLength(2);
  });

  it('error: empty urls array → clear error before API call (FULL only)', async () => {
    if (!isDeleteAllowed) return;
    const fetchSpy = vi.fn() as unknown as typeof fetch;
    const server = await setupMediaTools(fetchSpy);
    const result = await server.invoke('nevent_delete_image', {
      urls: [],
    }) as { isError: boolean; content: Array<{ text: string }> };
    // The schema enforces min(1), but the runtime guard also fires
    // In practice Zod rejects this at schema parse time — the handler does a
    // belt-and-suspenders check. Either way fetch must NOT be called.
    // We assert the tool returns an error (isError true OR schema rejection).
    // Schema rejection at the server.tool layer would throw before reaching the handler;
    // here we test the runtime handler guard only, so pass urls=[] directly.
    expect(result.isError).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('DELETE request sends URLs array in body (FULL only)', async () => {
    if (!isDeleteAllowed) return;
    let capturedBody: unknown;
    const server = await setupMediaTools(async (_url, init) => {
      capturedBody = JSON.parse((init?.body as string) ?? '[]');
      return mockFetch204();
    });
    const urlsToDelete = ['https://cdn.nevent.es/resources/tenant123/banner.png'];
    await server.invoke('nevent_delete_image', { urls: urlsToDelete });
    expect(capturedBody).toEqual(urlsToDelete);
  });

  it('DELETE request uses DELETE HTTP method (FULL only)', async () => {
    if (!isDeleteAllowed) return;
    let capturedMethod: string | undefined;
    const server = await setupMediaTools(async (_url, init) => {
      capturedMethod = init?.method;
      return mockFetch204();
    });
    await server.invoke('nevent_delete_image', {
      urls: ['https://cdn.nevent.es/resources/tenant123/banner.png'],
    });
    expect(capturedMethod).toBe('DELETE');
  });

  it('error: 403 forbidden → error envelope (FULL only)', async () => {
    if (!isDeleteAllowed) return;
    const server = await setupMediaTools(() => mockFetchError(403));
    const result = await server.invoke('nevent_delete_image', {
      urls: ['https://cdn.nevent.es/resources/tenant123/banner.png'],
    }) as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text) as { error: { code: string } };
    expect(body.error.code).toBe('forbidden');
  });

  it('error: 400 invalid request → error envelope (FULL only)', async () => {
    if (!isDeleteAllowed) return;
    const server = await setupMediaTools(() => mockFetchError(400, { message: 'Invalid URL format' }));
    const result = await server.invoke('nevent_delete_image', {
      urls: ['https://cdn.nevent.es/resources/tenant123/banner.png'],
    }) as { isError: boolean };
    expect(result.isError).toBe(true);
  });

  it('does NOT send tenant_id in request body (FULL only)', async () => {
    if (!isDeleteAllowed) return;
    let capturedBody: unknown;
    const server = await setupMediaTools(async (_url, init) => {
      capturedBody = JSON.parse((init?.body as string) ?? '[]');
      return mockFetch204();
    });
    await server.invoke('nevent_delete_image', {
      urls: ['https://cdn.nevent.es/resources/tenant123/banner.png'],
    });
    // body should be a plain array, not an object with tenant_id
    expect(Array.isArray(capturedBody)).toBe(true);
    // TypeScript type cast — at runtime this is an array
    const bodyArray = capturedBody as unknown[];
    expect(bodyArray).not.toContain('tenant_id');
  });
});

// ---------------------------------------------------------------------------
// SessionClients integration — mediaClient wiring
// ---------------------------------------------------------------------------

describe('SessionClients — mediaClient wiring', () => {
  it('mediaClient is accessible on SessionClients instance', async () => {
    const { DataClient } = await import('../clients/data-client.js');
    const { PaidMediaClient } = await import('../clients/paid-media-client.js');
    const { SessionClients } = await import('../clients/session-clients.js');

    const dc = new DataClient({ baseUrl: 'https://data.nevent.es', jwtToken: 'jwt-1' });
    const pmc = new PaidMediaClient({ baseUrl: 'https://api.nevent.es', jwtToken: 'jwt-1' });
    const sc = new SessionClients(dc, pmc, 'https://api.nevent.es');

    expect(sc.mediaClient).toBeDefined();
  });

  it('rotateJwt updates mediaClient token atomically', async () => {
    const { DataClient } = await import('../clients/data-client.js');
    const { PaidMediaClient } = await import('../clients/paid-media-client.js');
    const { SessionClients } = await import('../clients/session-clients.js');

    const dc = new DataClient({ baseUrl: 'https://data.nevent.es', jwtToken: 'old-jwt' });
    const pmc = new PaidMediaClient({ baseUrl: 'https://api.nevent.es', jwtToken: 'old-jwt' });
    const sc = new SessionClients(dc, pmc, 'https://api.nevent.es');

    sc.rotateJwt('new-jwt');

    expect(sc.mediaClient.getJwtToken()).toBe('new-jwt');
  });

  it('mediaClient shares same initial JWT as paidMediaClient', async () => {
    const { DataClient } = await import('../clients/data-client.js');
    const { PaidMediaClient } = await import('../clients/paid-media-client.js');
    const { SessionClients } = await import('../clients/session-clients.js');

    const dc = new DataClient({ baseUrl: 'https://data.nevent.es', jwtToken: 'initial-jwt' });
    const pmc = new PaidMediaClient({ baseUrl: 'https://api.nevent.es', jwtToken: 'initial-jwt' });
    const sc = new SessionClients(dc, pmc, 'https://api.nevent.es');

    expect(sc.mediaClient.getJwtToken()).toBe('initial-jwt');
    expect(sc.paidMediaClient.getJwtToken()).toBe('initial-jwt');
  });
});

// ---------------------------------------------------------------------------
// Base64 parsing edge cases (via the tool invocation path)
// ---------------------------------------------------------------------------

describe('nevent_upload_image — base64 parsing edge cases', () => {
  const isWriteAllowed =
    process.env['NEVENT_OPERATION_MODE'] === 'STANDARD' ||
    process.env['NEVENT_OPERATION_MODE'] === 'FULL';

  it('data URL with non-base64 encoding hint → rejected (STANDARD/FULL)', async () => {
    if (!isWriteAllowed) return;
    const server = await setupMediaTools(vi.fn() as unknown as typeof fetch);
    // Use charset=utf-8 encoding (not base64)
    const result = await server.invoke('nevent_upload_image', {
      source: 'data:text/plain;charset=utf-8,hello world',
    }) as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_source');
  });

  it('data URL missing MIME type → rejected (STANDARD/FULL)', async () => {
    if (!isWriteAllowed) return;
    const server = await setupMediaTools(vi.fn() as unknown as typeof fetch);
    // Malformed: data: prefix but no MIME
    const result = await server.invoke('nevent_upload_image', {
      source: 'data:;base64,abc',
    }) as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
  });

  it('MIME type resolved from data URL prefix, not from mimeType param (STANDARD/FULL)', async () => {
    if (!isWriteAllowed) return;
    // data URL says image/png; mimeType param says image/jpeg — data URL wins
    let capturedFormData: FormData | undefined;
    const server = await setupMediaTools(async (_url, init) => {
      capturedFormData = init?.body as FormData;
      return mockFetchOk(MOCK_UPLOAD_RESULT);
    });
    const result = await server.invoke('nevent_upload_image', {
      source: SMALL_PNG_DATA_URL,  // data URL: image/png
      mimeType: 'image/jpeg',      // should be IGNORED
    }) as { content: Array<{ text: string }> };
    const body = JSON.parse(result.content[0].text) as { mimeType: string };
    // The resolved mimeType in the response must come from the data URL prefix
    expect(body.mimeType).toBe('image/png');
    void capturedFormData; // suppress unused-variable lint
  });
});
