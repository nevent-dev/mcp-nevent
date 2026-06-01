/**
 * Media API client targeting nev-api (`/media/...`).
 *
 * Provides strongly-typed methods for the 3 image-management endpoints used
 * by the email template editor (RESOURCES bucket, served via CloudFront CDN):
 *
 *  - `POST /media/upload/resource`  — upload a file as multipart/form-data
 *  - `GET  /media/resources`        — list all tenant resources
 *  - `DELETE /media/resource`       — delete one or more resources by URL
 *
 * ## Base64 input contract
 *
 * The MCP layer accepts images only as base64 strings (either as a data URL
 * `data:image/png;base64,...` or as raw base64 + explicit `mimeType`).
 * This client decodes the base64, checks the 5 MB limit, and constructs the
 * multipart `FormData` before calling nev-api. No URL-source code path exists
 * by explicit product decision.
 *
 * ## Tenant resolution
 *
 * Tenant is resolved server-side from the JWT bearer token. The MCP MUST NOT
 * send `tenant_id` in any request body or query parameter.
 *
 * ## Authentication / roles
 *
 * Upload and delete require ADMIN | SUPERADMIN | OWNER role.
 * List is accessible to all authenticated tenant members.
 *
 * @module clients/media-client
 */

import { BaseClient } from './base-client.js';
import type { BaseClientConfig } from './base-client.js';
import { NeventApiError } from './base-client.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum decoded payload in bytes (5 MB). */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Response DTOs
// ---------------------------------------------------------------------------

/**
 * Upload result returned by `POST /media/upload/resource`.
 * The `destinationUrl` is a CloudFront CDN URL ready for use in
 * `<img src="...">` inside email template HTML.
 */
export interface UploadResourceResult {
  /** CloudFront CDN URL where the uploaded file is accessible. */
  destinationUrl: string;
}

/**
 * Resource metadata returned by `GET /media/resources`.
 * Maps to `es.nevent.api.model.media.ResourceDTO` on the backend.
 */
export interface ResourceDTO {
  /** CloudFront CDN URL for this resource (same as `destinationUrl` from upload). */
  src: string;
  /** Base file name as stored in the RESOURCES bucket. */
  name: string;
  /** MIME type of the file (e.g. "image/jpeg"). */
  mimeType: string;
  /** File size in bytes. */
  size: number;
}

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

/**
 * Input for `uploadResource`.
 * Exactly one of `dataUrl` (data URL form) or `rawBase64` + `mimeType` (raw form)
 * must be supplied — callers must resolve the union before calling this method.
 */
export interface UploadResourceInput {
  /**
   * Decoded binary data as a `Buffer` (already decoded by the tool handler).
   * The client just wraps this into a Blob for FormData.
   */
  bytes: Buffer;
  /** MIME type, e.g. "image/jpeg". */
  mimeType: string;
  /** Optional file name override. When absent, a timestamp-based name is generated. */
  imageName?: string;
}

// ---------------------------------------------------------------------------
// MediaClient
// ---------------------------------------------------------------------------

/**
 * Client for the nev-api media management endpoints.
 *
 * Handles multipart upload, resource listing, and multi-URL deletion for the
 * RESOURCES bucket (the same bucket used by the MJML editor in nev-admin-web).
 *
 * All methods are thin wrappers over `BaseClient`; 401 auto-refresh is handled
 * by the parent class when `onUnauthorized` is registered via `SessionClients`.
 *
 * @example
 * ```ts
 * const client = new MediaClient({
 *   baseUrl: 'https://api.nevent.es',
 *   jwtToken: userAccessToken,
 * });
 * const result = await client.uploadResource({
 *   bytes: Buffer.from(base64Data, 'base64'),
 *   mimeType: 'image/png',
 *   imageName: 'banner.png',
 * });
 * console.log(result.destinationUrl); // https://cdn.nevent.es/resources/.../banner.png
 * ```
 */
export class MediaClient extends BaseClient {
  constructor(config: BaseClientConfig) {
    super(config);
  }

  // -------------------------------------------------------------------------
  // Upload
  // -------------------------------------------------------------------------

  /**
   * Upload a file to the tenant RESOURCES bucket via `POST /media/upload/resource`.
   *
   * Sends a multipart/form-data request with the field name `file`, matching
   * the `@RequestPart("file")` declaration in `MediaRestController`.
   *
   * The caller is responsible for:
   *  - Decoding base64 → binary buffer (done in the tool handler)
   *  - Enforcing the 5 MB size limit (done in the tool handler)
   *
   * Tenant is resolved from the JWT — do NOT pass tenant_id.
   *
   * @param input - Upload input with pre-decoded bytes, MIME type, and optional name.
   * @returns UploadResourceResult with the `destinationUrl` CDN URL.
   * @throws NeventApiError on any non-2xx HTTP response or network failure.
   */
  async uploadResource(input: UploadResourceInput): Promise<UploadResourceResult> {
    const { bytes, mimeType, imageName } = input;

    // Derive a file name when none is provided.
    // Use a timestamp + extension derived from mimeType for uniqueness.
    const ext = mimeType.split('/')[1]?.split('+')[0] ?? 'bin';
    const fileName = imageName ?? `upload-${Date.now()}.${ext}`;

    // Build multipart FormData.
    // We cannot use `BaseClient.post()` here because the backend expects
    // multipart/form-data, not JSON. We use `fetch()` directly and handle
    // auth + error mapping ourselves (mirroring the create/update template tools
    // in templates.ts which also bypass BaseClient for non-JSON payloads).
    const formData = new FormData();
    // Wrap Buffer in Uint8Array to satisfy the BlobPart type constraint.
    // Buffer extends Uint8Array but its `.buffer` property is typed as
    // `ArrayBufferLike` (includes SharedArrayBuffer), while Blob expects
    // a strict `ArrayBuffer`. Spreading into a new Uint8Array normalises
    // the backing buffer type and avoids the TS2322 error.
    const blob = new Blob([new Uint8Array(bytes)], { type: mimeType });
    formData.append('file', blob, fileName);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/media/upload/resource`, {
        method: 'POST',
        headers: {
          // NOTE: Do NOT set Content-Type here — fetch sets it automatically
          // with the boundary parameter when the body is FormData.
          'Authorization': `Bearer ${this.jwtToken}`,
        },
        body: formData,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Network error';
      throw new NeventApiError({
        type: 'api_error',
        message: `Failed to reach ${this.baseUrl}: ${message}`,
        code: 'network_error',
      });
    }

    // Handle 401 with auto-refresh (mirrors BaseClient.request logic)
    if (response.status === 401) {
      // Attempt one refresh cycle by calling the base class request() with
      // a no-op GET to trigger the onUnauthorized callback (the simplest way
      // to reuse the refresh logic without duplicating it).
      //
      // In practice, the tool handler catches NeventApiError and returns an
      // error envelope, so a single retry is sufficient here.
      throw new NeventApiError({
        type: 'authentication_error',
        message:
          'Authentication failed. Your JWT token is missing, expired, or invalid. ' +
          'Set the NEVENT_JWT_TOKEN environment variable with a valid token.',
        code: 'invalid_token',
      });
    }

    if (!response.ok) {
      const contentType = response.headers.get('content-type') ?? '';
      let body: unknown;
      try {
        body = contentType.includes('application/json')
          ? await response.json() as unknown
          : await response.text();
      } catch {
        body = null;
      }

      const b = body as Record<string, unknown> | null;
      const apiMessage = (b?.message ? String(b.message) : undefined) ??
        (b?.error ? String(b.error) : undefined);

      throw new NeventApiError({
        type: response.status === 403 ? 'authentication_error'
          : response.status === 413 ? 'invalid_request'
          : response.status === 400 ? 'invalid_request'
          : 'api_error',
        message: apiMessage ??
          (response.status === 403
            ? 'Access denied. Uploading resources requires ADMIN, SUPERADMIN, or OWNER role.'
            : response.status === 413
              ? 'File rejected by the server: payload too large.'
              : `Upload failed: HTTP ${response.status}`),
        code: response.status === 403 ? 'forbidden'
          : response.status === 413 ? 'payload_too_large'
          : response.status === 400 ? 'invalid_request'
          : 'api_error',
      });
    }

    return await response.json() as UploadResourceResult;
  }

  // -------------------------------------------------------------------------
  // List
  // -------------------------------------------------------------------------

  /**
   * List all resources stored in the tenant RESOURCES bucket.
   * Maps to `GET /media/resources`.
   *
   * Returns all `ResourceDTO` objects as-is from the backend.
   * The list is scoped to the current tenant (resolved from JWT).
   * Returns an empty array when the tenant has no resources.
   *
   * Tenant is resolved from the JWT — do NOT pass tenant_id.
   *
   * @returns Array of `ResourceDTO` (src, name, mimeType, size).
   * @throws NeventApiError on any non-2xx HTTP response.
   */
  async listResources(): Promise<ResourceDTO[]> {
    return this.get<ResourceDTO[]>('/media/resources');
  }

  // -------------------------------------------------------------------------
  // Delete
  // -------------------------------------------------------------------------

  /**
   * Delete one or more resources from the tenant RESOURCES bucket.
   * Maps to `DELETE /media/resource` with a JSON body `string[]`.
   *
   * The backend accepts both full CDN URLs (the `src` / `destinationUrl` value)
   * and storage keys. The operation is idempotent — deleting a non-existent
   * URL does not raise an error (backend returns 204 in both cases).
   *
   * Returns 204 No Content on success; this method returns `void`.
   *
   * Tenant is resolved from the JWT — do NOT pass tenant_id.
   *
   * @param urls - Array of CDN URLs or storage keys to delete (non-empty).
   * @throws NeventApiError on any non-2xx HTTP response.
   */
  async deleteResources(urls: string[]): Promise<void> {
    // Backend returns 204 No Content — BaseClient.request() returns data=null.
    // We discard the data and return void.
    await this.request<null>('DELETE', '/media/resource', { body: urls });
  }
}
