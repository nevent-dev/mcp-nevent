/**
 * TypeScript types for Sprint 2 segment management tools.
 *
 * These types represent the shapes of documents stored in the MongoDB
 * `segments` collection (database: `nevent`) and the API response shapes
 * returned by the nev-api segments endpoints.
 *
 * All write operations are routed through nev-api (not nev-data-api) because
 * segment persistence is owned by the core API service. The `_id` field is
 * stored as a MongoDB `ObjectId` in the database but serialized to string in
 * API responses and MCP tool outputs.
 */

import type { SegmentDefinition } from './segmentation.js';

// ---------------------------------------------------------------------------
// Segment document shape (as returned by nev-api)
// ---------------------------------------------------------------------------

/**
 * A single segment record as returned by nev-api endpoints.
 *
 * Fields map directly to the MongoDB `segments` collection with `_id`
 * serialized as `id` (string) in the API response.
 */
export interface SegmentRecord {
  /** Unique segment identifier (MongoDB ObjectId as string). */
  id: string;

  /** Human-readable segment name. */
  name: string;

  /** Estimated number of matching contacts (last computed value, may be stale). */
  estimatedCount?: number;

  /**
   * Lifecycle status of the segment.
   * - `ACTIVE`   — Normal, usable segment.
   * - `INACTIVE` — Soft-disabled by the tenant.
   * - `DRAFT`    — Segment is not yet finalized.
   */
  status?: string;

  /** ISO 8601 timestamp of the last time the segment query was executed. */
  lastExecutedAt?: string;

  /** ISO 8601 timestamp of when the segment was created. */
  createdAt?: string;

  /** User or agent that created the segment (e.g. `"mcp-agent"`). */
  createdBy?: string;

  /**
   * `true` if this segment was migrated from a legacy system.
   * Legacy segments may not support the modern stanza DSL.
   */
  isLegacy?: boolean;

  /** Tenant identifier this segment belongs to. */
  tenantId?: string;

  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// API response shapes
// ---------------------------------------------------------------------------

/**
 * Response shape for `nevent_list_segments`.
 *
 * nev-api may return segments as a plain array or wrapped in a Spring Page
 * envelope. The tool handler normalizes both to this shape.
 */
export interface ListSegmentsResponse {
  /** Array of matching segment records (may be empty). */
  segments: SegmentRecord[];
  /** Total count of segments returned. */
  count: number;
}

/**
 * Response shape for `nevent_create_segment`.
 */
export interface CreateSegmentResponse {
  /** The newly created segment with its assigned `id`. */
  segment: SegmentRecord;
}

/**
 * Response shape for `nevent_update_segment`.
 */
export interface UpdateSegmentResponse {
  /** The full segment record after applying the update. */
  segment: SegmentRecord;
}

// ---------------------------------------------------------------------------
// Request body shapes (sent to nev-api)
// ---------------------------------------------------------------------------

/**
 * Request body for POST /segments (create a new segment).
 */
export interface CreateSegmentRequestBody {
  name: string;
  definition: SegmentDefinition;
  description?: string;
  tenantId?: string;
  status: 'ACTIVE';
  createdBy: 'mcp-agent';
}

/**
 * Request body for PUT /segments/:id (update an existing segment).
 */
export interface UpdateSegmentRequestBody {
  name?: string;
  definition?: SegmentDefinition;
  modifiedBy: 'mcp-agent';
  modifiedAt: string;
}
