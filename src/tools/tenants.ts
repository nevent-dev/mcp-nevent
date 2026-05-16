/**
 * Multi-tenant tools for the Nevent MCP Server.
 *
 * Registers 3 tools that enable users with hierarchical tenant access
 * (SUPERADMIN / OWNER) to discover and switch between tenants:
 *
 *  1. nevent_list_tenants   — List all tenants accessible to the current user
 *  2. nevent_switch_tenant  — Set the active tenant for this MCP session
 *  3. nevent_reset_tenant   — Restore the original home tenant (SUPERADMIN safety net)
 *
 * ## How tenant switching works
 *
 * Each MCP session in HTTP mode has its own `SessionClients` instance (per-session
 * rather than shared). `nevent_switch_tenant` calls `POST /users/tenant` on nev-api
 * to obtain a new JWT scoped to the target tenant, then rotates the JWT in all
 * session clients via `sessionClients.rotateJwt()`. Subsequent data-api calls carry
 * the new token, which nev-data-api resolves to the correct tenant server-side.
 *
 * ## SUPERADMIN warning
 *
 * For SUPERADMIN users, `POST /users/tenant` MUTATES the user record in the database.
 * The switch persists until explicitly reversed. Always call `nevent_reset_tenant`
 * after completing cross-tenant work to restore the original context.
 *
 * ## Roles
 *
 * - SUPERADMIN: can list and query all tenants; switch MUTATES the DB record.
 * - OWNER: can list and query their tenant and descendants (up to 3 levels deep).
 * - ADMIN/STAFF: session-scoped only — cannot switch to non-descendant tenants.
 *
 * ## nev-api endpoint
 *
 * Tenant listing calls nev-api (not nev-data-api) because tenant metadata
 * (id, name, domain, hierarchy level) is owned by the core API service.
 * The nev-api endpoint GET /tenants returns the tenant list filtered by the
 * authenticated user's permissions.
 *
 * @module tools/tenants
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { NeventApiError } from '../clients/base-client.js';
import type { SessionClients } from '../clients/session-clients.js';
import type { NeventErrorEnvelope } from '../types/common.js';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Tenant API types
// ---------------------------------------------------------------------------

/** A single tenant record from nev-api GET /tenants. */
interface TenantRecord {
  /** Unique tenant identifier. */
  id: string;
  /** Human-readable tenant name. */
  name: string;
  /** Primary domain associated with the tenant. */
  domain?: string;
  /** Hierarchy level (0 = root / SUPERADMIN-owned, higher = deeper). */
  level?: number;
  /** Parent tenant ID (for hierarchical tenants). */
  parentId?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wrap a result object as an MCP text content block.
 * Success responses are NOT pretty-printed to save LLM tokens.
 *
 * @param result — The result object to serialize.
 */
function ok(result: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
  };
}

/**
 * Wrap a `NeventErrorEnvelope` as an MCP error content block.
 * Errors ARE pretty-printed to aid human debugging.
 *
 * @param envelope — The structured error envelope to serialize.
 */
function err(
  envelope: NeventErrorEnvelope
): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return {
    content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
    isError: true,
  };
}

/**
 * Convert any caught error to a `NeventErrorEnvelope`.
 *
 * @param caught — The value thrown from an async handler.
 */
function toErrorEnvelope(caught: unknown): NeventErrorEnvelope {
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
// Tool schemas
// ---------------------------------------------------------------------------

/** Input schema for `nevent_list_tenants` — no parameters required. */
const ListTenantsSchema = {};

/** Input schema for `nevent_switch_tenant`. */
const SwitchTenantSchema = {
  /** The tenant ID to activate for this session. */
  tenant_id: z
    .string()
    .describe(
      'The tenant ID to activate for this MCP session. ' +
      'All subsequent analytics, segmentation, campaign, and paid media queries will use this tenant\'s data. ' +
      'Use nevent_list_tenants to discover available tenant IDs. ' +
      'SUPERADMIN: this mutates your user record in the database; call nevent_reset_tenant when done. ' +
      'OWNER/ADMIN/STAFF: session-scoped only (can only switch to descendants in your tenant hierarchy).'
    ),
};

/** Input schema for `nevent_reset_tenant` — no parameters required. */
const ResetTenantSchema = {};

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

/**
 * Register multi-tenant tools on the MCP server.
 *
 * These tools require the nev-api URL to call tenant management endpoints.
 * They are registered in both HTTP mode (per-session SessionClients) and
 * stdio mode (shared SessionClients).
 *
 * @param server         — The `McpServer` instance to register tools on.
 * @param sessionClients — The session's `SessionClients` (carries both clients + refresh token).
 * @param neventApiUrl   — Base URL of nev-api, e.g. `https://api.nevent.es`.
 *   Used to call GET /tenants for the tenant list.
 */
export function registerTenantTools(
  server: McpServer,
  sessionClients: SessionClients,
  neventApiUrl: string
): void {

  // -------------------------------------------------------------------------
  // Tool 1: nevent_list_tenants
  // -------------------------------------------------------------------------
  server.tool(
    'nevent_list_tenants',
    'List all Nevent tenants (clients) accessible to the authenticated user. ' +
    'Returns tenant IDs and names for use with nevent_switch_tenant. ' +
    'SUPERADMIN: returns all tenants in the platform. ' +
    'OWNER/ADMIN: returns only your tenant hierarchy subtree (up to 3 levels).',
    ListTenantsSchema,
    { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    async (_params) => {
      try {
        // Call nev-api GET /tenants using the DataClient's JWT token.
        // We reach into the protected jwtToken via a cast because the tenant
        // list endpoint is on nev-api, not nev-data-api, but they share the
        // same bearer token (the user's nev-api JWT).
        const jwtToken = (sessionClients.dataClient as unknown as { jwtToken: string }).jwtToken;

        // Try /platform/tenants first (SUPERADMIN — returns all tenants).
        // If 403, fall back to /users/accessible-tenants (ADMIN/OWNER — returns hierarchy).
        let response = await fetch(`${neventApiUrl}/platform/tenants`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${jwtToken}`,
          },
          signal: AbortSignal.timeout(30_000),
        });

        if (response.status === 403) {
          // Not SUPERADMIN — fall back to accessible tenants
          response = await fetch(`${neventApiUrl}/users/accessible-tenants`, {
            method: 'GET',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${jwtToken}`,
            },
            signal: AbortSignal.timeout(30_000),
          });
        }

        if (!response.ok) {
          const body = await response.text();
          return err({
            error: {
              type: response.status === 403 ? 'authentication_error' : 'api_error',
              message:
                response.status === 403
                  ? 'Access denied. Listing tenants requires OWNER or SUPERADMIN role.'
                  : `Failed to list tenants: HTTP ${response.status}. ${body}`,
              code: response.status === 403 ? 'forbidden' : 'api_error',
            },
          });
        }

        const data = await response.json() as unknown;

        // Response shapes:
        // - /platform/tenants (SUPERADMIN): plain array of tenant objects
        // - /users/accessible-tenants (ADMIN/OWNER): { root, children, flatList, totalTenants }
        // - Single tenant object: { id, name, ... }
        let tenants: TenantRecord[];
        if (Array.isArray(data)) {
          tenants = data as TenantRecord[];
        } else if (
          data !== null &&
          typeof data === 'object' &&
          'flatList' in data &&
          Array.isArray((data as Record<string, unknown>)['flatList'])
        ) {
          // /users/accessible-tenants response — use flatList + root
          const accessible = data as { root?: TenantRecord; flatList: TenantRecord[] };
          tenants = accessible.flatList;
          if (accessible.root) {
            tenants = [accessible.root, ...tenants];
          }
        } else if (
          data !== null &&
          typeof data === 'object' &&
          'tenants' in data &&
          Array.isArray((data as Record<string, unknown>)['tenants'])
        ) {
          tenants = (data as { tenants: TenantRecord[] }).tenants;
        } else if (
          data !== null &&
          typeof data === 'object' &&
          'content' in data &&
          Array.isArray((data as Record<string, unknown>)['content'])
        ) {
          tenants = (data as { content: TenantRecord[] }).content;
        } else if (
          data !== null &&
          typeof data === 'object' &&
          'id' in data
        ) {
          // Single tenant object — wrap in array
          tenants = [data as TenantRecord];
        } else {
          tenants = [];
        }

        // Slim response: only id + name to avoid huge payloads (328 tenants × full objects)
        const slim = tenants.map(t => ({ id: t.id, name: t.name }));

        return ok({ tenants: slim, count: slim.length, home_tenant_id: sessionClients.homeTenantId ?? null });
      } catch (caught) {
        return err(toErrorEnvelope(caught));
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool 2: nevent_switch_tenant
  // -------------------------------------------------------------------------
  server.tool(
    'nevent_switch_tenant',
    'Switch the active tenant for this session. All subsequent queries (analytics, segments, campaigns, paid media) will use the specified tenant\'s data. ' +
    'SUPERADMIN: this mutates your user record in the database — the switch PERSISTS. Always call nevent_reset_tenant when cross-tenant work is done to avoid leaving your account pointing at another tenant. ' +
    'OWNER/ADMIN/STAFF: session-scoped only; you can only switch to tenants in your hierarchy subtree (max 3 levels deep). ' +
    'Use nevent_list_tenants to discover available tenant IDs.',
    SwitchTenantSchema,
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async (params) => {
      try {
        const jwtToken = (sessionClients.dataClient as unknown as { jwtToken: string }).jwtToken;

        // Call POST /users/tenant to get a NEW JWT for the target tenant.
        // This is the same endpoint the admin panel uses when switching tenants.
        // nev-api returns a fresh access_token + refresh_token scoped to the new tenant.
        const response = await fetch(`${neventApiUrl}/users/tenant`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${jwtToken}`,
          },
          body: JSON.stringify({ tenantId: params.tenant_id }),
          signal: AbortSignal.timeout(30_000),
        });

        if (!response.ok) {
          const body = await response.text();
          console.error(`[nevent-mcp] Tenant switch failed | status=${response.status} | body=${body.slice(0, 200)}`);
          return err({
            error: {
              type: response.status === 403 ? 'authentication_error' : 'api_error',
              message: `Failed to switch tenant: HTTP ${response.status}. You may not have access to this tenant.`,
              code: response.status === 403 ? 'forbidden' : 'api_error',
            },
          });
        }

        const data = await response.json() as Record<string, unknown>;
        // Support both casing variants from different nev-api versions
        const newAccessToken = (data['access_token'] ?? data['accessToken']) as string | undefined;
        const newRefreshToken = (data['refresh_token'] ?? data['refreshToken']) as string | undefined;

        if (newAccessToken) {
          if (newRefreshToken) {
            // Rotate both tokens — also invalidates all caches
            sessionClients.rotateTokens(newAccessToken, newRefreshToken);
          } else {
            // Only access token available — still invalidates caches
            sessionClients.rotateJwt(newAccessToken);
          }
        }

        console.error(
          `[nevent-mcp] Tenant switched | targetTenantId=${params.tenant_id} | newToken=${!!newAccessToken}`
        );

        return ok({
          success: true,
          switched_to_tenant_id: params.tenant_id,
          home_tenant_id: sessionClients.homeTenantId ?? null,
          message: `Switched to tenant "${params.tenant_id}". All subsequent queries will use this tenant's data. ` +
            (sessionClients.homeTenantId
              ? 'Call nevent_reset_tenant to return to your home tenant when done.'
              : ''),
        });
      } catch (caught) {
        return err(toErrorEnvelope(caught));
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool 3: nevent_reset_tenant
  // -------------------------------------------------------------------------
  server.tool(
    'nevent_reset_tenant',
    'Restore the original tenant context set at session start. ' +
    'ALWAYS call this after cross-tenant queries (nevent_switch_tenant) to avoid leaving your SUPERADMIN account pointing to another tenant. ' +
    'For SUPERADMIN users, tenant switches PERSIST in the user record in the database — this tool reverses that. ' +
    'For OWNER/ADMIN/STAFF users, this resets to the session\'s home tenant. ' +
    'No parameters needed.',
    ResetTenantSchema,
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async (_params) => {
      try {
        const homeTenantId = sessionClients.homeTenantId;

        if (!homeTenantId) {
          return err({
            error: {
              type: 'invalid_request',
              message: 'Home tenant ID is not set for this session. Cannot reset tenant.',
              code: 'not_found',
            },
          });
        }

        const jwtToken = (sessionClients.dataClient as unknown as { jwtToken: string }).jwtToken;

        // Call the same endpoint as switch_tenant but with the home tenant ID
        const response = await fetch(`${neventApiUrl}/users/tenant`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${jwtToken}`,
          },
          body: JSON.stringify({ tenantId: homeTenantId }),
          signal: AbortSignal.timeout(30_000),
        });

        if (!response.ok) {
          const body = await response.text();
          console.error(`[nevent-mcp] Tenant reset failed | status=${response.status} | body=${body.slice(0, 200)}`);
          return err({
            error: {
              type: response.status === 403 ? 'authentication_error' : 'api_error',
              message: `Failed to reset tenant: HTTP ${response.status}. Cannot restore home tenant "${homeTenantId}".`,
              code: response.status === 403 ? 'forbidden' : 'api_error',
            },
          });
        }

        const data = await response.json() as Record<string, unknown>;
        const newAccessToken = (data['access_token'] ?? data['accessToken']) as string | undefined;
        const newRefreshToken = (data['refresh_token'] ?? data['refreshToken']) as string | undefined;

        if (newAccessToken) {
          if (newRefreshToken) {
            sessionClients.rotateTokens(newAccessToken, newRefreshToken);
          } else {
            sessionClients.rotateJwt(newAccessToken);
          }
        }

        console.error(
          `[nevent-mcp] Tenant reset | homeTenantId=${homeTenantId} | newToken=${!!newAccessToken}`
        );

        return ok({
          success: true,
          active_tenant_id: homeTenantId,
          message: `Successfully restored home tenant "${homeTenantId}". All subsequent queries will use your original tenant's data.`,
        });
      } catch (caught) {
        return err(toErrorEnvelope(caught));
      }
    }
  );
}
