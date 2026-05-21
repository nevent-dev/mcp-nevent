/**
 * TypeScript types mirroring the Java Short URL DTOs.
 *
 * These types are used by `ShortUrlClient` and the 9 short URL MCP tools.
 * They map directly to the Java classes in:
 *   es.nevent.api.model.shorturl.dto.*
 *
 * @module types/short-urls
 */

// ---------------------------------------------------------------------------
// Core DTO types
// ---------------------------------------------------------------------------

/**
 * Full representation of a short URL.
 * Maps to `es.nevent.api.model.shorturl.dto.ShortUrlDTO`.
 */
export interface ShortUrlDTO {
  /** MongoDB ObjectId of the short URL (24-hex string). */
  id: string;
  /** Unique short code used in the redirect URL, e.g. "Xj4K9a". */
  shortCode: string;
  /** Full short URL including domain, e.g. "https://nevt.link/Xj4K9a". */
  shortUrl: string;
  /** Original destination URL, e.g. "https://nevent.es/events/summer-festival-2025". */
  longUrl: string;
  /** Tenant ID that owns this short URL. */
  tenantId: string;
  /** User ID of the creator. */
  createdBy: string;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  /** ISO 8601 expiration date/time, or null if it never expires. */
  expiresAt: string | null;
  /** Whether this short URL is currently active. */
  isActive: boolean;
  /** Descriptive title for the short URL. */
  title: string | null;
  /** Tags for categorization. */
  tags: string[];
  /** Additional key-value metadata (campaignId, eventId, etc.). */
  metadata: Record<string, unknown> | null;
  /** Total number of clicks recorded. */
  clickCount: number;
  /** ISO 8601 timestamp of the most recent click, or null. */
  lastClickedAt: string | null;
  /** Whether this short URL has passed its expiration date. */
  isExpired: boolean;
  /** True = parent (campaign) link, false = user-specific link. */
  isParent: boolean | null;
  /** Short code of the parent short URL (only present on user links). */
  parentShortCode: string | null;
  /** User ID associated with this link (only present on user links). */
  userId: string | null;
  /** Number of user-specific child links created under this parent (only on parent links). */
  userLinksCount: number | null;
}

/**
 * Paginated response for the short URL listing endpoint.
 * Maps to `es.nevent.api.model.shorturl.dto.ShortUrlListResponse`.
 */
export interface ShortUrlListResponse {
  /** List of short URLs for the current page. */
  items: ShortUrlDTO[];
  /** Total number of short URLs matching the query (across all pages). */
  total: number;
  /** Current zero-based page number. */
  page: number;
  /** Number of items per page. */
  pageSize: number;
  /** Total number of pages. */
  totalPages: number;
}

/**
 * Aggregated click metrics for a single short URL.
 * Maps to `es.nevent.api.model.shorturl.dto.ShortUrlMetricsDTO`.
 */
export interface ShortUrlMetricsDTO {
  /** MongoDB ObjectId of the short URL. */
  shortUrlId: string;
  /** The short code, e.g. "Xj4K9a". */
  shortCode: string;
  /** Total number of clicks in the time window. */
  totalClicks: number;
  /** Number of unique visitor IPs. */
  uniqueVisitors: number;
  /** ISO 8601 timestamp of the first click. */
  firstClickAt: string | null;
  /** ISO 8601 timestamp of the most recent click. */
  lastClickAt: string | null;
  /** Clicks grouped by date (yyyy-MM-dd → count). */
  clicksByDay: Record<string, number>;
  /** Clicks grouped by country ISO code. */
  clicksByCountry: Record<string, number>;
  /** Clicks grouped by device type (mobile/desktop/tablet/unknown). */
  clicksByDevice: Record<string, number>;
  /** Clicks grouped by browser name. */
  clicksByBrowser: Record<string, number>;
  /** Clicks grouped by operating system. */
  clicksByOs: Record<string, number>;
  /** Top referring URLs and their click counts. */
  topReferers: Record<string, number>;
}

/**
 * Individual click event record.
 * Maps to `es.nevent.api.model.shorturl.dto.ShortUrlClickDTO`.
 */
export interface ShortUrlClickDTO {
  /** MongoDB ObjectId of the click record. */
  id: string;
  /** MongoDB ObjectId of the short URL that was clicked. */
  shortUrlId: string;
  /** The short code that was clicked. */
  shortCode: string;
  /** ISO 8601 timestamp of when the click occurred. */
  clickedAt: string;
  /** Visitor's IP address. */
  ipAddress: string | null;
  /** Full user-agent string. */
  userAgent: string | null;
  /** HTTP Referer header value. */
  referer: string | null;
  /** ISO country code (e.g. "ES"). */
  country: string | null;
  /** Country name (e.g. "Spain"). */
  countryName: string | null;
  /** Region/state code. */
  region: string | null;
  /** Region/state name. */
  regionName: string | null;
  /** City name. */
  city: string | null;
  /** Postal code. */
  postalCode: string | null;
  /** IANA timezone identifier. */
  timezone: string | null;
  /** Latitude. */
  latitude: number | null;
  /** Longitude. */
  longitude: number | null;
  /** Device type: mobile | desktop | tablet | unknown. */
  device: string | null;
  /** Browser name. */
  browser: string | null;
  /** Operating system name. */
  os: string | null;
  /** Client Hints API — browser hint. */
  browserHint: string | null;
  /** Client Hints API — platform hint. */
  platformHint: string | null;
  /** HTTP Origin header. */
  origin: string | null;
  /** Accept-Language header value. */
  language: string | null;
  /** UTM Source. */
  utmSource: string | null;
  /** UTM Medium. */
  utmMedium: string | null;
  /** UTM Campaign. */
  utmCampaign: string | null;
  /** UTM Term. */
  utmTerm: string | null;
  /** UTM Content. */
  utmContent: string | null;
  /** Facebook Click ID (_fbclid). */
  fbclid: string | null;
  /** Google Click ID (gclid). */
  gclid: string | null;
  /** Microsoft Click ID (msclkid). */
  msclkid: string | null;
  /** Do Not Track header was set. */
  dnt: boolean | null;
  /** Global Privacy Control signal. */
  gpc: boolean | null;
  /** Whether this click is classified as paid traffic (inferred from Click IDs). */
  isPaidTraffic: boolean | null;
}

// ---------------------------------------------------------------------------
// Campaign metrics types
// ---------------------------------------------------------------------------

/**
 * Per-user click summary within a campaign.
 * Maps to `CampaignShortUrlMetricsDTO.UserClickSummary` (inner class).
 */
export interface UserClickSummary {
  /** User ID. */
  userId: string;
  /** The user's unique short code. */
  shortCode: string;
  /** Number of clicks on this user's link. */
  clickCount: number;
  /** ISO 8601 timestamp of the last click, or null. */
  lastClickedAt: string | null;
}

/**
 * Aggregated campaign-level metrics across a parent short URL and all its child links.
 * Maps to `es.nevent.api.model.shorturl.dto.CampaignShortUrlMetricsDTO`.
 */
export interface CampaignShortUrlMetricsDTO {
  /** The parent short code for the campaign. */
  parentShortCode: string;
  /** The campaign destination URL. */
  parentLongUrl: string;
  /** Total number of user-specific child URLs created for this campaign. */
  totalChildUrls: number;
  /** Total clicks across all child URLs. */
  totalClicks: number;
  /** Number of child URLs that have received at least one click. */
  urlsWithClicks: number;
  /** Average clicks per child URL. */
  avgClicksPerUrl: number;
  /** Click-through rate: (urlsWithClicks / totalChildUrls) * 100. */
  clickThroughRate: number;
  /** Top users by click count (controlled by topN param). */
  topUsersByClicks: UserClickSummary[];
  /** Clicks grouped by date (yyyy-MM-dd → count). */
  clicksByDay: Record<string, number>;
  /** Clicks grouped by device type. */
  clicksByDevice: Record<string, number>;
  /** Clicks grouped by browser. */
  clicksByBrowser: Record<string, number>;
  /** Clicks grouped by country ISO code. */
  clicksByCountry: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Bulk response types
// ---------------------------------------------------------------------------

/**
 * Response from the bulk user short URL creation endpoint.
 * Maps to `es.nevent.api.model.shorturl.dto.BulkUserShortUrlResponse`.
 *
 * Note: The controller constructs this directly (not using BulkShortUrlResult),
 * so it has a simpler shape: parentShortCode, totalRequested, totalCreated, createdLinks.
 */
export interface BulkUserShortUrlResponse {
  /** The parent short code that the user links were created under. */
  parentShortCode: string;
  /** Number of user IDs that were requested. */
  totalRequested: number;
  /** Number of short URLs actually created. */
  totalCreated: number;
  /** The created ShortUrlDTO objects, one per user. */
  createdLinks: ShortUrlDTO[];
}

// ---------------------------------------------------------------------------
// Request types
// ---------------------------------------------------------------------------

/**
 * Request body for creating a new short URL.
 * Maps to `es.nevent.api.model.shorturl.dto.CreateShortUrlRequest`.
 */
export interface CreateShortUrlRequest {
  /** The full target URL to redirect to (required). */
  longUrl: string;
  /** Descriptive title for the short URL (max 200 chars). */
  title?: string;
  /** Expiration date/time as ISO 8601 string. Null or omit for no expiration. */
  expiresAt?: string;
  /** Tags for categorization. */
  tags?: string[];
  /** Additional metadata key-value pairs (e.g. campaignId, eventId). */
  metadata?: Record<string, unknown>;
  /** Custom short code (6-8 chars). Omit for auto-generated code. */
  customShortCode?: string;
}

/**
 * Request body for updating an existing short URL.
 * Maps to `es.nevent.api.model.shorturl.dto.UpdateShortUrlRequest`.
 * All fields are optional — only provided fields are updated.
 */
export interface UpdateShortUrlRequest {
  /** New descriptive title (max 200 chars). */
  title?: string;
  /** New expiration date/time. Pass null to remove expiration. */
  expiresAt?: string | null;
  /** Activate or deactivate the short URL. */
  isActive?: boolean;
  /** New tags replacing the existing ones. */
  tags?: string[];
  /** New metadata replacing the existing one. */
  metadata?: Record<string, unknown>;
  /** New destination URL (allows changing where the link redirects). */
  longUrl?: string;
}

/**
 * Request body for bulk creation of user-specific short URLs.
 * Maps to `es.nevent.api.model.shorturl.dto.CreateBulkUserShortUrlRequest`.
 */
export interface CreateBulkUserShortUrlRequest {
  /**
   * The parent short code — must match the path parameter.
   * The controller validates that path param and body param match.
   */
  parentShortCode: string;
  /** List of user IDs to create individual short URLs for. */
  userIds: string[];
}
