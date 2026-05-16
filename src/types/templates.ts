/**
 * TypeScript interfaces for email template API response shapes.
 *
 * These interfaces mirror the Java DTOs from `EmailTemplateRestController` and
 * its associated response classes:
 *
 *  - `EmailTemplate`              — full template record returned by clone/rename
 *  - `EmailTemplatePreviewResponse` — preview with merge-tag-resolved HTML
 *  - `EmailTemplateTestResponse`  — result of sending a test email via SES
 *
 * All shapes are derived from the actual Java DTOs — do NOT modify without
 * verifying against the nev-api source.
 *
 * @module types/templates
 */

// ---------------------------------------------------------------------------
// EmailTemplate (clone + rename endpoints)
// ---------------------------------------------------------------------------

/**
 * Full email template record returned by `POST /templates/{id}/clone` and
 * `PATCH /templates/{id}/rename`.
 *
 * Both endpoints return the complete `EmailTemplate` entity (same shape as the
 * create/update endpoints). MCP tools project a curated subset of this to keep
 * responses compact.
 */
export interface EmailTemplate {
  /** MongoDB ObjectId as a hex string. */
  id: string;
  /** Human-readable template name. */
  name: string | null;
  /** Template content format: "mjml" or "html". */
  format: string | null;
  /** Tag list for organisation and filtering. */
  tags: string[];
  /** Raw MJML source (present for MJML templates). */
  mjmlBody?: string | null;
  /** Rendered HTML body. */
  htmlBody?: string | null;
  /** ISO-8601 creation timestamp. */
  createdAt?: string | null;
  /** ISO-8601 last-modified timestamp. */
  modifiedAt?: string | null;
  /** User ID of the creator. */
  createdBy?: string | null;
  /** User ID of the last modifier. */
  modifiedBy?: string | null;
  /** Tenant ID that owns this template. */
  tenantId?: string | null;
}

// ---------------------------------------------------------------------------
// EmailTemplatePreviewResponse
// ---------------------------------------------------------------------------

/**
 * Response from `POST /templates/{id}/preview`.
 *
 * Contains both the original content (with raw `{{merge_tags}}`) and the
 * personalized content (with merge tags replaced by the sample user's data).
 *
 * Maps to `es.nevent.api.model.emailtemplate.preview.EmailTemplatePreviewResponse`.
 */
export interface EmailTemplatePreviewResponse {
  /** The template ID that was previewed. */
  templateId: string;
  /** User ID used for merge-tag resolution (null if no user was selected). */
  userId: string | null;
  /** User email address used for preview. */
  userEmail: string | null;
  /** User display name used for preview. */
  userDisplayName: string | null;
  /** Original subject line with raw merge tags (present only when subject was in the request). */
  originalSubject: string | null;
  /** Personalized subject with merge tags resolved (present only when user was resolved). */
  personalizedSubject: string | null;
  /** Original HTML body with raw merge tags. */
  originalBody: string | null;
  /** Personalized HTML body with merge tags replaced. */
  personalizedBody: string | null;
  /** All unique merge tags detected in the template (subject + body). */
  detectedMergeTags: string[];
  /** True when a sample user was found and used for personalization. */
  userResolved: boolean;
}

// ---------------------------------------------------------------------------
// EmailTemplateTestResponse
// ---------------------------------------------------------------------------

/**
 * Response from `POST /templates/{id}/test`.
 *
 * Indicates whether the test email was successfully sent via AWS SES and
 * which recipients received it.
 *
 * Maps to `es.nevent.api.model.emailtemplate.test.EmailTemplateTestResponse`.
 */
export interface EmailTemplateTestResponse {
  /** True when the email was successfully dispatched via SES. */
  success: boolean;
  /** List of email addresses the test email was sent to. */
  sentTo: string[] | null;
  /** Subject line used in the test email. */
  subject: string | null;
  /** Error message when success is false. */
  errorMessage: string | null;
}
