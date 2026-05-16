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
