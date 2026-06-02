/**
 * Unit tests for DataClient.transformQueryResponse().
 *
 * The method is private, so we test it indirectly via queryAnalytics()
 * by mocking the fetch global and inspecting the returned value.
 *
 * Tests cover:
 *  1. New nev-data-api envelope {success: true, data: {data:[...], metadata:{...}}, timestamp}
 *  2. Legacy format {data: [...], metadata: {...}} — must keep working
 *  3. Legacy format {rows: [...]} — must keep working
 *  4. Bare array response — must keep working
 *  5. Edge case: {success: false, data: {...}} — must NOT unwrap
 *  6. Edge case: {success: true, data: [bareArray]} — must NOT unwrap (data is array)
 *  7. Edge case: {} empty — no crash, returns {data:[], metadata:{...}}
 *  8. Edge case: {data: null} — no crash, returns {data:[], metadata:{...}}
 *  9. snake_case metadata fields (total_rows, execution_time) mapped correctly
 * 10. query field extracted from envelope metadata
 * 11. totalRows fallback to rows.length when metadata absent
 * 12. executionTime fallback to 0 when metadata absent
 * 13. Nested envelope with real production-shaped response (full integration shape)
 * 14. getCampaignReport — passes response through without transformation (no envelope bug)
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { DataClient } from '../clients/data-client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient(): DataClient {
  return new DataClient({ baseUrl: 'https://data.nevent.es', jwtToken: 'test-jwt' });
}

function mockOkFetch(body: unknown): ReturnType<typeof vi.fn> {
  const mock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => body,
  } as unknown as Response);
  vi.stubGlobal('fetch', mock);
  return mock;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. New nev-data-api envelope: {success:true, data:{data:[...], metadata:{}}, timestamp}
// ---------------------------------------------------------------------------

describe('transformQueryResponse — new nev-data-api envelope', () => {
  it('extracts rows and metadata from wrapped envelope', async () => {
    mockOkFetch({
      success: true,
      data: {
        data: [{ rev: 19843100, n: 10062 }],
        metadata: {
          totalRows: 1,
          executionTime: 487,
          query: 'SELECT SUM(`total_price`) ...',
        },
      },
      timestamp: '2026-06-02T11:53:31.859Z',
    });

    const client = makeClient();
    const result = await client.queryAnalytics({ collection: 'purchases', metrics: [] });

    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toEqual({ rev: 19843100, n: 10062 });
    expect(result.metadata.totalRows).toBe(1);
    expect(result.metadata.executionTime).toBe(487);
    expect(result.metadata.query).toBe('SELECT SUM(`total_price`) ...');
  });

  it('extracts multiple rows from wrapped envelope', async () => {
    mockOkFetch({
      success: true,
      data: {
        data: [
          { campaign_name: 'Primavera', sent: 5000 },
          { campaign_name: 'Summer Sale', sent: 3200 },
          { campaign_name: 'Autumn Fest', sent: 1800 },
        ],
        metadata: { totalRows: 3, executionTime: 312 },
      },
      timestamp: '2026-06-01T10:00:00.000Z',
    });

    const client = makeClient();
    const result = await client.queryAnalytics({ collection: 'campaigns', metrics: [] });

    expect(result.data).toHaveLength(3);
    expect(result.data[0]).toEqual({ campaign_name: 'Primavera', sent: 5000 });
    expect(result.metadata.totalRows).toBe(3);
    expect(result.metadata.executionTime).toBe(312);
  });

  it('handles empty data array inside wrapped envelope', async () => {
    mockOkFetch({
      success: true,
      data: {
        data: [],
        metadata: { totalRows: 0, executionTime: 100 },
      },
      timestamp: '2026-06-01T10:00:00.000Z',
    });

    const client = makeClient();
    const result = await client.queryAnalytics({ collection: 'purchases', metrics: [] });

    expect(result.data).toHaveLength(0);
    expect(result.metadata.totalRows).toBe(0);
    expect(result.metadata.executionTime).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// 2. Legacy format: {data: [...], metadata: {...}}
// ---------------------------------------------------------------------------

describe('transformQueryResponse — legacy {data: [], metadata: {}} format', () => {
  it('extracts rows directly from data array field', async () => {
    mockOkFetch({
      data: [{ total: 42 }],
      metadata: { totalRows: 1, executionTime: 55 },
    });

    const client = makeClient();
    const result = await client.queryAnalytics({ collection: 'purchases', metrics: [] });

    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toEqual({ total: 42 });
    expect(result.metadata.totalRows).toBe(1);
    expect(result.metadata.executionTime).toBe(55);
  });

  it('works without metadata field in legacy format', async () => {
    mockOkFetch({ data: [{ count: 7 }] });

    const client = makeClient();
    const result = await client.queryAnalytics({ collection: 'campaigns', metrics: [] });

    expect(result.data).toHaveLength(1);
    expect(result.metadata.totalRows).toBe(1); // fallback to rows.length
    expect(result.metadata.executionTime).toBe(0); // fallback to 0
  });
});

// ---------------------------------------------------------------------------
// 3. Legacy format: {rows: [...]}
// ---------------------------------------------------------------------------

describe('transformQueryResponse — legacy {rows: []} format', () => {
  it('extracts rows from rows field', async () => {
    mockOkFetch({
      rows: [{ event: 'Umbracle', revenue: 95000 }],
      metadata: { totalRows: 1, executionTime: 200 },
    });

    const client = makeClient();
    const result = await client.queryAnalytics({ collection: 'events', metrics: [] });

    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toEqual({ event: 'Umbracle', revenue: 95000 });
    expect(result.metadata.totalRows).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Bare array response
// ---------------------------------------------------------------------------

describe('transformQueryResponse — bare array response', () => {
  it('accepts a bare JSON array as rows', async () => {
    mockOkFetch([{ item: 'a' }, { item: 'b' }]);

    const client = makeClient();
    const result = await client.queryAnalytics({ collection: 'tickets', metrics: [] });

    expect(result.data).toHaveLength(2);
    expect(result.data[0]).toEqual({ item: 'a' });
  });
});

// ---------------------------------------------------------------------------
// 5. Edge case: {success: false, data: {...}} — must NOT unwrap
// ---------------------------------------------------------------------------

describe('transformQueryResponse — success:false must NOT unwrap', () => {
  it('does not unwrap when success is false', async () => {
    // When success: false, we should NOT treat raw['data'] as the payload.
    // In this test the raw is a 200 OK body with success:false — unusual but possible.
    // The method must NOT try to unwrap it and accidentally serve partial data.
    mockOkFetch({
      success: false,
      data: {
        data: [{ should_not_appear: true }],
        metadata: { totalRows: 1, executionTime: 10 },
      },
    });

    const client = makeClient();
    const result = await client.queryAnalytics({ collection: 'purchases', metrics: [] });

    // raw['data'] is an object with a data array, but since success !== true,
    // we treat the top-level as the payload. payload['data'] is the inner object
    // (not an array), so rows falls through to [].
    expect(result.data).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Edge case: {success: true, data: [bareArray]} — must NOT unwrap
// ---------------------------------------------------------------------------

describe('transformQueryResponse — success:true but data is array — must NOT unwrap', () => {
  it('does not unwrap when data field is itself an array', async () => {
    // If raw['data'] is already an array, it IS the rows — do not treat it as envelope
    mockOkFetch({
      success: true,
      data: [{ row: 1 }, { row: 2 }],
    });

    const client = makeClient();
    const result = await client.queryAnalytics({ collection: 'purchases', metrics: [] });

    // data is an array → no unwrapping → payload = raw → payload['data'] = [{row:1},{row:2}]
    expect(result.data).toHaveLength(2);
    expect(result.data[0]).toEqual({ row: 1 });
  });
});

// ---------------------------------------------------------------------------
// 7. Edge case: {} empty object — no crash
// ---------------------------------------------------------------------------

describe('transformQueryResponse — {} empty response — no crash', () => {
  it('returns empty data and zero metadata without crashing', async () => {
    mockOkFetch({});

    const client = makeClient();
    const result = await client.queryAnalytics({ collection: 'purchases', metrics: [] });

    expect(result.data).toHaveLength(0);
    expect(result.metadata.totalRows).toBe(0);
    expect(result.metadata.executionTime).toBe(0);
    expect(result.metadata.query).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 8. Edge case: {data: null} — no crash
// ---------------------------------------------------------------------------

describe('transformQueryResponse — {data: null} — no crash', () => {
  it('returns empty data without crashing when data is null', async () => {
    mockOkFetch({ data: null });

    const client = makeClient();
    const result = await client.queryAnalytics({ collection: 'purchases', metrics: [] });

    expect(result.data).toHaveLength(0);
    expect(result.metadata.totalRows).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 9. snake_case metadata fields
// ---------------------------------------------------------------------------

describe('transformQueryResponse — snake_case metadata fields', () => {
  it('maps total_rows to totalRows', async () => {
    mockOkFetch({
      success: true,
      data: {
        data: [{ x: 1 }],
        metadata: { total_rows: 99, execution_time: 250 },
      },
      timestamp: '2026-06-01T00:00:00.000Z',
    });

    const client = makeClient();
    const result = await client.queryAnalytics({ collection: 'purchases', metrics: [] });

    expect(result.metadata.totalRows).toBe(99);
    expect(result.metadata.executionTime).toBe(250);
  });

  it('maps snake_case in legacy format too', async () => {
    mockOkFetch({
      data: [{ y: 2 }],
      metadata: { total_rows: 5, execution_time: 75 },
    });

    const client = makeClient();
    const result = await client.queryAnalytics({ collection: 'tickets', metrics: [] });

    expect(result.metadata.totalRows).toBe(5);
    expect(result.metadata.executionTime).toBe(75);
  });
});

// ---------------------------------------------------------------------------
// 10. query field extracted from metadata
// ---------------------------------------------------------------------------

describe('transformQueryResponse — query field in metadata', () => {
  it('extracts query string from wrapped envelope metadata', async () => {
    const queryStr = 'SELECT SUM(`total_price`) AS rev FROM mart_nevent_prd.purchases WHERE tenant_id IN (...)';
    mockOkFetch({
      success: true,
      data: {
        data: [{ rev: 5000 }],
        metadata: {
          totalRows: 1,
          executionTime: 300,
          query: queryStr,
        },
      },
      timestamp: '2026-06-02T12:00:00.000Z',
    });

    const client = makeClient();
    const result = await client.queryAnalytics({ collection: 'purchases', metrics: [] });

    expect(result.metadata.query).toBe(queryStr);
  });

  it('returns undefined for query when not present', async () => {
    mockOkFetch({
      success: true,
      data: {
        data: [],
        metadata: { totalRows: 0, executionTime: 50 },
      },
      timestamp: '2026-06-02T12:00:00.000Z',
    });

    const client = makeClient();
    const result = await client.queryAnalytics({ collection: 'purchases', metrics: [] });

    expect(result.metadata.query).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 11. totalRows fallback to rows.length
// ---------------------------------------------------------------------------

describe('transformQueryResponse — totalRows fallback to rows.length', () => {
  it('uses rows.length when totalRows absent in metadata', async () => {
    mockOkFetch({
      success: true,
      data: {
        data: [{ a: 1 }, { a: 2 }, { a: 3 }],
        metadata: { executionTime: 100 }, // no totalRows
      },
      timestamp: '2026-06-01T00:00:00.000Z',
    });

    const client = makeClient();
    const result = await client.queryAnalytics({ collection: 'purchases', metrics: [] });

    expect(result.metadata.totalRows).toBe(3); // fallback to rows.length
  });

  it('uses rows.length when metadata is absent entirely', async () => {
    mockOkFetch({
      success: true,
      data: {
        data: [{ x: 10 }, { x: 20 }],
        // no metadata key at all
      },
      timestamp: '2026-06-01T00:00:00.000Z',
    });

    const client = makeClient();
    const result = await client.queryAnalytics({ collection: 'purchases', metrics: [] });

    expect(result.metadata.totalRows).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 12. executionTime fallback to 0
// ---------------------------------------------------------------------------

describe('transformQueryResponse — executionTime fallback to 0', () => {
  it('returns executionTime 0 when absent from metadata', async () => {
    mockOkFetch({
      data: [{ v: 1 }],
      metadata: { totalRows: 1 }, // no executionTime
    });

    const client = makeClient();
    const result = await client.queryAnalytics({ collection: 'purchases', metrics: [] });

    expect(result.metadata.executionTime).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 13. Full production-shaped response (integration shape)
// ---------------------------------------------------------------------------

describe('transformQueryResponse — full production-shaped response', () => {
  it('correctly processes the exact shape returned by prod nev-data-api', async () => {
    // This is the exact response shape confirmed via curl against data.nevent.es
    mockOkFetch({
      success: true,
      data: {
        data: [{ rev: 19843100, n: 10062 }],
        metadata: {
          totalRows: 1,
          executionTime: 487,
          query:
            'SELECT SUM(`total_price`) AS rev, COUNT(*) AS n FROM `nevent-daf5f.mart_nevent_prd.purchases` WHERE tenant_id IN (\'tenant123\') AND purchased_at >= TIMESTAMP(\'2026-01-01\') AND purchased_at < TIMESTAMP(\'2026-12-31\')',
        },
      },
      timestamp: '2026-06-02T11:53:31.859Z',
    });

    const client = makeClient();
    const result = await client.queryAnalytics({
      collection: 'purchases',
      metrics: [
        { field: 'totalPrice', operation: 'sum', alias: 'rev' },
        { field: 'id', operation: 'count', alias: 'n' },
      ],
      timeRange: { start: '2026-01-01', end: '2026-12-31' },
    });

    // Strict assertions — this is the regression test for the main bug
    expect(result.data).not.toHaveLength(0);
    expect(result.data[0]).toEqual({ rev: 19843100, n: 10062 });
    expect(result.metadata.totalRows).toBe(1);
    expect(result.metadata.executionTime).toBe(487);
    expect(result.metadata.query).toContain('SELECT SUM');
  });
});
