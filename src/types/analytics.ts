/**
 * BigQuery analytics types for the Nevent MCP Server.
 *
 * Defines the shapes of requests and responses for all analytics endpoints
 * exposed by the nev-data-api (data.nevent.es).
 */

// ---------------------------------------------------------------------------
// Query DSL types
// ---------------------------------------------------------------------------

/** A dimension field, optionally aliased in the result set. */
export interface Dimension {
  field: string;
  alias?: string;
}

/** Supported aggregation operations for metric fields. */
export type MetricOperation = 'sum' | 'count' | 'avg' | 'min' | 'max';

/** A metric field with an aggregation operation, optionally aliased. */
export interface Metric {
  field: string;
  operation: MetricOperation;
  alias?: string;
}

/** Time granularity for time-based grouping. */
export type TimeGranularity = 'day' | 'week' | 'month';

/** Time range filter with optional granularity for bucketed queries. */
export interface TimeRange {
  /** ISO 8601 date string, e.g. "2024-01-01". */
  start: string;
  /** ISO 8601 date string, e.g. "2024-12-31". */
  end: string;
  granularity?: TimeGranularity;
}

/** Supported filter comparison operators. */
export type FilterOperator =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'in'
  | 'not_in'
  | 'like';

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

// ---------------------------------------------------------------------------
// Analytics query request / response
// ---------------------------------------------------------------------------

/**
 * Full analytics query request body sent to POST /analytics/query.
 */
export interface AnalyticsQueryRequest {
  collection: string;
  dimensions?: Dimension[];
  metrics?: Metric[];
  timeRange?: TimeRange;
  filters?: Filter[];
  having?: Having[];
  sort?: Sort;
  limit?: number;
  compareDimensions?: CompareDimensions;
}

/** Metadata returned alongside query results. */
export interface QueryMetadata {
  totalRows: number;
  /** Query execution time in milliseconds. */
  executionTime: number;
  /** The resolved query sent to BigQuery, for debugging. */
  query?: string;
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
