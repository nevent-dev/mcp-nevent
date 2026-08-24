/**
 * Short URL API client targeting nev-api (`/admin/short-url/...`).
 *
 * Provides strongly-typed methods for all 9 short URL MCP tools (Tier 1 + Tier 2 + Tier 3).
 * All endpoints require roles ADMIN | OWNER | SUPERADMIN.
 * Tenant is resolved from the JWT — no `tenant_id` query param is sent.
 *
 * @module clients/short-url-client
 */

import { BaseClient } from './base-client.js';
import type { BaseClientConfig } from './base-client.js';
import type {
  ShortUrlDTO,
  ShortUrlListResponse,
  ShortUrlMetricsDTO,
  ShortUrlClickDTO,
  CampaignShortUrlMetricsDTO,
  BulkUserShortUrlResponse,
  CreateShortUrlRequest,
  UpdateShortUrlRequest,
  CreateBulkUserShortUrlRequest,
  ShortUrlDestinationListResponse,
} from '../types/short-urls.js';

// ---------------------------------------------------------------------------
// ShortUrlClient
// ---------------------------------------------------------------------------

/**
 * Client for the nev-api short URL admin endpoints (`/admin/short-url/...`).
 *
 * In HTTP mode, one `ShortUrlClient` is created per MCP session and authenticates
 * with the user's own nev-api JWT token. In stdio mode, a single shared instance
 * is used for all requests.
 *
 * All methods are thin wrappers over `BaseClient` — error handling (including
 * 401 auto-refresh via `onUnauthorized`) is delegated to the parent.
 *
 * ## Tenant resolution
 *
 * Tenant is resolved **server-side from the JWT**. The MCP MUST NOT send
 * `tenant_id` in the request body or as a query parameter — nev-api resolves
 * the tenant from the bearer token's `tenantId` claim.
 *
 * @example
 * ```ts
 * const client = new ShortUrlClient({
 *   baseUrl: process.env.NEVENT_API_URL ?? 'https://api.nevent.es',
 *   jwtToken: process.env.NEVENT_JWT_TOKEN!,
 * });
 * const list = await client.listShortUrls({});
 * ```
 */
export class ShortUrlClient extends BaseClient {
  constructor(config: BaseClientConfig) {
    super(config);
  }

  // -------------------------------------------------------------------------
  // Tier 1 — Read essentials
  // -------------------------------------------------------------------------

  /**
   * List all short URLs for the current tenant with optional filtering and pagination.
   * Maps to GET /admin/short-url.
   *
   * @param params.isActive  - Optional: filter by active/inactive status.
   * @param params.search    - Optional: search by short code, title, or target URL.
   * @param params.page      - Zero-based page number (default 0).
   * @param params.pageSize  - Number of results per page (default 20).
   * @returns Paginated ShortUrlListResponse with items, total, page, pageSize, totalPages.
   */
  async listShortUrls(params: {
    isActive?: boolean;
    search?: string;
    page?: number;
    pageSize?: number;
  }): Promise<ShortUrlListResponse> {
    const query: Record<string, string> = {};
    if (params.isActive !== undefined) query['isActive'] = String(params.isActive);
    if (params.search) query['search'] = params.search;
    if (params.page !== undefined) query['page'] = String(params.page);
    if (params.pageSize !== undefined) query['pageSize'] = String(params.pageSize);
    return this.get<ShortUrlListResponse>(
      '/admin/short-url',
      Object.keys(query).length ? query : undefined
    );
  }

  /**
   * Get full details of a specific short URL by its MongoDB ID.
   * Maps to GET /admin/short-url/{id}.
   *
   * @param id - The MongoDB ObjectId of the short URL (24-hex string).
   * @returns Full ShortUrlDTO.
   */
  async getShortUrl(id: string): Promise<ShortUrlDTO> {
    return this.get<ShortUrlDTO>(`/admin/short-url/${encodeURIComponent(id)}`);
  }

  /**
   * Get aggregated click metrics for a specific short URL.
   * Maps to GET /admin/short-url/{id}/metrics.
   *
   * @param id   - The MongoDB ObjectId of the short URL.
   * @param days - Number of days to include in metrics (default 30).
   * @returns ShortUrlMetricsDTO with totalClicks, uniqueVisitors, clicksByDay, etc.
   */
  async getShortUrlMetrics(id: string, days?: number): Promise<ShortUrlMetricsDTO> {
    const query: Record<string, string> = {};
    if (days !== undefined) query['days'] = String(days);
    return this.get<ShortUrlMetricsDTO>(
      `/admin/short-url/${encodeURIComponent(id)}/metrics`,
      Object.keys(query).length ? query : undefined
    );
  }

  /**
   * Get aggregated campaign-level metrics for a parent short URL and all its child links.
   * Maps to GET /admin/short-url/{parentShortCode}/campaign-metrics.
   *
   * @param parentShortCode - The short code of the parent short URL.
   * @param days            - Number of days to include (default 30).
   * @param topN            - Number of top users to return (default 10).
   * @returns CampaignShortUrlMetricsDTO with totalClicks, CTR, topUsersByClicks, etc.
   */
  async getCampaignMetrics(
    parentShortCode: string,
    days?: number,
    topN?: number
  ): Promise<CampaignShortUrlMetricsDTO> {
    const query: Record<string, string> = {};
    if (days !== undefined) query['days'] = String(days);
    if (topN !== undefined) query['topN'] = String(topN);
    return this.get<CampaignShortUrlMetricsDTO>(
      `/admin/short-url/${encodeURIComponent(parentShortCode)}/campaign-metrics`,
      Object.keys(query).length ? query : undefined
    );
  }

  // -------------------------------------------------------------------------
  // Tier 2 — Read drill-down
  // -------------------------------------------------------------------------

  /**
   * Get the most recent individual click records for a specific short URL.
   * Maps to GET /admin/short-url/{id}/clicks.
   *
   * @param id    - The MongoDB ObjectId of the short URL.
   * @param limit - Maximum number of recent clicks to return (default 100).
   * @returns Array of ShortUrlClickDTO ordered by most recent first.
   */
  async getClicks(id: string, limit?: number): Promise<ShortUrlClickDTO[]> {
    const query: Record<string, string> = {};
    if (limit !== undefined) query['limit'] = String(limit);
    return this.get<ShortUrlClickDTO[]>(
      `/admin/short-url/${encodeURIComponent(id)}/clicks`,
      Object.keys(query).length ? query : undefined
    );
  }

  /**
   * List all user-specific short URL links created under a parent short URL.
   * Maps to GET /admin/short-url/{parentShortCode}/user-links.
   *
   * @param parentShortCode - The short code of the parent short URL.
   * @returns Array of ShortUrlDTO — one per user who has a link.
   */
  async listUserLinks(parentShortCode: string): Promise<ShortUrlDTO[]> {
    return this.get<ShortUrlDTO[]>(
      `/admin/short-url/${encodeURIComponent(parentShortCode)}/user-links`
    );
  }

  // -------------------------------------------------------------------------
  // Tier 3 — Write operations
  // -------------------------------------------------------------------------

  /**
   * Create a new short URL for the current tenant.
   * Maps to POST /admin/short-url.
   *
   * @param request - CreateShortUrlRequest with longUrl (required), title, tags, etc.
   * @returns The newly created ShortUrlDTO with the generated shortCode and shortUrl.
   */
  async createShortUrl(request: CreateShortUrlRequest): Promise<ShortUrlDTO> {
    return this.post<ShortUrlDTO>('/admin/short-url', request);
  }

  /**
   * Update an existing short URL's configuration.
   * Maps to PUT /admin/short-url/{id}.
   *
   * @param id      - The MongoDB ObjectId of the short URL to update.
   * @param request - UpdateShortUrlRequest with fields to modify (all optional).
   * @returns The updated ShortUrlDTO.
   */
  async updateShortUrl(id: string, request: UpdateShortUrlRequest): Promise<ShortUrlDTO> {
    const response = await this.request<ShortUrlDTO>(
      'PUT',
      `/admin/short-url/${encodeURIComponent(id)}`,
      { body: request }
    );
    return response.data;
  }

  /**
   * Generate per-user short URL variants for an existing parent short URL in bulk.
   * Maps to POST /admin/short-url/{parentShortCode}/user-links.
   *
   * @param parentShortCode - The short code of the parent short URL.
   * @param request         - CreateBulkUserShortUrlRequest with parentShortCode and userIds.
   * @returns BulkUserShortUrlResponse with parentShortCode, totalRequested, totalCreated, createdLinks.
   */
  async createBulkUserShortUrls(
    parentShortCode: string,
    request: CreateBulkUserShortUrlRequest
  ): Promise<BulkUserShortUrlResponse> {
    return this.post<BulkUserShortUrlResponse>(
      `/admin/short-url/${encodeURIComponent(parentShortCode)}/user-links`,
      request
    );
  }
  /**
   * List short URLs grouped by canonical destination URL.
   * Maps to GET /admin/short-url/destinations.
   *
   * Unlike {@link listShortUrls}, campaign parents that share a destination
   * collapse into a single row with aggregated click/campaign counts, and
   * system-managed assistant links are included (flagged `readOnly`).
   * Pagination is over groups, not documents.
   *
   * @param params.origin   - Optional: ALL | MANUAL | CAMPAIGN | ASSISTANT (default ALL).
   * @param params.search   - Optional: search by destination URL, title, or short code.
   * @param params.page     - Zero-based page number over groups (default 0).
   * @param params.pageSize - Number of groups per page (default 20).
   * @returns Paginated ShortUrlDestinationListResponse.
   */
  async listDestinations(params: {
    origin?: string;
    search?: string;
    page?: number;
    pageSize?: number;
  }): Promise<ShortUrlDestinationListResponse> {
    const query: Record<string, string> = {};
    if (params.origin) query['origin'] = params.origin;
    if (params.search) query['search'] = params.search;
    if (params.page !== undefined) query['page'] = String(params.page);
    if (params.pageSize !== undefined) query['pageSize'] = String(params.pageSize);
    return this.get<ShortUrlDestinationListResponse>(
      '/admin/short-url/destinations',
      Object.keys(query).length ? query : undefined
    );
  }
}
