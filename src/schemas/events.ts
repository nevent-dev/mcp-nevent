/**
 * Zod validation schemas for the event tools.
 *
 *  1. nevent_list_events             — nev-api  GET /events
 *  2. nevent_event_sales_provenance  — nev-data-api GET /events/{id}/overview and
 *                                       GET /events/{id}/sales-provenance/{summary|daily|campaigns}
 *
 * Design principles:
 * - Parameters are snake_case for the agent; handlers map them to the backend names.
 * - Tenant scope is never a parameter: both backends derive it from the JWT.
 * - `nevent_list_events` always paginates. nev-api answers a call with none of
 *   page/size/sort/order/search in a legacy format that returns EVERY event with its
 *   full ticket and zone tree, which would flood the model's context.
 *
 * @module schemas/events
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/** Event identifiers are Mongo ObjectIds; nev-data-api rejects anything else. */
const eventId = z
  .string()
  .regex(/^[0-9a-f]{24}$/, 'Must be a 24-character lowercase hex event ID')
  .describe('Event ID (24-char hex). Get it from nevent_list_events.');

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD');

// ---------------------------------------------------------------------------
// Tool 1: nevent_list_events
// ---------------------------------------------------------------------------

/** Event natures nev-api filters on. */
export const EVENT_NATURE_VALUES = ['TICKETED', 'WAITLIST', 'REGISTRATION', 'UNKNOWN'] as const;

/** Default and maximum page size of `nevent_list_events`. */
export const LIST_EVENTS_DEFAULT_SIZE = 25;
export const LIST_EVENTS_MAX_SIZE = 100;

/**
 * Input schema for `nevent_list_events`.
 *
 * Lists the events of the active tenant, one page at a time.
 */
export const ListEventsSchema = {
  search: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe('Free-text search on the event name.'),

  future: z
    .boolean()
    .optional()
    .describe(
      'true (default) lists upcoming events; false lists past events. ' +
      'Use false to look up the event of a past campaign or sales period.'
    ),

  nature: z
    .enum(EVENT_NATURE_VALUES)
    .optional()
    .describe(
      'Filter by event nature: TICKETED (ticket sales), WAITLIST, REGISTRATION (free sign-up) or UNKNOWN. ' +
      'Sales provenance only makes sense for TICKETED events.'
    ),

  active_only: z
    .boolean()
    .optional()
    .describe('true returns only active events.'),

  sort: z
    .string()
    .regex(/^[A-Za-z0-9_.]{1,64}$/, 'Must be a field name such as venue.startDate or name')
    .optional()
    .describe('Field to sort by. Default venue.startDate.'),

  order: z
    .enum(['asc', 'desc'])
    .optional()
    .describe('Sort direction. Default asc.'),

  page: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Zero-based page number. Default 0.'),

  page_size: z
    .number()
    .int()
    .min(1)
    .max(LIST_EVENTS_MAX_SIZE)
    .optional()
    .describe(`Events per page (1-${LIST_EVENTS_MAX_SIZE}). Default ${LIST_EVENTS_DEFAULT_SIZE}.`),
};

// ---------------------------------------------------------------------------
// Tool 2: nevent_event_sales_provenance
// ---------------------------------------------------------------------------

/** Views of `nevent_event_sales_provenance`, one per nev-data-api endpoint. */
export const SALES_PROVENANCE_VIEWS = ['overview', 'summary', 'daily', 'campaigns'] as const;
export type SalesProvenanceView = (typeof SALES_PROVENANCE_VIEWS)[number];

/** Populations of purchases (nev-data-api contract). */
export const SALES_POPULATIONS = [
  'SETTLED_SALES',
  'REFUNDED_FULL',
  'REFUNDED_UNREPRESENTABLE',
  'ALL_REPORTED',
] as const;

/** Grouping dimensions of the `summary` view. */
export const SALES_DIMENSIONS = [
  'provider',
  'distribution',
  'purchaseChannel',
  'promoCode',
  'marketing',
] as const;

/** Dimensions accepted by the `daily` view (no marketing hierarchy). */
export const SALES_DAILY_DIMENSIONS = ['provider', 'distribution', 'purchaseChannel', 'promoCode'] as const;

/** Levels of the marketing (UTM) hierarchy. */
export const SALES_MARKETING_LEVELS = ['source', 'medium', 'campaign'] as const;

export const SALES_SUMMARY_MAX_TOP = 50;
export const SALES_DAILY_MAX_TOP = 10;

/**
 * Input schema for `nevent_event_sales_provenance`.
 *
 * One tool, four views. The view decides which optional parameters apply; the handler
 * rejects the ones that do not instead of silently ignoring them.
 */
export const EventSalesProvenanceSchema = {
  event_id: eventId,

  view: z
    .enum(SALES_PROVENANCE_VIEWS)
    .optional()
    .describe(
      'What to return. summary (default): sales grouped by provider / distribution / purchase channel / promo code / marketing (UTM). ' +
      'daily: dense day-by-day series stacked by one distribution dimension. ' +
      'campaigns: sales attributed to Nevent campaigns through tracking links. ' +
      'overview: totals, coverage and data freshness per block.'
    ),

  from: isoDay.describe('First purchase day, YYYY-MM-DD (local day of tz). Required by every view.'),
  to: isoDay.describe('Last purchase day, YYYY-MM-DD, inclusive. Max range 3660 days.'),

  tz: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe('IANA time zone that defines the purchase days. Default Europe/Madrid.'),

  currency: z
    .string()
    .regex(/^([A-Z]{3}|NONE)$/, 'Must be an ISO 4217 code such as EUR, or NONE')
    .optional()
    .describe(
      'ISO 4217 currency (EUR). NONE selects purchases without currency. Omit to get one block per currency: ' +
      'amounts of different currencies are never added together.'
    ),

  population: z
    .enum(SALES_POPULATIONS)
    .optional()
    .describe(
      'Which purchases to count. SETTLED_SALES (default): settled sales. REFUNDED_FULL: fully refunded. ' +
      'REFUNDED_UNREPRESENTABLE: other refunds (may be partial, refunded amount unknown). ' +
      'ALL_REPORTED: all of the above plus unrecognised states; its gross includes refunded purchases, so it is NOT collected revenue.'
    ),

  dimension: z
    .enum(SALES_DIMENSIONS)
    .optional()
    .describe(
      'Grouping dimension. summary: provider | distribution | purchaseChannel | promoCode | marketing (default marketing). ' +
      'daily: provider | distribution | purchaseChannel | promoCode (default distribution; marketing is not allowed). Not valid for overview/campaigns.'
    ),

  level: z
    .enum(SALES_MARKETING_LEVELS)
    .optional()
    .describe(
      'summary with dimension=marketing only: source (default), medium or campaign. ' +
      'medium and campaign need parent.'
    ),

  parent: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,4000}$/, 'Must be a group key returned by a previous summary call')
    .optional()
    .describe(
      'summary with dimension=marketing and level=medium|campaign: the key of the group one level up, ' +
      'copied verbatim from a previous summary response.'
    ),

  top: z
    .number()
    .int()
    .min(1)
    .max(SALES_SUMMARY_MAX_TOP)
    .optional()
    .describe(
      `Groups to list before collapsing the rest into «Otros». summary: 1-${SALES_SUMMARY_MAX_TOP}, default 20. ` +
      `daily: 1-${SALES_DAILY_MAX_TOP}, default 4.`
    ),

  search: z
    .string()
    .max(100)
    .optional()
    .describe('summary only: filter groups by text (max 100 chars).'),
};

// ---------------------------------------------------------------------------
// Campaign deliverability / unsubscribes (nev-api)
// ---------------------------------------------------------------------------

const campaignId = z
  .string()
  .min(1)
  .describe('Campaign ID. Get it from nevent_list_campaigns.');

/** Views of `nevent_get_campaign_deliverability`. */
export const DELIVERABILITY_VIEWS = ['summary', 'bounce_reasons', 'segment_breakdown'] as const;
export type DeliverabilityView = (typeof DELIVERABILITY_VIEWS)[number];

/** Bounce families accepted by the bounce-reasons endpoint. */
export const BOUNCE_TYPE_VALUES = ['soft', 'hard'] as const;

/**
 * Input schema for `nevent_get_campaign_deliverability`.
 */
export const GetCampaignDeliverabilitySchema = {
  campaign_id: campaignId,

  view: z
    .enum(DELIVERABILITY_VIEWS)
    .optional()
    .describe(
      'summary (default): sent, delivered, soft/hard bounces, complaints and an optional warning. ' +
      'bounce_reasons: bounce reasons grouped by SES bounce subtype; needs bounce_type. ' +
      'segment_breakdown: delivery / soft / hard bounce per segment (empty when the campaign has a single segment or no attribution).'
    ),

  bounce_type: z
    .enum(BOUNCE_TYPE_VALUES)
    .optional()
    .describe('Required when view=bounce_reasons: the bounce family, soft or hard.'),
};

/** Views of `nevent_get_campaign_unsubscribes`. */
export const UNSUBSCRIBES_VIEWS = ['summary', 'reasons', 'segment_breakdown'] as const;
export type UnsubscribesView = (typeof UNSUBSCRIBES_VIEWS)[number];

/**
 * Input schema for `nevent_get_campaign_unsubscribes`.
 */
export const GetCampaignUnsubscribesSchema = {
  campaign_id: campaignId,

  view: z
    .enum(UNSUBSCRIBES_VIEWS)
    .optional()
    .describe(
      'summary (default): unsubscribes, unsubscribe rate, spam complaints and complaint rate. ' +
      'reasons: voluntary unsubscribe reasons grouped into canonical buckets. ' +
      'segment_breakdown: unsubscribes and complaints per segment (empty when the campaign has a single segment or no attribution).'
    ),
};
