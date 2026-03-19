/**
 * nev-data-api client targeting https://data.nevent.es.
 *
 * Provides strongly-typed methods for all Sprint 1 endpoints:
 *  - Analytics query, capabilities, schema, filter values
 *  - Segmentation criteria, segment preview, segment execute
 *  - Dimension values autocomplete
 *
 * All methods are thin wrappers over `BaseClient.request()` — they handle
 * URL construction and casting but not error handling (let errors propagate).
 */

import { BaseClient } from './base-client.js';
import type { BaseClientConfig } from './base-client.js';
import type {
  AnalyticsQueryRequest,
  AnalyticsQueryResponse,
  AnalyticsCapabilitiesResponse,
  AnalyticsTableSchemaResponse,
  AnalyticsFilterValuesResponse,
} from '../types/analytics.js';
import type {
  SegmentationCriteriaResponse,
  SegmentPreviewResponse,
  SegmentExecuteResponse,
  DimensionValuesResponse,
  SegmentDefinition,
} from '../types/segmentation.js';

// ---------------------------------------------------------------------------
// DataClient
// ---------------------------------------------------------------------------

/**
 * Client for the nev-data-api service (data.nevent.es).
 *
 * Instantiated once in `index.ts` and passed to all tool handlers.
 *
 * @example
 * ```ts
 * const client = new DataClient({
 *   baseUrl: process.env.NEVENT_DATA_API_URL ?? 'https://data.nevent.es',
 *   jwtToken: process.env.NEVENT_JWT_TOKEN!,
 * });
 * const caps = await client.getCapabilities();
 * ```
 */
export class DataClient extends BaseClient {
  constructor(config: BaseClientConfig) {
    super(config);
  }

  // -------------------------------------------------------------------------
  // Analytics endpoints
  // -------------------------------------------------------------------------

  /**
   * Execute an analytics query against a BigQuery collection.
   * Maps to POST /analytics/query.
   *
   * @param request — Full query DSL including collection, dimensions, metrics, filters, etc.
   * @returns       Transformed response with `data` rows and `metadata`.
   */
  async queryAnalytics(request: AnalyticsQueryRequest): Promise<AnalyticsQueryResponse> {
    const raw = await this.post<Record<string, unknown>>('/analytics/query', request);
    return this.transformQueryResponse(raw);
  }

  /**
   * Retrieve available BigQuery tables and their column definitions.
   * Maps to GET /analytics/capabilities (public, no auth required).
   *
   * @returns List of tables with column names and types plus total count.
   */
  async getCapabilities(): Promise<AnalyticsCapabilitiesResponse> {
    return this.getPublic<AnalyticsCapabilitiesResponse>('/analytics/capabilities');
  }

  /**
   * Get detailed column schema for a specific BigQuery table.
   * Maps to GET /analytics/schema/:table.
   *
   * @param table — Table name (e.g. "purchases", "tickets").
   * @returns     Columns with name, type, and optional description.
   */
  async getTableSchema(table: string): Promise<AnalyticsTableSchemaResponse> {
    return this.get<AnalyticsTableSchemaResponse>(`/analytics/schema/${encodeURIComponent(table)}`);
  }

  /**
   * Discover distinct field values for constructing valid analytics filters.
   * Maps to POST /analytics/filters.
   *
   * @param collection — The collection to inspect.
   * @param filters    — Fields and optional seed values to look up.
   * @returns          Available values per field.
   */
  async getFilterValues(
    collection: string,
    filters: Array<{ field: string; operator?: string; value?: unknown }>
  ): Promise<AnalyticsFilterValuesResponse> {
    return this.post<AnalyticsFilterValuesResponse>('/analytics/filters', {
      collection,
      filters,
    });
  }

  // -------------------------------------------------------------------------
  // Segmentation endpoints
  // -------------------------------------------------------------------------

  /**
   * List all available segmentation criteria.
   * Maps to GET /segmentation/criteria.
   *
   * @returns Criteria grouped by type with supported operators.
   */
  async getSegmentationCriteria(): Promise<SegmentationCriteriaResponse> {
    return this.get<SegmentationCriteriaResponse>('/segmentation/criteria');
  }

  /**
   * Preview the estimated audience size for a segment definition.
   * Maps to POST /segments/preview.
   *
   * Use this before saving a segment to validate the definition and get a
   * fan count estimate without persisting anything.
   *
   * @param definition — DSL segment definition with stanzas and criteria.
   * @returns          Estimated fan count and a small sample of matching fans.
   */
  async previewSegment(definition: SegmentDefinition): Promise<SegmentPreviewResponse> {
    return this.post<SegmentPreviewResponse>('/segments/preview', { definition });
  }

  /**
   * Execute a segment definition and retrieve matching contacts with pagination.
   * Maps to POST /segments/execute.
   *
   * @param definition — DSL segment definition.
   * @param page       — Zero-based page index (default 0).
   * @param pageSize   — Results per page (max 100, default 20).
   * @returns          Paginated fan list with contact details.
   */
  async executeSegment(
    definition: SegmentDefinition,
    page = 0,
    pageSize = 20
  ): Promise<SegmentExecuteResponse> {
    return this.post<SegmentExecuteResponse>('/segments/execute', {
      definition,
      page,
      page_size: pageSize,
    });
  }

  /**
   * Get autocomplete values for a segmentation criterion.
   * Maps to POST /dimensions/values.
   *
   * @param criterionId — The criterion ID to look up values for.
   * @param search      — Optional search string to filter values.
   * @returns           Matching values as strings or labeled objects.
   */
  async getDimensionValues(
    criterionId: string,
    search?: string
  ): Promise<DimensionValuesResponse> {
    return this.post<DimensionValuesResponse>('/dimensions/values', {
      criterion_id: criterionId,
      search,
    });
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Transform the raw analytics query API response into the compact MCP format.
   *
   * The raw API may wrap results in various envelope shapes; we normalize to:
   * `{ data: rows[], metadata: { totalRows, executionTime, query? } }`
   *
   * @param raw — Raw parsed JSON from POST /analytics/query.
   */
  private transformQueryResponse(raw: Record<string, unknown>): AnalyticsQueryResponse {
    // Try to extract data rows from common envelope patterns
    let rows: Record<string, unknown>[] = [];

    if (Array.isArray(raw['data'])) {
      rows = raw['data'] as Record<string, unknown>[];
    } else if (Array.isArray(raw['rows'])) {
      rows = raw['rows'] as Record<string, unknown>[];
    } else if (Array.isArray(raw)) {
      rows = raw as unknown as Record<string, unknown>[];
    }

    // Extract metadata
    const rawMeta = raw['metadata'] as Record<string, unknown> | undefined;
    const totalRows =
      typeof rawMeta?.['totalRows'] === 'number'
        ? rawMeta['totalRows']
        : typeof rawMeta?.['total_rows'] === 'number'
          ? rawMeta['total_rows']
          : rows.length;

    const executionTime =
      typeof rawMeta?.['executionTime'] === 'number'
        ? rawMeta['executionTime']
        : typeof rawMeta?.['execution_time'] === 'number'
          ? rawMeta['execution_time']
          : 0;

    const query =
      typeof rawMeta?.['query'] === 'string' ? rawMeta['query'] : undefined;

    return {
      data: rows,
      metadata: { totalRows, executionTime, query },
    };
  }
}
