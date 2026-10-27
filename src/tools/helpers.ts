/**
 * Shared helper utilities for MCP tool handlers.
 *
 * Centralises the response-builder and error-mapping functions that would
 * otherwise be duplicated across every tool file.  Import from here instead
 * of re-declaring locally.
 *
 * @module tools/helpers
 */

import { NeventApiError } from '../clients/base-client.js';
import { isOperationAllowed, getOperationDeniedMessage } from '../config/operation-mode.js';
import type { NeventErrorEnvelope } from '../types/common.js';

// ---------------------------------------------------------------------------
// MCP response builders
// ---------------------------------------------------------------------------

/**
 * Wrap a result object as an MCP text content block.
 *
 * Every MCP tool response must be serialised to JSON text.
 * Use this for successful responses.
 *
 * @param result - The result object to serialise.
 * @returns An MCP content block with `type: "text"`.
 *
 * @example
 * ```ts
 * return ok({ campaigns, count: campaigns.length });
 * ```
 */
export function ok(result: unknown): { content: Array<{ type: 'text'; text: string }> } {
  // No indentation — saves LLM tokens on large responses.
  // Errors still use pretty-print (see err()) to aid human debugging.
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
  };
}

/**
 * Wrap a `NeventErrorEnvelope` as an MCP error content block.
 *
 * Setting `isError: true` signals to the MCP client that this is a failure,
 * allowing the LLM to surface the structured error to the user.
 *
 * @param envelope - The structured error envelope to serialise.
 * @returns An MCP content block with `isError: true`.
 *
 * @example
 * ```ts
 * return err({ error: { type: 'not_found', message: 'Campaign not found', code: 'campaign_not_found' } });
 * ```
 */
export function err(
  envelope: NeventErrorEnvelope
): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return {
    content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/**
 * Map any caught error into a `NeventErrorEnvelope` suitable for MCP output.
 *
 * Handles three categories:
 * - `NeventApiError` — already has a structured `NeventError` inside; unwrap it.
 * - Generic `Error`  — wrapped as `api_error` with the error's message.
 * - Unknown values   — wrapped as `api_error` with string coercion.
 *
 * @param caught - The value thrown from an async tool handler.
 * @returns A `NeventErrorEnvelope` safe to pass to `err()`.
 *
 * @example
 * ```ts
 * try {
 *   // ...
 * } catch (caught) {
 *   return err(toErrorEnvelope(caught));
 * }
 * ```
 */
export function toErrorEnvelope(caught: unknown): NeventErrorEnvelope {
  if (caught instanceof NeventApiError) {
    return { error: caught.neventError };
  }
  const message =
    caught instanceof Error
      ? caught.message
      : `Unexpected error: ${String(caught)}`;
  return {
    error: {
      type: 'api_error',
      message,
      code: 'unexpected_error',
    },
  };
}

// ---------------------------------------------------------------------------
// 409 conflict mapping (nev-api)
// ---------------------------------------------------------------------------

/** Parse an error body as a JSON object, or return `undefined` when it is not one. */
function parseJsonObject(body: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Machine code of a nev-api error body. nev-api answers with `{ code }` for
 * `ConflictException(code, details)` and with `{ errorCode }` for the canonical
 * `ApiError` envelope, so both are checked.
 */
function errorCodeOf(parsed: Record<string, unknown> | undefined): string | undefined {
  const raw = parsed?.['code'] ?? parsed?.['errorCode'];
  return typeof raw === 'string' ? raw : undefined;
}

/** Render the `blockers` list of a SENDER_INELIGIBLE body as readable text. */
function describeBlockers(parsed: Record<string, unknown> | undefined): string {
  const blockers = parsed?.['blockers'];
  if (!Array.isArray(blockers) || blockers.length === 0) return '';
  const labels = blockers.map((b) => {
    if (typeof b === 'string') return b;
    if (b !== null && typeof b === 'object') {
      const o = b as Record<string, unknown>;
      const label = o['label'] ?? o['code'] ?? o['name'];
      if (typeof label === 'string') return label;
    }
    return JSON.stringify(b);
  });
  return ` Blockers reported by nev-api: ${labels.join(', ')}.`;
}

/**
 * Map a 409 `SENDER_INELIGIBLE` response (nev-api sender gate, enforced on
 * schedule/send) to an actionable error. Returns `null` when the body is not
 * that conflict, so the caller falls back to its generic handling.
 *
 * The campaign is NOT scheduled when this fires. A campaign that passed the
 * gate at schedule time can still be paused later by the same gate with pause
 * code `AUTO_PAUSED_SENDER_INELIGIBLE` if the sender becomes ineligible before
 * delivery.
 *
 * @param body - Raw response body text of the 409.
 */
export function senderIneligibleEnvelope(body: string): NeventErrorEnvelope | null {
  const parsed = parseJsonObject(body);
  if (errorCodeOf(parsed) !== 'SENDER_INELIGIBLE') return null;
  return {
    error: {
      type: 'invalid_request',
      message:
        'The campaign was NOT scheduled: the sender identity or sending domain is not eligible to send (nev-api code SENDER_INELIGIBLE).' +
        describeBlockers(parsed) +
        ' Check the tenant sending profile with nevent_get_sending_profile (domain validated, sender verified), ' +
        'fix the sender or domain in the Nevent admin panel (Settings > Senders / Domains) or choose another sender for the campaign, then schedule again. ' +
        'Note: a campaign that was already scheduled can also be paused automatically by this same check, ' +
        'in which case it shows status PAUSED with pause code AUTO_PAUSED_SENDER_INELIGIBLE; fix the sender before resuming it.',
      code: 'sender_ineligible',
    },
  };
}

/**
 * Map a 409 `template_edit_conflict` response (nev-api compare-and-set on
 * template writes) to an actionable error. Returns `null` when the body is not
 * that conflict.
 *
 * The write was NOT applied. This tool never retries on its own: the caller must
 * re-read the template, merge its change onto the current content and retry.
 *
 * @param templateId - Template the write targeted.
 * @param body       - Raw response body text of the 409.
 */
export function templateEditConflictEnvelope(
  templateId: string,
  body: string
): NeventErrorEnvelope | null {
  if (errorCodeOf(parseJsonObject(body)) !== 'template_edit_conflict') return null;
  return {
    error: {
      type: 'invalid_request',
      message:
        `Template "${templateId}" was changed by someone else (another editor, the image processor or an AI edit) since it was read, ` +
        'so your update was NOT applied and nothing was overwritten (nev-api code template_edit_conflict). ' +
        'Re-read the template with nevent_get_template, apply your change on top of the current content, and call the update again. ' +
        'Do not resend the same stale content.',
      code: 'template_edit_conflict',
    },
  };
}

// ---------------------------------------------------------------------------
// Operation mode guard
// ---------------------------------------------------------------------------

/**
 * Return an error envelope if the named tool is not permitted in the current
 * operation mode.  Returns `null` when the operation is allowed.
 *
 * Intended to be the first call in every tool handler:
 *
 * @param toolName - MCP tool name to check against the operation registry.
 * @returns `NeventErrorEnvelope` when blocked, or `null` when allowed.
 *
 * @example
 * ```ts
 * const denied = checkMode('nevent_create_segment');
 * if (denied) return err(denied);
 * ```
 */
export function checkMode(toolName: string): NeventErrorEnvelope | null {
  if (!isOperationAllowed(toolName)) {
    return {
      error: {
        type: 'invalid_request',
        message: getOperationDeniedMessage(toolName),
        code: 'operation_not_permitted',
      },
    };
  }
  return null;
}
