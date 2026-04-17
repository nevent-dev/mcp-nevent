/**
 * Zod validation schemas for Sprint 2 segment management tools.
 *
 * Covers three MCP tools:
 *  1. nevent_list_segments   — List persisted segments for the active tenant (READ)
 *  2. nevent_create_segment  — Persist a new segment definition (WRITE)
 *  3. nevent_update_segment  — Modify an existing segment (WRITE)
 *
 * All three tools share the `SegmentDefinitionSchema` already defined in
 * `src/schemas/analytics.ts`. We re-export it here so callers in this module
 * do not need to cross-import from the analytics schema file.
 *
 * Design principles:
 * - Required fields have no default so missing params surface early.
 * - Optional fields use `.optional()` (not `.nullable()`) for clean JSON output.
 * - `definition` re-uses the exact same DSL already validated by the preview tool.
 */

import { z } from 'zod';
import { SegmentDefinitionSchema } from './analytics.js';

// Re-export so consumers in this module can stay self-contained.
export { SegmentDefinitionSchema };

// ---------------------------------------------------------------------------
// Tool 1: nevent_list_segments — no input parameters
// ---------------------------------------------------------------------------

/**
 * Input schema for `nevent_list_segments`.
 * No parameters required — the active tenant is resolved from `DataClient.activeTenantId`.
 */
export const ListSegmentsSchema = {};

// ---------------------------------------------------------------------------
// Tool 1b: nevent_get_segment
// ---------------------------------------------------------------------------

/**
 * Input schema for `nevent_get_segment`.
 */
export const GetSegmentSchema = {
  segment_id: z
    .string()
    .min(1)
    .regex(/^[a-f0-9]{24}$/i, 'Must be a valid 24-character hex identifier')
    .describe(
      'Identifier of the segment to retrieve. ' +
      'Get valid IDs from nevent_list_segments.'
    ),
};

// ---------------------------------------------------------------------------
// Tool 2: nevent_create_segment
// ---------------------------------------------------------------------------

/**
 * Input schema for `nevent_create_segment`.
 *
 * @example
 * ```ts
 * const params: z.infer<typeof z.object(CreateSegmentSchema)> = {
 *   name: 'VIP attendees 2025',
 *   definition: { stanzas: [{ criteria: [{ type: 'behavior', criterion_id: 'event_attended', operator: 'eq', value: 'EVENT_ID' }] }] },
 *   description: 'Fans who attended at least one event in 2025',
 * };
 * ```
 */
export const CreateSegmentSchema = {
  /**
   * Human-readable name for the new segment.
   * Must be non-empty; duplicates are allowed by the API.
   */
  name: z
    .string()
    .min(1)
    .describe('Human-readable name for the segment, e.g. "VIP Attendees 2025"'),

  /**
   * Segment DSL definition (stanzas and criteria).
   * Stanzas are OR-combined; criteria within a stanza are AND-combined.
   * Must contain at least one stanza with at least one criterion.
   *
   * Call `nevent_segmentation_criteria` first to discover valid criterion_ids
   * and operators, then optionally `nevent_segment_preview` to validate the
   * definition and estimate audience size before persisting.
   */
  definition: SegmentDefinitionSchema.describe(
    'Segment DSL: stanzas are OR-combined, criteria within each stanza are AND-combined. ' +
    'Must have at least one stanza with at least one criterion. ' +
    'Use nevent_segment_preview first to validate the definition.'
  ),

  /**
   * Optional human-readable description explaining the segment's purpose.
   */
  description: z
    .string()
    .optional()
    .describe('Optional description of the segment\'s purpose'),
};

// ---------------------------------------------------------------------------
// Tool 3: nevent_update_segment
// ---------------------------------------------------------------------------

/**
 * Input schema for `nevent_update_segment`.
 *
 * At least one of `name` or `definition` must be provided (validated at
 * runtime in the tool handler, not by Zod, to provide a clearer error).
 *
 * @example
 * ```ts
 * const params: z.infer<typeof z.object(UpdateSegmentSchema)> = {
 *   segment_id: '64f3a1b2c8e94d001e2a7f3c',
 *   name: 'VIP Attendees 2025 (updated)',
 * };
 * ```
 */
export const UpdateSegmentSchema = {
  /**
   * Identifier of the segment to update.
   * Use `nevent_list_segments` to discover valid segment IDs.
   * Must be a 24-character hex string.
   */
  segment_id: z
    .string()
    .min(1)
    .regex(/^[a-f0-9]{24}$/i, 'Must be a valid 24-character hex identifier')
    .describe(
      'Identifier of the segment to update. ' +
      'Use nevent_list_segments to get valid segment IDs.'
    ),

  /**
   * New name for the segment. Omit to leave unchanged.
   */
  name: z
    .string()
    .min(1)
    .optional()
    .describe('New human-readable name for the segment. Omit to leave unchanged.'),

  /**
   * Replacement segment definition. Omit to leave unchanged.
   * The entire definition is replaced — partial stanza updates are not supported.
   */
  definition: SegmentDefinitionSchema.optional().describe(
    'Replacement segment DSL. The full definition is replaced when provided. ' +
    'Omit to leave the existing definition unchanged.'
  ),
};
