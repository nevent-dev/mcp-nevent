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
 * values (nev-data-api 3.34.0, the same list GET /analytics/capabilities announces per type):
 *   eq | neq | gt | gte | lt | lte | in | nin | contains | not_contains | starts_with | ends_with |
 *   regex | regex_i | before | after | between | in_range | not_in_range | is_empty | is_not_empty | exists
 * BOOLEAN fields take eq/neq with true or false (or exists).
 */
export const FilterSchema = z.object({
  field: z.string().describe('Field name to filter on'),
  /**
   * Comparison operator.
   * Known values: see FilterSchema above; the per-type list comes from nevent_analytics_capabilities.
   */
  operator: z
    .string()
    .describe(
      'Comparison operator. Valid values depend on the field type (nevent_analytics_capabilities lists them): ' +
      'eq | neq | gt | gte | lt | lte | in | nin | contains | not_contains | starts_with | ends_with | ' +
      'regex | regex_i | before | after | between | in_range | not_in_range | is_empty | is_not_empty | exists. ' +
      'BOOLEAN fields: eq or neq with true/false.'
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

/**
 * A single criterion within a stanza.
 *
 * IMPORTANT: Only `criterion_id`, `operator`, and `value` are required.
 * Call nevent_segmentation_criteria first to discover valid criterion_ids and operators.
 *
 * Examples:
 *   { "criterion_id": "total_spent", "operator": "gt", "value": 100 }
 *   { "criterion_id": "attended_event", "operator": "is", "value": "EVENT_ID" }
 *   { "criterion_id": "user_gender", "operator": "is", "value": "female" }
 *   { "criterion_id": "user_custom_field", "operator": "eq", "value": "Rock", "filters": { "property_name": "preferred_genre" } }
 */
const SegmentCriterionSchema = z.object({
  id: z.string().optional().describe('Optional stable ID for UI/cross-request correlation. If omitted, the MCP client auto-generates one before sending to the API.'),
  criterion_id: z.string().describe(
    'Criterion identifier from nevent_segmentation_criteria. ' +
    'Examples: total_spent, attended_event, user_gender, user_age, campaign_opened, nevent_temperature'
  ),
  operator: z.string().describe(
    'Comparison operator. Rules by data type:\n' +
    '- ENTITY: "is" and "is_not" accept a single string ID OR an array of string IDs (valueType=array per API). "is_set", "is_not_set" also supported.\n' +
    '- TEXT: "eq", "neq", "contains", "starts_with", "ends_with", "is_set", "is_not_set"\n' +
    '- NUMBER/CURRENCY: "eq", "neq", "gt", "gte", "lt", "lte", "is_set", "is_not_set"\n' +
    '- BOOLEAN: "is_true", "is_false". NEVER use "eq" with "true"/"false" strings.\n' +
    '- DATE: "before", "after", "between", "eq", "is_set", "is_not_set"'
  ),
  value: z.unknown().describe(
    'Value to match. IMPORTANT rules:\n' +
    '- ENTITY operators (is/is_not): accepts a single string ID OR an array of string IDs (e.g. "event_123" or ["event_1", "event_2"]).\n' +
    '- NUMBER: must be a number (not string)\n' +
    '- BOOLEAN operators (is_true/is_false): no value needed, omit this field.\n' +
    '- DATE "between": array of 2 ISO date strings [start, end]'
  ),
  filters: z.record(z.unknown()).optional().describe(
    'Only needed for user_custom_field criterion. Pass { "property_name": "field_name" } to specify which custom field.'
  ),
  modifiers: z.object({
    frequency: z.object({
      count: z.number(),
      operator: z.string(),
    }).optional(),
    time_range: z.object({
      value: z.number().min(1),
      unit: z.string(),
    }).optional(),
  }).optional().describe(
    'ADVANCED: Usually OMIT this field entirely. Only include when the user explicitly asks for:\n' +
    '- "at least X times" → { frequency: { count: X, operator: "gte" } }\n' +
    '- "in the last X days" → { time_range: { value: X, unit: "days" } } (value MUST be > 0; unit is one of days, weeks, months, years)\n' +
    'If not asked for frequency or recency, DO NOT include modifiers.'
  ),
});

/** A stanza groups criteria that are OR-combined. Stanzas are AND-combined. */
const SegmentStanzaSchema = z.object({
  id: z.string().optional().describe('Optional stable ID for the stanza. If omitted, the MCP client auto-generates one before sending to the API. Provide your own only if you need stable references across requests.'),
  criteria: z.array(SegmentCriterionSchema).min(1).describe(
    'Criteria in the same stanza are OR-combined: a fan matches the stanza if ANY criterion matches. ' +
    'Stanzas are AND-combined, so a fan must match EVERY stanza.'
  ),
});

/**
 * Full segment definition DSL.
 *
 * Structure: { stanzas: [ { criteria: [ { criterion_id, operator, value } ] } ] }
 * - Criteria in the same stanza are OR-combined: a fan matches the stanza if ANY criterion matches.
 * - Stanzas are AND-combined: a fan must match EVERY stanza to enter the segment.
 *
 * To require A AND B, put A and B in separate stanzas.
 * To accept A OR B, put both in the same stanza.
 *
 * Simple example (users who spent > 100):
 *   { "stanzas": [{ "criteria": [{ "criterion_id": "total_spent", "operator": "gt", "value": 100 }] }] }
 *
 * Intersection example (females aged 18-35 who attended an event) — one stanza per
 * required condition, so each age bound needs its own stanza:
 *   { "stanzas": [
 *       { "criteria": [{ "criterion_id": "user_gender", "operator": "is", "value": "female" }] },
 *       { "criteria": [{ "criterion_id": "user_age", "operator": "gte", "value": 18 }] },
 *       { "criteria": [{ "criterion_id": "user_age", "operator": "lte", "value": 35 }] },
 *       { "criteria": [{ "criterion_id": "attended_event", "operator": "is", "value": "EVENT_ID" }] }
 *   ] }
 *
 * Union example (attended EVENT_A or EVENT_B) — both criteria in ONE stanza:
 *   { "stanzas": [{ "criteria": [
 *       { "criterion_id": "attended_event", "operator": "is", "value": "EVENT_A" },
 *       { "criterion_id": "attended_event", "operator": "is", "value": "EVENT_B" }
 *   ] }] }
 */
export const SegmentDefinitionSchema = z.object({
  stanzas: z
    .array(SegmentStanzaSchema)
    .min(1)
    .describe(
      'Array of stanzas. Stanzas are AND-combined: a fan must match EVERY stanza. ' +
      'Criteria inside one stanza are OR-combined, so a fan matching ANY of them matches that stanza.'
    ),
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
  // NOTE: tenant_id is NOT accepted here — nev-data-api resolves tenant from
  // the JWT claim. Use nevent_switch_tenant to change tenant context.
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
   * Segment DSL definition. Criteria in the same stanza are OR-combined.
   * Stanzas are AND-combined — a fan must match EVERY stanza.
   * Call nevent_segmentation_criteria first to get valid criterion_ids and operators.
   */
  definition: SegmentDefinitionSchema.describe(
    'Segment DSL. Criteria in the same stanza are OR-combined: a fan matches the stanza if ANY criterion matches. ' +
    'Stanzas are AND-combined: a fan must match EVERY stanza. ' +
    'To require A AND B, put them in separate stanzas; to accept A OR B, put both in the same stanza.'
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
    'Segment DSL. Criteria in the same stanza are OR-combined: a fan matches the stanza if ANY criterion matches. ' +
    'Stanzas are AND-combined: a fan must match EVERY stanza. ' +
    'To require A AND B, put them in separate stanzas; to accept A OR B, put both in the same stanza.'
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
  /** Calendar year of the report (e.g. 2026). */
  year: z
    .number()
    .int()
    .min(2000)
    .max(2100)
    .describe('Calendar year of the monthly report, e.g. 2026'),
  /** Calendar month of the report, 1-12. */
  month: z
    .number()
    .int()
    .min(1)
    .max(12)
    .describe('Calendar month of the report, 1 (January) to 12 (December)'),
  // NOTE: tenant_id is NOT accepted here — nev-data-api resolves the tenant from
  // the bearer JWT (the selected brand when one is selected).
};
