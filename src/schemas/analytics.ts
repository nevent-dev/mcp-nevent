/**
 * Zod validation schemas for Sprint 1 analytics and segmentation tools.
 *
 * Each schema corresponds to the input parameters of one MCP tool.
 * Schemas are used both for MCP tool registration and for deriving TypeScript
 * types via `z.infer<>`.
 *
 * Design principles:
 * - Required fields throw clear errors (no optional ambiguity on critical params)
 * - Optional fields use `.optional()` rather than `.nullable()` for clean JSON
 * - Numeric limits enforce API rate limits and server constraints
 * - Enum schemas document all valid string values explicitly
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared sub-schemas (reused across multiple tools)
// ---------------------------------------------------------------------------

/** A single dimension field with optional alias. */
export const DimensionSchema = z.object({
  /** BigQuery field name, e.g. "event_id", "purchase_date". */
  field: z.string().describe('BigQuery field name'),
  /** Optional alias for the column in result rows. */
  alias: z.string().optional().describe('Alias for the column in results'),
});

/** A single metric field with aggregation operation and optional alias. */
export const MetricSchema = z.object({
  /** BigQuery field name to aggregate. */
  field: z.string().describe('BigQuery field name to aggregate'),
  /** Aggregation function to apply. */
  operation: z
    .enum(['sum', 'count', 'avg', 'min', 'max'])
    .describe('Aggregation function: sum | count | avg | min | max'),
  /** Optional alias for the column in result rows. */
  alias: z.string().optional().describe('Alias for the aggregated column in results'),
});

/** Time range filter with optional granularity for time-series queries. */
export const TimeRangeSchema = z.object({
  /** Start date in ISO 8601 format, e.g. "2024-01-01". */
  start: z.string().describe('Start date in ISO 8601 format, e.g. "2024-01-01"'),
  /** End date in ISO 8601 format, e.g. "2024-12-31". */
  end: z.string().describe('End date in ISO 8601 format, e.g. "2024-12-31"'),
  /** Optional time bucket granularity for trend queries. */
  granularity: z
    .enum(['day', 'week', 'month'])
    .optional()
    .describe('Time bucket granularity: day | week | month'),
});

/** A single WHERE filter predicate. */
export const FilterSchema = z.object({
  field: z.string().describe('Field name to filter on'),
  operator: z
    .enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'like'])
    .describe('Comparison operator'),
  /** The filter value. For "in" / "not_in" operators, provide an array. */
  value: z.unknown().describe('Filter value; use array for "in" / "not_in" operators'),
});

/** A single HAVING predicate (applied after aggregation). */
export const HavingSchema = z.object({
  field: z.string().describe('Aggregated field name'),
  operator: z.string().describe('Comparison operator (e.g. "gt", "gte")'),
  value: z.unknown().describe('HAVING threshold value'),
});

/** Sort specification. */
export const SortSchema = z.object({
  field: z.string().describe('Field to sort by'),
  order: z.enum(['asc', 'desc']).describe('Sort direction: asc | desc'),
});

/** Comparative dimension configuration. */
export const CompareDimensionsSchema = z.object({
  active: z.boolean().describe('Enable comparative analysis'),
  dimensions: z.array(
    z.object({
      field: z.string().describe('Dimension field name'),
      value: z.string().describe('Dimension field value to compare'),
      name: z.string().describe('Display name for the comparison group'),
    })
  ).describe('Dimension values to compare against each other'),
});

// ---------------------------------------------------------------------------
// Segmentation DSL sub-schemas (shared by preview + execute)
// ---------------------------------------------------------------------------

/** The type of a segmentation criterion. */
const CriterionTypeSchema = z.enum([
  'profile_property',
  'behavior',
  'communication_interaction',
  'app_interaction',
  'acquisition_source',
  'predictive',
]);

/** Time-frame window for behavioral criteria. */
const CriterionTimeframeSchema = z.object({
  type: z.string().describe('Timeframe type (e.g. "relative", "absolute")'),
  unit: z.string().optional().describe('Time unit (e.g. "days", "weeks")'),
  value_start: z.number().optional().describe('Start offset for relative timeframe'),
  value_end: z.number().optional().describe('End offset for relative timeframe'),
});

/** Modifiers that refine criterion matching semantics. */
const CriterionModifiersSchema = z.object({
  frequency: z
    .object({
      count: z.number().describe('Minimum occurrence count'),
      operator: z.string().describe('Comparison operator (e.g. "gte")'),
    })
    .optional()
    .describe('Frequency modifier — how many times the criterion must be true'),
  time_range: z
    .object({
      value: z.number().describe('Time range window size'),
      unit: z.string().describe('Time range window unit (e.g. "days")'),
    })
    .optional()
    .describe('Time range modifier — sliding window for the criterion'),
});

/** A single criterion within a stanza. */
const SegmentCriterionSchema = z.object({
  id: z.string().optional().describe('Optional stable identifier for UI correlation'),
  type: CriterionTypeSchema.describe('Criterion category'),
  criterion_id: z.string().describe('Criterion identifier from GET /segmentation/criteria'),
  operator: z.string().describe('Comparison operator (depends on criterion type)'),
  value: z.unknown().describe('Criterion value to match against'),
  timeframe: CriterionTimeframeSchema.optional().describe('Optional timeframe window'),
  filters: z.record(z.unknown()).optional().describe('Additional field filters for the criterion'),
  modifiers: CriterionModifiersSchema.optional().describe('Optional frequency / time-range modifiers'),
});

/** A stanza groups criteria with AND logic; stanzas are OR-combined. */
const SegmentStanzaSchema = z.object({
  id: z.string().optional().describe('Optional stable identifier for UI correlation'),
  criteria: z.array(SegmentCriterionSchema).describe('Criteria combined with AND logic'),
});

/**
 * Full segment definition DSL.
 * Stanzas are OR-combined; criteria within a stanza are AND-combined.
 */
export const SegmentDefinitionSchema = z.object({
  stanzas: z
    .array(SegmentStanzaSchema)
    .describe('Array of stanzas (OR logic). Each stanza contains criteria (AND logic).'),
});

// ---------------------------------------------------------------------------
// Tool 1: nevent_analytics_query
// ---------------------------------------------------------------------------

/**
 * Input schema for `nevent_analytics_query`.
 * Queries a BigQuery collection with flexible dimension/metric/filter DSL.
 */
export const AnalyticsQuerySchema = {
  /** Target BigQuery collection (table name). Call nevent_analytics_capabilities first if unsure. */
  collection: z
    .string()
    .describe('Target BigQuery collection name, e.g. "purchases", "tickets", "campaigns"'),
  dimensions: z
    .array(DimensionSchema)
    .optional()
    .describe('Fields to group by (SELECT dimensions). Omit for aggregate-only queries.'),
  metrics: z
    .array(MetricSchema)
    .optional()
    .describe('Aggregated metrics to compute (SUM, COUNT, etc.)'),
  timeRange: TimeRangeSchema.optional().describe(
    'Time range filter with optional granularity for trend analysis'
  ),
  filters: z
    .array(FilterSchema)
    .optional()
    .describe('WHERE clause filters to apply before aggregation'),
  having: z
    .array(HavingSchema)
    .optional()
    .describe('HAVING clause filters to apply after aggregation'),
  sort: SortSchema.optional().describe('Sort the result rows'),
  limit: z
    .number()
    .max(1000)
    .default(100)
    .describe('Maximum rows to return (max 1000, default 100)'),
  compareDimensions: CompareDimensionsSchema.optional().describe(
    'Comparative dimension analysis configuration'
  ),
};

// ---------------------------------------------------------------------------
// Tool 2: nevent_analytics_capabilities
// ---------------------------------------------------------------------------

/**
 * Input schema for `nevent_analytics_capabilities`.
 * No parameters required — this is a discovery endpoint.
 */
export const AnalyticsCapabilitiesSchema = {};

// ---------------------------------------------------------------------------
// Tool 3: nevent_analytics_table_schema
// ---------------------------------------------------------------------------

/**
 * Input schema for `nevent_analytics_table_schema`.
 */
export const AnalyticsTableSchemaInputSchema = {
  /** Table name to inspect, e.g. "purchases". */
  table: z
    .string()
    .describe('BigQuery table name to inspect, e.g. "purchases", "tickets"'),
};

// ---------------------------------------------------------------------------
// Tool 4: nevent_analytics_filter_values
// ---------------------------------------------------------------------------

/**
 * Input schema for `nevent_analytics_filter_values`.
 */
export const AnalyticsFilterValuesSchema = {
  /** Target collection to discover filter values in. */
  collection: z.string().describe('BigQuery collection name to get filter values for'),
  /** Fields to get distinct values for, with optional seed filters. */
  filters: z
    .array(
      z.object({
        field: z.string().describe('Field name to get distinct values for'),
        operator: z
          .string()
          .optional()
          .describe('Optional operator to apply when retrieving values'),
        value: z.unknown().optional().describe('Optional seed value'),
      })
    )
    .describe('Fields to get distinct values for'),
};

// ---------------------------------------------------------------------------
// Tool 5: nevent_segmentation_criteria
// ---------------------------------------------------------------------------

/**
 * Input schema for `nevent_segmentation_criteria`.
 * No parameters — returns all available criteria definitions.
 */
export const SegmentationCriteriaSchema = {};

// ---------------------------------------------------------------------------
// Tool 6: nevent_segment_preview
// ---------------------------------------------------------------------------

/**
 * Input schema for `nevent_segment_preview`.
 */
export const SegmentPreviewSchema = {
  /**
   * Segment DSL definition (stanzas = OR groups, criteria = AND within group).
   * Call nevent_segmentation_criteria first to get valid criterion_ids and operators.
   */
  definition: SegmentDefinitionSchema.describe(
    'Segment DSL: stanzas are OR-combined, criteria within each stanza are AND-combined'
  ),
};

// ---------------------------------------------------------------------------
// Tool 7: nevent_segment_execute
// ---------------------------------------------------------------------------

/**
 * Input schema for `nevent_segment_execute`.
 */
export const SegmentExecuteSchema = {
  /** Segment DSL definition (same shape as nevent_segment_preview). */
  definition: SegmentDefinitionSchema.describe(
    'Segment DSL: stanzas are OR-combined, criteria within each stanza are AND-combined'
  ),
  /** Zero-based page index for pagination. */
  page: z
    .number()
    .min(0)
    .default(0)
    .describe('Zero-based page index (default 0)'),
  /** Number of results per page. Max 100. */
  page_size: z
    .number()
    .min(1)
    .max(100)
    .default(20)
    .describe('Results per page (max 100, default 20)'),
};

// ---------------------------------------------------------------------------
// Tool 8: nevent_dimension_values
// ---------------------------------------------------------------------------

/**
 * Input schema for `nevent_dimension_values`.
 */
export const DimensionValuesSchema = {
  /** Criterion ID to get autocomplete values for. */
  criterion_id: z
    .string()
    .describe('Criterion ID from nevent_segmentation_criteria, e.g. "country", "event_attended"'),
  /** Optional search string to filter autocomplete results. */
  search: z
    .string()
    .optional()
    .describe('Optional search string to filter matching values'),
};
