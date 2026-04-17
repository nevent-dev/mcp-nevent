/**
 * Zod validation schemas for Sprint 2 campaign tools.
 *
 * Each schema corresponds to the input parameters of one MCP tool:
 *  - ListCampaignsSchema       — nevent_list_campaigns
 *  - GetCampaignSchema         — nevent_get_campaign
 *  - GetCampaignInsightsSchema — nevent_get_campaign_insights
 *
 * Design principles (same as analytics.ts):
 * - Required fields throw clear errors (no optional ambiguity on critical params)
 * - Optional fields use `.optional()` rather than `.nullable()` for clean JSON
 * - Numeric limits enforce sensible upper bounds
 * - Enum schemas document all valid string values explicitly
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared enums
// ---------------------------------------------------------------------------

/**
 * Valid campaign status values in the Nevent platform.
 * Maps directly to the `status` field in the `campaign` MongoDB collection.
 */
export const CampaignStatusEnum = z.enum([
  'EXECUTED',
  'DRAFT',
  'PAUSED',
  'STOPPED',
  'SCHEDULED',
]);

/**
 * Valid campaign channel values.
 * Maps directly to the `channel` field in the `campaign` MongoDB collection.
 */
export const CampaignChannelEnum = z.enum(['EMAIL', 'SMS', 'WHATSAPP']);

// ---------------------------------------------------------------------------
// Tool schemas
// ---------------------------------------------------------------------------

/**
 * Input schema for `nevent_list_campaigns`.
 *
 * All parameters are optional — calling with no params returns the 50 most
 * recently created campaigns for the active tenant.
 */
export const ListCampaignsSchema = {
  status: CampaignStatusEnum.optional().describe(
    'Filter by campaign status: EXECUTED | DRAFT | PAUSED | STOPPED | SCHEDULED'
  ),
  channel: CampaignChannelEnum.optional().describe(
    'Filter by channel: EMAIL | SMS | WHATSAPP'
  ),
  /**
   * ISO 8601 datetime string — campaigns created on or after this timestamp.
   * Validated as a proper datetime with optional timezone offset.
   */
  date_from: z
    .string()
    .datetime({ offset: true })
    .optional()
    .describe(
      'Filter campaigns created on or after this date (ISO 8601, e.g. "2024-01-01T00:00:00Z")'
    ),
  /**
   * ISO 8601 datetime string — campaigns created on or before this timestamp.
   * Validated as a proper datetime with optional timezone offset.
   */
  date_to: z
    .string()
    .datetime({ offset: true })
    .optional()
    .describe(
      'Filter campaigns created on or before this date (ISO 8601, e.g. "2024-12-31T23:59:59Z")'
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .default(50)
    .optional()
    .describe('Maximum number of campaigns to return (default 50, max 200)'),
  sort: z
    .enum(['createdAt', 'executedAt', 'name'])
    .default('createdAt')
    .optional()
    .describe('Field to sort by: createdAt (default) | executedAt | name'),
  sort_order: z
    .enum(['asc', 'desc'])
    .default('desc')
    .optional()
    .describe('Sort direction: asc | desc (default desc)'),
};

/**
 * Input schema for `nevent_get_campaign`.
 *
 * Retrieves the complete detail record for a single campaign.
 */
export const GetCampaignSchema = {
  campaign_id: z
    .string()
    .describe(
      'The campaign Identifier. ' +
        'Use nevent_list_campaigns to discover valid campaign IDs.'
    ),
};

/**
 * Input schema for `nevent_get_campaign_insights`.
 *
 * Retrieves AI-generated insights and detected anomalies for a campaign
 * from the `campaign_insights` and `campaign_anomalies` collections.
 */
export const GetCampaignInsightsSchema = {
  campaign_id: z
    .string()
    .describe(
      'The campaign Identifier. ' +
        'Use nevent_list_campaigns to discover valid campaign IDs.'
    ),
};
