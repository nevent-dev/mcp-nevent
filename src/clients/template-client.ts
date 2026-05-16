/**
 * Template API client targeting nev-api (`/templates/{id}/...`).
 *
 * Provides strongly-typed methods for the 4 template operation endpoints:
 *  - `POST /templates/{id}/clone`   — duplicate a template
 *  - `PATCH /templates/{id}/rename` — rename without content re-render
 *  - `POST /templates/{id}/preview` — preview with merge-tag resolution
 *  - `POST /templates/{id}/test`    — send a test email via SES
 *
 * ## Tenant resolution
 *
 * Tenant is resolved **server-side from the JWT**. The MCP MUST NOT send
 * `tenant_id` in the request body or as a query parameter — nev-api resolves
 * the tenant from the bearer token's `tenantId` claim.
 *
 * ## Usage
 *
 * In HTTP mode, one `TemplateClient` is created per MCP session and shares
 * the same bearer JWT as `DataClient` and `PaidMediaClient`. In stdio mode, a
 * single shared instance is used for all requests.
 *
 * All methods are thin wrappers over `BaseClient` — error handling (including
 * 401 auto-refresh via `onUnauthorized`) is delegated to the parent.
 *
 * @module clients/template-client
 */

import { BaseClient } from './base-client.js';
import type { BaseClientConfig } from './base-client.js';
import type {
  EmailTemplate,
  EmailTemplatePreviewResponse,
  EmailTemplateTestResponse,
} from '../types/templates.js';

// ---------------------------------------------------------------------------
// Request body interfaces
// ---------------------------------------------------------------------------

/**
 * Request body for `PATCH /templates/{id}/rename`.
 * Maps to `es.nevent.api.model.emailtemplate.RenameTemplateRequest`.
 */
export interface RenameTemplateBody {
  /** New template name (1–255 characters). */
  name: string;
}

/**
 * Request body for `POST /templates/{id}/preview`.
 * Maps to `es.nevent.api.model.emailtemplate.preview.EmailTemplatePreviewRequest`.
 * All fields are optional — nev-api handles empty objects gracefully.
 */
export interface PreviewTemplateBody {
  /**
   * Optional user ID for merge-tag resolution.
   * Takes priority over sampleUserEmail when both are provided.
   */
  sampleUserId?: string;
  /**
   * Optional user email for merge-tag resolution (looked up within the tenant).
   * Ignored when sampleUserId is provided.
   */
  sampleUserEmail?: string;
  /**
   * Optional subject line to preview with merge-tag resolution.
   */
  subject?: string;
}

/**
 * Request body for `POST /templates/{id}/test`.
 * Maps to `es.nevent.api.model.emailtemplate.test.EmailTemplateTestRequest`.
 */
export interface TestTemplateBody {
  /** List of email addresses to send the test to. */
  emails: string[];
  /** Optional subject line (nev-api uses a default when omitted). */
  subject?: string;
  /** Optional custom parameters for merge-tag substitution. */
  parameters?: Record<string, unknown>;
  /**
   * Optional user ID for merge-tag personalization.
   * Takes priority over sampleUserEmail.
   */
  sampleUserId?: string;
  /**
   * Optional user email for merge-tag personalization (looked up within tenant).
   * Ignored when sampleUserId is provided.
   */
  sampleUserEmail?: string;
}

// ---------------------------------------------------------------------------
// TemplateClient
// ---------------------------------------------------------------------------

/**
 * Client for the nev-api email template operation endpoints.
 *
 * All four methods that modify or act on a template (clone, rename, preview,
 * test) are implemented here. Read operations (list, get) go via MongoDB
 * directly — they are handled by `registerTemplateTools` in `tools/templates.ts`.
 *
 * ## Tenant resolution (IMPORTANT)
 *
 * Tenant is resolved **server-side from the JWT**. Do NOT pass `tenant_id` in
 * any request body or query parameter to these endpoints.
 *
 * @example
 * ```ts
 * const client = new TemplateClient({
 *   baseUrl: process.env.NEVENT_API_URL ?? 'https://api.nevent.es',
 *   jwtToken: userAccessToken,
 * });
 * const cloned = await client.cloneTemplate('64f3a1b2c8e94d001e2a7f3c');
 * ```
 */
export class TemplateClient extends BaseClient {
  constructor(config: BaseClientConfig) {
    super(config);
  }

  // -------------------------------------------------------------------------
  // clone
  // -------------------------------------------------------------------------

  /**
   * Clone an existing email template.
   * Maps to `POST /templates/{templateId}/clone`.
   *
   * nev-api creates a full copy of the template (content, metadata, tags) with
   * a new unique ID. The clone's name is automatically suffixed with "(Copy)".
   *
   * Tenant is resolved from the JWT — do NOT pass tenant_id.
   *
   * @param templateId - The ID of the template to clone.
   * @returns The newly created cloned `EmailTemplate`.
   */
  async cloneTemplate(templateId: string): Promise<EmailTemplate> {
    return this.post<EmailTemplate>(
      `/templates/${encodeURIComponent(templateId)}/clone`,
      {}
    );
  }

  // -------------------------------------------------------------------------
  // rename
  // -------------------------------------------------------------------------

  /**
   * Rename an existing email template.
   * Maps to `PATCH /templates/{templateId}/rename`.
   *
   * Lightweight operation — does not trigger content re-rendering or thumbnail
   * regeneration. Only the `name` field is updated.
   *
   * Tenant is resolved from the JWT — do NOT pass tenant_id.
   *
   * @param templateId - The ID of the template to rename.
   * @param name       - The new name for the template (1–255 chars).
   * @returns The updated `EmailTemplate` with the new name.
   */
  async renameTemplate(templateId: string, name: string): Promise<EmailTemplate> {
    const response = await this.request<EmailTemplate>(
      'PATCH',
      `/templates/${encodeURIComponent(templateId)}/rename`,
      { body: { name } satisfies RenameTemplateBody }
    );
    return response.data;
  }

  // -------------------------------------------------------------------------
  // preview
  // -------------------------------------------------------------------------

  /**
   * Preview an email template with merge tags resolved.
   * Maps to `POST /templates/{templateId}/preview`.
   *
   * Returns both the original HTML (with raw `{{merge_tags}}`) and the
   * personalized HTML (with tags replaced by the sample user's data).
   * When no sample user is provided, only the original body is returned.
   *
   * Tenant is resolved from the JWT — do NOT pass tenant_id.
   *
   * @param templateId - The ID of the template to preview.
   * @param body       - Optional preview request (sampleUserId, sampleUserEmail, subject).
   * @returns Preview response with original + personalized content.
   */
  async previewTemplate(
    templateId: string,
    body: PreviewTemplateBody = {}
  ): Promise<EmailTemplatePreviewResponse> {
    return this.post<EmailTemplatePreviewResponse>(
      `/templates/${encodeURIComponent(templateId)}/preview`,
      body
    );
  }

  // -------------------------------------------------------------------------
  // test
  // -------------------------------------------------------------------------

  /**
   * Send a test email using the specified template.
   * Maps to `POST /templates/{templateId}/test`.
   *
   * Dispatches the rendered template to the provided email addresses via AWS
   * SES. Test emails include a test indicator in headers. This call may take
   * up to 30–60 seconds due to SES rendering and delivery latency.
   *
   * Tenant is resolved from the JWT — do NOT pass tenant_id.
   *
   * @param templateId - The ID of the template to test.
   * @param body       - Test request with recipients, optional subject and merge-tag params.
   * @returns Result including success flag, sentTo list, and optional errorMessage.
   */
  async sendTestEmail(
    templateId: string,
    body: TestTemplateBody
  ): Promise<EmailTemplateTestResponse> {
    return this.post<EmailTemplateTestResponse>(
      `/templates/${encodeURIComponent(templateId)}/test`,
      body
    );
  }
}
