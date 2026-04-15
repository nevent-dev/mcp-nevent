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
 */

import { z } from 'zod';

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
   * Delivery channel. Determines which content fields are relevant.
   * - EMAIL  : requires email_subject; supports email_body, preview_text, from_name
   * - SMS    : requires message
   * - WHATSAPP: requires message
   */
  channel: z
    .enum(['EMAIL', 'SMS', 'WHATSAPP'])
    .describe('Delivery channel: EMAIL | SMS | WHATSAPP'),

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
