/**
 * Zod validation schemas for short URL MCP tools.
 *
 * Covers all 9 tools (Tier 1 + Tier 2 + Tier 3):
 *
 * Tier 1 — Read essentials:
 *  - ListShortUrlsSchema              — nevent_list_short_urls
 *  - GetShortUrlSchema                — nevent_get_short_url
 *  - GetShortUrlMetricsSchema         — nevent_get_short_url_metrics
 *  - GetShortUrlCampaignMetricsSchema — nevent_get_short_url_campaign_metrics
 *
 * Tier 2 — Read drill-down:
 *  - GetShortUrlClicksSchema          — nevent_get_short_url_clicks
 *  - ListShortUrlUserLinksSchema      — nevent_list_short_url_user_links
 *
 * Tier 3 — Write:
 *  - CreateShortUrlSchema             — nevent_create_short_url
 *  - UpdateShortUrlSchema             — nevent_update_short_url
 *  - CreateBulkUserShortUrlsSchema    — nevent_create_bulk_user_short_urls
 *
 * Design principles:
 * - Each field has a rich `.describe()` explaining what to pass and where to get it
 * - MongoDB ObjectIds validated with /^[a-f0-9]{24}$/i regex
 * - Short codes validated with /^[A-Za-z0-9]{6,8}$/ (6-8 alphanumeric per API constraint)
 * - URLs use z.string().url() for longUrl fields
 * - Arrays have z.array().min(1) where required
 * - Dates use ISO 8601 with .datetime({ offset: true }) for request bodies
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/**
 * MongoDB ObjectId — 24 hex characters.
 * Used for `id` parameters in most endpoints.
 */
const MongoId = z
  .string()
  .regex(/^[a-f0-9]{24}$/i, 'Must be a 24-character MongoDB ObjectId (hex string)')
  .describe(
    'MongoDB ObjectId of the short URL (24 hex characters). ' +
    'Obtain from nevent_list_short_urls response field "id".'
  );

/**
 * Short code — 6 to 8 alphanumeric characters.
 * Used as the path key in redirect URLs (e.g. "Xj4K9a").
 */
const ShortCode = z
  .string()
  .regex(/^[A-Za-z0-9]{6,8}$/, 'Short code must be 6-8 alphanumeric characters')
  .describe(
    'Short code string (6-8 alphanumeric characters), e.g. "Xj4K9a". ' +
    'Obtain from nevent_list_short_urls response field "shortCode".'
  );

// ---------------------------------------------------------------------------
// Tier 1 — Read essential schemas
// ---------------------------------------------------------------------------

/**
 * Input schema for `nevent_list_short_urls`.
 * All parameters are optional — returns all short URLs by default (paginated).
 */
export const ListShortUrlsSchema = {
  isActive: z
    .boolean()
    .optional()
    .describe(
      'Filter by active status. true = only active links, false = only inactive/expired links. ' +
      'Omit to return both.'
    ),
  search: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Free-text search across short code, title, and target URL. ' +
      'E.g. "summer" to find links tagged or titled with that word.'
    ),
  page: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      'Zero-based page number for pagination. Default: 0 (first page).'
    ),
  pageSize: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'Number of results per page. Default: 20. Max: 200.'
    ),
};

/**
 * Input schema for `nevent_get_short_url`.
 * Fetches full detail of a single short URL by its MongoDB ID.
 */
export const GetShortUrlSchema = {
  id: MongoId,
};

/**
 * Input schema for `nevent_get_short_url_metrics`.
 * Fetches aggregated analytics for one short URL.
 */
export const GetShortUrlMetricsSchema = {
  id: MongoId,
  days: z
    .number()
    .int()
    .min(1)
    .max(365)
    .optional()
    .describe(
      'Number of days to include in metrics calculation. Default: 30. Max: 365. ' +
      'Use 7 for last week, 30 for last month, 90 for last quarter.'
    ),
};

/**
 * Input schema for `nevent_get_short_url_campaign_metrics`.
 * Fetches aggregated campaign-level metrics across a parent and all user links.
 */
export const GetShortUrlCampaignMetricsSchema = {
  parentShortCode: z
    .string()
    .min(1)
    .describe(
      'Short code of the parent (campaign) short URL. ' +
      'Obtain from nevent_list_short_urls where isParent=true, field "shortCode".'
    ),
  days: z
    .number()
    .int()
    .min(1)
    .max(365)
    .optional()
    .describe(
      'Number of days to include in metrics. Default: 30.'
    ),
  topN: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe(
      'Number of top-performing users to return in topUsersByClicks. Default: 10.'
    ),
};

// ---------------------------------------------------------------------------
// Tier 2 — Read drill-down schemas
// ---------------------------------------------------------------------------

/**
 * Input schema for `nevent_get_short_url_clicks`.
 * Fetches individual click event records for a short URL.
 */
export const GetShortUrlClicksSchema = {
  id: MongoId,
  limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe(
      'Maximum number of recent click records to return, ordered newest-first. ' +
      'Default: 100. Max: 1000.'
    ),
};

/**
 * Input schema for `nevent_list_short_url_user_links`.
 * Lists all per-user short URL links created under a parent.
 */
export const ListShortUrlUserLinksSchema = {
  parentShortCode: z
    .string()
    .min(1)
    .describe(
      'Short code of the parent (campaign) short URL. ' +
      'Obtain from nevent_list_short_urls where isParent=true, field "shortCode".'
    ),
};

// ---------------------------------------------------------------------------
// Tier 3 — Write schemas
// ---------------------------------------------------------------------------

/**
 * Input schema for `nevent_create_short_url`.
 * Creates a new short URL with the provided configuration.
 */
export const CreateShortUrlSchema = {
  longUrl: z
    .string()
    .url('Must be a valid URL including protocol (https://...)')
    .describe(
      'The full destination URL to redirect to. Must include protocol (https:// or http://). ' +
      'Example: "https://nevent.es/events/summer-festival-2025".'
    ),
  title: z
    .string()
    .max(200, 'Title cannot exceed 200 characters')
    .optional()
    .describe(
      'Descriptive label for the short URL (max 200 chars). ' +
      'Shown in the admin list view and used for search.'
    ),
  expiresAt: z
    .string()
    .datetime({ offset: true })
    .optional()
    .describe(
      'Expiration date/time in ISO 8601 format, e.g. "2025-12-31T23:59:59.000Z". ' +
      'After this date the short URL stops redirecting. Omit for a permanent link.'
    ),
  tags: z
    .array(z.string().min(1))
    .optional()
    .describe(
      'Tags for categorization and filtering. ' +
      'Example: ["campaign", "summer", "2025"]. Use consistent tag names across campaigns.'
    ),
  metadata: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Arbitrary key-value metadata. Useful for storing campaignId, eventId, or other ' +
      'business identifiers. Example: {"campaignId": "NEV-123", "eventId": "evt-456"}.'
    ),
  customShortCode: z
    .string()
    .min(6, 'Custom short code must be at least 6 characters')
    .max(8, 'Custom short code cannot exceed 8 characters')
    .regex(/^[A-Za-z0-9]+$/, 'Custom short code must be alphanumeric only')
    .optional()
    .describe(
      'Custom short code (6-8 alphanumeric characters). ' +
      'If omitted, a unique code is auto-generated. Example: "SUMMER". ' +
      'Use nevent_validate_short_code (if available) to check availability first.'
    ),
};

/**
 * Input schema for `nevent_update_short_url`.
 * Updates an existing short URL. All fields are optional — only provided fields change.
 */
export const UpdateShortUrlSchema = {
  id: MongoId,
  title: z
    .string()
    .max(200)
    .optional()
    .describe(
      'New descriptive title (max 200 chars). Replaces the existing title.'
    ),
  expiresAt: z
    .union([
      z.string().datetime({ offset: true }),
      z.null(),
    ])
    .optional()
    .describe(
      'New expiration date/time (ISO 8601). Pass null to remove an existing expiration ' +
      'and make the link permanent. Omit this field entirely to leave expiration unchanged.'
    ),
  isActive: z
    .boolean()
    .optional()
    .describe(
      'Activate (true) or deactivate (false) the short URL. ' +
      'Deactivated links stop redirecting immediately.'
    ),
  tags: z
    .array(z.string().min(1))
    .optional()
    .describe(
      'New tag list. Replaces (not merges) the existing tags.'
    ),
  metadata: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'New metadata object. Replaces (not merges) the existing metadata.'
    ),
  longUrl: z
    .string()
    .url()
    .optional()
    .describe(
      'New destination URL. Changes where existing links redirect to — takes effect immediately.'
    ),
};

/**
 * Input schema for `nevent_create_bulk_user_short_urls`.
 * Generates per-user short URL variants for an existing parent short URL.
 */
export const CreateBulkUserShortUrlsSchema = {
  parentShortCode: z
    .string()
    .min(1)
    .describe(
      'Short code of the parent (campaign) short URL under which user links will be created. ' +
      'Must already exist. Obtain from nevent_list_short_urls where isParent=true.'
    ),
  userIds: z
    .array(z.string().min(1))
    .min(1, 'Must provide at least one user ID')
    .describe(
      'List of user IDs (MongoDB ObjectIds or Nevent user identifiers) to create ' +
      'individual tracking links for. Each user gets a unique short code that resolves ' +
      'to the same destination as the parent. Duplicates are skipped.'
    ),
};
