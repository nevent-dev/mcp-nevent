/**
 * Zod validation schemas for email template tools.
 *
 * Each schema corresponds to the input parameters of one MCP tool:
 *  - `ListTemplatesSchema`  → nevent_list_templates
 *  - `GetTemplateSchema`    → nevent_get_template
 *
 * Design principles:
 * - All fields optional except where explicitly required
 * - Numeric limits enforce practical API constraints
 * - Enum schemas document all valid string values explicitly
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Tool: nevent_list_templates
// ---------------------------------------------------------------------------

/**
 * Input schema for `nevent_list_templates`.
 *
 * Lists email templates from the `email_templates` collection in the `nevent`
 * MongoDB database, scoped to the active tenant. Large body fields (htmlBody,
 * mjmlBody) are excluded from list results — use `nevent_get_template` to
 * retrieve them for a specific template.
 */
export const ListTemplatesSchema = {
  /** Filter templates by one or more tag values. */
  tags: z
    .array(z.string())
    .optional()
    .describe(
      'Filter templates by tags. Only templates that have ALL specified tags are returned. ' +
      'Omit to return templates regardless of tags.'
    ),

  /**
   * Filter templates by AI-assigned content nature classification.
   * Common values: "promotional", "transactional", "newsletter", "event_reminder", etc.
   */
  content_nature: z
    .string()
    .optional()
    .describe(
      'Filter by AI-assigned content nature classification ' +
      '(e.g. "promotional", "transactional", "newsletter", "event_reminder"). ' +
      'Omit to return templates of all natures.'
    ),

  /** Maximum number of templates to return. Capped at 200. */
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .default(50)
    .describe('Maximum number of templates to return (default 50, max 200)'),

  /** Field to sort results by. */
  sort: z
    .enum(['createdAt', 'modifiedAt', 'name'])
    .default('modifiedAt')
    .describe('Sort field: createdAt | modifiedAt | name (default modifiedAt)'),

  /** Sort direction. */
  sort_order: z
    .enum(['asc', 'desc'])
    .default('desc')
    .describe('Sort direction: asc | desc (default desc)'),
};

// ---------------------------------------------------------------------------
// Tool: nevent_get_template
// ---------------------------------------------------------------------------

/**
 * Input schema for `nevent_get_template`.
 *
 * Retrieves the full detail of a single email template including the compiled
 * HTML body, MJML source, AI classification fields, and performance metrics
 * when available in `template_performance_index`.
 */
export const GetTemplateSchema = {
  /**
   * MongoDB ObjectId of the template to retrieve.
   * Must be a 24-character hex string.
   */
  template_id: z
    .string()
    .regex(/^[a-f0-9]{24}$/i, 'Must be a valid 24-character MongoDB ObjectId (hex string)')
    .describe(
      'The MongoDB ObjectId of the template to retrieve. ' +
      'Get valid IDs from nevent_list_templates.'
    ),
};
