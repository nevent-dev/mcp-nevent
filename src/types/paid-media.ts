/**
 * TypeScript response types for the Paid Media (Ads) API.
 *
 * These types mirror the Java record DTOs in
 * `es.nevent.api.ads.dto` and are used by `PaidMediaClient`
 * and the paid-media tool handlers for type-safe response handling.
 *
 * Enums:
 *  - `AdsProvider`    — meta | google | tiktok
 *  - `CampaignStatus` — ACTIVE | PAUSED | ARCHIVED | DELETED | DRAFT | ...
 *  - `BudgetType`     — DAILY | LIFETIME | TOTAL | UNKNOWN
 *  - `InsightsLevel`  — CAMPAIGN | ADSET | AD
 *
 * Key response shapes:
 *  - `AdsConnectionStatus`       — connection + last sync timestamp
 *  - `AdsHealthResponse`         — operational signals (throttle, feature gate, tier)
 *  - `NormalizedCampaign`        — campaign list item with budget
 *  - `NormalizedInsightsRow`     — daily metrics row (spend, impressions, CTR, ROAS, …)
 *  - `AdsAttributionSummary`     — campaign linked to ticket sales via UTM
 *  - `NormalizedAdGroup`         — ad set / ad group list item
 *  - `AdGroupComparativeStats`   — per-metric comparison vs campaign siblings
 *  - `NormalizedAdGroupTargeting`— audience targeting detail (geo, interests, placements)
 *  - `NormalizedAd`              — individual ad with UTM fields
 *  - `CreativeResponseDTO`       — ad creative with S3 pre-signed URLs (1h TTL)
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/** Supported paid advertising providers. */
export type AdsProvider = 'meta' | 'google' | 'tiktok';

/** Campaign lifecycle status values as returned by nev-api. */
export type AdsCampaignStatus =
  | 'ACTIVE'
  | 'PAUSED'
  | 'ARCHIVED'
  | 'DELETED'
  | 'DRAFT'
  | 'PENDING_REVIEW'
  | 'REJECTED'
  | 'UNKNOWN';

/** Budget period type for a paid campaign. */
export type AdsBudgetType = 'DAILY' | 'LIFETIME' | 'TOTAL' | 'UNKNOWN';

/** Aggregation level for an insights row. */
export type AdsInsightsLevel = 'CAMPAIGN' | 'ADSET' | 'AD';

// ---------------------------------------------------------------------------
// Shared sub-types
// ---------------------------------------------------------------------------

/**
 * Monetary amount with ISO 4217 currency code.
 * Used inside `NormalizedCampaign` and `AdsAttributionSummary`.
 */
export interface AdsMoney {
  amount: number | null;
  currency: string | null;
}

// ---------------------------------------------------------------------------
// Tier 1 responses
// ---------------------------------------------------------------------------

/**
 * Response shape for `GET /api/ads/{provider}/status`.
 *
 * Tells whether the provider account is connected and when it last synced.
 */
export interface AdsConnectionStatus {
  connected: boolean;
  provider: string;
  accountId: string | null;
  accountName: string | null;
  lastSyncAt: string | null;
}

/**
 * Throttle details returned inside `AdsHealthResponse`.
 */
export interface AdsThrottleStatus {
  isThrottled: boolean;
  nextAttemptAt: string | null;
  reason: string | null;
  lastAccountUtilPct: number | null;
  consecutiveHits: number | null;
}

/**
 * Feature gate status returned inside `AdsHealthResponse`.
 */
export interface AdsFeatureGateStatus {
  isInsightsEnabled: boolean;
  isInTenantAllowlist: boolean;
}

/**
 * Response shape for `GET /api/ads/{provider}/health`.
 *
 * Exposes operational signals needed to detect stale syncs, throttle windows,
 * and feature-gate status (pilot allowlist).
 */
export interface AdsHealthResponse {
  provider: string;
  tenantId: string | null;
  lastSuccessfulSyncAt: string | null;
  lastSuccessfulInsightsAt: string | null;
  throttle: AdsThrottleStatus | null;
  featureGate: AdsFeatureGateStatus | null;
  tier: string | null;
  backfillEnabled: boolean;
}

/**
 * A single normalized paid campaign as returned by
 * `GET /api/ads/{provider}/campaigns`.
 */
export interface NormalizedCampaign {
  id: string;
  provider: string;
  name: string | null;
  status: AdsCampaignStatus;
  objective: string | null;
  budget: AdsMoney | null;
  budgetType: AdsBudgetType | null;
  lastSyncedAt: string | null;
}

/**
 * A single row of provider-agnostic daily insights metrics.
 * Returned by all three `…/insights` endpoints (campaign, ad-group, ad).
 */
export interface NormalizedInsightsRow {
  entityId: string;
  providerId: string | null;
  level: AdsInsightsLevel;
  date: string | null;
  spend: number | null;
  currency: string | null;
  impressions: number | null;
  reach: number | null;
  frequency: number | null;
  clicks: number | null;
  ctr: number | null;
  cpm: number | null;
  cpc: number | null;
  results: number | null;
  costPerResult: number | null;
  pixelRoas: number | null;
  hookRate: number | null;
  engagementCount: number | null;
  engagementRate: number | null;
  video3sViews: number | null;
  videoThruPlay: number | null;
  videoP25Pct: number | null;
  videoP50Pct: number | null;
  videoP75Pct: number | null;
  videoP100Pct: number | null;
}

/**
 * Attribution summary linking a paid campaign to actual ticket sales via UTM matching.
 * Returned by `GET /api/ads/{provider}/attribution`.
 */
export interface AdsAttributionSummary {
  campaignId: string;
  provider: string;
  campaignName: string | null;
  status: AdsCampaignStatus;
  utmCampaigns: string[];
  ticketsSold: number;
  revenue: number | null;
  budget: AdsMoney | null;
  budgetType: AdsBudgetType | null;
}

// ---------------------------------------------------------------------------
// Tier 2 responses
// ---------------------------------------------------------------------------

/**
 * A single normalized ad group (ad set) as returned by
 * `GET /api/ads/{provider}/ad-groups`.
 */
export interface NormalizedAdGroup {
  id: string;
  provider: string;
  campaignId: string;
  name: string | null;
  status: AdsCampaignStatus;
  lastSyncedAt: string | null;
}

/**
 * Per-metric comparison value within `AdGroupComparativeStats`.
 */
export interface AdMetricComparison {
  value: number | null;
  campaignMean: number | null;
  ratioVsMean: number | null;
}

/**
 * Comparative stats for an ad group vs its campaign siblings.
 * Returned by `GET /api/ads/{provider}/ad-groups/{id}/comparative-stats`.
 */
export interface AdGroupComparativeStats {
  adGroupId: string;
  campaignId: string;
  siblingsInCampaign: number;
  costPerResult: AdMetricComparison | null;
  cpm: AdMetricComparison | null;
  frequency: AdMetricComparison | null;
  ctr: AdMetricComparison | null;
}

/**
 * Geographic summary within `NormalizedAdGroupTargeting`.
 */
export interface AdsGeoSummary {
  countries: string[];
  cities: string[];
  regions: string[];
  zips: string[];
  places: Array<{
    name: string;
    latitude: number | null;
    longitude: number | null;
    radius: number | null;
    distanceUnit: string | null;
  }>;
  locationTypes: string[];
}

/**
 * Advantage+ audience expansion flags within `NormalizedAdGroupTargeting`.
 */
export interface AdsAdvantagePlusFlags {
  advantageAudience: boolean;
  expandAge: boolean;
  expandGender: boolean;
  expandGeo: boolean;
}

/**
 * A single custom audience entry within `NormalizedAdGroupTargeting`.
 */
export interface AdsHidratedAudience {
  id: string;
  name: string | null;
  subtype: string | null;
  approximateCountLowerBound: number | null;
  retentionDays: number | null;
}

/**
 * Promoted object summary within `NormalizedAdGroupTargeting`.
 */
export interface AdsPromotedObjectSummary {
  pixelId: string | null;
  pageId: string | null;
  customEventType: string | null;
}

/**
 * Full audience targeting detail for an ad group.
 * Returned by `GET /api/ads/{provider}/ad-groups/{id}/targeting`.
 */
export interface NormalizedAdGroupTargeting {
  adSetId: string;
  ageRange: string | null;
  genders: string | null;
  geoSummary: AdsGeoSummary | null;
  topInterests: Array<{ id: string; name: string }>;
  totalInterests: number;
  topBehaviors: Array<{ id: string; name: string }>;
  totalBehaviors: number;
  placements: string[];
  automaticPlacements: boolean | null;
  advantagePlus: AdsAdvantagePlusFlags | null;
  customAudiences: AdsHidratedAudience[];
  excludedCustomAudiences: AdsHidratedAudience[];
  bidStrategy: string | null;
  promotedObject: AdsPromotedObjectSummary | null;
  targetingSyncedAt: string | null;
}

/**
 * A single normalized ad as returned by `GET /api/ads/{provider}/ads`.
 */
export interface NormalizedAd {
  id: string;
  provider: string;
  campaignId: string;
  adGroupId: string;
  name: string | null;
  status: AdsCampaignStatus;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContainsMacros: boolean;
  lastSyncedAt: string | null;
}

/**
 * DCA (Dynamic Creative Ads) image asset within `CreativeResponseDTO`.
 */
export interface DcaImageDTO {
  hash: string | null;
  imageUrl: string | null;
}

/**
 * DCA video asset within `CreativeResponseDTO`.
 */
export interface DcaVideoDTO {
  videoId: string | null;
  videoUrl: string | null;
  thumbnailUrl: string | null;
}

/**
 * Dynamic Creative Ads content block within `CreativeResponseDTO`.
 */
export interface DcaResponseDTO {
  images: DcaImageDTO[];
  videos: DcaVideoDTO[];
  bodies: string[];
  titles: string[];
  descriptions: string[];
  callToActionTypes: string[];
  linkUrls: string[];
}

/**
 * Full ad creative detail including S3 pre-signed URLs (1h TTL).
 * Returned by `GET /api/ads/{provider}/ads/{id}/creative`.
 *
 * Image/video URLs are pre-signed S3 URLs that expire after ~1 hour.
 * A `null` URL means the asset has not been mirrored yet — retry after ~5 min.
 */
export interface CreativeResponseDTO {
  adId: string;
  body: string | null;
  title: string | null;
  description: string | null;
  callToAction: string | null;
  clickUrl: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  imageUrl: string | null;
  videoUrl: string | null;
  videoThumbnailUrl: string | null;
  videoThumbnailHdUrl: string | null;
  previewShareableLink: string | null;
  hasDca: boolean;
  dca: DcaResponseDTO | null;
}
