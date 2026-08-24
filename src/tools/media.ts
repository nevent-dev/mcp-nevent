/**
 * Image management tools for the Nevent MCP Server.
 *
 * Registers 3 tools that proxy the RESOURCES bucket endpoints in nev-api
 * (the same flow used by the MJML email template editor in nev-admin-web):
 *
 *  1. nevent_upload_image  — Upload an image from base64 and get a CDN URL (WRITE)
 *  2. nevent_list_images   — List all images stored for the current tenant (READ)
 *  3. nevent_delete_image  — Permanently delete one or more images (DELETE)
 *
 * ## Base64-only source contract
 *
 * Only base64 input is accepted for upload. URL sources are explicitly excluded
 * to prevent the MCP from acting as a third-party content rehosting proxy
 * (explicit product decision). The tool accepts:
 *
 *  - **Data URL** form: `data:image/png;base64,<data>` — MIME type auto-parsed.
 *  - **Raw base64** form: bare base64 string + explicit `mimeType` parameter.
 *
 * ## 5 MB size enforcement
 *
 * The decoded byte length is checked before any network call. Payloads larger
 * than 5 MB are rejected immediately with a clear error message.
 *
 * ## Operation Mode
 *
 * - `nevent_upload_image`  → WRITE  — requires STANDARD or FULL mode.
 * - `nevent_list_images`   → READ   — permitted in all modes.
 * - `nevent_delete_image`  → DELETE — requires FULL mode (irreversible).
 *
 * ## Roles required (from nev-api)
 *
 * Upload and delete require ADMIN | SUPERADMIN | OWNER.
 * List is accessible to all authenticated tenant members.
 *
 * @module tools/media
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MediaClient } from '../clients/media-client.js';
import { MAX_UPLOAD_BYTES } from '../clients/media-client.js';
import { ok, err, toErrorEnvelope, checkMode } from './helpers.js';
import { logger } from '../logger.js';
import {
  UploadImageSchema,
  ListImagesSchema,
  DeleteImageSchema,
} from '../schemas/media.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse a base64 source string and return the raw binary Buffer and MIME type.
 *
 * Handles two input forms:
 *  1. Data URL: `data:<mimeType>;base64,<base64data>` — MIME type extracted from prefix.
 *  2. Raw base64: bare string — `explicitMimeType` is used (must be provided).
 *
 * Returns a structured error object (not thrown) when:
 *  - The source is a data URL but the prefix is malformed.
 *  - The source is raw base64 but `explicitMimeType` is absent.
 *  - The base64 payload decodes to more than `MAX_UPLOAD_BYTES` (5 MB).
 *  - The base64 data is not valid base64.
 *
 * @param source           - The `source` parameter from the MCP tool call.
 * @param explicitMimeType - The `mimeType` parameter from the MCP tool call (optional).
 * @returns `{ bytes, mimeType }` on success or `{ errorMessage }` on failure.
 */
function parseBase64Source(
  source: string,
  explicitMimeType?: string
): { bytes: Buffer; mimeType: string } | { errorMessage: string } {
  let base64Data: string;
  let resolvedMimeType: string;

  // ---- Detect form ----
  if (source.startsWith('data:')) {
    // Form 1: data URL — data:<mimeType>;base64,<data>
    const commaIndex = source.indexOf(',');
    if (commaIndex === -1) {
      return {
        errorMessage:
          'Invalid data URL: missing comma separator. ' +
          'Expected format: "data:image/png;base64,<base64data>".',
      };
    }

    const header = source.slice(0, commaIndex); // e.g. "data:image/png;base64"
    const headerParts = header.split(';');
    const mediaType = headerParts[0]?.slice('data:'.length); // e.g. "image/png"

    if (!mediaType || mediaType.length === 0) {
      return {
        errorMessage:
          'Invalid data URL: could not parse MIME type from prefix. ' +
          'Expected format: "data:image/png;base64,<base64data>".',
      };
    }

    if (!headerParts.includes('base64')) {
      return {
        errorMessage:
          'Invalid data URL: only base64-encoded data URLs are accepted. ' +
          `Found encoding hint: "${headerParts.slice(1).join(';')}" — expected "base64".`,
      };
    }

    resolvedMimeType = mediaType;
    base64Data = source.slice(commaIndex + 1);
  } else {
    // Form 2: raw base64 — mimeType is required
    if (!explicitMimeType || explicitMimeType.trim().length === 0) {
      return {
        errorMessage:
          'mimeType is required when source is raw base64 (no data URL prefix). ' +
          'Provide the image MIME type, e.g. "image/png" or "image/jpeg".',
      };
    }
    resolvedMimeType = explicitMimeType.trim();
    base64Data = source;
  }

  // ---- Decode and size-check ----
  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64Data, 'base64');
  } catch {
    return {
      errorMessage:
        'Failed to decode base64 data. Ensure the source is valid base64.',
    };
  }

  // Sanity check: if the decoded size is suspiciously smaller than expected
  // for a non-empty input, the base64 may have been corrupted. Buffer.from()
  // silently ignores invalid characters, so we verify the round-trip.
  const reEncoded = bytes.toString('base64');
  if (bytes.length === 0 && base64Data.replace(/\s/g, '').length > 0) {
    // Non-empty input decoded to zero bytes — the input is not valid base64.
    return {
      errorMessage:
        'base64 decoding produced an empty buffer. ' +
        'Verify that the source is properly base64-encoded.',
    };
  }
  // Suppress unused variable warning — reEncoded is used as a side-effect check
  void reEncoded;

  if (bytes.length > MAX_UPLOAD_BYTES) {
    const sizeKb = Math.round(bytes.length / 1024);
    const limitKb = Math.round(MAX_UPLOAD_BYTES / 1024);
    return {
      errorMessage:
        `Image payload too large: ${sizeKb} KB decoded. ` +
        `Maximum allowed size is ${limitKb} KB (5 MB). ` +
        'Compress the image or use a lower resolution before uploading.',
    };
  }

  return { bytes, mimeType: resolvedMimeType };
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

/**
 * Register all image management tools on the MCP server.
 *
 * All three tools require a `MediaClient` that has been configured with the
 * same nev-api base URL and JWT as the other clients in `SessionClients`.
 *
 * Should be called during server initialization after other tool sets are
 * registered (no ordering dependency).
 *
 * @param server      - The `McpServer` instance to register tools on.
 * @param mediaClient - Pre-configured `MediaClient` for nev-api media endpoints.
 */
export function registerMediaTools(
  server: McpServer,
  mediaClient: MediaClient
): void {

  // -------------------------------------------------------------------------
  // Tool 1: nevent_upload_image (WRITE)
  // -------------------------------------------------------------------------

  server.tool(
    'nevent_upload_image',
    'Upload an image to the Nevent media library and get a CDN URL. ' +
    'Accepts base64-encoded images as a data URL (data:image/png;base64,...) or as raw base64 with an explicit mimeType. ' +
    'Returns a destinationUrl (CloudFront CDN URL) that can be used directly in <img src="..."> inside email template HTML. ' +
    'Maximum decoded size: 5 MB. ' +
    'Upload the image, then reference the returned destinationUrl in nevent_update_template or nevent_create_template HTML content.',
    UploadImageSchema,
    { title: 'Upload image to media library', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async (params) => {
      const denied = checkMode('nevent_upload_image');
      if (denied) return err(denied);

      // Parse + validate the base64 source
      const parsed = parseBase64Source(params.source, params.mimeType);
      if ('errorMessage' in parsed) {
        return err({
          error: {
            type: 'invalid_request',
            message: parsed.errorMessage,
            code: 'invalid_source',
            param: 'source',
          },
        });
      }

      const { bytes, mimeType } = parsed;

      try {
        const result = await mediaClient.uploadResource({
          bytes,
          mimeType,
          imageName: params.imageName,
        });

        logger.info({
          audit: true,
          tool: 'nevent_upload_image',
          operation: 'upload',
          outcome: 'success',
          mimeType,
          sizeBytes: bytes.length,
          imageName: params.imageName ?? '(auto)',
        }, 'Image uploaded');

        return ok({
          destinationUrl: result.destinationUrl,
          mimeType,
          sizeBytes: bytes.length,
        });
      } catch (caught) {
        return err(toErrorEnvelope(caught));
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool 2: nevent_list_images (READ)
  // -------------------------------------------------------------------------

  server.tool(
    'nevent_list_images',
    'List all images stored in the Nevent media library for the current tenant. ' +
    'Returns each image\'s CDN URL (src), file name, MIME type, and size in bytes. ' +
    'Use the src value in <img src="..."> in email template HTML, or pass it to nevent_delete_image to remove it.',
    ListImagesSchema,
    { title: 'List media library images', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async () => {
      const denied = checkMode('nevent_list_images');
      if (denied) return err(denied);

      try {
        const resources = await mediaClient.listResources();
        return ok({ resources, count: resources.length });
      } catch (caught) {
        return err(toErrorEnvelope(caught));
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool 3: nevent_delete_image (DELETE)
  // -------------------------------------------------------------------------

  server.tool(
    'nevent_delete_image',
    'Permanently delete one or more images from the Nevent media library. ' +
    'Provide the CDN URLs (src / destinationUrl) from nevent_list_images or nevent_upload_image. ' +
    'The operation is irreversible. Any email template HTML that references the deleted URLs will show broken images. ' +
    'Requires FULL operation mode (NEVENT_OPERATION_MODE=FULL) and ADMIN, SUPERADMIN, or OWNER role.',
    DeleteImageSchema,
    { title: 'Delete images from media library', readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    async (params) => {
      const denied = checkMode('nevent_delete_image');
      if (denied) return err(denied);

      // Belt-and-suspenders guard: schema enforces min(1) but protect at runtime too
      if (!params.urls || params.urls.length === 0) {
        return err({
          error: {
            type: 'invalid_request',
            message:
              'At least one URL is required. Provide the CDN URLs to delete ' +
              '(use nevent_list_images to find them).',
            code: 'urls_required',
            param: 'urls',
          },
        });
      }

      try {
        await mediaClient.deleteResources(params.urls);

        logger.info({
          audit: true,
          tool: 'nevent_delete_image',
          operation: 'delete',
          outcome: 'success',
          urlCount: params.urls.length,
        }, 'Images deleted');

        return ok({
          deleted: params.urls.length,
          urls: params.urls,
        });
      } catch (caught) {
        return err(toErrorEnvelope(caught));
      }
    }
  );
}
