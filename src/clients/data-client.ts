/**
 * nev-data-api client targeting https://data.nevent.es.
 *
 * Provides strongly-typed methods for all Sprint 1 endpoints:
 *  - Analytics query, capabilities, schema, filter values
 *  - Segmentation criteria, segment preview, segment execute
 *  - Dimension values autocomplete
 *
 * Updated for v3.19.0:
 *  - queryAnalytics passes all new v3.19.0 fields (distinct, dryRun, timeGranularity, etc.)
 *  - New getCampaignReport method for POST /analytics/campaign-report
 *
 * ## Tenant resolution
 *
 * Tenant is resolved **server-side** from the JWT claim `tenantId`. The MCP
 * MUST NOT send `tenant_id` in body or query — nev-data-api silently ignores
 * it. To change the active tenant, call `POST /users/tenant` via the
 * `nevent_switch_tenant` tool, which issues a new JWT scoped to the target
 * tenant. The new JWT is then applied to this client via
 * `SessionClients.rotateJwt()`.
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
  CampaignReportResponse,
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
 * ## Tenant resolution (IMPORTANT)
 *
 * Tenant is resolved **server-side from the JWT**. The MCP must NOT send
 * `tenant_id` in any request body or query parameter — nev-data-api would
 * silently ignore it anyway. To switch tenant, call `POST /users/tenant` via
 * the `nevent_switch_tenant` tool, which re-issues the JWT scoped to the new
 * tenant. Apply the new token via `SessionClients.rotateJwt()`.
 *
 * ## Caches
 *
 * Some read-heavy, rarely-changing responses (capabilities, segmentation
 * criteria) are cached in-memory for 5 minutes. Call `clearAllCaches()` when
 * the JWT is rotated to avoid serving stale data from a different tenant.
 *
 * @example
 * ```ts
 * const client = new DataClient({
 *   baseUrl: process.env.NEVENT_DATA_API_URL ?? 'https://data.nevent.es',
 *   jwtToken: userAccessToken,
 * });
 * const caps = await client.getCapabilities();
 * ```
 */
export class DataClient extends BaseClient {
  /** Cache TTL in milliseconds (5 minutes). */
  private static readonly CACHE_TTL_MS = 5 * 60 * 1000;

  /**
   * The tenant ID that the current JWT is scoped to.
   *
   * Read-only from the perspective of tool code — updated by
   * `SessionClients.rotateJwt()` when the JWT is rotated. Used by
   * MongoDB-backed tools (campaigns, templates, deliverability, segments)
   * to scope queries to the correct tenant.
   *
   * Note: the JWT is the authoritative source. This field mirrors the
   * `tenantId` claim for convenience — it is kept in sync by SessionClients.
   */
  activeTenantId: string | undefined;

  /** Cached analytics capabilities response. */
  private capabilitiesCache: { data: AnalyticsCapabilitiesResponse; expiresAt: number } | null =
    null;

  /** Cached segmentation criteria response. */
  private criteriaCache: { data: SegmentationCriteriaResponse; expiresAt: number } | null = null;

  constructor(config: BaseClientConfig, activeTenantId?: string) {
    super(config);
    this.activeTenantId = activeTenantId;
  }

  // -------------------------------------------------------------------------
  // Cache management
  // -------------------------------------------------------------------------

  /**
   * Invalidate all in-memory caches.
   *
   * Must be called after `SessionClients.rotateJwt()` because the new JWT may
   * belong to a different tenant, making cached data stale.
   */
  clearAllCaches(): void {
    this.capabilitiesCache = null;
    this.criteriaCache = null;
  }

  /**
   * Clear only the capabilities cache (e.g. for manual refresh in tests).
   */
  clearCapabilitiesCache(): void {
    this.capabilitiesCache = null;
  }

  /**
   * Clear only the segmentation criteria cache (e.g. for tests).
   */
  clearCriteriaCache(): void {
    this.criteriaCache = null;
  }

  // -------------------------------------------------------------------------
  // Analytics endpoints
  // -------------------------------------------------------------------------

  /**
   * Execute an analytics query against a BigQuery collection.
   * Maps to POST /analytics/query.
   *
   * Tenant is resolved server-side from the bearer JWT — do NOT pass tenant_id.
   *
   * v3.19.0: When `dryRun` is true, sends `?dryRun=true` as a query param
   * instead of including it in the body. The API returns an estimated cost
   * (bytes) without actually executing the query.
   *
   * @param request - Full query DSL including collection, dimensions, metrics, filters, etc.
   * @param dryRun  - Optional dry-run flag. When true, estimates cost without executing.
   * @returns Transformed response with `data` rows and `metadata`.
   */
  async queryAnalytics(
    request: AnalyticsQueryRequest,
    dryRun?: boolean
  ): Promise<AnalyticsQueryResponse> {
    // dryRun is passed as a query parameter, not in the body
    const params = dryRun ? { dryRun: 'true' } : undefined;
    const raw = await this.postWithParams<Record<string, unknown>>(
      '/analytics/query',
      request,
      params
    );
    return this.transformQueryResponse(raw);
  }

  /**
   * Retrieve available BigQuery tables and their column definitions.
   * Maps to GET /analytics/capabilities (public, no auth required).
   *
   * Result is cached for 5 minutes. Call `clearAllCaches()` to force a refresh.
   *
   * @returns List of tables with column names and types plus total count.
   */
  async getCapabilities(): Promise<AnalyticsCapabilitiesResponse> {
    const now = Date.now();
    if (this.capabilitiesCache && this.capabilitiesCache.expiresAt > now) {
      return this.capabilitiesCache.data;
    }
    const data = await this.getPublic<AnalyticsCapabilitiesResponse>(
      '/analytics/capabilities'
    );
    this.capabilitiesCache = { data, expiresAt: now + DataClient.CACHE_TTL_MS };
    return data;
  }

  /**
   * Get detailed column schema for a specific BigQuery table.
   * Maps to GET /analytics/schema/:table.
   *
   * Tenant is resolved server-side from the bearer JWT — do NOT pass tenant_id.
   *
   * @param table - Table name (e.g. "purchases", "tickets").
   * @returns Columns with name, type, and optional description.
   */
  async getTableSchema(table: string): Promise<AnalyticsTableSchemaResponse> {
    return this.get<AnalyticsTableSchemaResponse>(
      `/analytics/schema/${encodeURIComponent(table)}`
    );
  }

  /**
   * Discover distinct field values for constructing valid analytics filters.
   * Maps to POST /analytics/filters.
   *
   * Tenant is resolved server-side from the bearer JWT — do NOT pass tenant_id.
   *
   * @param collection - The collection to inspect.
   * @param filters    - Fields and optional seed values to look up.
   * @returns Available values per field.
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

  /**
   * Generate a comprehensive campaign analytics report.
   * Maps to POST /analytics/campaign-report.
   *
   * Introduced in v3.19.0: executes 13 parallel analytics queries for a single
   * campaign in one API call, returning opens, clicks, bounces, unsubscribes,
   * conversions, revenue, and other performance metrics.
   *
   * Tenant is resolved server-side from the bearer JWT — do NOT pass tenant_id.
   *
   * @param campaignId - The campaign ID to report on.
   * @param timeRange  - Optional time range to restrict the report data.
   * @returns Structured campaign performance report.
   */
  async getCampaignReport(
    campaignId: string,
    timeRange?: { start: string; end: string; granularity?: string }
  ): Promise<CampaignReportResponse> {
    const body: Record<string, unknown> = { campaignId };
    if (timeRange) {
      body['timeRange'] = timeRange;
    }
    return this.post<CampaignReportResponse>('/analytics/campaign-report', body);
  }

  // -------------------------------------------------------------------------
  // Segmentation endpoints
  // -------------------------------------------------------------------------

  /**
   * List all available segmentation criteria.
   * Maps to GET /segmentation/criteria.
   *
   * Result is cached for 5 minutes per-session. Cache is invalidated when the
   * JWT is rotated (tenant switch) via `clearAllCaches()`.
   *
   * Tenant is resolved server-side from the bearer JWT — do NOT pass tenant_id.
   *
   * @returns Criteria grouped by type with supported operators.
   */
  async getSegmentationCriteria(): Promise<SegmentationCriteriaResponse> {
    const now = Date.now();
    if (this.criteriaCache && this.criteriaCache.expiresAt > now) {
      return this.criteriaCache.data;
    }
    const data = await this.get<SegmentationCriteriaResponse>('/segmentation/criteria');
    this.criteriaCache = { data, expiresAt: now + DataClient.CACHE_TTL_MS };
    return data;
  }

  /**
   * Preview the estimated audience size for a segment definition.
   * Maps to POST /segments/preview.
   *
   * Tenant is resolved server-side from the bearer JWT — do NOT pass tenant_id.
   *
   * @param definition - DSL segment definition with stanzas and criteria.
   * @returns Estimated fan count and a small sample of matching fans.
   */
  async previewSegment(definition: SegmentDefinition): Promise<SegmentPreviewResponse> {
    return this.post<SegmentPreviewResponse>('/segments/preview', { definition });
  }

  /**
   * Execute a segment definition and retrieve matching contacts with pagination.
   * Maps to POST /segments/execute.
   *
   * Tenant is resolved server-side from the bearer JWT — do NOT pass tenant_id.
   *
   * @param definition - DSL segment definition.
   * @param page       - Zero-based page index (default 0).
   * @param pageSize   - Results per page (max 100, default 20).
   * @returns Paginated fan list with contact details.
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
   * Tenant is resolved server-side from the bearer JWT — do NOT pass tenant_id.
   *
   * @param criterionId - The criterion ID to look up values for.
   * @param search      - Optional search string to filter values.
   * @returns Matching values as strings or labeled objects.
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
   * @param raw - Raw parsed JSON from POST /analytics/query.
   */
  private transformQueryResponse(raw: Record<string, unknown>): AnalyticsQueryResponse {
    // Normalize response envelope: accept { data: [] }, { rows: [] }, or bare array
    const rows: Record<string, unknown>[] = (
      (Array.isArray(raw['data']) ? raw['data'] : null) ??
      (Array.isArray(raw['rows']) ? raw['rows'] : null) ??
      (Array.isArray(raw) ? (raw as unknown as unknown[]) : null) ??
      []
    ) as Record<string, unknown>[];

    const meta = raw['metadata'] as Record<string, unknown> | undefined;

    return {
      data: rows,
      metadata: {
        // Accept both camelCase and snake_case variants from the API
        totalRows: (meta?.['totalRows'] as number | undefined) ??
                   (meta?.['total_rows'] as number | undefined) ??
                   rows.length,
        executionTime: (meta?.['executionTime'] as number | undefined) ??
                       (meta?.['execution_time'] as number | undefined) ??
                       0,
        query: typeof meta?.['query'] === 'string' ? meta['query'] : undefined,
      },
    };
  }
}
