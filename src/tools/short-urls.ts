/**
 * Short URL MCP tools — 9 tools exposing nev-api `/admin/short-url/...` endpoints.
 *
 * Tier 1 — Read essentials (4 READ tools):
 *  1. nevent_list_short_urls          — paginated list with optional filters
 *  2. nevent_get_short_url            — full detail of a single short URL
 *  3. nevent_get_short_url_metrics    — aggregated click analytics
 *  4. nevent_get_short_url_campaign_metrics — campaign-wide CTR and breakdown
 *
 * Tier 2 — Read drill-down (2 READ tools):
 *  5. nevent_get_short_url_clicks     — individual click event records
 *  6. nevent_list_short_url_user_links — per-user links under a parent
 *
 * Tier 3 — Write (3 WRITE tools):
 *  7. nevent_create_short_url         — create a new short URL
 *  8. nevent_update_short_url         — update configuration
 *  9. nevent_create_bulk_user_short_urls — bulk per-user link generation
 *
 * All tools require roles ADMIN | OWNER | SUPERADMIN.
 * Tenant is resolved from the JWT — no tenant_id parameter is accepted.
 * WRITE tools are gated behind STANDARD or FULL operation mode via checkMode().
 *
 * @module tools/short-urls
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ok, err, toErrorEnvelope, checkMode } from './helpers.js';
import type { ShortUrlClient } from '../clients/short-url-client.js';
import {
  ListShortUrlsSchema,
  GetShortUrlSchema,
  GetShortUrlMetricsSchema,
  GetShortUrlCampaignMetricsSchema,
  GetShortUrlClicksSchema,
  ListShortUrlUserLinksSchema,
  CreateShortUrlSchema,
  UpdateShortUrlSchema,
  CreateBulkUserShortUrlsSchema,
} from '../schemas/short-urls.js';
import type {
  CreateShortUrlRequest,
  UpdateShortUrlRequest,
  CreateBulkUserShortUrlRequest,
} from '../types/short-urls.js';

// ---------------------------------------------------------------------------
// Shared annotations
// ---------------------------------------------------------------------------

// Base annotation objects — spread these and add `title` per tool registration.
const READ_ONLY_ANNOTATIONS_BASE = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

const WRITE_ANNOTATIONS_BASE = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: true,
} as const;

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

/**
 * Register all 9 short URL MCP tools on the MCP server.
 *
 * Call this once during server initialisation after the `ShortUrlClient` is
 * created. The function is a no-op if called without a valid `shortUrlClient`.
 *
 * @param server         — The `McpServer` instance to register tools on.
 * @param shortUrlClient — Pre-configured `ShortUrlClient` for nev-api.
 */
export function registerShortUrlTools(
  server: McpServer,
  shortUrlClient: ShortUrlClient
): void {

  // =========================================================================
  // TIER 1 TOOLS — Read essentials
  // =========================================================================

  // -------------------------------------------------------------------------
  // Tool 1: nevent_list_short_urls
  // -------------------------------------------------------------------------
  server.tool(
    'nevent_list_short_urls',
    'List all short URLs for the current tenant with their tracking metrics (click count, last clicked). ' +
    'Use to discover existing campaign links or to audit active tracking URLs. ' +
    'Returns items (array of ShortUrlDTO), total, page, pageSize, totalPages. ' +
    'Key fields per item: id (use with nevent_get_short_url_metrics or nevent_get_short_url_clicks), ' +
    'shortCode (use with nevent_get_short_url_campaign_metrics or nevent_list_short_url_user_links), ' +
    'shortUrl, longUrl, title, tags, clickCount, isActive, isParent. ' +
    'Filter by isActive=true for active links only. Use search to filter by title or URL.',
    ListShortUrlsSchema,
    { title: 'List short URLs', ...READ_ONLY_ANNOTATIONS_BASE },
    async (params) => {
      const denied = checkMode('nevent_list_short_urls');
      if (denied) return err(denied);

      try {
        const result = await shortUrlClient.listShortUrls({
          isActive: params.isActive,
          search: params.search,
          page: params.page,
          pageSize: params.pageSize,
        });
        return ok(result);
      } catch (caught) {
        return err(toErrorEnvelope(caught));
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool 2: nevent_get_short_url
  // -------------------------------------------------------------------------
  server.tool(
    'nevent_get_short_url',
    'Get complete details of a specific short URL including target URL, metadata, creation date, ' +
    'expiration, tags, and current click count. ' +
    'Use after nevent_list_short_urls to get the `id`. ' +
    'Key fields returned: id, shortCode, shortUrl, longUrl, title, tags, metadata, ' +
    'clickCount, lastClickedAt, isActive, isExpired, isParent, parentShortCode, userId, userLinksCount. ' +
    'Use the returned id with nevent_get_short_url_metrics for time-series analytics.',
    GetShortUrlSchema,
    { title: 'Get short URL details', ...READ_ONLY_ANNOTATIONS_BASE },
    async (params) => {
      const denied = checkMode('nevent_get_short_url');
      if (denied) return err(denied);

      try {
        const result = await shortUrlClient.getShortUrl(params.id);
        return ok(result);
      } catch (caught) {
        return err(toErrorEnvelope(caught));
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool 3: nevent_get_short_url_metrics
  // -------------------------------------------------------------------------
  server.tool(
    'nevent_get_short_url_metrics',
    'Get aggregated click analytics for a specific short URL over a time window (default 30 days). ' +
    'Use after nevent_list_short_urls to get the `id`. ' +
    'Returns: totalClicks, uniqueVisitors, firstClickAt, lastClickAt, ' +
    'clicksByDay (date → count), clicksByCountry, clicksByDevice (mobile/desktop/tablet), ' +
    'clicksByBrowser, clicksByOs, topReferers. ' +
    'Use for performance analysis of individual tracking links. ' +
    'For campaign-wide aggregation across all user links, use nevent_get_short_url_campaign_metrics instead.',
    GetShortUrlMetricsSchema,
    { title: 'Get short URL metrics', ...READ_ONLY_ANNOTATIONS_BASE },
    async (params) => {
      const denied = checkMode('nevent_get_short_url_metrics');
      if (denied) return err(denied);

      try {
        const result = await shortUrlClient.getShortUrlMetrics(params.id, params.days);
        return ok(result);
      } catch (caught) {
        return err(toErrorEnvelope(caught));
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool 4: nevent_get_short_url_campaign_metrics
  // -------------------------------------------------------------------------
  server.tool(
    'nevent_get_short_url_campaign_metrics',
    'Get aggregated click metrics across a parent short URL and all its per-user variants. ' +
    'Use when a marketing campaign was sent with per-user tracking links (created via ' +
    'nevent_create_bulk_user_short_urls) to see total reach and CTR. ' +
    'Requires the `parentShortCode` from nevent_list_short_urls (where isParent=true). ' +
    'Returns: totalChildUrls, totalClicks, urlsWithClicks, avgClicksPerUrl, ' +
    'clickThroughRate (%), topUsersByClicks (userId, shortCode, clickCount, lastClickedAt), ' +
    'clicksByDay, clicksByDevice, clicksByBrowser, clicksByCountry. ' +
    'This tool aggregates across ALL child user links — use nevent_get_short_url_metrics(id) when you need per-link breakdown for a single URL.',
    GetShortUrlCampaignMetricsSchema,
    { title: 'Get short URL campaign metrics', ...READ_ONLY_ANNOTATIONS_BASE },
    async (params) => {
      const denied = checkMode('nevent_get_short_url_campaign_metrics');
      if (denied) return err(denied);

      try {
        const result = await shortUrlClient.getCampaignMetrics(
          params.parentShortCode,
          params.days,
          params.topN
        );
        return ok(result);
      } catch (caught) {
        return err(toErrorEnvelope(caught));
      }
    }
  );

  // =========================================================================
  // TIER 2 TOOLS — Read drill-down
  // =========================================================================

  // -------------------------------------------------------------------------
  // Tool 5: nevent_get_short_url_clicks
  // -------------------------------------------------------------------------
  server.tool(
    'nevent_get_short_url_clicks',
    'Get individual click event records for a specific short URL, ordered by most recent first. ' +
    'Use after nevent_list_short_urls to get the `id`. ' +
    'Each click record includes: clickedAt, ipAddress, userAgent, referer, ' +
    'country, city, device, browser, os, utmSource, utmCampaign, fbclid, gclid, isPaidTraffic. ' +
    'Use for detailed click attribution, fraud detection, or per-user behavior analysis. ' +
    'Default returns 100 most recent clicks; use limit to adjust.',
    GetShortUrlClicksSchema,
    { title: 'Get short URL click events', ...READ_ONLY_ANNOTATIONS_BASE },
    async (params) => {
      const denied = checkMode('nevent_get_short_url_clicks');
      if (denied) return err(denied);

      try {
        const clicks = await shortUrlClient.getClicks(params.id, params.limit);
        return ok({ clicks, count: clicks.length });
      } catch (caught) {
        return err(toErrorEnvelope(caught));
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool 6: nevent_list_short_url_user_links
  // -------------------------------------------------------------------------
  server.tool(
    'nevent_list_short_url_user_links',
    'List all per-user short URL variants created under a parent (campaign) short URL. ' +
    'Use after nevent_create_bulk_user_short_urls to inspect the generated links, or to audit ' +
    'which users have a tracking link for a campaign. ' +
    'Requires the `parentShortCode` from nevent_list_short_urls (where isParent=true). ' +
    'Returns an array of ShortUrlDTO — each with userId, shortCode, shortUrl, clickCount. ' +
    'Use the returned `id` values with nevent_get_short_url_metrics for per-user analytics.',
    ListShortUrlUserLinksSchema,
    { title: 'List short URL user links', ...READ_ONLY_ANNOTATIONS_BASE },
    async (params) => {
      const denied = checkMode('nevent_list_short_url_user_links');
      if (denied) return err(denied);

      try {
        const links = await shortUrlClient.listUserLinks(params.parentShortCode);
        return ok({ links, count: links.length });
      } catch (caught) {
        return err(toErrorEnvelope(caught));
      }
    }
  );

  // =========================================================================
  // TIER 3 TOOLS — Write operations
  // =========================================================================

  // -------------------------------------------------------------------------
  // Tool 7: nevent_create_short_url
  // -------------------------------------------------------------------------
  server.tool(
    'nevent_create_short_url',
    'Create a new short URL that redirects to the specified destination. ' +
    'Persists immediately — the short code is active as soon as the call returns. ' +
    'Requires at minimum a valid longUrl. All other fields are optional. ' +
    'Returns the created ShortUrlDTO with: id, shortCode, shortUrl (full redirect URL), ' +
    'longUrl, title, tags, isActive. ' +
    'Use the returned shortCode with nevent_create_bulk_user_short_urls to generate per-user variants. ' +
    'WRITE operation — requires STANDARD or FULL operation mode. ' +
    'In READ_ONLY mode this tool returns an operation_not_permitted error immediately without making any API call.',
    CreateShortUrlSchema,
    { title: 'Create short URL', ...WRITE_ANNOTATIONS_BASE },
    async (params) => {
      const denied = checkMode('nevent_create_short_url');
      if (denied) return err(denied);

      try {
        const request: CreateShortUrlRequest = {
          longUrl: params.longUrl,
          title: params.title,
          expiresAt: params.expiresAt !== undefined ? new Date(params.expiresAt).toISOString() : undefined,
          tags: params.tags,
          metadata: params.metadata as Record<string, unknown> | undefined,
          customShortCode: params.customShortCode,
        };
        const result = await shortUrlClient.createShortUrl(request);
        return ok(result);
      } catch (caught) {
        return err(toErrorEnvelope(caught));
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool 8: nevent_update_short_url
  // -------------------------------------------------------------------------
  server.tool(
    'nevent_update_short_url',
    'Update an existing short URL\'s configuration. Only provided fields are changed — ' +
    'omitted fields remain unchanged. Changes apply immediately. ' +
    'Use after nevent_list_short_urls to get the `id`. ' +
    'Supported updates: title, expiresAt (pass null to remove expiration), isActive (true/false), ' +
    'tags (replaces existing), metadata (replaces existing), longUrl (changes redirect destination). ' +
    'Returns the updated ShortUrlDTO. ' +
    'WRITE operation — requires STANDARD or FULL operation mode. ' +
    'In READ_ONLY mode this tool returns an operation_not_permitted error immediately without making any API call.',
    UpdateShortUrlSchema,
    { title: 'Update short URL', ...WRITE_ANNOTATIONS_BASE, destructiveHint: true },
    async (params) => {
      const denied = checkMode('nevent_update_short_url');
      if (denied) return err(denied);

      try {
        const request: UpdateShortUrlRequest = {};
        if (params.title !== undefined) request.title = params.title;
        if (params.expiresAt !== undefined) {
          request.expiresAt = params.expiresAt !== null
            ? new Date(params.expiresAt).toISOString()
            : null;
        }
        if (params.isActive !== undefined) request.isActive = params.isActive;
        if (params.tags !== undefined) request.tags = params.tags as string[];
        if (params.metadata !== undefined) request.metadata = params.metadata as Record<string, unknown>;
        if (params.longUrl !== undefined) request.longUrl = params.longUrl;

        const result = await shortUrlClient.updateShortUrl(params.id, request);
        return ok(result);
      } catch (caught) {
        return err(toErrorEnvelope(caught));
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool 9: nevent_create_bulk_user_short_urls
  // -------------------------------------------------------------------------
  server.tool(
    'nevent_create_bulk_user_short_urls',
    'Generate per-user short URL variants for an existing parent short URL. ' +
    'Each user receives their own unique short link that resolves to the same destination as the parent, ' +
    'but identifies the user on click — used for fan-level click attribution in email/SMS campaigns. ' +
    'The parent short URL must already exist (create it first with nevent_create_short_url). ' +
    'Requires: parentShortCode (from nevent_list_short_urls) and userIds (list of user IDs). ' +
    'Returns: parentShortCode, totalRequested, totalCreated, ' +
    'createdLinks (array of ShortUrlDTO with userId, shortCode, shortUrl per user). ' +
    'Use nevent_get_short_url_campaign_metrics afterwards to track aggregate CTR. ' +
    'WRITE operation — requires STANDARD or FULL operation mode. ' +
    'In READ_ONLY mode this tool returns an operation_not_permitted error immediately without making any API call. ' +
    'Note: parentShortCode is sent in both the URL path and request body — they must match (validated server-side).',
    CreateBulkUserShortUrlsSchema,
    { title: 'Create bulk user short URLs', ...WRITE_ANNOTATIONS_BASE },
    async (params) => {
      const denied = checkMode('nevent_create_bulk_user_short_urls');
      if (denied) return err(denied);

      try {
        const request: CreateBulkUserShortUrlRequest = {
          parentShortCode: params.parentShortCode,
          userIds: params.userIds as string[],
        };
        const result = await shortUrlClient.createBulkUserShortUrls(
          params.parentShortCode,
          request
        );
        return ok(result);
      } catch (caught) {
        return err(toErrorEnvelope(caught));
      }
    }
  );
}
