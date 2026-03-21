/**
 * Segmentation DSL types for the Nevent MCP Server.
 *
 * Defines the complete type system for audience segmentation, including
 * the DSL used to compose segment definitions and the responses returned
 * by segment preview, execute, and criteria endpoints.
 */

// ---------------------------------------------------------------------------
// Criteria types
// ---------------------------------------------------------------------------

/**
 * The category of a segmentation criterion.
 *
 * - `profile_property`        — Fan profile attributes (name, age, country, etc.)
 * - `behavior`                — Purchase, attendance, or event-related behavior.
 * - `communication_interaction` — Email, SMS, or push open/click events.
 * - `app_interaction`         — Mobile app usage events.
 * - `acquisition_source`      — How the fan was acquired.
 * - `predictive`              — ML-predicted attributes (churn score, LTV, etc.)
 */
export type CriterionType =
  | 'profile_property'
  | 'behavior'
  | 'communication_interaction'
  | 'app_interaction'
  | 'acquisition_source'
  | 'predictive';

/**
 * A single criterion definition returned by GET /segmentation/criteria.
 */
export interface CriterionDefinition {
  id: string;
  type: CriterionType;
  label: string;
  operators: string[];
  valueType: string;
}

/** Response from GET /segmentation/criteria. */
export interface SegmentationCriteriaResponse {
  criteria: CriterionDefinition[];
}

// ---------------------------------------------------------------------------
// Segment definition DSL
// ---------------------------------------------------------------------------

/** Optional time-frame window applied to a behavioral criterion. */
export interface CriterionTimeframe {
  type: string;
  unit?: string;
  /** For relative timeframes: start offset value. */
  value_start?: number;
  /** For relative timeframes: end offset value. */
  value_end?: number;
}

/** Frequency modifier — the criterion must be true N times. */
export interface FrequencyModifier {
  count: number;
  operator: string;
}

/** Time range modifier — restrict criterion to a sliding window. */
export interface TimeRangeModifier {
  value: number;
  unit: string;
}

/** Optional modifiers that refine criterion matching semantics. */
export interface CriterionModifiers {
  frequency?: FrequencyModifier;
  time_range?: TimeRangeModifier;
}

/**
 * A single criterion within a stanza.
 * All criteria in a stanza are AND-combined; stanzas are OR-combined.
 */
export interface SegmentCriterion {
  /** Optional stable identifier for UI correlation. */
  id?: string;
  type: CriterionType;
  criterion_id: string;
  operator: string;
  /** Criterion value to match against. */
  value?: unknown;
  timeframe?: CriterionTimeframe;
  filters?: Record<string, unknown>;
  modifiers?: CriterionModifiers;
}

/**
 * A stanza groups one or more criteria with AND logic.
 * Multiple stanzas are OR-combined to form the overall segment.
 */
export interface SegmentStanza {
  /** Optional stable identifier for UI correlation. */
  id?: string;
  criteria: SegmentCriterion[];
}

/**
 * Top-level segment definition used as input to preview and execute endpoints.
 * The DSL is an array of stanzas (OR), each containing an array of criteria (AND).
 */
export interface SegmentDefinition {
  stanzas: SegmentStanza[];
}

// ---------------------------------------------------------------------------
// Preview response
// ---------------------------------------------------------------------------

/** A sample fan returned in the preview response. */
export interface PreviewFan {
  fan_id: string;
  first_name?: string;
  last_name?: string;
  email?: string;
}

/** Response from POST /segments/preview. */
export interface SegmentPreviewResponse {
  estimated_fan_count: number;
  sample_fans: PreviewFan[];
}

// ---------------------------------------------------------------------------
// Execute response
// ---------------------------------------------------------------------------

/** A fan in the full execute result set. */
export interface ExecuteFan {
  fan_id: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
}

/** Response from POST /segments/execute. */
export interface SegmentExecuteResponse {
  total_fans: number;
  fans: ExecuteFan[];
  current_page: number;
  total_pages: number;
  has_more: boolean;
}

// ---------------------------------------------------------------------------
// Dimension values response
// ---------------------------------------------------------------------------

/** A labeled value option (used for enum-type criteria). */
export interface LabeledValue {
  id: string;
  label: string;
}

/**
 * Response from POST /dimensions/values.
 * Values may be plain strings or labeled objects depending on the criterion.
 */
export interface DimensionValuesResponse {
  values: string[] | LabeledValue[];
}
