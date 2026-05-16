/**
 * Unit tests for DataClient in-memory caches.
 *
 * Tests cover:
 *  - getCapabilities returns cached result on second call (no extra fetch)
 *  - getCapabilities re-fetches after cache expires
 *  - getSegmentationCriteria returns cached result on second call
 *  - clearAllCaches invalidates both caches
 *  - clearCapabilitiesCache only invalidates capabilities cache
 *  - clearCriteriaCache only invalidates criteria cache
 *  - DataClient does NOT inject tenant_id in any request body
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { DataClient } from '../clients/data-client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCapabilitiesResponse() {
  return { tables: [{ name: 'purchases', fields: [] }], count: 1 };
}

function makeCriteriaResponse() {
  return { criteria: [{ id: 'attended_event', type: 'ENTITY' }] };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DataClient caches', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('getCapabilities cache', () => {
    it('returns cached result on second call', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => makeCapabilitiesResponse(),
      } as unknown as Response);

      const client = new DataClient({ baseUrl: 'https://data.nevent.es', jwtToken: 'jwt' });

      const first = await client.getCapabilities();
      const second = await client.getCapabilities();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(first).toBe(second); // same object reference from cache
    });

    it('re-fetches after clearCapabilitiesCache', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => makeCapabilitiesResponse(),
      } as unknown as Response);

      const client = new DataClient({ baseUrl: 'https://data.nevent.es', jwtToken: 'jwt' });

      await client.getCapabilities();
      client.clearCapabilitiesCache();
      await client.getCapabilities();

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('getSegmentationCriteria cache', () => {
    it('returns cached result on second call', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => makeCriteriaResponse(),
      } as unknown as Response);

      const client = new DataClient({ baseUrl: 'https://data.nevent.es', jwtToken: 'jwt' });

      const first = await client.getSegmentationCriteria();
      const second = await client.getSegmentationCriteria();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(first).toBe(second);
    });

    it('re-fetches after clearCriteriaCache', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => makeCriteriaResponse(),
      } as unknown as Response);

      const client = new DataClient({ baseUrl: 'https://data.nevent.es', jwtToken: 'jwt' });

      await client.getSegmentationCriteria();
      client.clearCriteriaCache();
      await client.getSegmentationCriteria();

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('TTL expiry', () => {
    /** DataClient.CACHE_TTL_MS is private static — 5 minutes. */
    const CACHE_TTL_MS = 5 * 60 * 1000;

    it('re-fetches getCapabilities after TTL elapses', async () => {
      vi.useFakeTimers();

      // First response: data1
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => makeCapabilitiesResponse(),
      } as unknown as Response);

      const client = new DataClient({ baseUrl: 'https://data.nevent.es', jwtToken: 'jwt' });

      // Prime the cache
      await client.getCapabilities();
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Advance time past the TTL
      vi.advanceTimersByTime(CACHE_TTL_MS + 1);

      // Update mock for second fetch
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ tables: [{ name: 'updated', fields: [] }], count: 1 }),
      } as unknown as Response);

      // Second call — cache expired, must re-fetch
      await client.getCapabilities();
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('re-fetches getSegmentationCriteria after TTL elapses', async () => {
      vi.useFakeTimers();

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => makeCriteriaResponse(),
      } as unknown as Response);

      const client = new DataClient({ baseUrl: 'https://data.nevent.es', jwtToken: 'jwt' });

      await client.getSegmentationCriteria();
      expect(mockFetch).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(CACHE_TTL_MS + 1);

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ criteria: [{ id: 'new_criterion', type: 'EVENT' }] }),
      } as unknown as Response);

      await client.getSegmentationCriteria();
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('does NOT re-fetch before TTL elapses', async () => {
      vi.useFakeTimers();

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => makeCapabilitiesResponse(),
      } as unknown as Response);

      const client = new DataClient({ baseUrl: 'https://data.nevent.es', jwtToken: 'jwt' });

      await client.getCapabilities();
      // Advance time but stay within TTL
      vi.advanceTimersByTime(CACHE_TTL_MS - 1);
      await client.getCapabilities();

      // Should still be cached — only 1 fetch
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('clearAllCaches', () => {
    it('invalidates both caches simultaneously', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => makeCapabilitiesResponse(),
      } as unknown as Response);

      const client = new DataClient({ baseUrl: 'https://data.nevent.es', jwtToken: 'jwt' });

      await client.getCapabilities();
      // Mock different response for criteria
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => makeCriteriaResponse(),
      } as unknown as Response);
      await client.getSegmentationCriteria();

      expect(mockFetch).toHaveBeenCalledTimes(2);

      client.clearAllCaches();

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => makeCapabilitiesResponse(),
      } as unknown as Response);
      await client.getCapabilities();

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => makeCriteriaResponse(),
      } as unknown as Response);
      await client.getSegmentationCriteria();

      // 2 original + 2 after clearAllCaches = 4
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });
  });

  describe('tenant_id not injected in request body', () => {
    it('queryAnalytics does NOT send tenant_id in body', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ data: [], metadata: { totalRows: 0, executionTime: 0 } }),
      } as unknown as Response);

      const client = new DataClient(
        { baseUrl: 'https://data.nevent.es', jwtToken: 'jwt' },
        'tenant_abc'
      );

      await client.queryAnalytics({ collection: 'purchases', metrics: [{ field: 'id', aggregation: 'count' }] });

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body as string);
      expect(body).not.toHaveProperty('tenant_id');
    });

    it('previewSegment does NOT send tenant_id in body', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ estimatedCount: 100, sample: [] }),
      } as unknown as Response);

      const client = new DataClient(
        { baseUrl: 'https://data.nevent.es', jwtToken: 'jwt' },
        'tenant_abc'
      );

      await client.previewSegment({ stanzas: [] });

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body as string);
      expect(body).not.toHaveProperty('tenant_id');
    });

    it('executeSegment does NOT send tenant_id in body', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ contacts: [], total: 0, page: 0 }),
      } as unknown as Response);

      const client = new DataClient(
        { baseUrl: 'https://data.nevent.es', jwtToken: 'jwt' },
        'tenant_abc'
      );

      await client.executeSegment({ stanzas: [] });

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body as string);
      expect(body).not.toHaveProperty('tenant_id');
    });

    it('getFilterValues does NOT send tenant_id in body', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ values: [] }),
      } as unknown as Response);

      const client = new DataClient(
        { baseUrl: 'https://data.nevent.es', jwtToken: 'jwt' },
        'tenant_abc'
      );

      await client.getFilterValues('purchases', [{ field: 'state' }]);

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body as string);
      expect(body).not.toHaveProperty('tenant_id');
    });

    it('getTableSchema does NOT send tenant_id as query param', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ columns: [] }),
      } as unknown as Response);

      const client = new DataClient(
        { baseUrl: 'https://data.nevent.es', jwtToken: 'jwt' },
        'tenant_abc'
      );

      await client.getTableSchema('purchases');

      const callUrl = mockFetch.mock.calls[0][0] as string;
      expect(callUrl).not.toContain('tenant_id');
    });
  });
});
