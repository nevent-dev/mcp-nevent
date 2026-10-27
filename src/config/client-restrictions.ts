/**
 * Per-OAuth-client tool restrictions (NEV-1848).
 *
 * Some OAuth clients (today: the `nev-helpbot` support bot) must only ever see
 * a locked-down, read-only subset of the MCP tools, regardless of the global
 * `NEVENT_OPERATION_MODE` (FULL in production). This module answers two
 * questions:
 *
 *  1. {@link isReadOnlyClient} — is this registered OAuth client restricted?
 *  2. {@link isToolAllowedForReadOnlyClient} — may a restricted client see/call
 *     this tool?
 *
 * ## How a client is identified
 *
 * The `client_id` is minted by Dynamic Client Registration (DCR, open) and is
 * not known in advance, so the primary identification is the `redirect_uri`
 * the client registered. A client is restricted when ANY of its registered
 * redirect URIs starts with one of the prefixes in
 * `MCP_READONLY_REDIRECT_PREFIXES` (comma-separated, e.g.
 * `https://support.nevent.ai/helpbot/`). `MCP_READONLY_CLIENT_IDS`
 * (comma-separated) is an additional, exact-match option for when the helpbot
 * `client_id` is pinned.
 *
 * Matching is deliberately conservative ("any match restricts"): registering
 * extra redirect URIs can only make a client MORE restricted, never less.
 * Note that this protects against a compromised/over-powered bot; it is not a
 * barrier against a person who logs in with their own credentials through a
 * DCR client that matches no prefix (that is the unchanged, pre-existing
 * behaviour for claude.ai and similar clients).
 *
 * ## Tool policy (fail-closed)
 *
 * A tool is allowed for a restricted client only when it is classified `READ`
 * in `TOOL_OPERATIONS` AND is not in {@link EXCLUDED_TOOLS_READONLY_CLIENT}.
 * Anything unclassified is denied.
 *
 * @module config/client-restrictions
 */

import { getToolOperationType } from './operation-mode.js';
import { logger } from '../logger.js';

/**
 * Tools denied to restricted clients even though they are classified `READ`:
 *
 * - `nevent_segment_execute` — returns the full paginated contact list of a
 *   segment (PII); `nevent_segment_preview` (counts only) stays available.
 * - `nevent_list_tenants` / `nevent_switch_tenant` / `nevent_reset_tenant` —
 *   the tenant is fixed by the caller's JWT; a restricted client must never
 *   discover or switch to another tenant. `switch`/`reset` also mutate the
 *   user record for SUPERADMINs.
 */
export const EXCLUDED_TOOLS_READONLY_CLIENT: ReadonlySet<string> = new Set([
  'nevent_segment_execute',
  'nevent_list_tenants',
  'nevent_switch_tenant',
  'nevent_reset_tenant',
]);

/**
 * Returns `true` when `toolName` may be exposed to / executed by a restricted
 * client. Fail-closed: unclassified tools and any non-READ tool are denied.
 *
 * @param toolName — The MCP tool name to check.
 */
export function isToolAllowedForReadOnlyClient(toolName: string): boolean {
  if (EXCLUDED_TOOLS_READONLY_CLIENT.has(toolName)) {
    return false;
  }
  return getToolOperationType(toolName) === 'READ';
}

/** Parsed restriction policy. */
export interface ClientRestrictionPolicy {
  /** Exact `client_id` values that are restricted. */
  clientIds: ReadonlySet<string>;
  /** `redirect_uri` prefixes; a client with any matching URI is restricted. */
  redirectPrefixes: readonly string[];
}

function parseCsv(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

/**
 * Reads the restriction policy from the environment. Evaluated on every call
 * (not at module load) so tests and env overrides apply immediately.
 *
 * @param env — Environment to read; defaults to `process.env`.
 */
export function getClientRestrictionPolicy(
  env: NodeJS.ProcessEnv = process.env
): ClientRestrictionPolicy {
  return {
    clientIds: new Set(parseCsv(env['MCP_READONLY_CLIENT_IDS'])),
    redirectPrefixes: parseCsv(env['MCP_READONLY_REDIRECT_PREFIXES']),
  };
}

/** `true` when at least one restriction rule is configured. */
export function hasClientRestrictions(policy: ClientRestrictionPolicy): boolean {
  return policy.clientIds.size > 0 || policy.redirectPrefixes.length > 0;
}

/** Minimal client shape needed to evaluate the policy. */
export interface RestrictableClient {
  client_id: string;
  redirect_uris?: readonly (string | URL)[];
}

/**
 * Returns `true` when the client must be limited to read-only tools.
 *
 * @param client — Registered OAuth client (id + redirect URIs).
 * @param policy — Restriction policy (see {@link getClientRestrictionPolicy}).
 */
export function isReadOnlyClient(
  client: RestrictableClient,
  policy: ClientRestrictionPolicy = getClientRestrictionPolicy()
): boolean {
  if (policy.clientIds.has(client.client_id)) {
    return true;
  }
  const uris = (client.redirect_uris ?? []).map((u) => u.toString());
  return uris.some((uri) => policy.redirectPrefixes.some((prefix) => uri.startsWith(prefix)));
}

/**
 * Resolves the tool allowlist to apply to a new session (NEV-1848).
 *
 * - No rule configured: returns `undefined` WITHOUT calling `getClient`, so
 *   every client behaves exactly as before and no extra DB read happens.
 * - A rule is configured: the client is loaded; a matching client gets
 *   {@link isToolAllowedForReadOnlyClient}, any other client `undefined`.
 * - Fail-closed: if the client is unknown or cannot be loaded while rules are
 *   configured, the session is limited to read-only tools.
 *
 * @param clientId  — `clientId` claim of the session's access token.
 * @param getClient — Loader for the registered client (e.g. `clientsStore.getClient`).
 * @param policy    — Restriction policy; defaults to the environment.
 */
export async function resolveToolFilterForClient(
  clientId: string | undefined,
  getClient: (clientId: string) => Promise<RestrictableClient | undefined> | RestrictableClient | undefined,
  policy: ClientRestrictionPolicy = getClientRestrictionPolicy()
): Promise<((toolName: string) => boolean) | undefined> {
  if (!hasClientRestrictions(policy)) {
    return undefined;
  }
  try {
    const client = clientId ? await getClient(clientId) : undefined;
    if (!client) {
      logger.warn({ clientId: clientId ?? 'none' }, 'OAuth client not found while client restrictions are active — read-only tools only (fail-closed)');
      return isToolAllowedForReadOnlyClient;
    }
    return isReadOnlyClient(client, policy) ? isToolAllowedForReadOnlyClient : undefined;
  } catch (err) {
    logger.error({ err, clientId }, 'Could not resolve OAuth client for tool restrictions — read-only tools only (fail-closed)');
    return isToolAllowedForReadOnlyClient;
  }
}
