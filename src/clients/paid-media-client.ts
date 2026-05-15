/**
 * Paid Media API client targeting nev-api (`/api/ads/{provider}/...`).
 *
 * Provides strongly-typed methods for all 11 paid media MCP tools (Tier 1 + Tier 2).
 * All endpoints require roles ADMIN | SUPERADMIN | OWNER and capability MODULE_ATTRIBUTION.
 * Tenant is resolved from the JWT — no `tenant_id` query param is sent.
 *
 * ## Feature gate handling
 *
 * Some endpoints (insights, targeting, creative, comparative-stats, health) return
 * HTTP 404 when the tenant is not enrolled in the provider's insights pilot.
 * The `get()` calls propagate `NeventApiError` (code: 'not_found') and the tool
 * handlers remap this to a user-friendly feature gate message.
 *
 * @module clients/paid-media-client
 */

import { BaseClient } from './base-client.js';
import type { BaseClientConfig } from './base-client.js';
import type {
  AdsProvider,
  AdsConnectionStatus,
  AdsHealthResponse,
  NormalizedCampaign,
  NormalizedInsightsRow,
  AdsAttributionSummary,
  NormalizedAdGroup,
  AdGroupComparativeStats,
  NormalizedAdGroupTargeting,
  NormalizedAd,
  CreativeResponseDTO,
} from '../types/paid-media.js';

// ---------------------------------------------------------------------------
// PaidMediaClient
// ---------------------------------------------------------------------------

/**
 * Client for the nev-api paid media endpoints (`/api/ads/{provider}/...`).
 *
 * In HTTP mode, one `PaidMediaClient` is created per MCP session and authenticates
 * with the user's own nev-api JWT token. In stdio mode, a single shared instance
 * is used for all requests.
 *
 * All methods are thin wrappers over `BaseClient.get()` — error handling
 * (including feature gate 404s) is left to tool handlers.
 *
 * @example
 * ```ts
 * const client = new PaidMediaClient({
 *   baseUrl: process.env.NEVENT_API_URL ?? 'https://api.nevent.es',
 *   jwtToken: process.env.NEVENT_JWT_TOKEN!,
 * });
 * const status = await client.getStatus('meta');
 * ```
 */
export class PaidMediaClient extends BaseClient {
  constructor(config: BaseClientConfig) {
    super(config);
  }

  // -------------------------------------------------------------------------
  // Tier 1 endpoints
  // -------------------------------------------------------------------------

  /**
   * Check whether a provider account is connected and when it last synced.
   * Maps to GET /api/ads/{provider}/status.
   *
   * @param provider — meta | google | tiktok
   * @returns Connection status including accountId, accountName, lastSyncAt.
   */
  async getStatus(provider: AdsProvider): Promise<AdsConnectionStatus> {
    return this.get<AdsConnectionStatus>(`/api/ads/${provider}/status`);
  }

  /**
   * Retrieve operational health signals for a provider.
   * Maps to GET /api/ads/{provider}/health.
   *
   * Returns throttle state, feature gate (pilot allowlist), tier, and stale sync info.
   * May return a 404 NeventApiError when the tenant is not in the pilot allowlist
   * for the provider — callers should detect this and show a feature gate message.
   *
   * @param provider — meta | google | tiktok
   * @returns Health response with throttle, featureGate, tier, backfillEnabled.
   */
  async getHealth(provider: AdsProvider): Promise<AdsHealthResponse> {
    return this.get<AdsHealthResponse>(`/api/ads/${provider}/health`);
  }

  /**
   * List all synced campaigns for a provider.
   * Maps to GET /api/ads/{provider}/campaigns.
   *
   * @param provider — meta | google | tiktok
   * @returns Array of normalized campaigns with budget and status.
   */
  async listCampaigns(provider: AdsProvider): Promise<NormalizedCampaign[]> {
    return this.get<NormalizedCampaign[]>(`/api/ads/${provider}/campaigns`);
  }

  /**
   * Get daily insights rows for a specific campaign.
   * Maps to GET /api/ads/{provider}/campaigns/{campaignId}/insights.
   *
   * May return a 404 NeventApiError when the tenant is not in the pilot allowlist.
   *
   * @param provider   — meta | google | tiktok
   * @param campaignId — Provider campaign ID (from listCampaigns).
   * @param from       — Optional start date (yyyy-MM-dd). Defaults to 7 days ago.
   * @param to         — Optional end date (yyyy-MM-dd). Defaults to today.
   * @returns Array of daily insights rows.
   */
  async getCampaignInsights(
    provider: AdsProvider,
    campaignId: string,
    from?: string,
    to?: string
  ): Promise<NormalizedInsightsRow[]> {
    const params: Record<string, string> = {};
    if (from) params['from'] = from;
    if (to) params['to'] = to;
    return this.get<NormalizedInsightsRow[]>(
      `/api/ads/${provider}/campaigns/${encodeURIComponent(campaignId)}/insights`,
      Object.keys(params).length ? params : undefined
    );
  }

  /**
   * Get the attribution summary linking campaigns to ticket sales via UTM matching.
   * Maps to GET /api/ads/{provider}/attribution.
   *
   * @param provider — meta | google | tiktok
   * @returns Array of attribution summaries with ticketsSold and revenue per campaign.
   */
  async getAttribution(provider: AdsProvider): Promise<AdsAttributionSummary[]> {
    return this.get<AdsAttributionSummary[]>(`/api/ads/${provider}/attribution`);
  }

  // -------------------------------------------------------------------------
  // Tier 2 endpoints
  // -------------------------------------------------------------------------

  /**
   * List ad groups (ad sets) for a provider, optionally filtered by campaign.
   * Maps to GET /api/ads/{provider}/ad-groups?campaignId={campaignId}.
   *
   * @param provider   — meta | google | tiktok
   * @param campaignId — Optional: filter to ad groups belonging to this campaign.
   * @returns Array of normalized ad groups.
   */
  async listAdGroups(
    provider: AdsProvider,
    campaignId?: string
  ): Promise<NormalizedAdGroup[]> {
    const params = campaignId ? { campaignId } : undefined;
    return this.get<NormalizedAdGroup[]>(`/api/ads/${provider}/ad-groups`, params);
  }

  /**
   * Get daily insights rows for a specific ad group.
   * Maps to GET /api/ads/{provider}/ad-groups/{id}/insights.
   *
   * May return a 404 NeventApiError when the tenant is not in the pilot allowlist.
   *
   * @param provider   — meta | google | tiktok
   * @param adGroupId  — Provider ad group ID (from listAdGroups).
   * @param from       — Optional start date (yyyy-MM-dd). Defaults to 7 days ago.
   * @param to         — Optional end date (yyyy-MM-dd). Defaults to today.
   * @returns Array of daily insights rows.
   */
  async getAdGroupInsights(
    provider: AdsProvider,
    adGroupId: string,
    from?: string,
    to?: string
  ): Promise<NormalizedInsightsRow[]> {
    const params: Record<string, string> = {};
    if (from) params['from'] = from;
    if (to) params['to'] = to;
    return this.get<NormalizedInsightsRow[]>(
      `/api/ads/${provider}/ad-groups/${encodeURIComponent(adGroupId)}/insights`,
      Object.keys(params).length ? params : undefined
    );
  }

  /**
   * Get comparative stats for an ad group vs its campaign siblings.
   * Maps to GET /api/ads/{provider}/ad-groups/{id}/comparative-stats.
   *
   * May return a 404 NeventApiError when the tenant is not in the pilot allowlist.
   *
   * @param provider  — meta | google | tiktok
   * @param adGroupId — Provider ad group ID (from listAdGroups).
   * @param from      — Optional start date (yyyy-MM-dd). Defaults to 7 days ago.
   * @param to        — Optional end date (yyyy-MM-dd). Defaults to today.
   * @returns Comparative stats with per-metric value, mean, and ratio vs siblings.
   */
  async getAdGroupComparativeStats(
    provider: AdsProvider,
    adGroupId: string,
    from?: string,
    to?: string
  ): Promise<AdGroupComparativeStats> {
    const params: Record<string, string> = {};
    if (from) params['from'] = from;
    if (to) params['to'] = to;
    return this.get<AdGroupComparativeStats>(
      `/api/ads/${provider}/ad-groups/${encodeURIComponent(adGroupId)}/comparative-stats`,
      Object.keys(params).length ? params : undefined
    );
  }

  /**
   * Get audience targeting detail for an ad group.
   * Maps to GET /api/ads/{provider}/ad-groups/{id}/targeting.
   *
   * May return a 404 NeventApiError when the tenant is not in the pilot allowlist.
   *
   * @param provider  — meta | google | tiktok
   * @param adGroupId — Provider ad group ID (from listAdGroups).
   * @returns Full targeting detail: demographics, geo, interests, placements, audiences.
   */
  async getAdGroupTargeting(
    provider: AdsProvider,
    adGroupId: string
  ): Promise<NormalizedAdGroupTargeting> {
    return this.get<NormalizedAdGroupTargeting>(
      `/api/ads/${provider}/ad-groups/${encodeURIComponent(adGroupId)}/targeting`
    );
  }

  /**
   * List ads for a provider, optionally filtered by campaign and/or ad group.
   * Maps to GET /api/ads/{provider}/ads?campaignId={}&adGroupId={}.
   *
   * @param provider   — meta | google | tiktok
   * @param campaignId — Optional: filter to ads in this campaign.
   * @param adGroupId  — Optional: filter to ads in this ad group.
   * @returns Array of normalized ads with UTM fields.
   */
  async listAds(
    provider: AdsProvider,
    campaignId?: string,
    adGroupId?: string
  ): Promise<NormalizedAd[]> {
    const params: Record<string, string> = {};
    if (campaignId) params['campaignId'] = campaignId;
    if (adGroupId) params['adGroupId'] = adGroupId;
    return this.get<NormalizedAd[]>(
      `/api/ads/${provider}/ads`,
      Object.keys(params).length ? params : undefined
    );
  }

  /**
   * Get the creative detail for a specific ad, including S3 pre-signed image/video URLs.
   * Maps to GET /api/ads/{provider}/ads/{id}/creative.
   *
   * S3 URLs have a ~1h TTL. A null URL means the asset has not been mirrored yet.
   * May return a 404 NeventApiError when the tenant is not in the pilot allowlist.
   *
   * @param provider — meta | google | tiktok
   * @param adId     — Provider ad ID (from listAds).
   * @returns Creative detail with body, title, description, image/video URLs, DCA data.
   */
  async getAdCreative(provider: AdsProvider, adId: string): Promise<CreativeResponseDTO> {
    return this.get<CreativeResponseDTO>(
      `/api/ads/${provider}/ads/${encodeURIComponent(adId)}/creative`
    );
  }
}
