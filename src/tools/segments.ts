/**
 * Sprint 2: Segment management tools for the Nevent MCP Server.
 *
 * Registers 3 tools that allow agents to discover, create, and modify
 * persisted audience segments via nev-api:
 *
 *  1. nevent_list_segments   — List saved segments for the active tenant (READ)
 *  2. nevent_create_segment  — Persist a new segment definition (WRITE)
 *  3. nevent_update_segment  — Modify an existing segment (WRITE)
 *
 * ## Architecture
 *
 * Unlike Sprint 1 analytics tools (which call nev-data-api), segment
 * management operations target nev-api (the core Java Spring Boot service).
 * This follows the same pattern established by `registerTenantTools` in
 * `src/tools/tenants.ts`: the nev-api JWT token is extracted from the
 * `DataClient` instance and used directly in `fetch()` calls.
 *
 * ## Operation Mode Guards
 *
 * - `nevent_list_segments`  → READ — always permitted.
 * - `nevent_create_segment` → WRITE — blocked in READ_ONLY mode.
 * - `nevent_update_segment` → WRITE — blocked in READ_ONLY mode.
 *
 * ## Audit Logging
 *
 * Write operations emit a structured `console.error` audit log entry with:
 * toolName, tenantId, timestamp, operation, and outcome. This mirrors the
 * existing logging pattern in the rest of the codebase.
 *
 * @module tools/segments
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DataClient } from '../clients/data-client.js';
import type { SegmentRecord, ListSegmentsResponse } from '../types/segments.js';
import { ok, err, toErrorEnvelope, checkMode } from './helpers.js';
import {
  ListSegmentsSchema,
  GetSegmentSchema,
  CreateSegmentSchema,
  UpdateSegmentSchema,
} from '../schemas/segments.js';

// ---------------------------------------------------------------------------
// Helper: extract JWT token from DataClient
// ---------------------------------------------------------------------------

/**
 * Extract the JWT bearer token from a `DataClient` instance.
 *
 * `DataClient` inherits `jwtToken` as a protected member from `BaseClient`.
 * We access it via an unsafe cast — the same pattern used in `tenants.ts` —
 * because nev-api and nev-data-api share the same bearer token.
 *
 * @param client — The session's DataClient.
 * @returns The raw JWT string for use in Authorization headers.
 */
function extractJwt(client: DataClient): string {
  return (client as unknown as { jwtToken: string }).jwtToken;
}

// ---------------------------------------------------------------------------
// Helper: normalize nev-api segment list response
// ---------------------------------------------------------------------------

/**
 * Normalize any shape returned by nev-api GET /segments into a flat array.
 *
 * nev-api may return:
 * - A plain array: `[{...}, {...}]`
 * - A Spring Page envelope: `{ content: [...], totalElements: N, ... }`
 * - A custom envelope: `{ segments: [...], ... }`
 *
 * @param data — The raw parsed JSON from the API.
 * @returns Normalized segment array.
 */
function normalizeSegmentList(data: unknown): SegmentRecord[] {
  if (Array.isArray(data)) {
    return data as SegmentRecord[];
  }
  if (data !== null && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj['segments'])) {
      return obj['segments'] as SegmentRecord[];
    }
    if (Array.isArray(obj['content'])) {
      // Spring Page wrapper
      return obj['content'] as SegmentRecord[];
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Helper: normalize a single segment record
// ---------------------------------------------------------------------------

/**
 * Project a raw segment document to the fields exposed by MCP tools.
 *
 * We only expose a curated set of fields to keep the MCP response compact
 * and avoid leaking internal fields. The `_id` MongoDB field is mapped to
 * `id` if the API has not already done the conversion.
 *
 * @param raw — Raw segment record from the API.
 * @returns Projected segment with only MCP-relevant fields.
 */
function projectSegment(raw: Record<string, unknown>): SegmentRecord {
  return {
    id: String(raw['id'] ?? raw['_id'] ?? ''),
    name: String(raw['name'] ?? ''),
    estimatedCount: typeof raw['estimatedCount'] === 'number' ? raw['estimatedCount'] : undefined,
    status: typeof raw['status'] === 'string' ? raw['status'] : undefined,
    lastExecutedAt: typeof raw['lastExecutedAt'] === 'string' ? raw['lastExecutedAt'] : undefined,
    createdAt: typeof raw['createdAt'] === 'string' ? raw['createdAt'] : undefined,
    createdBy: typeof raw['createdBy'] === 'string' ? raw['createdBy'] : undefined,
    isLegacy: typeof raw['isLegacy'] === 'boolean' ? raw['isLegacy'] : undefined,
  };
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

/**
 * Register all Sprint 2 segment management tools on the MCP server.
 *
 * Call this function once during server initialization, after
 * `registerAnalyticsTools`, before connecting the transport.
 *
 * All three tools call nev-api directly (not nev-data-api) using the JWT
 * token extracted from `dataClient`. The `neventApiUrl` parameter sets the
 * base URL for those requests.
 *
 * Parameter order follows the convention established by `registerTenantTools`:
 * (server, dataClient, neventApiUrl).
 *
 * @param server       — The `McpServer` instance to register tools on.
 * @param dataClient   — The session's `DataClient` (carries JWT + activeTenantId).
 * @param neventApiUrl — Base URL of nev-api, e.g. `https://api.nevent.es`.
 */
export function registerSegmentTools(
  server: McpServer,
  dataClient: DataClient,
  neventApiUrl: string
): void {

  // -------------------------------------------------------------------------
  // Tool 1: nevent_list_segments (READ)
  // -------------------------------------------------------------------------

  server.tool(
    'nevent_list_segments',
    'List audience segments for the active tenant with names, sizes, and last execution dates.',
    ListSegmentsSchema,
    { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    async (_params) => {
      const denied = checkMode('nevent_list_segments');
      if (denied) return err(denied);

      const jwtToken = extractJwt(dataClient);
      const tenantId = dataClient.activeTenantId;

      try {
        const url = new URL(`${neventApiUrl}/segments`);
        if (tenantId) {
          url.searchParams.set('tenant_id', tenantId);
        }

        const response = await fetch(url.toString(), {
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
              type: response.status === 401 || response.status === 403 ? 'authentication_error' : 'api_error',
              message:
                response.status === 403
                  ? 'Access denied. Listing segments requires at least ADMIN role.'
                  : `Failed to list segments: HTTP ${response.status}. ${body}`,
              code: response.status === 403 ? 'forbidden' : 'api_error',
            },
          });
        }

        const data = await response.json() as unknown;
        const raw = normalizeSegmentList(data);
        const segments = raw.map((s) => projectSegment(s as Record<string, unknown>));

        const result: ListSegmentsResponse = {
          segments,
          count: segments.length,
        };

        return ok(result);
      } catch (caught) {
        return err(toErrorEnvelope(caught));
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool 1b: nevent_get_segment (READ)
  // -------------------------------------------------------------------------

  server.tool(
    'nevent_get_segment',
    'Get full details of a segment including its filter definition, estimated size, and metadata.',
    GetSegmentSchema,
    { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    async (params) => {
      const denied = checkMode('nevent_get_segment');
      if (denied) return err(denied);

      const jwtToken = extractJwt(dataClient);

      try {
        const url = `${neventApiUrl}/segments/${encodeURIComponent(params.segment_id)}`;

        const response = await fetch(url, {
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
              type: response.status === 404 ? 'not_found' :
                    response.status === 401 || response.status === 403 ? 'authentication_error' : 'api_error',
              message: response.status === 404
                ? `Segment "${params.segment_id}" not found or does not belong to the active tenant.`
                : `Failed to get segment: HTTP ${response.status}. ${body.slice(0, 200)}`,
              code: response.status === 404 ? 'not_found' : response.status === 403 ? 'forbidden' : 'api_error',
            },
          });
        }

        const data = await response.json() as Record<string, unknown>;

        return ok({
          id: data['id'] ?? data['_id'],
          name: data['name'],
          description: data['description'] ?? null,
          status: data['status'] ?? null,
          definition: data['definition'] ?? null,
          estimatedCount: data['estimatedCount'] ?? null,
          lastExecutedAt: data['lastExecutedAt'] ?? null,
          tags: data['tags'] ?? [],
          createdAt: data['createdAt'] ?? null,
          createdBy: data['createdBy'] ?? null,
          modifiedAt: data['modifiedAt'] ?? null,
          modifiedBy: data['modifiedBy'] ?? null,
        });
      } catch (caught) {
        return err(toErrorEnvelope(caught));
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool 2: nevent_create_segment (WRITE)
  // -------------------------------------------------------------------------

  server.tool(
    'nevent_create_segment',
    'Create a new audience segment with a name and filter definition. The segment is saved and can be used in campaigns.',
    CreateSegmentSchema,
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async (params) => {
      const denied = checkMode('nevent_create_segment');
      if (denied) return err(denied);

      const jwtToken = extractJwt(dataClient);
      const tenantId = dataClient.activeTenantId;

      try {
        const url = new URL(`${neventApiUrl}/segments`);
        if (tenantId) {
          url.searchParams.set('tenant_id', tenantId);
        }

        const requestBody: Record<string, unknown> = {
          name: params.name,
          definition: params.definition,
          status: 'ACTIVE',
          createdBy: 'mcp-agent',
        };

        if (params.description) {
          requestBody['description'] = params.description;
        }

        if (tenantId) {
          requestBody['tenantId'] = tenantId;
        }

        const response = await fetch(url.toString(), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${jwtToken}`,
          },
          body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout(15_000),
        });

        if (!response.ok) {
          const body = await response.text();
          return err({
            error: {
              type: response.status === 400 ? 'invalid_request' : 'api_error',
              message: `Failed to create segment: HTTP ${response.status}. ${body}`,
              code: response.status === 400 ? 'invalid_segment_definition' : 'api_error',
            },
          });
        }

        const data = await response.json() as unknown;
        const rawSegment =
          data !== null && typeof data === 'object' && 'segment' in (data as Record<string, unknown>)
            ? (data as Record<string, unknown>)['segment'] as Record<string, unknown>
            : (data as Record<string, unknown>);

        const segment = projectSegment(rawSegment);

        // Audit log for write operation
        console.error(
          JSON.stringify({
            audit: true,
            tool: 'nevent_create_segment',
            tenantId: tenantId ?? 'default',
            timestamp: new Date().toISOString(),
            operation: 'create',
            outcome: 'success',
            segmentId: segment.id,
            segmentName: segment.name,
          })
        );

        return ok({ segment });
      } catch (caught) {
        return err(toErrorEnvelope(caught));
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool 3: nevent_update_segment (WRITE)
  // -------------------------------------------------------------------------

  server.tool(
    'nevent_update_segment',
    'Update an existing segment\'s name or filter definition.',
    UpdateSegmentSchema,
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async (params) => {
      const denied = checkMode('nevent_update_segment');
      if (denied) return err(denied);

      // Runtime validation: at least one field must be provided
      if (params.name === undefined && params.definition === undefined) {
        return err({
          error: {
            type: 'invalid_request',
            message:
              'At least one of "name" or "definition" must be provided for nevent_update_segment.',
            code: 'missing_update_fields',
            param: 'name',
          },
        });
      }

      const jwtToken = extractJwt(dataClient);
      const tenantId = dataClient.activeTenantId;

      try {
        const url = new URL(`${neventApiUrl}/segments/${encodeURIComponent(params.segment_id)}`);
        if (tenantId) {
          url.searchParams.set('tenant_id', tenantId);
        }

        const requestBody: Record<string, unknown> = {
          modifiedBy: 'mcp-agent',
          modifiedAt: new Date().toISOString(),
        };

        if (params.name !== undefined) {
          requestBody['name'] = params.name;
        }

        if (params.definition !== undefined) {
          requestBody['definition'] = params.definition;
        }

        const response = await fetch(url.toString(), {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${jwtToken}`,
          },
          body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout(15_000),
        });

        if (!response.ok) {
          const body = await response.text();
          return err({
            error: {
              type:
                response.status === 404
                  ? 'not_found'
                  : response.status === 403
                    ? 'authentication_error'
                    : response.status === 400
                      ? 'invalid_request'
                      : 'api_error',
              message:
                response.status === 404
                  ? `Segment "${params.segment_id}" not found or does not belong to the active tenant.`
                  : `Failed to update segment: HTTP ${response.status}. ${body}`,
              code:
                response.status === 404
                  ? 'segment_not_found'
                  : response.status === 403
                    ? 'forbidden'
                    : response.status === 400
                      ? 'invalid_segment_definition'
                      : 'api_error',
            },
          });
        }

        const data = await response.json() as unknown;
        const rawSegment =
          data !== null && typeof data === 'object' && 'segment' in (data as Record<string, unknown>)
            ? (data as Record<string, unknown>)['segment'] as Record<string, unknown>
            : (data as Record<string, unknown>);

        const segment = projectSegment(rawSegment);

        // Audit log for write operation
        console.error(
          JSON.stringify({
            audit: true,
            tool: 'nevent_update_segment',
            tenantId: tenantId ?? 'default',
            timestamp: new Date().toISOString(),
            operation: 'update',
            outcome: 'success',
            segmentId: params.segment_id,
            updatedFields: [
              ...(params.name !== undefined ? ['name'] : []),
              ...(params.definition !== undefined ? ['definition'] : []),
            ],
          })
        );

        return ok({ segment });
      } catch (caught) {
        return err(toErrorEnvelope(caught));
      }
    }
  );
}
