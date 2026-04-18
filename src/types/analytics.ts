/**
 * BigQuery analytics types for the Nevent MCP Server.
 *
 * Defines the shapes of requests and responses for all analytics endpoints
 * exposed by the nev-data-api (data.nevent.es).
 *
 * Updated for nev-data-api v3.19.0:
 * - Expanded FilterOperator with new string/null/array operators
 * - Expanded MetricOperation with statistical and date operations
 * - Multi-sort: Sort is now a single object OR an array of objects
 * - Top-level TimeGranularity field (was only inside TimeRange)
 * - GroupBy array for calendar-based grouping
 * - ComparePeriods for YoY/MoM comparisons
 * - CTEs (Common Table Expressions) and sourceTable
 * - distinct flag for SELECT DISTINCT
 * - dryRun flag for cost estimation without execution
 */

// ---------------------------------------------------------------------------
// Query DSL types
// ---------------------------------------------------------------------------

/** A dimension field, optionally aliased in the result set. */
export interface Dimension {
  field: string;
  alias?: string;
}

/**
 * Supported aggregation operations for metric fields.
 *
 * Known values (v3.19.0):
 *   Basic: sum | count | avg | min | max
 *   Extended: count_distinct | median | percentile | stddev | variance | date_diff
 *
 * Typed as `string` so the MCP remains resilient to future API additions.
 * The API validates the value server-side and returns a clear error for unknowns.
 */
export type MetricOperation = string;

/** A metric field with an aggregation operation, optionally aliased. */
export interface Metric {
  field: string;
  operation: MetricOperation;
  alias?: string;
}

/**
 * Time granularity for time-based grouping at the top level of a query.
 *
 * Known values (v3.19.0):
 *   day | week | month | quarter | year | hour | minute | fiscalQuarter | fiscalYear
 *
 * Typed as `string` so the MCP remains resilient to future API additions.
 */
export type TimeGranularity = string;

/** Time range filter with optional granularity for bucketed queries. */
export interface TimeRange {
  /** ISO 8601 date string, e.g. "2024-01-01". */
  start: string;
  /** ISO 8601 date string, e.g. "2024-12-31". */
  end: string;
  /** Deprecated: Use top-level timeGranularity instead. Retained for backwards compatibility. */
  granularity?: TimeGranularity;
}

/**
 * Supported filter comparison operators.
 *
 * Known values (v3.19.0):
 *   Basic: eq | neq | gt | gte | lt | lte | in | not_in | like
 *   Extended: contains | not_contains | starts_with | ends_with |
 *     regex | between | is_null | is_not_null | is_true | is_false |
 *     array_contains | array_contains_any
 *
 * Typed as `string` so the MCP remains resilient to future API additions.
 * The API validates the value server-side and returns a clear error for unknowns.
 */
export type FilterOperator = string;

/** A single filter predicate applied to a field. */
export interface Filter {
  field: string;
  operator: FilterOperator;
  /** Filter value. May be undefined when probing available values. */
  value?: unknown;
}

/** A single HAVING predicate applied after aggregation. */
export interface Having {
  field: string;
  operator: string;
  /** HAVING threshold value. */
  value?: unknown;
}

/** Sort specification for result ordering. */
export interface Sort {
  field: string;
  order: 'asc' | 'desc';
}

/**
 * Multi-sort: accepts a single Sort object or an array of Sort objects.
 * Introduced in v3.19.0.
 */
export type SortInput = Sort | Sort[];

/** A dimension with a specific value for comparative analytics. */
export interface CompareDimension {
  field: string;
  value: string;
  name: string;
}

/** Configuration for comparative dimension analysis. */
export interface CompareDimensions {
  active: boolean;
  dimensions: CompareDimension[];
}

/**
 * Period definition for comparative time-period analysis.
 * Used within ComparePeriods.
 */
export interface TimePeriod {
  /** ISO 8601 start date, e.g. "2024-01-01". */
  start: string;
  /** ISO 8601 end date, e.g. "2024-12-31". */
  end: string;
}

/**
 * Configuration for period-over-period comparison (YoY, MoM, etc.).
 * Introduced in v3.19.0.
 */
export interface ComparePeriods {
  /** Enable period comparison mode. */
  active: boolean;
  /** The reference (current) time period. */
  current: TimePeriod;
  /** The baseline (previous) time period to compare against. */
  previous: TimePeriod;
}

/**
 * A CTE (Common Table Expression) sub-query definition.
 * Introduced in v3.19.0.
 */
export interface CteDefinition {
  /** Name used to reference this CTE in the main query via sourceTable. */
  name: string;
  /** Source collection for this CTE. */
  collection: string;
  dimensions?: Dimension[];
  metrics?: Metric[];
  filters?: Filter[];
  timeRange?: TimeRange;
  sort?: SortInput;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Analytics query request / response
// ---------------------------------------------------------------------------

/**
 * Full analytics query request body sent to POST /analytics/query.
 *
 * Updated for v3.19.0 with optional new fields. All existing fields remain
 * unchanged to preserve backwards compatibility.
 */
export interface AnalyticsQueryRequest {
  collection: string;
  dimensions?: Dimension[];
  metrics?: Metric[];
  timeRange?: TimeRange;
  filters?: Filter[];
  having?: Having[];
  /** v3.19.0: Single or multi-sort. */
  sort?: SortInput;
  limit?: number;
  compareDimensions?: CompareDimensions;
  /** v3.19.0: SELECT DISTINCT flag. */
  distinct?: boolean;
  /** v3.19.0: Top-level time granularity for time-series buckets. */
  timeGranularity?: TimeGranularity;
  /** v3.19.0: Calendar-based group-by fields (e.g. dayOfWeek, month). */
  groupBy?: string[];
  /** v3.19.0: Period-over-period comparison (YoY, MoM). */
  comparePeriods?: ComparePeriods;
  /** v3.19.0: CTE sub-query definitions. */
  ctes?: CteDefinition[];
  /**
   * v3.19.0: Use a CTE name as the source table instead of a raw collection.
   * Requires at least one entry in `ctes`.
   */
  sourceTable?: string;
}

/** Metadata returned alongside query results. */
export interface QueryMetadata {
  totalRows: number;
  /** Query execution time in milliseconds. */
  executionTime: number;
  /** The resolved query sent to BigQuery, for debugging. */
  query?: string;
  /**
   * v3.19.0: Estimated cost in bytes when dryRun=true was passed.
   * Only present in dry-run responses.
   */
  estimatedBytes?: number;
}

/** Transformed analytics query response. */
export interface AnalyticsQueryResponse {
  data: Record<string, unknown>[];
  metadata: QueryMetadata;
}

// ---------------------------------------------------------------------------
// Capabilities response
// ---------------------------------------------------------------------------

/** A single column definition within a table schema. */
export interface TableColumn {
  name: string;
  type: string;
  description?: string;
}

/** A BigQuery table with its column definitions. */
export interface AnalyticsTable {
  name: string;
  columns: TableColumn[];
}

/** Response from GET /analytics/capabilities. */
export interface AnalyticsCapabilitiesResponse {
  tables: AnalyticsTable[];
  count: number;
}

// ---------------------------------------------------------------------------
// Table schema response
// ---------------------------------------------------------------------------

/** Response from GET /analytics/schema/:table. */
export interface AnalyticsTableSchemaResponse {
  table: string;
  columns: TableColumn[];
  column_count: number;
}

// ---------------------------------------------------------------------------
// Filter values response
// ---------------------------------------------------------------------------

/** A single filter-values result for one collection. */
export interface FilterValuesResult {
  collection: string;
  results: Record<string, string[]>;
}

/** Full response from POST /analytics/filters. */
export type AnalyticsFilterValuesResponse = FilterValuesResult[];

// ---------------------------------------------------------------------------
// Campaign report response (v3.19.0)
// ---------------------------------------------------------------------------

/**
 * Response from POST /analytics/campaign-report.
 * Contains 13 parallel analytics queries for a single campaign.
 */
export interface CampaignReportResponse {
  campaignId: string;
  [key: string]: unknown;
}
