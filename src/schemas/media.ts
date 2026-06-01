/**
 * Zod validation schemas for image-management MCP tools.
 *
 * Each schema corresponds to one tool's input parameters:
 *  - `UploadImageSchema`  → nevent_upload_image
 *  - `ListImagesSchema`   → nevent_list_images  (empty — no params)
 *  - `DeleteImageSchema`  → nevent_delete_image
 *
 * Design principles:
 *  - `source` accepts either a data URL (`data:image/...;base64,...`) or raw
 *    base64; MIME type is inferred from the data URL prefix or from `mimeType`.
 *  - No URL source is accepted — only base64. This is a hard product constraint
 *    to prevent the MCP from acting as a third-party content rehosting proxy.
 *  - Size enforcement (5 MB decoded) is done in the tool handler, not the schema,
 *    because Zod transforms add complexity for minimal validation benefit here.
 *
 * @module schemas/media
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Tool: nevent_upload_image
// ---------------------------------------------------------------------------

/**
 * Input schema for `nevent_upload_image`.
 *
 * Accepts the image as a base64 string in one of two forms:
 *
 *  1. **Data URL** — `data:image/png;base64,<base64-encoded-data>`
 *     - The MIME type is embedded in the prefix; `mimeType` can be omitted.
 *  2. **Raw base64** — the bare base64 string without any prefix.
 *     - `mimeType` is required in this form; the tool returns an error when absent.
 *
 * @example
 * ```ts
 * // Data URL form (mimeType can be omitted)
 * { source: 'data:image/jpeg;base64,/9j/4AAQ...', imageName: 'banner.jpg' }
 *
 * // Raw base64 form (mimeType required)
 * { source: '/9j/4AAQ...', mimeType: 'image/jpeg', imageName: 'banner.jpg' }
 * ```
 */
export const UploadImageSchema = {
  /**
   * Base64-encoded image data. Accepted in two forms:
   *
   * - **Data URL**: `data:<mimeType>;base64,<base64data>` — the MIME type is
   *   parsed from the prefix and `mimeType` can be omitted.
   * - **Raw base64**: bare base64 string without a prefix — `mimeType` must
   *   be provided explicitly.
   *
   * Only base64 input is accepted. URL sources are not supported.
   * Maximum decoded size: 5 MB.
   */
  source: z
    .string()
    .min(1, 'source must not be empty')
    .describe(
      'Base64-encoded image. Two accepted forms:\n' +
      '1. Data URL: "data:image/png;base64,<base64data>" — MIME type parsed from prefix.\n' +
      '2. Raw base64 string — mimeType parameter required.\n' +
      'Maximum decoded size: 5 MB. URL sources are not accepted.'
    ),

  /**
   * Optional file name for the uploaded resource (e.g. "event-banner.png").
   * When omitted, the server generates a name from the upload timestamp.
   * Including a meaningful name helps with organization in `nevent_list_images`.
   */
  imageName: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Optional file name for the uploaded resource (e.g. "event-banner.png"). ' +
      'When omitted, a name is generated from the upload timestamp.'
    ),

  /**
   * MIME type of the image (e.g. "image/png", "image/jpeg", "image/webp").
   * Required when `source` is raw base64 without a data URL prefix.
   * Ignored when `source` is a data URL (MIME type is parsed from the prefix instead).
   * Common values: image/png | image/jpeg | image/gif | image/webp | image/svg+xml.
   */
  mimeType: z
    .string()
    .min(1)
    .optional()
    .describe(
      'MIME type of the image, e.g. "image/png" or "image/jpeg". ' +
      'Required when source is raw base64 (no data URL prefix). ' +
      'Ignored when source is a data URL (MIME type parsed from prefix). ' +
      'Common values: image/png | image/jpeg | image/gif | image/webp | image/svg+xml.'
    ),
};

// ---------------------------------------------------------------------------
// Tool: nevent_list_images
// ---------------------------------------------------------------------------

/**
 * Input schema for `nevent_list_images`.
 *
 * No input parameters — the tool lists all resources for the current tenant
 * as resolved from the JWT bearer token.
 */
export const ListImagesSchema = {};

// ---------------------------------------------------------------------------
// Tool: nevent_delete_image
// ---------------------------------------------------------------------------

/**
 * Input schema for `nevent_delete_image`.
 *
 * Accepts one or more CDN URLs to delete. The URLs must match the `src` /
 * `destinationUrl` values returned by `nevent_upload_image` or
 * `nevent_list_images`. The operation is idempotent — deleting a URL that no
 * longer exists does not raise an error.
 *
 * @example
 * ```ts
 * {
 *   urls: [
 *     'https://cdn.nevent.es/resources/tenant123/banner.png',
 *     'https://cdn.nevent.es/resources/tenant123/old-logo.jpg',
 *   ]
 * }
 * ```
 */
export const DeleteImageSchema = {
  /**
   * One or more CDN URLs of the images to delete.
   * Use the `src` / `destinationUrl` values returned by `nevent_list_images`
   * or `nevent_upload_image`. At least one URL is required.
   * The operation is permanent and irreversible.
   */
  urls: z
    .array(z.string().min(1, 'Each URL must not be empty'))
    .min(1, 'At least one URL is required. Provide the CDN URLs to delete.')
    .describe(
      'Array of CDN image URLs to delete. ' +
      'Use the src/destinationUrl values from nevent_list_images or nevent_upload_image. ' +
      'Minimum 1 URL required. The operation is permanent. ' +
      'Example: ["https://cdn.nevent.es/resources/tenant123/banner.png"].'
    ),
};
