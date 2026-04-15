/**
 * Zod validation schemas for deliverability tools.
 *
 * Covers the input schemas for:
 *  1. nevent_get_sending_profile      — Warm-up state and sending configuration
 *  2. nevent_get_suppressions_summary — Suppressions and unsubscriptions summary
 *
 * Both tools derive the tenant context from the DataClient's activeTenantId
 * (set via nevent_switch_tenant) and therefore accept no parameters.
 *
 * Design principles:
 * - No-parameter tools use an empty plain object schema `{}`
 *   (consistent with AnalyticsCapabilitiesSchema and SegmentationCriteriaSchema)
 * - If optional parameters are added in the future, extend this file
 */

// ---------------------------------------------------------------------------
// Tool 1: nevent_get_sending_profile
// ---------------------------------------------------------------------------

/**
 * Input schema for `nevent_get_sending_profile`.
 *
 * No parameters — the tenant is resolved from the DataClient's activeTenantId.
 * Call `nevent_switch_tenant` first if you need to query a specific tenant.
 */
export const GetSendingProfileSchema = {};

// ---------------------------------------------------------------------------
// Tool 2: nevent_get_suppressions_summary
// ---------------------------------------------------------------------------

/**
 * Input schema for `nevent_get_suppressions_summary`.
 *
 * No parameters — the tenant is resolved from the DataClient's activeTenantId.
 * Call `nevent_switch_tenant` first if you need to query a specific tenant.
 *
 * Note: `by_reason` counts represent lifetime totals (not 30-day windowed).
 * The `last_30d` field provides the windowed count for trend analysis.
 */
export const GetSuppressionsSummarySchema = {};
