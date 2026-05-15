/**
 * Paid Media MCP tools — 11 tools exposing nev-api `/api/ads/{provider}/...` endpoints.
 *
 * All 11 tools are READ operations and are registered when `NEVENT_API_URL` is available.
 * They require roles ADMIN | SUPERADMIN | OWNER and capability MODULE_ATTRIBUTION.
 * Tenant is resolved from the JWT token — no tenant parameter is accepted.
 *
 * ## Feature Gate (404 handling)
 *
 * Several endpoints return HTTP 404 when the tenant is NOT enrolled in the
 * provider's insights pilot (not 403 — this is an intentional API design choice).
 * These tools detect that 404 and remap it to a friendly, actionable message
 * instead of surfacing "resource not found".
 *
 * Affected tools: health, campaign insights, ad group insights,
 * ad group comparative stats, ad group targeting, ad creative.
 *
 * ## Tier 1 tools (nevent_paid_ads_status → nevent_paid_attribution)
 *
 *  1. nevent_paid_ads_status
 *  2. nevent_paid_ads_health
 *  3. nevent_list_paid_campaigns
 *  4. nevent_get_paid_campaign_insights
 *  5. nevent_paid_attribution
 *
 * ## Tier 2 tools (nevent_list_paid_ad_groups → nevent_get_paid_ad_creative)
 *
 *  6. nevent_list_paid_ad_groups
 *  7. nevent_get_paid_ad_group_insights
 *  8. nevent_get_paid_ad_group_comparative_stats
 *  9. nevent_get_paid_ad_group_targeting
 * 10. nevent_list_paid_ads
 * 11. nevent_get_paid_ad_creative
 *
 * @module tools/paid-media
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { NeventApiError } from '../clients/base-client.js';
import { ok, err, toErrorEnvelope, checkMode } from './helpers.js';
import type { PaidMediaClient } from '../clients/paid-media-client.js';
import type { AdsProvider } from '../types/paid-media.js';
import {
  AdsStatusSchema,
  AdsHealthSchema,
  ListPaidCampaignsSchema,
  GetPaidCampaignInsightsSchema,
  AdsAttributionSchema,
  ListPaidAdGroupsSchema,
  GetPaidAdGroupInsightsSchema,
  GetPaidAdGroupComparativeStatsSchema,
  GetPaidAdGroupTargetingSchema,
  ListPaidAdsSchema,
  GetPaidAdCreativeSchema,
} from '../schemas/paid-media.js';

// ---------------------------------------------------------------------------
// Shared annotations
// ---------------------------------------------------------------------------

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: true,
} as const;

// ---------------------------------------------------------------------------
// Feature gate message builder
// ---------------------------------------------------------------------------

/**
 * Returns a user-facing message when a 404 indicates that the tenant
 * is not enrolled in the provider's insights pilot (feature gate).
 *
 * This is distinct from "resource not found" — the endpoint deliberately
 * returns 404 (not 403) when the tenant is not in the pilot allowlist.
 *
 * @param provider  — The ads provider (meta | google | tiktok).
 * @param feature   — Human-readable name of the feature that is gated.
 */
function featureGateMessage(provider: AdsProvider, feature: string): string {
  return (
    `This tenant is not enrolled in the ${provider} ${feature} pilot. ` +
    `Contact admin to enable the feature gate (MODULE_ATTRIBUTION must be active ` +
    `and the tenant must be added to the provider allowlist).`
  );
}

/**
 * Detect whether a caught error is a 404 that indicates a feature gate block
 * (as opposed to a genuinely missing resource like a wrong campaignId).
 *
 * We treat ALL 404s from feature-gated endpoints as potential feature gate
 * issues, because nev-api returns 404 (not 403) for pilot allowlist checks.
 *
 * @param error — The caught unknown value.
 */
function isFeatureGate404(error: unknown): boolean {
  return (
    error instanceof NeventApiError &&
    error.neventError.code === 'not_found'
  );
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

/**
 * Register all 11 paid media MCP tools on the MCP server.
 *
 * Call this once during server initialisation after the `PaidMediaClient` is
 * created. The function is a no-op if called without a valid `paidMediaClient`.
 *
 * @param server          — The `McpServer` instance to register tools on.
 * @param paidMediaClient — Pre-configured `PaidMediaClient` for nev-api.
 */
export function registerPaidMediaTools(
  server: McpServer,
  paidMediaClient: PaidMediaClient
): void {

  // =========================================================================
  // TIER 1 TOOLS
  // =========================================================================

  // -------------------------------------------------------------------------
  // Tool 1: nevent_paid_ads_status
  // -------------------------------------------------------------------------
  server.tool(
    'nevent_paid_ads_status',
    'Check if a paid ads provider account (meta, google, or tiktok) is connected to this tenant and when data was last synced. ' +
    'Call this first before any ads queries to confirm the integration is active. ' +
    'Returns: connected (bool), accountId, accountName, lastSyncAt.',
    AdsStatusSchema,
    READ_ONLY_ANNOTATIONS,
    async (params) => {
      const denied = checkMode('nevent_paid_ads_status');
      if (denied) return err(denied);

      try {
        const result = await paidMediaClient.getStatus(params.provider as AdsProvider);
        return ok(result);
      } catch (caught) {
        return err(toErrorEnvelope(caught));
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool 2: nevent_paid_ads_health
  // -------------------------------------------------------------------------
  server.tool(
    'nevent_paid_ads_health',
    'Get operational health signals for a paid ads provider. ' +
    'Always call this before claiming "no data" to the user — it surfaces throttle state, feature gate enrollment, stale syncs, and tier. ' +
    'Key fields: throttle.isThrottled (API throttled), throttle.nextAttemptAt (next retry), ' +
    'featureGate.isInTenantAllowlist (pilot access), lastSuccessfulSyncAt, lastSuccessfulInsightsAt, backfillEnabled. ' +
    'A 404 here means this tenant is not enrolled in the insights pilot for this provider.',
    AdsHealthSchema,
    READ_ONLY_ANNOTATIONS,
    async (params) => {
      const denied = checkMode('nevent_paid_ads_health');
      if (denied) return err(denied);

      const provider = params.provider as AdsProvider;

      try {
        const result = await paidMediaClient.getHealth(provider);
        return ok(result);
      } catch (caught) {
        if (isFeatureGate404(caught)) {
          return err({
            error: {
              type: 'not_found',
              message: featureGateMessage(provider, 'health / insights'),
              code: 'feature_gate_not_enrolled',
            },
          });
        }
        return err(toErrorEnvelope(caught));
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool 3: nevent_list_paid_campaigns
  // -------------------------------------------------------------------------
  server.tool(
    'nevent_list_paid_campaigns',
    'List all paid campaigns synced from a provider (meta, google, or tiktok) for this tenant. ' +
    'Returns campaign IDs, names, statuses, objectives, and budgets. ' +
    'Use the returned campaign IDs with nevent_get_paid_campaign_insights and nevent_list_paid_ad_groups.',
    ListPaidCampaignsSchema,
    READ_ONLY_ANNOTATIONS,
    async (params) => {
      const denied = checkMode('nevent_list_paid_campaigns');
      if (denied) return err(denied);

      try {
        const campaigns = await paidMediaClient.listCampaigns(params.provider as AdsProvider);
        return ok({ campaigns, count: campaigns.length });
      } catch (caught) {
        return err(toErrorEnvelope(caught));
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool 4: nevent_get_paid_campaign_insights
  // -------------------------------------------------------------------------
  server.tool(
    'nevent_get_paid_campaign_insights',
    'Get daily performance metrics for a specific paid campaign. ' +
    'Use after nevent_list_paid_campaigns to get a valid campaignId. ' +
    'Date range defaults to the last 7 days when from/to are omitted. ' +
    'Returns daily rows with: spend, impressions, reach, frequency, clicks, CTR, CPM, CPC, ROAS, engagement rate, video metrics. ' +
    'A 404 may mean this tenant is not enrolled in the insights pilot — call nevent_paid_ads_health to confirm.',
    GetPaidCampaignInsightsSchema,
    READ_ONLY_ANNOTATIONS,
    async (params) => {
      const denied = checkMode('nevent_get_paid_campaign_insights');
      if (denied) return err(denied);

      const provider = params.provider as AdsProvider;

      try {
        const rows = await paidMediaClient.getCampaignInsights(
          provider,
          params.campaignId,
          params.from,
          params.to
        );
        return ok({ rows, count: rows.length });
      } catch (caught) {
        if (isFeatureGate404(caught)) {
          return err({
            error: {
              type: 'not_found',
              message: featureGateMessage(provider, 'campaign insights'),
              code: 'feature_gate_not_enrolled',
            },
          });
        }
        return err(toErrorEnvelope(caught));
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool 5: nevent_paid_attribution
  // -------------------------------------------------------------------------
  server.tool(
    'nevent_paid_attribution',
    'Get the most business-focused view of paid ads: links campaigns to actual ticket sales and revenue via UTM matching. ' +
    'Returns per-campaign: ticketsSold, revenue, budget, utmCampaigns (matched UTM values), status. ' +
    'Use this when the user asks about ROI, conversion, or revenue from paid ads. ' +
    'Use after nevent_list_paid_campaigns to cross-reference campaign IDs.',
    AdsAttributionSchema,
    READ_ONLY_ANNOTATIONS,
    async (params) => {
      const denied = checkMode('nevent_paid_attribution');
      if (denied) return err(denied);

      try {
        const summaries = await paidMediaClient.getAttribution(params.provider as AdsProvider);
        return ok({ attribution: summaries, count: summaries.length });
      } catch (caught) {
        return err(toErrorEnvelope(caught));
      }
    }
  );

  // =========================================================================
  // TIER 2 TOOLS
  // =========================================================================

  // -------------------------------------------------------------------------
  // Tool 6: nevent_list_paid_ad_groups
  // -------------------------------------------------------------------------
  server.tool(
    'nevent_list_paid_ad_groups',
    'List ad groups (ad sets) for a paid ads provider, optionally filtered by campaign. ' +
    'Use after nevent_list_paid_campaigns to drill down into a campaign\'s ad sets. ' +
    'Returns ad group IDs, names, statuses, and lastSyncedAt. ' +
    'Use the returned adGroupId values with the ad group insights, targeting, and comparative stats tools.',
    ListPaidAdGroupsSchema,
    READ_ONLY_ANNOTATIONS,
    async (params) => {
      const denied = checkMode('nevent_list_paid_ad_groups');
      if (denied) return err(denied);

      try {
        const adGroups = await paidMediaClient.listAdGroups(
          params.provider as AdsProvider,
          params.campaignId
        );
        return ok({ adGroups, count: adGroups.length });
      } catch (caught) {
        return err(toErrorEnvelope(caught));
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool 7: nevent_get_paid_ad_group_insights
  // -------------------------------------------------------------------------
  server.tool(
    'nevent_get_paid_ad_group_insights',
    'Get daily performance metrics for a specific ad group (ad set). ' +
    'Use after nevent_list_paid_ad_groups to get a valid adGroupId. ' +
    'Date range defaults to the last 7 days when from/to are omitted. ' +
    'Returns daily rows with: spend, impressions, reach, frequency, clicks, CTR, CPM, CPC, ROAS, engagement rate, video metrics. ' +
    'A 404 may mean this tenant is not enrolled in the insights pilot — call nevent_paid_ads_health to confirm.',
    GetPaidAdGroupInsightsSchema,
    READ_ONLY_ANNOTATIONS,
    async (params) => {
      const denied = checkMode('nevent_get_paid_ad_group_insights');
      if (denied) return err(denied);

      const provider = params.provider as AdsProvider;

      try {
        const rows = await paidMediaClient.getAdGroupInsights(
          provider,
          params.adGroupId,
          params.from,
          params.to
        );
        return ok({ rows, count: rows.length });
      } catch (caught) {
        if (isFeatureGate404(caught)) {
          return err({
            error: {
              type: 'not_found',
              message: featureGateMessage(provider, 'ad group insights'),
              code: 'feature_gate_not_enrolled',
            },
          });
        }
        return err(toErrorEnvelope(caught));
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool 8: nevent_get_paid_ad_group_comparative_stats
  // -------------------------------------------------------------------------
  server.tool(
    'nevent_get_paid_ad_group_comparative_stats',
    'Compare an ad group\'s performance metrics against the mean of its campaign sibling ad groups. ' +
    'Use to detect underperforming ad sets — each metric (costPerResult, CPM, frequency, CTR) is returned ' +
    'with its campaign sibling mean and ratioVsMean (1.0 = on par, 1.3 = 30% worse, 0.7 = 30% better). ' +
    'Use after nevent_list_paid_ad_groups to get a valid adGroupId. ' +
    'A 404 may mean this tenant is not enrolled in the insights pilot — call nevent_paid_ads_health to confirm.',
    GetPaidAdGroupComparativeStatsSchema,
    READ_ONLY_ANNOTATIONS,
    async (params) => {
      const denied = checkMode('nevent_get_paid_ad_group_comparative_stats');
      if (denied) return err(denied);

      const provider = params.provider as AdsProvider;

      try {
        const stats = await paidMediaClient.getAdGroupComparativeStats(
          provider,
          params.adGroupId,
          params.from,
          params.to
        );
        return ok(stats);
      } catch (caught) {
        if (isFeatureGate404(caught)) {
          return err({
            error: {
              type: 'not_found',
              message: featureGateMessage(provider, 'comparative stats'),
              code: 'feature_gate_not_enrolled',
            },
          });
        }
        return err(toErrorEnvelope(caught));
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool 9: nevent_get_paid_ad_group_targeting
  // -------------------------------------------------------------------------
  server.tool(
    'nevent_get_paid_ad_group_targeting',
    'Get the full audience targeting configuration for an ad group. ' +
    'Use after nevent_list_paid_ad_groups to get a valid adGroupId. ' +
    'Returns: ageRange, genders, geoSummary (countries/cities/regions), topInterests, topBehaviors, placements, ' +
    'Advantage+ flags (automaticPlacements, expandAge, expandGender), custom and excluded audiences, bidStrategy, promotedObject. ' +
    'A 404 may mean this tenant is not enrolled in the insights pilot — call nevent_paid_ads_health to confirm.',
    GetPaidAdGroupTargetingSchema,
    READ_ONLY_ANNOTATIONS,
    async (params) => {
      const denied = checkMode('nevent_get_paid_ad_group_targeting');
      if (denied) return err(denied);

      const provider = params.provider as AdsProvider;

      try {
        const targeting = await paidMediaClient.getAdGroupTargeting(provider, params.adGroupId);
        return ok(targeting);
      } catch (caught) {
        if (isFeatureGate404(caught)) {
          return err({
            error: {
              type: 'not_found',
              message: featureGateMessage(provider, 'targeting'),
              code: 'feature_gate_not_enrolled',
            },
          });
        }
        return err(toErrorEnvelope(caught));
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool 10: nevent_list_paid_ads
  // -------------------------------------------------------------------------
  server.tool(
    'nevent_list_paid_ads',
    'List individual ads for a paid ads provider, optionally filtered by campaign and/or ad group. ' +
    'Use after nevent_list_paid_campaigns or nevent_list_paid_ad_groups to drill down to ad level. ' +
    'Returns ad IDs, names, statuses, UTM fields (utmSource, utmMedium, utmCampaign, utmContainsMacros), and lastSyncedAt. ' +
    'Use the returned adId values with nevent_get_paid_ad_creative.',
    ListPaidAdsSchema,
    READ_ONLY_ANNOTATIONS,
    async (params) => {
      const denied = checkMode('nevent_list_paid_ads');
      if (denied) return err(denied);

      try {
        const ads = await paidMediaClient.listAds(
          params.provider as AdsProvider,
          params.campaignId,
          params.adGroupId
        );
        return ok({ ads, count: ads.length });
      } catch (caught) {
        return err(toErrorEnvelope(caught));
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool 11: nevent_get_paid_ad_creative
  // -------------------------------------------------------------------------
  server.tool(
    'nevent_get_paid_ad_creative',
    'Get the creative content of a specific ad: copy (body, title, description, CTA), click URL, UTM params, ' +
    'and pre-signed S3 image/video URLs (TTL ~1 hour). ' +
    'Use after nevent_list_paid_ads to get a valid adId. ' +
    'Null imageUrl/videoUrl means the asset mirror job has not run yet — retry in ~5 minutes. ' +
    'For Dynamic Creative Ads (hasDca: true), the dca field contains multiple creative variants. ' +
    'A 404 may mean this tenant is not enrolled in the insights pilot — call nevent_paid_ads_health to confirm.',
    GetPaidAdCreativeSchema,
    READ_ONLY_ANNOTATIONS,
    async (params) => {
      const denied = checkMode('nevent_get_paid_ad_creative');
      if (denied) return err(denied);

      const provider = params.provider as AdsProvider;

      try {
        const creative = await paidMediaClient.getAdCreative(provider, params.adId);
        return ok(creative);
      } catch (caught) {
        if (isFeatureGate404(caught)) {
          return err({
            error: {
              type: 'not_found',
              message: featureGateMessage(provider, 'ad creative'),
              code: 'feature_gate_not_enrolled',
            },
          });
        }
        return err(toErrorEnvelope(caught));
      }
    }
  );
}
