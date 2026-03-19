/**
 * Common shared types for the Nevent MCP Server.
 *
 * Provides the foundational type definitions used across all modules,
 * including the Stripe-inspired error format and shared API response types.
 */

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Categorized error types following a Stripe-inspired convention.
 *
 * - `invalid_request`    — Client sent bad parameters or malformed input.
 * - `authentication_error` — Missing or invalid JWT token.
 * - `api_error`          — Unexpected error from the upstream API.
 * - `rate_limit_error`   — Request rate exceeded; caller should back off.
 * - `not_found`          — The requested resource does not exist.
 */
export type NeventErrorType =
  | 'invalid_request'
  | 'authentication_error'
  | 'api_error'
  | 'rate_limit_error'
  | 'not_found';

/**
 * Structured error object returned in every error response.
 *
 * @example
 * ```ts
 * const err: NeventError = {
 *   type: 'invalid_request',
 *   message: '`collection` is required.',
 *   code: 'missing_required_param',
 *   param: 'collection',
 * };
 * ```
 */
export interface NeventError {
  /** High-level error category. */
  type: NeventErrorType;
  /** Human-readable explanation of what went wrong. */
  message: string;
  /** Snake-case code suitable for programmatic handling. */
  code: string;
  /** The offending parameter name, when applicable. */
  param?: string;
}

/**
 * Top-level envelope wrapping a `NeventError`.
 * Every error tool response must be serialised to this shape.
 */
export interface NeventErrorEnvelope {
  error: NeventError;
}

// ---------------------------------------------------------------------------
// Pagination helpers
// ---------------------------------------------------------------------------

/**
 * Generic paginated response wrapper.
 *
 * @typeParam T — The item type contained in the `data` array.
 */
export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasMore: boolean;
}

// ---------------------------------------------------------------------------
// HTTP utility types
// ---------------------------------------------------------------------------

/**
 * Allowed query-string parameter value types.
 * Matches the constraint used in the HTTP client.
 */
export type QueryParamValue = string | number | boolean | undefined;

/**
 * Generic raw HTTP response wrapper returned by the base client.
 *
 * @typeParam T — The deserialized response body type.
 */
export interface HttpResponse<T> {
  data: T;
  status: number;
  ok: boolean;
}
