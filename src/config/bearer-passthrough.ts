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
 *      it is classified READ — these tools let the caller discover or change
 *      which tenant the session operates on (bearer-passthrough clients
 *      always operate in the tenant carried by their JWT; there is no
 *      session to switch).
 *
 * The resulting policy is intentionally identical to the OAuth read-only
 * client policy (`isToolAllowedForReadOnlyClient`). The product owner decided
 * on 2026-10-28 that `nevent_segment_execute` (paginated contact list, PII)
 * is exposed here too; `bearer-passthrough-read-tools-parity.test.ts` pins
 * both the decision and the equality of the two policies.
 *
 * ## Per-session write policy (NEV-1854)
 *
 * On top of the READ policy, a HUMAN session MAY also see an explicit,
 * closed allowlist of write tools ({@link BEARER_WRITE_ALLOWLIST_HUMAN}) when
 * the `MCP_BEARER_PASSTHROUGH_WRITES=human` flag is set. Rules:
 *
 *   - Default is `off`: the exposed set is exactly the READ set above.
 *   - `SERVICE` sessions NEVER see a write tool, flag or not.
 *   - Tools in {@link ALWAYS_DENIED_TOOLS_BEARER_PASSTHROUGH} are never
 *     exposed to anyone, even if one day they land in the allowlist.
 *   - A tool not classified in `TOOL_OPERATIONS` is denied (fail-closed), and
 *     so is any unknown principal type.
 *   - The allowlist is by NAME, not by operation type: `schedule_campaign` is
 *     classified DELETE (it triggers a real send) and is allowed explicitly.
 *
 * The filter is applied at tool REGISTRATION (`createNeventServer`), once per
 * MCP session, with the principal verified against nev-api `/auth/me` at
 * `initialize`. A denied tool is absent from `tools/list` and not callable.
 * Sessions are bound to that principal (`bindRequestToSession`), so the
 * policy cannot change mid-session.
 *
 * This policy alone does NOT make writes safe to enable: the real barrier is
 * the signed single-use write grant (NEV-1855). See
 * {@link WRITE_GRANT_ENFORCEMENT_AVAILABLE}.
 *
 * @module config/bearer-passthrough
 */

import { getToolOperationType } from './operation-mode.js';
import type { PrincipalType } from '../auth/session-verifier.js';
import type { OperationMode } from './operation-mode.js';

/**
 * Tools excluded from `bearer-passthrough` mode even though they are
 * classified `READ`:
 *
 * - `nevent_list_tenants` / `nevent_switch_tenant` / `nevent_reset_tenant` —
 *   tenant is resolved server-side from the caller's JWT; a bearer-passthrough
 *   client must never be able to discover or switch to a tenant other than
 *   the one its own token grants.
 */
export const EXCLUDED_TOOLS_BEARER_PASSTHROUGH: ReadonlySet<string> = new Set([
  'nevent_list_tenants',
  'nevent_switch_tenant',
  'nevent_reset_tenant',
]);

/**
 * Tools no bearer-passthrough session may ever see, regardless of principal
 * or the writes flag: the tenant-discovery/switching trio plus image upload
 * and deletion (out of scope for the assistant in v1).
 */
export const ALWAYS_DENIED_TOOLS_BEARER_PASSTHROUGH: ReadonlySet<string> = new Set([
  ...EXCLUDED_TOOLS_BEARER_PASSTHROUGH,
  'nevent_upload_image',
  'nevent_delete_image',
]);

/**
 * v1 write allowlist for HUMAN sessions (product decision, Epic NEV-1851).
 * Closed list: adding a tool here is a reviewed decision, pinned by
 * `bearer-write-policy*.test.ts`.
 */
export const BEARER_WRITE_ALLOWLIST_HUMAN: ReadonlySet<string> = new Set([
  'nevent_create_segment',
  'nevent_update_segment',
  'nevent_create_template',
  'nevent_update_template',
  'nevent_clone_template',
  'nevent_rename_template',
  'nevent_send_test_template',
  'nevent_create_campaign',
  // Classified DELETE in TOOL_OPERATIONS (real send); allowed by name.
  'nevent_schedule_campaign',
  'nevent_create_short_url',
  'nevent_update_short_url',
  'nevent_create_bulk_user_short_urls',
]);

/** Env var that switches the write policy on. */
export const BEARER_WRITES_ENV = 'MCP_BEARER_PASSTHROUGH_WRITES';

/**
 * Explicit, loud opt-out of the grant requirement. Only meaningful while
 * {@link WRITE_GRANT_ENFORCEMENT_AVAILABLE} is false; non-production only.
 */
export const WRITES_WITHOUT_GRANT_ENV = 'MCP_BEARER_PASSTHROUGH_WRITES_UNSAFE_NO_GRANT';

/**
 * TODO(NEV-1855): flip to `true` when the signed single-use write-grant
 * verification is implemented and wired into the write tools. Until then the
 * process refuses to start with writes enabled unless
 * {@link WRITES_WITHOUT_GRANT_ENV} is set to `true`.
 */
export const WRITE_GRANT_ENFORCEMENT_AVAILABLE = false;

/** `off` (default): READ only. `human`: HUMAN sessions also get the allowlist. */
export type BearerWritesMode = 'off' | 'human';

/**
 * Parses `MCP_BEARER_PASSTHROUGH_WRITES`. Unset/empty -> `off`. Any value
 * other than `off`/`human` throws (a typo must never silently widen or
 * silently narrow the policy).
 */
export function parseBearerWritesMode(raw: string | undefined): BearerWritesMode {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '' || value === 'off') return 'off';
  if (value === 'human') return 'human';
  throw new Error(`${BEARER_WRITES_ENV} must be "off" or "human" (got an unsupported value).`);
}

/**
 * Per-session predicate: may a session of `session.principalType` see/call
 * `toolName` under `writesMode`? Fail-closed on unknown tools and principals.
 */
export function isToolAllowedForSession(
  toolName: string,
  session: { principalType: PrincipalType },
  writesMode: BearerWritesMode
): boolean {
  if (ALWAYS_DENIED_TOOLS_BEARER_PASSTHROUGH.has(toolName)) return false;
  const op = getToolOperationType(toolName);
  if (op === undefined) return false;
  if (op === 'READ') return true;
  return (
    writesMode === 'human' &&
    session.principalType === 'HUMAN' &&
    BEARER_WRITE_ALLOWLIST_HUMAN.has(toolName)
  );
}

/** Builds the `toolFilter` for one session (bound to its verified principal). */
export function createBearerToolFilter(
  principalType: PrincipalType,
  writesMode: BearerWritesMode
): (toolName: string) => boolean {
  return (toolName) => isToolAllowedForSession(toolName, { principalType }, writesMode);
}

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

/** A log line the caller must emit after {@link assertWritesStartupAllowed}. */
export interface StartupLog {
  level: 'error' | 'warn';
  message: string;
}

/**
 * Pure startup gate for the bearer-passthrough write policy. Throws when the
 * combination of settings would expose writes unsafely; otherwise returns the
 * log lines the caller should emit.
 *
 * - `off` + `UNSAFE_NO_GRANT=true` -> warning that the override is ignored.
 * - `human` + no write grant available:
 *     - override not exactly `true` (unset, `TRUE`, `1`, ...) -> throws;
 *     - override `true` but `NODE_ENV=production` -> throws;
 *     - override `true` otherwise -> allowed, with an ERROR-level log.
 * - `human` + `READ_ONLY` operation mode -> throws (every write would be
 *   rejected at call time while listed); `STANDARD` -> warning that
 *   `schedule_campaign` (DELETE) needs `FULL`.
 *
 * @param mode - Parsed `MCP_BEARER_PASSTHROUGH_WRITES`.
 * @param env - Environment (injected for testing).
 * @param grantAvailable - Whether write-grant enforcement exists (NEV-1855).
 * @param operationMode - Call-time `NEVENT_OPERATION_MODE`.
 */
export function assertWritesStartupAllowed(
  mode: BearerWritesMode,
  env: Readonly<Record<string, string | undefined>>,
  grantAvailable: boolean,
  operationMode: OperationMode
): StartupLog[] {
  const logs: StartupLog[] = [];
  const unsafe = env[WRITES_WITHOUT_GRANT_ENV] === 'true';

  if (mode === 'off') {
    if (unsafe) {
      logs.push({
        level: 'warn',
        message: `${WRITES_WITHOUT_GRANT_ENV}=true is ignored because ${BEARER_WRITES_ENV} is not "human". Remove it.`,
      });
    }
    return logs;
  }

  if (!grantAvailable) {
    if (!unsafe) {
      throw new Error(
        `${BEARER_WRITES_ENV}=human requires the write-grant verification (NEV-1855), which is not available in this build. ` +
          `Leave ${BEARER_WRITES_ENV} unset, or set ${WRITES_WITHOUT_GRANT_ENV}=true (exactly) for NON-production testing only.`
      );
    }
    if (env['NODE_ENV'] === 'production') {
      throw new Error(
        `${WRITES_WITHOUT_GRANT_ENV}=true is not allowed when NODE_ENV=production: writes without a write grant cannot run in production.`
      );
    }
    logs.push({
      level: 'error',
      message:
        `WRITES ENABLED WITHOUT A WRITE GRANT (${WRITES_WITHOUT_GRANT_ENV}=true). HUMAN sessions can execute the write ` +
        'allowlist with no per-action confirmation proof. Never use in production.',
    });
  }

  if (operationMode === 'READ_ONLY') {
    throw new Error(
      `${BEARER_WRITES_ENV}=human needs NEVENT_OPERATION_MODE=STANDARD or FULL: with READ_ONLY every write would be listed but rejected at call time.`
    );
  }
  if (operationMode === 'STANDARD') {
    logs.push({
      level: 'warn',
      message: 'NEVENT_OPERATION_MODE=STANDARD: nevent_schedule_campaign (classified DELETE) needs FULL and will be rejected at call time.',
    });
  }
  return logs;
}
