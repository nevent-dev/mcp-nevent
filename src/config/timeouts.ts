/**
 * Centralized HTTP timeout constants for all Nevent MCP tool fetch() calls.
 *
 * All tool files use these constants via `AbortSignal.timeout(TIMEOUTS.xxx)`
 * instead of inlining raw millisecond values. This makes it trivial to tune
 * timeouts globally or per-category without hunting through individual files.
 *
 * ## Guidelines
 *
 * - **DEFAULT_MS** (15 s): General nev-api REST calls (segments, templates,
 *   campaign actions). Covers typical response times with margin for slow
 *   tenant switches.
 *
 * - **LONG_MS** (30 s): Operations known to be slow — segment preview
 *   (executes a MongoDB aggregation across large contact collections),
 *   campaign creation (may trigger async enrichment on nev-api side).
 *
 * - **AUTH_MS** (10 s): Token refresh and tenant switch calls. These MUST
 *   fail fast to avoid blocking the tool response chain. Tenant switch
 *   returns a new JWT, so auth latency is user-visible.
 *
 * - **MONGO_CONNECT_MS** (8 s): MongoDB connection timeout for the lazy-
 *   connect clients in campaigns.ts, templates.ts, and deliverability.ts.
 *   Separate from query timeout — once connected, queries use DEFAULT_MS.
 *
 * @module config/timeouts
 */

/** Timeout constants in milliseconds. */
export const TIMEOUTS = {
  /**
   * Standard nev-api REST call timeout.
   * Used by: list_segments, get_segment, create_segment, update_segment,
   *           list_templates, get_template, create_template, update_template,
   *           get_sending_profile, get_suppressions_summary, paid media tools.
   */
  DEFAULT_MS: 15_000,

  /**
   * Extended timeout for slow operations.
   * Used by: segment_preview (MongoDB aggregation over large collections),
   *           create_campaign (may trigger async enrichment on nev-api).
   */
  LONG_MS: 30_000,

  /**
   * Short timeout for authentication and token management calls.
   * These must fail fast to avoid stalling the tool response chain.
   * Used by: switch_tenant, refreshAccessToken, OAuth token endpoints.
   */
  AUTH_MS: 10_000,

  /**
   * MongoDB initial connection timeout.
   * Applied via MongoClient serverSelectionTimeoutMS option.
   * Separate from per-query timeouts.
   */
  MONGO_CONNECT_MS: 8_000,
} as const;

/** Type-safe alias for timeout value (milliseconds). */
export type TimeoutMs = (typeof TIMEOUTS)[keyof typeof TIMEOUTS];
