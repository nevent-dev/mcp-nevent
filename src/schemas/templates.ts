/**
 * Zod validation schemas for email template tools.
 *
 * Each schema corresponds to the input parameters of one MCP tool:
 *  - `ListTemplatesSchema`       → nevent_list_templates
 *  - `GetTemplateSchema`         → nevent_get_template
 *  - `CreateTemplateSchema`      → nevent_create_template
 *  - `UpdateTemplateSchema`      → nevent_update_template
 *  - `CloneTemplateSchema`       → nevent_clone_template
 *  - `RenameTemplateSchema`      → nevent_rename_template
 *  - `PreviewTemplateSchema`     → nevent_preview_template
 *  - `SendTestTemplateSchema`    → nevent_send_test_template
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

// ---------------------------------------------------------------------------
// Tool: nevent_clone_template
// ---------------------------------------------------------------------------

/**
 * Input schema for `nevent_clone_template`.
 *
 * Clones an existing email template via `POST /templates/{templateId}/clone`
 * on nev-api. The clone receives a new unique ID and its name is automatically
 * suffixed with "(Copy)" by nev-api.
 *
 * No request body is required — the template ID in the path is sufficient.
 *
 * @example
 * ```ts
 * const params = { template_id: '64f3a1b2c8e94d001e2a7f3c' };
 * ```
 */
export const CloneTemplateSchema = {
  /**
   * Identifier of the template to clone.
   * Must be a 24-character hex string. Use `nevent_list_templates` to discover IDs.
   */
  template_id: z
    .string()
    .min(1, 'template_id must not be empty')
    .describe(
      'The ID of the email template to clone. ' +
      'Use nevent_list_templates to discover valid template IDs. ' +
      'The clone will have a new unique ID and its name will be suffixed with "(Copy)".'
    ),
};

// ---------------------------------------------------------------------------
// Tool: nevent_rename_template
// ---------------------------------------------------------------------------

/**
 * Input schema for `nevent_rename_template`.
 *
 * Renames an existing email template via `PATCH /templates/{templateId}/rename`
 * on nev-api. This is a lightweight operation — no content re-rendering or
 * thumbnail regeneration is triggered.
 *
 * @example
 * ```ts
 * const params = {
 *   template_id: '64f3a1b2c8e94d001e2a7f3c',
 *   name: 'Spring Sale — Final Reminder',
 * };
 * ```
 */
export const RenameTemplateSchema = {
  /**
   * Identifier of the template to rename.
   * Must be a 24-character hex string. Use `nevent_list_templates` to discover IDs.
   */
  template_id: z
    .string()
    .min(1, 'template_id must not be empty')
    .describe(
      'The ID of the email template to rename. ' +
      'Use nevent_list_templates to get valid template IDs.'
    ),

  /**
   * New human-readable name for the template.
   * nev-api enforces a maximum of 255 characters.
   */
  name: z
    .string()
    .min(1, 'Name must not be empty')
    .max(255, 'Name must be at most 255 characters')
    .describe(
      'The new name for the template. Must be between 1 and 255 characters. ' +
      'Duplicate names are allowed by the API.'
    ),
};

// ---------------------------------------------------------------------------
// Tool: nevent_preview_template
// ---------------------------------------------------------------------------

/**
 * Input schema for `nevent_preview_template`.
 *
 * Previews an email template with merge tags resolved against a sample user's
 * profile via `POST /templates/{templateId}/preview` on nev-api.
 *
 * All fields are optional. When no sample user is provided, nev-api returns
 * only the original HTML with raw merge tags.
 *
 * @example
 * ```ts
 * const params = {
 *   template_id: '64f3a1b2c8e94d001e2a7f3c',
 *   sample_user_id: '507f1f77bcf86cd799439011',
 *   subject: 'Hola {{name}}, tu resumen semanal',
 * };
 * ```
 */
export const PreviewTemplateSchema = {
  /**
   * Identifier of the template to preview.
   * Must be a non-empty string. Use `nevent_list_templates` to discover IDs.
   */
  template_id: z
    .string()
    .min(1, 'template_id must not be empty')
    .describe(
      'The ID of the email template to preview. ' +
      'Use nevent_list_templates to discover valid template IDs.'
    ),

  /**
   * Optional user ID to use for merge-tag resolution.
   * When provided, merge tags like {{name}}, {{email}}, {{custom_field}} will
   * be replaced with the user's actual profile data. Takes priority over
   * sample_user_email when both are provided.
   */
  sample_user_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Optional MongoDB user ID for merge-tag personalization. ' +
      'When provided, {{name}}, {{email}} and custom fields are resolved from this user\'s profile. ' +
      'Takes priority over sample_user_email. Omit to return raw merge tags only.'
    ),

  /**
   * Optional user email for merge-tag resolution (fallback when sample_user_id
   * is not provided). The user is looked up by email within the active tenant.
   */
  sample_user_email: z
    .string()
    .email('Must be a valid email address')
    .optional()
    .describe(
      'Optional user email to look up within the active tenant for merge-tag personalization. ' +
      'Ignored when sample_user_id is also provided. ' +
      'Omit to return raw merge tags only.'
    ),

  /**
   * Optional subject line to include in the preview with merge-tag resolution.
   * When provided, the response will include both originalSubject and
   * personalizedSubject fields.
   */
  subject: z
    .string()
    .optional()
    .describe(
      'Optional subject line to preview with merge-tag resolution. ' +
      'Example: "Hola {{name|title}}, tu resumen semanal". ' +
      'Omit to skip subject personalization.'
    ),
};

// ---------------------------------------------------------------------------
// Tool: nevent_send_test_template
// ---------------------------------------------------------------------------

/**
 * Input schema for `nevent_send_test_template`.
 *
 * Sends a test email using the specified template via
 * `POST /templates/{templateId}/test` on nev-api. The email is dispatched
 * via AWS SES with test indicators in the headers.
 *
 * @example
 * ```ts
 * const params = {
 *   template_id: '64f3a1b2c8e94d001e2a7f3c',
 *   emails: ['qa@example.com', 'dev@example.com'],
 *   subject: 'Test: Spring Sale Template',
 * };
 * ```
 */
export const SendTestTemplateSchema = {
  /**
   * Identifier of the template to use for the test email.
   * Must be a non-empty string. Use `nevent_list_templates` to discover IDs.
   */
  template_id: z
    .string()
    .min(1, 'template_id must not be empty')
    .describe(
      'The ID of the email template to send as a test. ' +
      'Use nevent_list_templates to discover valid template IDs.'
    ),

  /**
   * List of email addresses to send the test email to.
   * At least one address required; capped at 10 to avoid accidental mass sends.
   */
  emails: z
    .array(
      z
        .string()
        .email('Each recipient must be a valid email address')
    )
    .min(1, 'At least one recipient email is required')
    .max(10, 'Maximum 10 recipients per test send')
    .describe(
      'List of email addresses to send the test email to. ' +
      'Each entry must be a valid email address. Minimum 1, maximum 10 recipients. ' +
      'Example: ["qa@example.com", "dev@company.com"].'
    ),

  /**
   * Optional subject line for the test email.
   * When omitted, nev-api uses a default subject derived from the template name.
   */
  subject: z
    .string()
    .optional()
    .describe(
      'Optional subject line for the test email. ' +
      'Omit to use the default subject from the template.'
    ),

  /**
   * Optional user ID to use as a sample profile for merge-tag resolution in the
   * test email. When provided, merge tags are resolved against this user's data.
   * Takes priority over sample_user_email when both are provided.
   */
  sample_user_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Optional user ID for merge-tag personalization in the test email. ' +
      'When provided, {{name}}, {{email}} and custom fields are resolved from this user\'s profile. ' +
      'Takes priority over sample_user_email.'
    ),

  /**
   * Optional user email for merge-tag resolution (looked up within the active tenant).
   * Ignored when sample_user_id is provided.
   */
  sample_user_email: z
    .string()
    .email('Must be a valid email address')
    .optional()
    .describe(
      'Optional user email within the active tenant for merge-tag personalization. ' +
      'Ignored when sample_user_id is also provided.'
    ),

  /**
   * Optional custom parameters for merge-tag substitution in the test email.
   * Key-value pairs where keys match merge tag names defined in the template.
   * When provided, overrides sample user profile data for the corresponding tags.
   *
   * @example
   * ```ts
   * parameters: { name: 'Juan', city: 'Madrid', discount: '20%' }
   * ```
   */
  parameters: z
    .record(z.unknown())
    .optional()
    .describe(
      'Optional custom parameters for merge-tag substitution in the test email. ' +
      'Key-value pairs where keys match merge tag names. Example: {name: "Juan", city: "Madrid"}. ' +
      'When provided, overrides sample user profile data for the corresponding tags.'
    ),
};
