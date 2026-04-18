/**
 * Sprint 1: Analytics + Segmentation tools for the Nevent MCP Server.
 *
 * Registers 9 tools against the nev-data-api (data.nevent.es):
 *
 *  Analytics (5 tools):
 *   1. nevent_analytics_query         — Execute BigQuery analytics query
 *   2. nevent_analytics_capabilities  — Discover available tables
 *   3. nevent_analytics_table_schema  — Get column schema for a table
 *   4. nevent_analytics_filter_values — Discover distinct field values
 *   5. nevent_campaign_report         — Comprehensive campaign report (v3.19.0)
 *
 *  Segmentation (4 tools):
 *   6. nevent_segmentation_criteria   — List all segment criteria
 *   7. nevent_segment_preview         — Preview audience size (non-persisting)
 *   8. nevent_segment_execute         — Execute segment, get paginated contacts
 *   9. nevent_dimension_values        — Autocomplete values for a criterion
 *
 * Each tool handler:
 *  1. Checks operation mode (all Sprint 1 tools are READ — always allowed)
 *  2. Calls the DataClient method
 *  3. Returns `{ content: [{ type: "text", text: JSON.stringify(result) }] }`
 *  4. On error: returns `{ content: [...], isError: true }` with structured error
 *
 * Updated for nev-data-api v3.19.0:
 *  - nevent_analytics_query passes all new optional fields to the API
 *  - dryRun parameter is forwarded as a query param (?dryRun=true)
 *  - nevent_campaign_report tool added
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DataClient } from '../clients/data-client.js';
import { NeventApiError } from '../clients/base-client.js';
import { isOperationAllowed, getOperationDeniedMessage } from '../config/operation-mode.js';
import type { NeventErrorEnvelope } from '../types/common.js';
import {
  AnalyticsQuerySchema,
  AnalyticsCapabilitiesSchema,
  AnalyticsTableSchemaInputSchema,
  AnalyticsFilterValuesSchema,
  SegmentationCriteriaSchema,
  SegmentPreviewSchema,
  SegmentExecuteSchema,
  DimensionValuesSchema,
  CampaignReportSchema,
} from '../schemas/analytics.js';

// ---------------------------------------------------------------------------
// Helper: build a success content block
// ---------------------------------------------------------------------------

/**
 * Wrap a result object as an MCP text content block.
 * Every tool response must be serialized to JSON text.
 *
 * @param result — The result object to serialize.
 */
function ok(result: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  };
}

// ---------------------------------------------------------------------------
// Helper: build an error content block
// ---------------------------------------------------------------------------

/**
 * Wrap a `NeventErrorEnvelope` as an MCP error content block.
 * Setting `isError: true` signals to the MCP client that this is a failure.
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

// ---------------------------------------------------------------------------
// Helper: convert any thrown value to a NeventErrorEnvelope
// ---------------------------------------------------------------------------

/**
 * Map any caught error into a `NeventErrorEnvelope` suitable for MCP output.
 *
 * Handles:
 * - `NeventApiError` — already has a structured `NeventError` inside
 * - Generic `Error`  — wrapped as `api_error`
 * - Unknown values   — wrapped as `api_error` with string coercion
 *
 * @param caught — The value thrown from an async tool handler.
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
// Helper: guard for operation mode
// ---------------------------------------------------------------------------

/**
 * Return an error envelope if the tool is not permitted in the current mode.
 * Returns `null` when the operation is allowed.
 *
 * @param toolName — MCP tool name to check.
 */
function checkMode(
  toolName: string
): NeventErrorEnvelope | null {
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

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

/**
 * Register all Sprint 1 analytics + segmentation tools on the MCP server.
 *
 * Call this function once during server initialization before connecting
 * the transport.
 *
 * @param server — The `McpServer` instance to register tools on.
 * @param client — The `DataClient` instance connected to data.nevent.es.
 */
export function registerAnalyticsTools(server: McpServer, client: DataClient): void {

  // -------------------------------------------------------------------------
  // Tool 1: nevent_analytics_query
  // -------------------------------------------------------------------------
  server.tool(
    'nevent_analytics_query',
    'Query event marketing analytics. Supports dimensions, metrics, time ranges, and filters across campaigns, purchases, users, and more. IMPORTANT: Call nevent_analytics_capabilities first to discover available tables and columns — do not guess field names.',
    AnalyticsQuerySchema,
    { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    async (params) => {
      const denied = checkMode('nevent_analytics_query');
      if (denied) return err(denied);

      try {
        const result = await client.queryAnalytics(
          {
            collection: params.collection,
            dimensions: params.dimensions,
            metrics: params.metrics,
            timeRange: params.timeRange,
            filters: params.filters as typeof params.filters,
            having: params.having as typeof params.having,
            sort: params.sort,
            limit: params.limit,
            compareDimensions: params.compareDimensions,
            // v3.19.0 new fields — all optional, only included when provided
            distinct: params.distinct,
            timeGranularity: params.timeGranularity,
            groupBy: params.groupBy,
            comparePeriods: params.comparePeriods,
            ctes: params.ctes,
            sourceTable: params.sourceTable,
          },
          params.tenant_id,
          // dryRun is forwarded as a query param, not in the body
          params.dryRun
        );
        return ok(result);
      } catch (caught) {
        return err(toErrorEnvelope(caught));
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool 2: nevent_analytics_capabilities
  // -------------------------------------------------------------------------
  server.tool(
    'nevent_analytics_capabilities',
    'Discover all available analytics tables and their columns. Call this before nevent_analytics_query to learn valid table and field names.',
    AnalyticsCapabilitiesSchema,
    { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    async (_params) => {
      const denied = checkMode('nevent_analytics_capabilities');
      if (denied) return err(denied);

      try {
        const fullResult = await client.getCapabilities();

        // Slim down the response — the full payload is ~865KB (19 tables × 200 fields)
        // which is too large for LLM tool responses. Return table summaries only.
        // Use nevent_analytics_table_schema for field details of a specific table.
        const raw = fullResult as unknown as Record<string, unknown>;
        const dataObj = (raw['data'] ?? raw) as Record<string, unknown>;
        const rawTables = dataObj['tables'];
        const tables = Array.isArray(rawTables) ? rawTables : [];

        const summary = tables.map((t: Record<string, unknown>) => ({
          name: t['name'],
          description: t['description'] ?? null,
          timeField: t['timeField'] ?? null,
          tenantField: t['tenantField'] ?? null,
          fieldCount: Array.isArray(t['fields']) ? (t['fields'] as unknown[]).length : 0,
        }));

        return ok({
          tables: summary,
          count: summary.length,
          hint: 'Use nevent_analytics_table_schema with a specific table name to get the full list of fields.',
        });
      } catch (caught) {
        return err(toErrorEnvelope(caught));
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool 3: nevent_analytics_table_schema
  // -------------------------------------------------------------------------
  server.tool(
    'nevent_analytics_table_schema',
    'Get the full column schema for a specific analytics table including column names, types, and descriptions.',
    AnalyticsTableSchemaInputSchema,
    { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    async (params) => {
      const denied = checkMode('nevent_analytics_table_schema');
      if (denied) return err(denied);

      try {
        const result = await client.getTableSchema(params.table);
        return ok(result);
      } catch (caught) {
        return err(toErrorEnvelope(caught));
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool 4: nevent_analytics_filter_values
  // -------------------------------------------------------------------------
  server.tool(
    'nevent_analytics_filter_values',
    'Get distinct values available for a field in an analytics table. Useful for building valid filter values before querying.',
    AnalyticsFilterValuesSchema,
    { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    async (params) => {
      const denied = checkMode('nevent_analytics_filter_values');
      if (denied) return err(denied);

      try {
        const result = await client.getFilterValues(params.collection, params.filters);
        return ok(result);
      } catch (caught) {
        return err(toErrorEnvelope(caught));
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool 5: nevent_campaign_report (v3.19.0)
  // -------------------------------------------------------------------------
  server.tool(
    'nevent_campaign_report',
    'Generate a comprehensive analytics report for a single campaign. Executes 13 parallel queries in one call returning opens, clicks, bounces, unsubscribes, conversions, revenue, and other key performance metrics. Use nevent_list_campaigns to get valid campaign IDs.',
    CampaignReportSchema,
    { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    async (params) => {
      const denied = checkMode('nevent_campaign_report');
      if (denied) return err(denied);

      try {
        const result = await client.getCampaignReport(
          params.campaignId,
          params.timeRange,
          params.tenant_id
        );
        return ok(result);
      } catch (caught) {
        return err(toErrorEnvelope(caught));
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool 6 (was 5): nevent_segmentation_criteria
  // -------------------------------------------------------------------------
  server.tool(
    'nevent_segmentation_criteria',
    'List all available audience segmentation criteria including their IDs, operators, and value types.',
    SegmentationCriteriaSchema,
    { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    async (_params) => {
      const denied = checkMode('nevent_segmentation_criteria');
      if (denied) return err(denied);

      try {
        const result = await client.getSegmentationCriteria();
        return ok(result);
      } catch (caught) {
        return err(toErrorEnvelope(caught));
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool 7 (was 6): nevent_segment_preview
  // -------------------------------------------------------------------------
  server.tool(
    'nevent_segment_preview',
    'Preview estimated audience size for a segment definition without saving it. Returns fan count and sample contacts.',
    SegmentPreviewSchema,
    { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    async (params) => {
      const denied = checkMode('nevent_segment_preview');
      if (denied) return err(denied);

      try {
        const result = await client.previewSegment(params.definition);
        return ok(result);
      } catch (caught) {
        return err(toErrorEnvelope(caught));
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool 8 (was 7): nevent_segment_execute
  // -------------------------------------------------------------------------
  server.tool(
    'nevent_segment_execute',
    'Execute a segment definition and retrieve matching contacts with pagination.',
    SegmentExecuteSchema,
    { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    async (params) => {
      const denied = checkMode('nevent_segment_execute');
      if (denied) return err(denied);

      try {
        const result = await client.executeSegment(
          params.definition,
          params.page ?? 0,
          params.page_size ?? 20
        );
        return ok(result);
      } catch (caught) {
        return err(toErrorEnvelope(caught));
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool 9 (was 8): nevent_dimension_values
  // -------------------------------------------------------------------------
  server.tool(
    'nevent_dimension_values',
    'Autocomplete values for a segmentation criterion. Useful for discovering valid values when building segment definitions.',
    DimensionValuesSchema,
    { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    async (params) => {
      const denied = checkMode('nevent_dimension_values');
      if (denied) return err(denied);

      try {
        const result = await client.getDimensionValues(params.criterion_id, params.search);
        return ok(result);
      } catch (caught) {
        return err(toErrorEnvelope(caught));
      }
    }
  );
}
