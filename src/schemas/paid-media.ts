/**
 * Zod validation schemas for paid media (ads) MCP tools.
 *
 * Covers all 11 tools (Tier 1 + Tier 2):
 *
 * Tier 1:
 *  - AdsStatusSchema             — nevent_paid_ads_status
 *  - AdsHealthSchema             — nevent_paid_ads_health
 *  - ListPaidCampaignsSchema     — nevent_list_paid_campaigns
 *  - GetPaidCampaignInsightsSchema — nevent_get_paid_campaign_insights
 *  - AdsAttributionSchema        — nevent_paid_attribution
 *
 * Tier 2:
 *  - ListPaidAdGroupsSchema      — nevent_list_paid_ad_groups
 *  - GetPaidAdGroupInsightsSchema — nevent_get_paid_ad_group_insights
 *  - GetPaidAdGroupComparativeStatsSchema — nevent_get_paid_ad_group_comparative_stats
 *  - GetPaidAdGroupTargetingSchema — nevent_get_paid_ad_group_targeting
 *  - ListPaidAdsSchema           — nevent_list_paid_ads
 *  - GetPaidAdCreativeSchema     — nevent_get_paid_ad_creative
 *
 * Design principles (same as campaigns.ts / analytics.ts):
 * - Enums use `.describe()` with the full list of valid values
 * - Optional params use `.optional()`, not `.nullable()`
 * - Date params use `.regex()` for yyyy-MM-dd format (not `.datetime()`)
 * - Descriptions are written for LLMs: what to pass, where to get the value
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared enums
// ---------------------------------------------------------------------------

/**
 * Supported paid advertising providers.
 * Maps directly to the `{provider}` path segment in `/api/ads/{provider}/...`.
 */
export const AdsProviderEnum = z.enum(['meta', 'google', 'tiktok']).describe(
  'Ad provider: meta | google | tiktok'
);

/**
 * ISO date string in yyyy-MM-dd format (no time component).
 * Used for insights date range parameters.
 */
const InsightsDateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in yyyy-MM-dd format (e.g. "2024-01-15")')
  .describe('Date in yyyy-MM-dd format, e.g. "2024-01-15"');

// ---------------------------------------------------------------------------
// Tier 1 schemas
// ---------------------------------------------------------------------------

/**
 * Input schema for `nevent_paid_ads_status`.
 * Just requires a provider — tenant is resolved from the JWT.
 */
export const AdsStatusSchema = {
  provider: AdsProviderEnum,
};

/**
 * Input schema for `nevent_paid_ads_health`.
 * Just requires a provider — tenant is resolved from the JWT.
 */
export const AdsHealthSchema = {
  provider: AdsProviderEnum,
};

/**
 * Input schema for `nevent_list_paid_campaigns`.
 * Lists all synced campaigns for the provider. No filtering supported.
 */
export const ListPaidCampaignsSchema = {
  provider: AdsProviderEnum,
};

/**
 * Input schema for `nevent_get_paid_campaign_insights`.
 *
 * Date range is optional — nev-api defaults to the last 7 days when omitted.
 * Use `nevent_list_paid_campaigns` to discover valid `campaignId` values.
 */
export const GetPaidCampaignInsightsSchema = {
  provider: AdsProviderEnum,
  campaignId: z
    .string()
    .min(1)
    .describe(
      'Paid campaign ID from the provider (not a Nevent ObjectId). ' +
      'Use nevent_list_paid_campaigns to get valid campaignId values.'
    ),
  from: InsightsDateString.optional().describe(
    'Start date for insights window (yyyy-MM-dd). Defaults to 7 days ago when omitted.'
  ),
  to: InsightsDateString.optional().describe(
    'End date for insights window (yyyy-MM-dd). Defaults to today when omitted.'
  ),
};

/**
 * Input schema for `nevent_paid_attribution`.
 * Lists all campaigns with UTM-matched ticket sales. No extra params needed.
 */
export const AdsAttributionSchema = {
  provider: AdsProviderEnum,
};

// ---------------------------------------------------------------------------
// Tier 2 schemas
// ---------------------------------------------------------------------------

/**
 * Input schema for `nevent_list_paid_ad_groups`.
 *
 * The `campaignId` filter is optional — when omitted, all ad groups
 * for the provider are returned.
 */
export const ListPaidAdGroupsSchema = {
  provider: AdsProviderEnum,
  campaignId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Optional: filter ad groups by parent campaign ID. ' +
      'Use nevent_list_paid_campaigns to get valid campaignId values.'
    ),
};

/**
 * Input schema for `nevent_get_paid_ad_group_insights`.
 *
 * Date range is optional — nev-api defaults to the last 7 days when omitted.
 * Use `nevent_list_paid_ad_groups` to discover valid `adGroupId` values.
 */
export const GetPaidAdGroupInsightsSchema = {
  provider: AdsProviderEnum,
  adGroupId: z
    .string()
    .min(1)
    .describe(
      'Ad group (ad set) ID from the provider. ' +
      'Use nevent_list_paid_ad_groups to get valid adGroupId values.'
    ),
  from: InsightsDateString.optional().describe(
    'Start date for insights window (yyyy-MM-dd). Defaults to 7 days ago when omitted.'
  ),
  to: InsightsDateString.optional().describe(
    'End date for insights window (yyyy-MM-dd). Defaults to today when omitted.'
  ),
};

/**
 * Input schema for `nevent_get_paid_ad_group_comparative_stats`.
 *
 * Date range is optional. Use `nevent_list_paid_ad_groups` to discover `adGroupId`.
 */
export const GetPaidAdGroupComparativeStatsSchema = {
  provider: AdsProviderEnum,
  adGroupId: z
    .string()
    .min(1)
    .describe(
      'Ad group (ad set) ID from the provider. ' +
      'Use nevent_list_paid_ad_groups to get valid adGroupId values.'
    ),
  from: InsightsDateString.optional().describe(
    'Start date for the comparison window (yyyy-MM-dd). Defaults to 7 days ago when omitted.'
  ),
  to: InsightsDateString.optional().describe(
    'End date for the comparison window (yyyy-MM-dd). Defaults to today when omitted.'
  ),
};

/**
 * Input schema for `nevent_get_paid_ad_group_targeting`.
 * Use `nevent_list_paid_ad_groups` to discover `adGroupId`.
 */
export const GetPaidAdGroupTargetingSchema = {
  provider: AdsProviderEnum,
  adGroupId: z
    .string()
    .min(1)
    .describe(
      'Ad group (ad set) ID from the provider. ' +
      'Use nevent_list_paid_ad_groups to get valid adGroupId values.'
    ),
};

/**
 * Input schema for `nevent_list_paid_ads`.
 *
 * Both `campaignId` and `adGroupId` are optional filters. Pass at least one
 * to narrow results. Without filters, all ads for the provider are returned.
 */
export const ListPaidAdsSchema = {
  provider: AdsProviderEnum,
  campaignId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Optional: filter ads by parent campaign ID. ' +
      'Use nevent_list_paid_campaigns to get valid campaignId values.'
    ),
  adGroupId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Optional: filter ads by parent ad group ID. ' +
      'Use nevent_list_paid_ad_groups to get valid adGroupId values.'
    ),
};

/**
 * Input schema for `nevent_get_paid_ad_creative`.
 * Use `nevent_list_paid_ads` to discover `adId`.
 */
export const GetPaidAdCreativeSchema = {
  provider: AdsProviderEnum,
  adId: z
    .string()
    .min(1)
    .describe(
      'Ad ID from the provider. ' +
      'Use nevent_list_paid_ads to get valid adId values.'
    ),
};
