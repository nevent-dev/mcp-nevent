/**
 * Sprint 1: Analytics + Segmentation tools for the Nevent MCP Server.
 *
 * Registers 8 tools against the nev-data-api (data.nevent.es):
 *
 *  Analytics (4 tools):
 *   1. nevent_analytics_query         — Execute BigQuery analytics query
 *   2. nevent_analytics_capabilities  — Discover available tables
 *   3. nevent_analytics_table_schema  — Get column schema for a table
 *   4. nevent_analytics_filter_values — Discover distinct field values
 *
 *  Segmentation (4 tools):
 *   5. nevent_segmentation_criteria   — List all segment criteria
 *   6. nevent_segment_preview         — Preview audience size (non-persisting)
 *   7. nevent_segment_execute         — Execute segment, get paginated contacts
 *   8. nevent_dimension_values        — Autocomplete values for a criterion
 *
 * Each tool handler:
 *  1. Checks operation mode (all Sprint 1 tools are READ — always allowed)
 *  2. Calls the DataClient method
 *  3. Returns `{ content: [{ type: "text", text: JSON.stringify(result) }] }`
 *  4. On error: returns `{ content: [...], isError: true }` with structured error
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
    'Query BigQuery analytics. Params: collection (required, e.g. purchases|tickets|campaigns), ' +
    'dimensions [{field, alias?}], metrics [{field, operation: sum|count|avg|min|max, alias?}], ' +
    'timeRange {start: ISO date, end: ISO date, granularity?: day|week|month}, ' +
    'filters [{field, operator: eq|neq|gt|gte|lt|lte|in|not_in|like, value}], ' +
    'having [{field, operator, value}], sort {field, order: asc|desc}, ' +
    'limit (max 1000, default 100), compareDimensions. ' +
    'Returns: {data: rows[], metadata: {totalRows, executionTime, query}}. ' +
    'Call nevent_analytics_capabilities first if unsure which collections exist.',
    AnalyticsQuerySchema,
    async (params) => {
      const denied = checkMode('nevent_analytics_query');
      if (denied) return err(denied);

      try {
        const result = await client.queryAnalytics({
          collection: params.collection,
          dimensions: params.dimensions,
          metrics: params.metrics,
          timeRange: params.timeRange,
          filters: params.filters as typeof params.filters,
          having: params.having as typeof params.having,
          sort: params.sort,
          limit: params.limit,
          compareDimensions: params.compareDimensions,
        });
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
    'Discover available BigQuery analytics tables and their columns/types. ' +
    'No params required. Returns: {tables: [{name, columns: [{name, type}]}], count}. ' +
    'Call this first when unsure what data exists or before building an analytics query.',
    AnalyticsCapabilitiesSchema,
    async (_params) => {
      const denied = checkMode('nevent_analytics_capabilities');
      if (denied) return err(denied);

      try {
        const result = await client.getCapabilities();
        return ok(result);
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
    'Get full column definitions for a BigQuery table. ' +
    'Params: table (required, e.g. "purchases", "tickets"). ' +
    'Returns: {table, columns: [{name, type, description?}], column_count}. ' +
    'Requires ADMIN role. Use to understand available fields before querying.',
    AnalyticsTableSchemaInputSchema,
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
    'Get distinct values available for analytics filters on a collection. ' +
    'Params: collection (required), filters [{field, operator?, value?}]. ' +
    'Returns: [{collection, results: Record<field, string[]>}]. ' +
    'Use to build valid filter values before calling nevent_analytics_query.',
    AnalyticsFilterValuesSchema,
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
  // Tool 5: nevent_segmentation_criteria
  // -------------------------------------------------------------------------
  server.tool(
    'nevent_segmentation_criteria',
    'List all available audience segmentation criteria. No params required. ' +
    'Returns: {criteria: [{id, type, label, operators, valueType}]}. ' +
    'Types: profile_property | behavior | communication_interaction | ' +
    'app_interaction | acquisition_source | predictive. ' +
    'Call this first to discover valid criterion_ids and operators for segment definitions.',
    SegmentationCriteriaSchema,
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
  // Tool 6: nevent_segment_preview
  // -------------------------------------------------------------------------
  server.tool(
    'nevent_segment_preview',
    'Preview estimated audience size for a segment definition without saving it. ' +
    'Params: definition {stanzas: [{criteria: [{type, criterion_id, operator, value, ...}]}]}. ' +
    'Stanzas are OR-combined; criteria within a stanza are AND-combined. ' +
    'Returns: {estimated_fan_count, sample_fans: [{fan_id, first_name, last_name, email}]}. ' +
    'Always call this before nevent_segment_execute to validate the definition.',
    SegmentPreviewSchema,
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
  // Tool 7: nevent_segment_execute
  // -------------------------------------------------------------------------
  server.tool(
    'nevent_segment_execute',
    'Execute a segment definition and retrieve matching contacts with pagination. ' +
    'Params: definition (same DSL as nevent_segment_preview), page (default 0), page_size (max 100, default 20). ' +
    'Returns: {total_fans, fans: [{fan_id, first_name, last_name, email, phone}], current_page, total_pages, has_more}. ' +
    'Call nevent_segment_preview first to validate the definition before executing.',
    SegmentExecuteSchema,
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
  // Tool 8: nevent_dimension_values
  // -------------------------------------------------------------------------
  server.tool(
    'nevent_dimension_values',
    'Autocomplete values for a segmentation criterion. ' +
    'Params: criterion_id (required, from nevent_segmentation_criteria), search (optional filter string). ' +
    'Returns: {values: string[] | [{id, label}]}. ' +
    'Use to discover valid values before setting criterion value in a segment definition.',
    DimensionValuesSchema,
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
