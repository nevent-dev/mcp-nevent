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
 * In HTTP mode, one DataClient is created per MCP session and authenticates
 * with the user's own nev-api JWT token. In stdio mode, a single shared
 * instance is used for all requests.
 *
 * ## Multi-tenant support
 *
 * Set `activeTenantId` to override the tenant context for all subsequent
 * requests made by this client instance. This is mutable because the client
 * is per-session in HTTP mode, so setting it only affects one user's session.
 *
 * When `activeTenantId` is set, it is sent as the `tenant_id` query parameter
 * on every request. data-api validates that the authenticated user has access
 * to the requested tenant.
 *
 * @example
 * ```ts
 * const client = new DataClient({
 *   baseUrl: process.env.NEVENT_DATA_API_URL ?? 'https://data.nevent.es',
 *   jwtToken: userAccessToken,
 * });
 * client.setActiveTenant('tenant_abc');
 * const caps = await client.getCapabilities();
 * ```
 */
export class DataClient extends BaseClient {
  /**
   * Optional active tenant ID for multi-tenant queries.
   *
   * When set, this value is sent as `tenant_id` in all data-api requests,
   * allowing SUPERADMIN / OWNER users to query a specific tenant's data.
   * Set via `nevent_switch_tenant` tool; cleared by setting to `undefined`.
   */
  activeTenantId: string | undefined;

  constructor(config: BaseClientConfig) {
    super(config);
    this.activeTenantId = undefined;
  }

  /**
   * Set the active tenant for subsequent requests.
   *
   * @param tenantId - The tenant ID to activate, or `undefined` to clear.
   */
  setActiveTenant(tenantId: string | undefined): void {
    this.activeTenantId = tenantId;
  }

  // -------------------------------------------------------------------------
  // Analytics endpoints
  // -------------------------------------------------------------------------

  /**
   * Execute an analytics query against a BigQuery collection.
   * Maps to POST /analytics/query.
   *
   * When `tenantId` is explicitly provided it overrides `activeTenantId`.
   * When neither is set, data-api uses the tenant from the bearer token.
   *
   * @param request  — Full query DSL including collection, dimensions, metrics, filters, etc.
   * @param tenantId — Optional per-call tenant override (takes precedence over activeTenantId).
   * @returns        Transformed response with `data` rows and `metadata`.
   */
  async queryAnalytics(request: AnalyticsQueryRequest, tenantId?: string): Promise<AnalyticsQueryResponse> {
    const effectiveTenantId = tenantId ?? this.activeTenantId;
    const body = effectiveTenantId
      ? { ...request, tenant_id: effectiveTenantId }
      : request;
    const raw = await this.post<Record<string, unknown>>('/analytics/query', body);
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
   * @param table    — Table name (e.g. "purchases", "tickets").
   * @param tenantId — Optional per-call tenant override.
   * @returns        Columns with name, type, and optional description.
   */
  async getTableSchema(table: string, tenantId?: string): Promise<AnalyticsTableSchemaResponse> {
    const effectiveTenantId = tenantId ?? this.activeTenantId;
    const params = effectiveTenantId ? { tenant_id: effectiveTenantId } : undefined;
    return this.get<AnalyticsTableSchemaResponse>(
      `/analytics/schema/${encodeURIComponent(table)}`,
      params
    );
  }

  /**
   * Discover distinct field values for constructing valid analytics filters.
   * Maps to POST /analytics/filters.
   *
   * @param collection — The collection to inspect.
   * @param filters    — Fields and optional seed values to look up.
   * @param tenantId   — Optional per-call tenant override.
   * @returns          Available values per field.
   */
  async getFilterValues(
    collection: string,
    filters: Array<{ field: string; operator?: string; value?: unknown }>,
    tenantId?: string
  ): Promise<AnalyticsFilterValuesResponse> {
    const effectiveTenantId = tenantId ?? this.activeTenantId;
    const body = effectiveTenantId
      ? { collection, filters, tenant_id: effectiveTenantId }
      : { collection, filters };
    return this.post<AnalyticsFilterValuesResponse>('/analytics/filters', body);
  }

  // -------------------------------------------------------------------------
  // Segmentation endpoints
  // -------------------------------------------------------------------------

  /**
   * List all available segmentation criteria.
   * Maps to GET /segmentation/criteria.
   *
   * @param tenantId — Optional per-call tenant override.
   * @returns Criteria grouped by type with supported operators.
   */
  async getSegmentationCriteria(tenantId?: string): Promise<SegmentationCriteriaResponse> {
    const effectiveTenantId = tenantId ?? this.activeTenantId;
    const params = effectiveTenantId ? { tenant_id: effectiveTenantId } : undefined;
    return this.get<SegmentationCriteriaResponse>('/segmentation/criteria', params);
  }

  /**
   * Preview the estimated audience size for a segment definition.
   * Maps to POST /segments/preview.
   *
   * Use this before saving a segment to validate the definition and get a
   * fan count estimate without persisting anything.
   *
   * @param definition — DSL segment definition with stanzas and criteria.
   * @param tenantId   — Optional per-call tenant override.
   * @returns          Estimated fan count and a small sample of matching fans.
   */
  async previewSegment(definition: SegmentDefinition, tenantId?: string): Promise<SegmentPreviewResponse> {
    const effectiveTenantId = tenantId ?? this.activeTenantId;
    const body = effectiveTenantId
      ? { definition, tenant_id: effectiveTenantId }
      : { definition };
    return this.post<SegmentPreviewResponse>('/segments/preview', body);
  }

  /**
   * Execute a segment definition and retrieve matching contacts with pagination.
   * Maps to POST /segments/execute.
   *
   * @param definition — DSL segment definition.
   * @param page       — Zero-based page index (default 0).
   * @param pageSize   — Results per page (max 100, default 20).
   * @param tenantId   — Optional per-call tenant override.
   * @returns          Paginated fan list with contact details.
   */
  async executeSegment(
    definition: SegmentDefinition,
    page = 0,
    pageSize = 20,
    tenantId?: string
  ): Promise<SegmentExecuteResponse> {
    const effectiveTenantId = tenantId ?? this.activeTenantId;
    const body = effectiveTenantId
      ? { definition, page, page_size: pageSize, tenant_id: effectiveTenantId }
      : { definition, page, page_size: pageSize };
    return this.post<SegmentExecuteResponse>('/segments/execute', body);
  }

  /**
   * Get autocomplete values for a segmentation criterion.
   * Maps to POST /dimensions/values.
   *
   * @param criterionId — The criterion ID to look up values for.
   * @param search      — Optional search string to filter values.
   * @param tenantId    — Optional per-call tenant override.
   * @returns           Matching values as strings or labeled objects.
   */
  async getDimensionValues(
    criterionId: string,
    search?: string,
    tenantId?: string
  ): Promise<DimensionValuesResponse> {
    const effectiveTenantId = tenantId ?? this.activeTenantId;
    const body = effectiveTenantId
      ? { criterion_id: criterionId, search, tenant_id: effectiveTenantId }
      : { criterion_id: criterionId, search };
    return this.post<DimensionValuesResponse>('/dimensions/values', body);
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
