/**
 * Multi-tenant tools for the Nevent MCP Server.
 *
 * Registers 2 tools that enable users with hierarchical tenant access
 * (SUPERADMIN / OWNER) to discover and switch between tenants:
 *
 *  1. nevent_list_tenants   — List all tenants accessible to the current user
 *  2. nevent_switch_tenant  — Set the active tenant for this MCP session
 *
 * ## How tenant switching works
 *
 * Each MCP session in HTTP mode has its own `DataClient` instance (per-session
 * rather than shared). `nevent_switch_tenant` sets `DataClient.activeTenantId`
 * on the session's client so that subsequent data-api calls include the
 * `tenant_id` field in their request bodies, routing the query to the
 * specified tenant's data.
 *
 * ## Roles
 *
 * - SUPERADMIN: can list and query all tenants
 * - OWNER: can list and query their tenant and immediate children
 * - ADMIN: can only query their own tenant (switching has no effect)
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
import type { DataClient } from '../clients/data-client.js';
import { NeventApiError } from '../clients/base-client.js';
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
 *
 * @param result — The result object to serialize.
 */
function ok(result: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  };
}

/**
 * Wrap a `NeventErrorEnvelope` as an MCP error content block.
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
      'Subsequent analytics and segmentation queries will use this tenant\'s data. ' +
      'Use nevent_list_tenants to discover available tenant IDs.'
    ),
};

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

/**
 * Register multi-tenant tools on the MCP server.
 *
 * These tools require the nev-api URL to call tenant management endpoints.
 * They are registered in HTTP mode only (where per-session DataClients exist)
 * but can also be registered in stdio mode using a shared DataClient.
 *
 * @param server      — The `McpServer` instance to register tools on.
 * @param client      — The session's `DataClient` (carries `activeTenantId`).
 * @param neventApiUrl — Base URL of nev-api, e.g. `https://api.nevent.es`.
 *   Used to call GET /tenants for the tenant list.
 */
export function registerTenantTools(
  server: McpServer,
  client: DataClient,
  neventApiUrl: string
): void {

  // -------------------------------------------------------------------------
  // Tool 1: nevent_list_tenants
  // -------------------------------------------------------------------------
  server.tool(
    'nevent_list_tenants',
    'List all Nevent tenants (clients) accessible to the authenticated user.',
    ListTenantsSchema,
    { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    async (_params) => {
      try {
        // Call nev-api GET /tenants using the DataClient's JWT token.
        // We reach into the protected jwtToken via a cast because the tenant
        // list endpoint is on nev-api, not nev-data-api, but they share the
        // same bearer token (the user's nev-api JWT).
        const jwtToken = (client as unknown as { jwtToken: string }).jwtToken;

        const response = await fetch(`${neventApiUrl}/tenants`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${jwtToken}`,
          },
          signal: AbortSignal.timeout(15_000),
        });

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

        // nev-api may return the list as an array or wrapped in an envelope.
        let tenants: TenantRecord[];
        if (Array.isArray(data)) {
          tenants = data as TenantRecord[];
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
          // Spring Page wrapper: { content: [], totalElements, ... }
          tenants = (data as { content: TenantRecord[] }).content;
        } else {
          tenants = [];
        }

        return ok({ tenants, count: tenants.length });
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
    'Switch the active tenant for this session. All subsequent queries will use the specified tenant\'s data.',
    SwitchTenantSchema,
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async (params) => {
      try {
        // Update the session's DataClient to send this tenant_id in future requests.
        // Since DataClient is per-session in HTTP mode, this only affects the
        // current user's session.
        client.setActiveTenant(params.tenant_id);

        console.error(
          `[nevent-mcp] Tenant switched | activeTenantId=${params.tenant_id}`
        );

        return ok({
          success: true,
          active_tenant_id: params.tenant_id,
          message:
            `Active tenant set to "${params.tenant_id}". ` +
            'All subsequent analytics and segmentation queries will use this tenant\'s data. ' +
            'Call nevent_switch_tenant again with a different tenant_id to change, ' +
            'or use the tenant_id parameter on individual nevent_analytics_query calls for a one-off override.',
        });
      } catch (caught) {
        return err(toErrorEnvelope(caught));
      }
    }
  );
}
