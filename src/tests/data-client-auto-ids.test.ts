/**
 * Unit tests for DataClient auto-ID injection and BaseClient error propagation.
 *
 * Tests cover:
 *  1. previewSegment without IDs → request body has auto-generated IDs on all stanzas/criteria
 *  2. previewSegment with pre-existing IDs → original IDs are preserved
 *  3. executeSegment also auto-generates IDs
 *  4. BaseClient.buildApiError propagates body.error when it is a plain string
 *  5. BaseClient.buildApiError still works with the old nested { error: { message } } shape
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { DataClient } from '../clients/data-client.js';
import { BaseClient, NeventApiError } from '../clients/base-client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal mock fetch Response that returns `body` as JSON with status 200. */
function mockJsonOk(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => body,
  } as unknown as Response;
}

/** Build a mock fetch Response that returns an error with the given status and JSON body. */
function mockJsonError(status: number, body: unknown): Response {
  return {
    ok: false,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Shared setup / teardown
// ---------------------------------------------------------------------------

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. previewSegment without IDs → auto-generated IDs injected
// ---------------------------------------------------------------------------

describe('DataClient.previewSegment — auto-ID injection', () => {
  it('injects non-empty stanza ID when stanza.id is absent', async () => {
    mockFetch.mockResolvedValue(
      mockJsonOk({ estimated_fan_count: 0, sample_fans: [] })
    );

    const client = new DataClient({ baseUrl: 'https://data.nevent.es', jwtToken: 'jwt' });
    await client.previewSegment({
      stanzas: [
        { criteria: [{ criterion_id: 'total_spent', operator: 'gt', value: 100 }] },
      ],
    });

    const callArgs = mockFetch.mock.calls[0];
    const body = JSON.parse(callArgs[1].body as string) as {
      definition: { stanzas: Array<{ id: string; criteria: Array<{ id: string }> }> };
    };

    expect(typeof body.definition.stanzas[0].id).toBe('string');
    expect(body.definition.stanzas[0].id.length).toBeGreaterThan(0);
  });

  it('injects non-empty criterion ID when criterion.id is absent', async () => {
    mockFetch.mockResolvedValue(
      mockJsonOk({ estimated_fan_count: 0, sample_fans: [] })
    );

    const client = new DataClient({ baseUrl: 'https://data.nevent.es', jwtToken: 'jwt' });
    await client.previewSegment({
      stanzas: [
        { criteria: [{ criterion_id: 'total_spent', operator: 'gt', value: 100 }] },
      ],
    });

    const callArgs = mockFetch.mock.calls[0];
    const body = JSON.parse(callArgs[1].body as string) as {
      definition: { stanzas: Array<{ criteria: Array<{ id: string }> }> };
    };

    expect(typeof body.definition.stanzas[0].criteria[0].id).toBe('string');
    expect(body.definition.stanzas[0].criteria[0].id.length).toBeGreaterThan(0);
  });

  it('injects IDs for all stanzas and all criteria in multi-stanza definition', async () => {
    mockFetch.mockResolvedValue(
      mockJsonOk({ estimated_fan_count: 0, sample_fans: [] })
    );

    const client = new DataClient({ baseUrl: 'https://data.nevent.es', jwtToken: 'jwt' });
    await client.previewSegment({
      stanzas: [
        {
          criteria: [
            { criterion_id: 'total_spent', operator: 'gt', value: 100 },
            { criterion_id: 'user_gender', operator: 'eq', value: 'female' },
          ],
        },
        {
          criteria: [
            { criterion_id: 'attended_event', operator: 'is', value: 'EVENT_1' },
          ],
        },
      ],
    });

    const callArgs = mockFetch.mock.calls[0];
    const body = JSON.parse(callArgs[1].body as string) as {
      definition: { stanzas: Array<{ id: string; criteria: Array<{ id: string }> }> };
    };

    // All stanzas must have IDs
    for (const stanza of body.definition.stanzas) {
      expect(stanza.id.length).toBeGreaterThan(0);
      // All criteria in each stanza must have IDs
      for (const criterion of stanza.criteria) {
        expect(criterion.id.length).toBeGreaterThan(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 2. previewSegment with pre-existing IDs → IDs are preserved
// ---------------------------------------------------------------------------

describe('DataClient.previewSegment — existing IDs preserved', () => {
  it('preserves stanza.id when already set', async () => {
    mockFetch.mockResolvedValue(
      mockJsonOk({ estimated_fan_count: 10, sample_fans: [] })
    );

    const client = new DataClient({ baseUrl: 'https://data.nevent.es', jwtToken: 'jwt' });
    await client.previewSegment({
      stanzas: [
        {
          id: 'my-stanza',
          criteria: [
            { id: 'my-crit', criterion_id: 'total_spent', operator: 'gt', value: 50 },
          ],
        },
      ],
    });

    const callArgs = mockFetch.mock.calls[0];
    const body = JSON.parse(callArgs[1].body as string) as {
      definition: { stanzas: Array<{ id: string; criteria: Array<{ id: string }> }> };
    };

    expect(body.definition.stanzas[0].id).toBe('my-stanza');
    expect(body.definition.stanzas[0].criteria[0].id).toBe('my-crit');
  });

  it('does not overwrite non-empty criterion.id', async () => {
    mockFetch.mockResolvedValue(
      mockJsonOk({ estimated_fan_count: 5, sample_fans: [] })
    );

    const client = new DataClient({ baseUrl: 'https://data.nevent.es', jwtToken: 'jwt' });
    await client.previewSegment({
      stanzas: [
        {
          criteria: [
            {
              id: 'stable-crit-id',
              criterion_id: 'user_age',
              operator: 'gte',
              value: 18,
            },
          ],
        },
      ],
    });

    const callArgs = mockFetch.mock.calls[0];
    const body = JSON.parse(callArgs[1].body as string) as {
      definition: { stanzas: Array<{ criteria: Array<{ id: string }> }> };
    };

    expect(body.definition.stanzas[0].criteria[0].id).toBe('stable-crit-id');
  });
});

// ---------------------------------------------------------------------------
// 3. executeSegment also auto-generates IDs
// ---------------------------------------------------------------------------

describe('DataClient.executeSegment — auto-ID injection', () => {
  it('injects stanza and criterion IDs in executeSegment request', async () => {
    mockFetch.mockResolvedValue(
      mockJsonOk({ total_fans: 0, fans: [], current_page: 0, total_pages: 0, has_more: false })
    );

    const client = new DataClient({ baseUrl: 'https://data.nevent.es', jwtToken: 'jwt' });
    await client.executeSegment({
      stanzas: [
        { criteria: [{ criterion_id: 'user_country', operator: 'eq', value: 'ES' }] },
      ],
    });

    const callArgs = mockFetch.mock.calls[0];
    const body = JSON.parse(callArgs[1].body as string) as {
      definition: { stanzas: Array<{ id: string; criteria: Array<{ id: string }> }> };
    };

    expect(body.definition.stanzas[0].id.length).toBeGreaterThan(0);
    expect(body.definition.stanzas[0].criteria[0].id.length).toBeGreaterThan(0);
  });

  it('preserves pre-existing IDs in executeSegment', async () => {
    mockFetch.mockResolvedValue(
      mockJsonOk({ total_fans: 1, fans: [], current_page: 0, total_pages: 1, has_more: false })
    );

    const client = new DataClient({ baseUrl: 'https://data.nevent.es', jwtToken: 'jwt' });
    await client.executeSegment({
      stanzas: [
        {
          id: 'exec-stanza',
          criteria: [
            { id: 'exec-crit', criterion_id: 'user_country', operator: 'eq', value: 'ES' },
          ],
        },
      ],
    });

    const callArgs = mockFetch.mock.calls[0];
    const body = JSON.parse(callArgs[1].body as string) as {
      definition: { stanzas: Array<{ id: string; criteria: Array<{ id: string }> }> };
    };

    expect(body.definition.stanzas[0].id).toBe('exec-stanza');
    expect(body.definition.stanzas[0].criteria[0].id).toBe('exec-crit');
  });
});

// ---------------------------------------------------------------------------
// 4. BaseClient.buildApiError propagates body.error as plain string
// ---------------------------------------------------------------------------

describe('BaseClient error propagation — body.error as string', () => {
  it('propagates body.error string to NeventApiError.message when body.message is a generic wrapper', async () => {
    // Shape emitted by nev-data-api: { success: false, message: "Failed to preview segment", error: "Invalid DSL: stanza 0 missing id" }
    mockFetch.mockResolvedValue(
      mockJsonError(400, {
        success: false,
        message: 'Failed to preview segment',
        error: 'Invalid DSL: stanza 0 missing id',
      })
    );

    const client = new BaseClient({ baseUrl: 'https://data.nevent.es', jwtToken: 'jwt' });

    let thrown: NeventApiError | null = null;
    try {
      await client.get('/segments/preview');
    } catch (e) {
      thrown = e as NeventApiError;
    }

    expect(thrown).toBeInstanceOf(NeventApiError);
    // The real error message from the API (body.error string) must be propagated
    expect(thrown!.neventError.message).toContain('Invalid DSL: stanza 0 missing id');
  });

  it('propagates body.error string on 5xx responses too', async () => {
    mockFetch.mockResolvedValue(
      mockJsonError(500, {
        message: 'Internal server error',
        error: 'Detailed upstream failure reason',
      })
    );

    const client = new BaseClient({ baseUrl: 'https://data.nevent.es', jwtToken: 'jwt' });

    let thrown: NeventApiError | null = null;
    try {
      await client.get('/some/endpoint');
    } catch (e) {
      thrown = e as NeventApiError;
    }

    expect(thrown).toBeInstanceOf(NeventApiError);
    expect(thrown!.neventError.message).toContain('Detailed upstream failure reason');
  });
});

// ---------------------------------------------------------------------------
// 5. BaseClient.buildApiError still works with nested { error: { message } }
// ---------------------------------------------------------------------------

describe('BaseClient error propagation — legacy nested error object shape', () => {
  it('still extracts message from nested error.message object', async () => {
    // Old shape: { error: { message: "...", code: "...", type: "..." } }
    mockFetch.mockResolvedValue(
      mockJsonError(400, {
        error: {
          type: 'invalid_request',
          message: 'Missing required field: name',
          code: 'missing_field',
        },
      })
    );

    const client = new BaseClient({ baseUrl: 'https://data.nevent.es', jwtToken: 'jwt' });

    let thrown: NeventApiError | null = null;
    try {
      await client.get('/segments');
    } catch (e) {
      thrown = e as NeventApiError;
    }

    expect(thrown).toBeInstanceOf(NeventApiError);
    expect(thrown!.neventError.message).toContain('Missing required field: name');
    expect(thrown!.neventError.code).toBe('missing_field');
  });
});
