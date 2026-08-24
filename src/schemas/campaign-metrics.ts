/**
 * Zod validation schemas for the campaign performance tools (MCP 1.8.0).
 *
 * Covers two read tools backed by nev-api (not the analytics warehouse):
 *  1. nevent_get_campaign_metrics     — GET /campaigns/{id}/metrics
 *  2. nevent_list_campaign_recipients — GET /campaigns/{id}/recipients
 *
 * Design principles:
 * - Parameters are snake_case for the agent; the handler maps them to the
 *   backend's names (`page_size` → `size`, `segment_id` → `segmentId`).
 * - `status` mirrors the recipient states nev-api filters on exactly.
 * - Pagination is capped at 100 rows per page: recipient rows carry PII and a
 *   larger page would flood the model's context for no analytical gain.
 *
 * @module schemas/campaign-metrics
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/**
 * Campaign identifier. Not constrained to a 24-hex ObjectId: campaign ids are
 * echoed back by other tools (`nevent_list_campaigns`, `nevent_create_campaign`)
 * and are passed straight through to nev-api, which owns the validation.
 */
const campaignId = z
  .string()
  .min(1)
  .describe(
    'Campaign ID. Get it from nevent_list_campaigns, or from the response of nevent_create_campaign.'
  );

/**
 * Recipient delivery states nev-api can filter on for a campaign.
 * Note the plural on BOUNCES/UNSUBSCRIBES — that is the backend's own naming.
 */
export const CAMPAIGN_RECIPIENT_STATUS_VALUES = [
  'SCHEDULED',
  'DELIVERED',
  'OPENED',
  'CLICKED',
  'BOUNCES',
  'UNSUBSCRIBES',
] as const;

// ---------------------------------------------------------------------------
// Tool 1: nevent_get_campaign_metrics
// ---------------------------------------------------------------------------

/**
 * Input schema for `nevent_get_campaign_metrics`.
 *
 * Returns the operational delivery and engagement counters nev-api holds for a
 * campaign — sent, delivered, bounces, opens, clicks, unsubscribes, the derived
 * rates, and the conversion counters (carts, purchases, revenue).
 */
export const GetCampaignMetricsSchema = {
  campaign_id: campaignId,
};

// ---------------------------------------------------------------------------
// Tool 2: nevent_list_campaign_recipients
// ---------------------------------------------------------------------------

/**
 * Input schema for `nevent_list_campaign_recipients`.
 *
 * Paginated per-recipient drill-down for a campaign: who was targeted and what
 * happened to their message.
 */
export const ListCampaignRecipientsSchema = {
  campaign_id: campaignId,

  status: z
    .enum(CAMPAIGN_RECIPIENT_STATUS_VALUES)
    .optional()
    .describe(
      'Filter recipients by delivery state. SCHEDULED = queued but not sent; ' +
      'DELIVERED = accepted by the receiving server; OPENED / CLICKED = engaged; ' +
      'BOUNCES = delivery failed; UNSUBSCRIBES = opted out from this send. ' +
      'Omit to return every recipient.'
    ),

  search: z
    .string()
    .optional()
    .describe('Free-text search across recipient name and email address.'),

  segment_id: z
    .string()
    .optional()
    .describe(
      'Restrict the listing to recipients that came from one segment. ' +
      'Useful on multi-segment campaigns to compare which segment engaged. ' +
      'Get segment IDs from nevent_list_segments.'
    ),

  page: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Zero-based page number. Default: 0 (first page).'),

  page_size: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe(
      'Recipients per page (1-100). Default: 25. ' +
      'Keep this small — recipient rows contain personal data and large pages waste context.'
    ),
};
