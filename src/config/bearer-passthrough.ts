/**
 * Tool allowlist for the `bearer-passthrough` HTTP auth mode.
 *
 * `bearer-passthrough` is meant for trusted internal clients (e.g. the
 * `nev-helpbot` Chatwoot support bot) that call MCP tools on behalf of the
 * promoter currently chatting, forwarding that promoter's own nev-api JWT on
 * every request. See `src/transports/http.ts` for the transport itself.
 *
 * This module answers one question — "is this tool exposed in
 * bearer-passthrough mode?" — independently of `NEVENT_OPERATION_MODE`
 * (which governs the OAuth transport instead). The rule is:
 *
 *   1. The tool must be classified `READ` in `TOOL_OPERATIONS`
 *      (`src/config/operation-mode.ts`). An unclassified tool is denied
 *      (fail-closed), same as the general operation-mode guard.
 *   2. The tool must NOT be in `EXCLUDED_TOOLS_BEARER_PASSTHROUGH`, even if
 *      it is classified READ — these tools either return PII outside the
 *      normal analytics/segmentation shape, or let the caller change which
 *      tenant the session operates on (bearer-passthrough clients always
 *      operate in the tenant carried by their JWT; there is no session to
 *      switch).
 *
 * @module config/bearer-passthrough
 */

import { getToolOperationType } from './operation-mode.js';

/**
 * Tools excluded from `bearer-passthrough` mode even though they are
 * classified `READ`:
 *
 * - `nevent_segment_execute` — returns the full paginated contact list for a
 *   segment (PII), unlike `nevent_segment_preview` which only returns counts.
 * - `nevent_list_tenants` / `nevent_switch_tenant` / `nevent_reset_tenant` —
 *   tenant is resolved server-side from the caller's JWT; a bearer-passthrough
 *   client must never be able to discover or switch to a tenant other than
 *   the one its own token grants.
 */
export const EXCLUDED_TOOLS_BEARER_PASSTHROUGH: ReadonlySet<string> = new Set([
  'nevent_segment_execute',
  'nevent_list_tenants',
  'nevent_switch_tenant',
  'nevent_reset_tenant',
]);

/**
 * Returns `true` when `toolName` should be registered (and therefore
 * discoverable and callable) in `bearer-passthrough` HTTP mode.
 *
 * Fail-closed: a tool that is not classified `READ` in `TOOL_OPERATIONS` —
 * including tools unknown to the registry entirely — is denied.
 *
 * @param toolName — The MCP tool name to check.
 */
export function isToolAllowedInBearerPassthrough(toolName: string): boolean {
  if (EXCLUDED_TOOLS_BEARER_PASSTHROUGH.has(toolName)) {
    return false;
  }
  return getToolOperationType(toolName) === 'READ';
}
