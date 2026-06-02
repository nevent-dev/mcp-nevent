/**
 * Zod validation schemas for campaign action tools (NEV-1585).
 *
 * Covers two MCP write tools:
 *  1. nevent_create_campaign  — Create a new campaign in DRAFT state
 *  2. nevent_schedule_campaign — Schedule a DRAFT campaign for future delivery
 *
 * Design principles:
 * - `status` is NOT exposed as a parameter — it is hardcoded to "DRAFT" in
 *   the tool handler to prevent direct sends.
 * - `confirmed` on schedule is a z.literal(true) gate: the agent must pass
 *   the exact value `true` or Zod will reject it at parse time.
 * - ISO 8601 strings are validated at the schema level for format, and the
 *   handler validates that the scheduled time is in the future.
 * - `channel` mirrors the backend `CommunicationChannel` enum exactly (11
 *   values). Legacy aliases EMAIL/SMS/WHATSAPP are mapped to their _ONLY
 *   counterparts in the handler for backwards-compatibility (NEV-1669).
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// CommunicationChannel enum (NEV-1669)
// ---------------------------------------------------------------------------

/**
 * The complete set of delivery channel values accepted by the nev-api
 * `CommunicationChannel` enum. The handler maps the three legacy aliases
 * (EMAIL, SMS, WHATSAPP) to EMAIL_ONLY, SMS_ONLY, and WHATSAPP_ONLY
 * respectively for backwards-compatibility.
 *
 * Choose the value that best describes the intended delivery mix:
 *
 * | Value              | Channels used                         |
 * |--------------------|---------------------------------------|
 * | EMAIL_ONLY         | Email only                            |
 * | SMS_ONLY           | SMS only                              |
 * | WHATSAPP_ONLY      | WhatsApp only                         |
 * | PUSH_ONLY          | Push notifications only               |
 * | EMAIL_AND_SMS      | Email + SMS                           |
 * | EMAIL_AND_WHATSAPP | Email + WhatsApp                      |
 * | PUSH_AND_SMS       | Push + SMS                            |
 * | PUSH_AND_WHATSAPP  | Push + WhatsApp                       |
 * | SMS_AND_WHATSAPP   | SMS + WhatsApp                        |
 * | ALL_CHANNELS       | All available channels                |
 * | OMNICHANNEL        | Automatic best-channel selection      |
 *
 * Deprecated aliases (mapped internally, not recommended for new use):
 *   EMAIL → EMAIL_ONLY, SMS → SMS_ONLY, WHATSAPP → WHATSAPP_ONLY
 */
export const COMMUNICATION_CHANNEL_VALUES = [
  // Primary single-channel values
  'EMAIL_ONLY',
  'SMS_ONLY',
  'WHATSAPP_ONLY',
  'PUSH_ONLY',
  // Multi-channel combinations
  'EMAIL_AND_SMS',
  'EMAIL_AND_WHATSAPP',
  'PUSH_AND_SMS',
  'PUSH_AND_WHATSAPP',
  'SMS_AND_WHATSAPP',
  // Broad values
  'ALL_CHANNELS',
  'OMNICHANNEL',
  // Backwards-compatibility aliases (mapped in handler to _ONLY variants)
  'EMAIL',
  'SMS',
  'WHATSAPP',
] as const;

/** Union type of all accepted channel values (including legacy aliases). */
export type CommunicationChannel = (typeof COMMUNICATION_CHANNEL_VALUES)[number];

/**
 * Mapping of legacy channel aliases to the correct nev-api enum values.
 * Applied in the `nevent_create_campaign` handler before sending to the API.
 */
export const CHANNEL_ALIAS_MAP: Partial<Record<CommunicationChannel, string>> = {
  EMAIL: 'EMAIL_ONLY',
  SMS: 'SMS_ONLY',
  WHATSAPP: 'WHATSAPP_ONLY',
};

// ---------------------------------------------------------------------------
// Tool 1: nevent_create_campaign
// ---------------------------------------------------------------------------

/**
 * Input schema for `nevent_create_campaign`.
 *
 * Creates a campaign in DRAFT state via nev-api POST /campaigns.
 * The `status` field is intentionally absent — it is hardcoded in the handler.
 */
export const CreateCampaignSchema = {
  /**
   * Human-readable name for the campaign.
   * Displayed in the Nevent dashboard and used for reporting.
   */
  name: z
    .string()
    .min(1)
    .max(255)
    .describe('Campaign name (required, max 255 characters)'),

  /**
   * Delivery channel. Must be one of the nev-api CommunicationChannel enum values.
   *
   * Single-channel: EMAIL_ONLY | SMS_ONLY | WHATSAPP_ONLY | PUSH_ONLY
   * Multi-channel:  EMAIL_AND_SMS | EMAIL_AND_WHATSAPP | PUSH_AND_SMS |
   *                 PUSH_AND_WHATSAPP | SMS_AND_WHATSAPP
   * Broad:          ALL_CHANNELS | OMNICHANNEL
   *
   * Legacy aliases EMAIL, SMS, WHATSAPP are accepted and mapped automatically
   * to EMAIL_ONLY, SMS_ONLY, WHATSAPP_ONLY (deprecated, prefer _ONLY variants).
   *
   * Content requirements by channel:
   * - EMAIL_ONLY / EMAIL_AND_*: email_subject required; email_body, preview_text, from_name optional
   * - SMS_ONLY / SMS_AND_* / PUSH_AND_SMS: message required
   * - WHATSAPP_ONLY / EMAIL_AND_WHATSAPP / PUSH_AND_WHATSAPP / SMS_AND_WHATSAPP: message required
   * - PUSH_ONLY: message required
   */
  channel: z
    .enum(COMMUNICATION_CHANNEL_VALUES)
    .describe(
      'Delivery channel (nev-api CommunicationChannel enum). ' +
      'Use EMAIL_ONLY, SMS_ONLY, WHATSAPP_ONLY, PUSH_ONLY for single-channel; ' +
      'EMAIL_AND_SMS, EMAIL_AND_WHATSAPP, PUSH_AND_SMS, PUSH_AND_WHATSAPP, SMS_AND_WHATSAPP for multi-channel; ' +
      'ALL_CHANNELS or OMNICHANNEL for broad delivery. ' +
      'Legacy values EMAIL/SMS/WHATSAPP are accepted but deprecated.'
    ),

  /**
   * Email subject line.
   * Required when channel is EMAIL; ignored for SMS/WHATSAPP.
   */
  email_subject: z
    .string()
    .max(998)
    .optional()
    .describe(
      'Email subject line (required when channel=EMAIL, max 998 chars per RFC 5322)'
    ),

  /**
   * HTML body of the email.
   * Optional; can be set or updated later via the campaign editor.
   */
  email_body: z
    .string()
    .optional()
    .describe('HTML body content of the email (optional, can be set later)'),

  /**
   * Email preview text shown in inbox summaries.
   * Optional; typically 40–140 characters for best display across clients.
   */
  preview_text: z
    .string()
    .max(500)
    .optional()
    .describe('Inbox preview text (optional, shown in email client summaries)'),

  /**
   * Sender display name.
   * Optional; falls back to the tenant default sender name when omitted.
   */
  from_name: z
    .string()
    .max(255)
    .optional()
    .describe('Sender display name (optional, defaults to tenant sender name)'),

  /**
   * Text body for SMS or WhatsApp campaigns.
   * Required when channel is SMS or WHATSAPP.
   */
  message: z
    .string()
    .optional()
    .describe('Message text body (required when channel=SMS or WHATSAPP)'),

  /**
   * Array of audience segment IDs to target with this campaign.
   * Optional; segments can be attached or changed before sending.
   */
  segment_ids: z
    .array(z.string())
    .optional()
    .describe('Array of segment IDs to target (optional, can be set later)'),

  /**
   * ID of a saved template to use for this campaign's content.
   * Optional; providing this populates email_body from the template.
   */
  template_id: z
    .string()
    .optional()
    .describe('Template ID to pre-populate campaign content (optional)'),

  // -------------------------------------------------------------------------
  // UTM tracking parameters (NEV-1669)
  // -------------------------------------------------------------------------

  /**
   * UTM source parameter — identifies the traffic source.
   * Maps to `utmTracking.source` on the backend (max 100 chars).
   * Example: "nevent", "newsletter", "instagram"
   * Defaults to "nevent" on the backend when omitted.
   */
  utm_source: z
    .string()
    .max(100)
    .optional()
    .describe('UTM source parameter (e.g. "nevent", "newsletter"). Max 100 chars.'),

  /**
   * UTM medium parameter — identifies the marketing medium.
   * Maps to `utmTracking.medium` on the backend (max 100 chars).
   * Example: "email", "sms", "whatsapp"
   * The backend auto-detects the medium from the channel when omitted.
   */
  utm_medium: z
    .string()
    .max(100)
    .optional()
    .describe('UTM medium parameter (e.g. "email", "sms"). Max 100 chars. Auto-detected from channel if omitted.'),

  /**
   * UTM campaign parameter — identifies the specific campaign.
   * Maps to `utmTracking.campaign` on the backend (max 100 chars).
   * Example: "summer-sale-2026", "welcome-series"
   * The backend defaults to a slugified version of the campaign name when omitted.
   */
  utm_campaign: z
    .string()
    .max(100)
    .optional()
    .describe('UTM campaign parameter (e.g. "summer-sale-2026"). Max 100 chars. Defaults to slugified campaign name.'),

  /**
   * UTM content parameter — differentiates ads or links in the same campaign.
   * Maps to `utmTracking.content` on the backend (max 100 chars).
   * Example: "header-cta", "footer-link"
   */
  utm_content: z
    .string()
    .max(100)
    .optional()
    .describe('UTM content parameter — differentiates links/variants. Max 100 chars.'),

  /**
   * UTM term parameter — identifies paid search keywords.
   * Maps to `utmTracking.term` on the backend (max 100 chars).
   * Example: "festival+tickets", "music+events"
   */
  utm_term: z
    .string()
    .max(100)
    .optional()
    .describe('UTM term parameter — paid search keyword. Max 100 chars.'),

  /**
   * Custom UTM-style query parameters to append to tracked links.
   * Maps to `utmTracking.customParams` on the backend (Map<String,String>).
   * Example: { "ref": "promo2026", "variant": "A" }
   */
  utm_custom_params: z
    .record(z.string(), z.string())
    .optional()
    .describe('Custom tracking parameters as key-value pairs appended to tracked links (optional).'),
};

// ---------------------------------------------------------------------------
// Tool 2: nevent_schedule_campaign
// ---------------------------------------------------------------------------

/**
 * Input schema for `nevent_schedule_campaign`.
 *
 * Schedules a DRAFT campaign for delivery at a specified future time.
 * The `confirmed` field uses `z.literal(true)` so Zod rejects any value
 * other than the exact literal `true` before the handler is even invoked.
 */
export const ScheduleCampaignSchema = {
  /**
   * ID of the campaign to schedule.
   * Must reference an existing campaign in DRAFT status.
   */
  campaign_id: z
    .string()
    .min(1)
    .describe('Campaign ID to schedule (must be in DRAFT status)'),

  /**
   * ISO 8601 datetime for when to send the campaign.
   * Must be a future timestamp. Example: "2026-05-01T10:00:00Z"
   *
   * The handler validates that this is strictly in the future at call time;
   * this schema-level validation only checks the string format.
   */
  scheduled_time: z
    .string()
    .datetime({ offset: true })
    .describe(
      'ISO 8601 datetime for scheduled send (must be in the future). ' +
      'Example: "2026-05-01T10:00:00Z" or "2026-05-01T10:00:00+02:00"'
    ),

  /**
   * Explicit confirmation that scheduling should proceed.
   *
   * MUST be the literal value `true` — Zod rejects any other value at parse
   * time, preventing accidental scheduling. The agent must consciously pass
   * `true` to confirm it intends to schedule a real send.
   */
  confirmed: z
    .literal(true)
    .describe(
      'Must be the literal value true to proceed. ' +
      'Set confirmed=true to confirm you want to schedule this campaign for sending.'
    ),
};
