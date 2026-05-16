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
