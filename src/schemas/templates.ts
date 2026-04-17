/**
 * Zod validation schemas for email template tools.
 *
 * Each schema corresponds to the input parameters of one MCP tool:
 *  - `ListTemplatesSchema`    → nevent_list_templates
 *  - `GetTemplateSchema`      → nevent_get_template
 *  - `CreateTemplateSchema`   → nevent_create_template
 *  - `UpdateTemplateSchema`   → nevent_update_template
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
   * Identifier of the template to retrieve.
   * Must be a 24-character hex string.
   */
  template_id: z
    .string()
    .regex(/^[a-f0-9]{24}$/i, 'Must be a valid 24-character hex identifier')
    .describe(
      'The Identifier of the template to retrieve. ' +
      'Get valid IDs from nevent_list_templates.'
    ),
};

// ---------------------------------------------------------------------------
// Tool: nevent_create_template
// ---------------------------------------------------------------------------

/**
 * Input schema for `nevent_create_template`.
 *
 * Creates a new email template via POST /templates on nev-api.
 * Either `mjml_body` (MJML source) or `html_body` (raw HTML) should be
 * supplied depending on the chosen `format`.
 *
 * @example
 * ```ts
 * const params = {
 *   name: 'Event Reminder — Spring 2026',
 *   format: 'mjml',
 *   mjml_body: '<mjml>...</mjml>',
 *   tags: ['event', 'reminder'],
 * };
 * ```
 */
export const CreateTemplateSchema = {
  /**
   * Human-readable name for the new template.
   * Must be non-empty. Duplicate names are allowed by the API.
   */
  name: z
    .string()
    .min(1)
    .describe('Human-readable name for the template, e.g. "Event Reminder — Spring 2026"'),

  /**
   * Content format of the template.
   * Use "mjml" for MJML source (compiled server-side to HTML).
   * Use "html" for a raw pre-compiled HTML template.
   */
  format: z
    .enum(['html', 'mjml'])
    .describe('Template format: "html" for raw HTML, "mjml" for MJML source code'),

  /**
   * MJML source code for the template.
   * Required when `format` is "mjml"; ignored otherwise.
   */
  mjml_body: z
    .string()
    .optional()
    .describe(
      'MJML source code for the template. ' +
      'Provide this field when format is "mjml".'
    ),

  /**
   * Raw HTML content for the template.
   * Required when `format` is "html"; ignored otherwise.
   */
  html_body: z
    .string()
    .optional()
    .describe(
      'Raw HTML content for the template. ' +
      'Provide this field when format is "html".'
    ),

  /**
   * List of string tags to categorise the template.
   * Tags enable filtering via `nevent_list_templates`.
   */
  tags: z
    .array(z.string())
    .optional()
    .describe(
      'List of string tags to categorise the template ' +
      '(e.g. ["promotional", "event", "reminder"]). Omit to create with no tags.'
    ),
};

// ---------------------------------------------------------------------------
// Tool: nevent_update_template
// ---------------------------------------------------------------------------

/**
 * Input schema for `nevent_update_template`.
 *
 * Updates an existing email template via PUT /templates/{templateId} on nev-api.
 * At least one of `name`, `format`, `mjml_body`, `html_body`, or `tags` must
 * be provided (validated at runtime in the tool handler for a clearer error).
 *
 * @example
 * ```ts
 * const params = {
 *   template_id: '64f3a1b2c8e94d001e2a7f3c',
 *   name: 'Event Reminder — Updated',
 *   tags: ['event', 'reminder', 'updated'],
 * };
 * ```
 */
export const UpdateTemplateSchema = {
  /**
   * Identifier of the template to update.
   * Use `nevent_list_templates` to discover valid template IDs.
   * Must be a 24-character hex string.
   */
  template_id: z
    .string()
    .regex(/^[a-f0-9]{24}$/i, 'Must be a valid 24-character hex identifier')
    .describe(
      'Identifier of the template to update. ' +
      'Use nevent_list_templates to get valid template IDs.'
    ),

  /**
   * New human-readable name for the template. Omit to leave unchanged.
   */
  name: z
    .string()
    .min(1)
    .optional()
    .describe('New human-readable name for the template. Omit to leave unchanged.'),

  /**
   * New content format for the template. Omit to leave unchanged.
   */
  format: z
    .enum(['html', 'mjml'])
    .optional()
    .describe('New template format: "html" or "mjml". Omit to leave unchanged.'),

  /**
   * New MJML source code. Omit to leave unchanged.
   */
  mjml_body: z
    .string()
    .optional()
    .describe('New MJML source code for the template. Omit to leave unchanged.'),

  /**
   * New raw HTML content. Omit to leave unchanged.
   */
  html_body: z
    .string()
    .optional()
    .describe('New raw HTML content for the template. Omit to leave unchanged.'),

  /**
   * Replacement list of tags. Omit to leave unchanged.
   * The entire tag list is replaced when provided — partial updates are not supported.
   */
  tags: z
    .array(z.string())
    .optional()
    .describe(
      'Replacement list of tags. The full tag list is replaced when provided. ' +
      'Omit to leave existing tags unchanged.'
    ),
};
