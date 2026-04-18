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
 * - String fields for operator/operation/granularity enums are intentionally
 *   open (not closed enums) so the MCP remains resilient to API-side additions.
 *   Known valid values are documented in the field descriptions.
 *
 * Updated for nev-data-api v3.19.0:
 * - distinct, dryRun boolean flags
 * - Multi-sort (sort accepts object OR array of objects)
 * - Expanded operator values for filters
 * - Expanded operation values for metrics
 * - timeGranularity as top-level field
 * - groupBy array with calendar fields
 * - comparePeriods (YoY/MoM comparison)
 * - ctes array + sourceTable for CTE queries
 * - New nevent_campaign_report tool schema
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared sub-schemas (reused across multiple tools)
// ---------------------------------------------------------------------------

/** A single dimension field with optional alias. */
export const DimensionSchema = z.object({
  /** Field name, e.g. "event_id", "purchase_date". */
  field: z.string().describe('Field name'),
  /** Optional alias for the column in result rows. */
  alias: z.string().optional().describe('Alias for the column in results'),
});

/**
 * A single metric field with aggregation operation and optional alias.
 *
 * The `operation` field accepts any string that the API recognises. Known
 * valid values (v3.19.0):
 *   Basic: sum | count | avg | min | max
 *   Extended: count_distinct | median | percentile | stddev | variance | date_diff
 */
export const MetricSchema = z.object({
  /** Field name to aggregate. */
  field: z.string().describe('Field name to aggregate'),
  /**
   * Aggregation function to apply.
   * Known values: sum | count | avg | min | max |
   *   count_distinct | median | percentile | stddev | variance | date_diff
   */
  operation: z
    .string()
    .describe(
      'Aggregation function. Known values: sum | count | avg | min | max | ' +
      'count_distinct | median | percentile | stddev | variance | date_diff'
    ),
  /** Optional alias for the column in result rows. */
  alias: z.string().optional().describe('Alias for the aggregated column in results'),
});

/** Time range filter with optional granularity for time-series queries. */
export const TimeRangeSchema = z.object({
  /** Start date in ISO 8601 format, e.g. "2024-01-01". */
  start: z.string().describe('Start date in ISO 8601 format, e.g. "2024-01-01"'),
  /** End date in ISO 8601 format, e.g. "2024-12-31". */
  end: z.string().describe('End date in ISO 8601 format, e.g. "2024-12-31"'),
  /**
   * Optional time bucket granularity for trend queries (inside timeRange).
   * Prefer the top-level `timeGranularity` field introduced in v3.19.0.
   */
  granularity: z
    .string()
    .optional()
    .describe('Time bucket granularity (deprecated: use top-level timeGranularity)'),
});

/**
 * A single WHERE filter predicate.
 *
 * The `operator` field accepts any string recognised by the API. Known valid
 * values (v3.19.0):
 *   eq | neq | gt | gte | lt | lte | in | not_in | like |
 *   contains | not_contains | starts_with | ends_with | regex | between |
 *   is_null | is_not_null | is_true | is_false | array_contains | array_contains_any
 */
export const FilterSchema = z.object({
  field: z.string().describe('Field name to filter on'),
  /**
   * Comparison operator.
   * Known values: eq | neq | gt | gte | lt | lte | in | not_in | like |
   *   contains | not_contains | starts_with | ends_with | regex | between |
   *   is_null | is_not_null | is_true | is_false | array_contains | array_contains_any
   */
  operator: z
    .string()
    .describe(
      'Comparison operator. Known values: eq | neq | gt | gte | lt | lte | in | not_in | like | ' +
      'contains | not_contains | starts_with | ends_with | regex | between | ' +
      'is_null | is_not_null | is_true | is_false | array_contains | array_contains_any'
    ),
  /** The filter value. For "in" / "not_in" operators, provide an array. For "between", provide [min, max]. */
  value: z.unknown().describe('Filter value; use array for "in" / "not_in" / "between" operators'),
});

/** A single HAVING predicate (applied after aggregation). */
export const HavingSchema = z.object({
  field: z.string().describe('Aggregated field name'),
  operator: z.string().describe('Comparison operator (e.g. "gt", "gte")'),
  value: z.unknown().describe('HAVING threshold value'),
});

/** Sort specification for a single field. */
export const SortSchema = z.object({
  field: z.string().describe('Field to sort by'),
  order: z.enum(['asc', 'desc']).describe('Sort direction: asc | desc'),
});

/**
 * Multi-sort input: accepts a single sort object OR an array of sort objects.
 * Introduced in v3.19.0 to support ordering by multiple fields simultaneously.
 *
 * Examples:
 *   Single: { "field": "purchase_date", "order": "desc" }
 *   Multi:  [{ "field": "status", "order": "asc" }, { "field": "created_at", "order": "desc" }]
 */
export const SortInputSchema = z.union([
  SortSchema,
  z.array(SortSchema).min(1),
]).describe(
  'Sort order. Accepts a single { field, order } object or an array of sort objects for multi-sort.'
);

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

/**
 * Period definition used in comparePeriods.
 * Each period is a { start, end } date range in ISO 8601 format.
 */
export const TimePeriodSchema = z.object({
  start: z.string().describe('ISO 8601 start date, e.g. "2024-01-01"'),
  end: z.string().describe('ISO 8601 end date, e.g. "2024-12-31"'),
});

/**
 * Period-over-period comparison configuration (YoY, MoM, custom).
 * Introduced in v3.19.0.
 *
 * Example (YoY):
 * {
 *   active: true,
 *   current:  { start: "2024-01-01", end: "2024-12-31" },
 *   previous: { start: "2023-01-01", end: "2023-12-31" }
 * }
 */
export const ComparePeriodsSchema = z.object({
  active: z.boolean().describe('Enable period-over-period comparison'),
  current: TimePeriodSchema.describe('The reference (current) time period'),
  previous: TimePeriodSchema.describe('The baseline (previous) time period to compare against'),
});

/**
 * CTE (Common Table Expression) sub-query definition.
 * Introduced in v3.19.0. Each CTE can define a pre-computed sub-query that
 * the main query can reference via `sourceTable`.
 */
export const CteSchema = z.object({
  name: z.string().describe('Name used to reference this CTE via the sourceTable field'),
  collection: z.string().describe('Source collection for this CTE'),
  dimensions: z.array(DimensionSchema).optional().describe('Dimensions to select in the CTE'),
  metrics: z.array(MetricSchema).optional().describe('Metrics to compute in the CTE'),
  filters: z.array(FilterSchema).optional().describe('Filters to apply in the CTE'),
  timeRange: TimeRangeSchema.optional().describe('Time range filter for the CTE'),
  sort: SortInputSchema.optional().describe('Sort order for the CTE'),
  limit: z.number().max(10000).optional().describe('Row limit for the CTE'),
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
 *
 * Updated for v3.19.0: distinct, dryRun, multi-sort, timeGranularity,
 * groupBy, comparePeriods, ctes, sourceTable.
 */
export const AnalyticsQuerySchema = {
  /** Target BigQuery collection (table name). Call nevent_analytics_capabilities first if unsure. */
  collection: z
    .string()
    .describe('Collection name, e.g. "purchases", "tickets", "campaigns"'),
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
  /** v3.19.0: Accepts a single sort object or an array for multi-field sorting. */
  sort: SortInputSchema.optional().describe(
    'Sort the result rows. Accepts a single { field, order } object or an array for multi-field sorting.'
  ),
  limit: z
    .number()
    .max(1000)
    .default(100)
    .describe('Maximum rows to return (max 1000, default 100)'),
  compareDimensions: CompareDimensionsSchema.optional().describe(
    'Comparative dimension analysis configuration'
  ),
  /**
   * v3.19.0: Add SELECT DISTINCT to deduplicate result rows.
   */
  distinct: z
    .boolean()
    .optional()
    .describe('Add SELECT DISTINCT to deduplicate result rows (v3.19.0+)'),
  /**
   * v3.19.0: Dry-run mode — estimates query cost in bytes without executing.
   * When true, the request is sent with `?dryRun=true` as a query parameter.
   * The response metadata will include `estimatedBytes` instead of actual data.
   */
  dryRun: z
    .boolean()
    .optional()
    .describe(
      'Dry-run mode: estimate query cost without executing (v3.19.0+). ' +
      'Response includes estimatedBytes in metadata.'
    ),
  /**
   * v3.19.0: Top-level time granularity for bucketing time-series data.
   * Known values: day | week | month | quarter | year | hour | minute | fiscalQuarter | fiscalYear
   */
  timeGranularity: z
    .string()
    .optional()
    .describe(
      'Time granularity for bucketing (v3.19.0+). ' +
      'Known values: day | week | month | quarter | year | hour | minute | fiscalQuarter | fiscalYear'
    ),
  /**
   * v3.19.0: Calendar-based group-by fields.
   * Known values: dayOfWeek | weekOfYear | hourOfDay | minuteOfHour | month | quarter | year
   */
  groupBy: z
    .array(z.string())
    .optional()
    .describe(
      'Calendar-based group-by fields (v3.19.0+). ' +
      'Known values: dayOfWeek | weekOfYear | hourOfDay | minuteOfHour | month | quarter | year'
    ),
  /**
   * v3.19.0: Period-over-period comparison (YoY, MoM, custom periods).
   */
  comparePeriods: ComparePeriodsSchema.optional().describe(
    'Period-over-period comparison (YoY, MoM, etc.) — v3.19.0+'
  ),
  /**
   * v3.19.0: CTE sub-query definitions. Each CTE can be referenced in
   * the main query via the `sourceTable` field.
   */
  ctes: z
    .array(CteSchema)
    .optional()
    .describe('CTE (Common Table Expression) sub-queries — v3.19.0+'),
  /**
   * v3.19.0: Use a CTE name (from the `ctes` array) as the main query source
   * instead of a raw collection. Requires at least one entry in `ctes`.
   */
  sourceTable: z
    .string()
    .optional()
    .describe('CTE name to use as source instead of a raw collection — v3.19.0+'),
  /**
   * Optional tenant ID override for multi-tenant queries.
   *
   * When provided, overrides the active tenant set via nevent_switch_tenant.
   * Requires hierarchical access — SUPERADMIN can query any tenant, OWNER
   * can query their tenant and children. If omitted, uses the active tenant
   * from the session (or the authenticated user's default tenant).
   */
  tenant_id: z
    .string()
    .optional()
    .describe(
      'Optional tenant ID for multi-tenant queries. Requires SUPERADMIN or OWNER role with ' +
      'access to the target tenant. Omit to use the session active tenant.'
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
    .describe('Table name to inspect, e.g. "purchases", "tickets"'),
};

// ---------------------------------------------------------------------------
// Tool 4: nevent_analytics_filter_values
// ---------------------------------------------------------------------------

/**
 * Input schema for `nevent_analytics_filter_values`.
 */
export const AnalyticsFilterValuesSchema = {
  /** Target collection to discover filter values in. */
  collection: z.string().describe('Collection name to get filter values for'),
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

// ---------------------------------------------------------------------------
// Tool 9: nevent_campaign_report (v3.19.0)
// ---------------------------------------------------------------------------

/**
 * Input schema for `nevent_campaign_report`.
 *
 * Introduced in v3.19.0: POST /analytics/campaign-report executes 13 parallel
 * analytics queries for a single campaign in one API call, returning a
 * comprehensive performance report (opens, clicks, bounces, unsubscribes,
 * conversions, revenue, etc.).
 */
export const CampaignReportSchema = {
  /**
   * Campaign ID to generate the report for.
   * Use nevent_list_campaigns to get valid campaign IDs.
   */
  campaignId: z
    .string()
    .describe('Campaign ID to generate the analytics report for'),
  /**
   * Optional time range to restrict the report data.
   * When omitted, the full campaign lifetime is used.
   */
  timeRange: TimeRangeSchema.optional().describe(
    'Optional time range to restrict report data. Defaults to full campaign lifetime.'
  ),
  /**
   * Optional tenant ID override for multi-tenant queries.
   */
  tenant_id: z
    .string()
    .optional()
    .describe(
      'Optional tenant ID for multi-tenant queries. Requires SUPERADMIN or OWNER role.'
    ),
};
