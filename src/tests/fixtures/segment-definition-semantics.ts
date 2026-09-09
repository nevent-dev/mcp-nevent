/**
 * Deterministic fixtures that pin the canonical boolean algebra of the segment DSL.
 *
 * The canonical engine (nev-data-api `SegmentExecutionService`) resolves a
 * definition as:
 *   - criterion  → the fan set that criterion matches
 *   - stanza     → UNION of its criteria sets      (any criterion matches)
 *   - definition → INTERSECT of its stanza sets    (every stanza must match)
 *
 * Every case below is expressed over the closed fan universe `FAN_UNIVERSE`,
 * so the expected result is a plain, hand-checkable set — no engine required.
 *
 * Each criterion carries an explicit `id`, which doubles as its stable key in
 * `criterionMembers`. That keeps the criterion → fan-set mapping unambiguous
 * without a parallel index structure.
 *
 * @module tests/fixtures/segment-definition-semantics
 */

import type { SegmentDefinition } from '../../types/segmentation.js';

// ---------------------------------------------------------------------------
// Fan universe
// ---------------------------------------------------------------------------

/** Closed fan universe shared by every case. */
export const FAN_UNIVERSE = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8'] as const;

/** Sorted set union — used to derive multi-value criterion sets. */
function union(...sets: readonly string[][]): string[] {
  return [...new Set(sets.flat())].sort();
}

// ---------------------------------------------------------------------------
// Named member sets
// ---------------------------------------------------------------------------

/** Fans matched by `total_spent gt 100`. */
const SPENDERS = ['f1', 'f2', 'f3'];
/** Fans matched by `user_country eq ES`. */
const SPANISH = ['f3', 'f4'];
/** Fans matched by `user_age gte 18`. */
const ADULTS = ['f2', 'f3', 'f6'];
/** Fans matched by `attended_event is EVENT_ONLY_7`. */
const EVENT_SEVEN = ['f7'];
/** Fans matched by `attended_event is EVENT_ONLY_8`. */
const EVENT_EIGHT = ['f8'];
/** Fans whose custom field `company` equals "Nevent". */
const COMPANY_NEVENT = ['f1', 'f2', 'f5'];
/** Fans carrying the `vip` label. */
const LABEL_VIP = ['f1', 'f2'];
/** Fans carrying the `press` label. */
const LABEL_PRESS = ['f2', 'f5'];
/** Fans matched by `attended_event is EVENT_MIXED`. */
const EVENT_MIXED = ['f2', 'f5', 'f7'];

/**
 * An ENTITY `is` criterion whose value is an ARRAY matches the UNION of the
 * per-value fan sets — one criterion, several accepted values.
 */
const LABEL_VIP_OR_PRESS = union(LABEL_VIP, LABEL_PRESS);

// ---------------------------------------------------------------------------
// Case shape
// ---------------------------------------------------------------------------

/** One deterministic segment-algebra case. */
export interface SegmentSemanticsCase {
  /** Human-readable case name, used as the test title. */
  name: string;
  /** The DSL definition exactly as an MCP consumer would send it. */
  definition: SegmentDefinition;
  /** Fans matched by each criterion, keyed by that criterion's `id`. */
  criterionMembers: Record<string, string[]>;
  /** Fans the canonical engine returns for `definition`, sorted. */
  expected: string[];
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

export const SEGMENT_SEMANTICS_CASES: SegmentSemanticsCase[] = [
  {
    name: '1. single criterion — the criterion set itself',
    definition: {
      stanzas: [
        { criteria: [{ id: 'c1', criterion_id: 'total_spent', operator: 'gt', value: 100 }] },
      ],
    },
    criterionMembers: { c1: SPENDERS },
    expected: ['f1', 'f2', 'f3'],
  },
  {
    name: '2. two criteria in ONE stanza — union',
    definition: {
      stanzas: [
        {
          criteria: [
            { id: 'c1', criterion_id: 'total_spent', operator: 'gt', value: 100 },
            { id: 'c2', criterion_id: 'user_country', operator: 'eq', value: 'ES' },
          ],
        },
      ],
    },
    criterionMembers: { c1: SPENDERS, c2: SPANISH },
    expected: ['f1', 'f2', 'f3', 'f4'],
  },
  {
    name: '3. the same two criteria in TWO stanzas — intersection',
    definition: {
      stanzas: [
        { criteria: [{ id: 'c1', criterion_id: 'total_spent', operator: 'gt', value: 100 }] },
        { criteria: [{ id: 'c2', criterion_id: 'user_country', operator: 'eq', value: 'ES' }] },
      ],
    },
    criterionMembers: { c1: SPENDERS, c2: SPANISH },
    expected: ['f3'],
  },
  {
    name: '4. mixed grouping — (a OR b) AND c',
    definition: {
      stanzas: [
        {
          criteria: [
            { id: 'c1', criterion_id: 'total_spent', operator: 'gt', value: 100 },
            { id: 'c2', criterion_id: 'user_country', operator: 'eq', value: 'ES' },
          ],
        },
        { criteria: [{ id: 'c3', criterion_id: 'user_age', operator: 'gte', value: 18 }] },
      ],
    },
    criterionMembers: { c1: SPENDERS, c2: SPANISH, c3: ADULTS },
    expected: ['f2', 'f3'],
  },
  {
    name: '5. disjoint sets in separate stanzas — empty',
    definition: {
      stanzas: [
        {
          criteria: [
            { id: 'c1', criterion_id: 'attended_event', operator: 'is', value: 'EVENT_ONLY_7' },
          ],
        },
        {
          criteria: [
            { id: 'c2', criterion_id: 'attended_event', operator: 'is', value: 'EVENT_ONLY_8' },
          ],
        },
      ],
    },
    criterionMembers: { c1: EVENT_SEVEN, c2: EVENT_EIGHT },
    expected: [],
  },
  {
    name: '6. custom field OR label, AND a behavior criterion in a second stanza',
    definition: {
      stanzas: [
        {
          criteria: [
            {
              id: 'c1',
              criterion_id: 'user_custom_field',
              operator: 'eq',
              value: 'Nevent',
              filters: { property_name: 'company' },
            },
            { id: 'c2', criterion_id: 'user_label', operator: 'is', value: 'vip' },
          ],
        },
        {
          criteria: [
            { id: 'c3', criterion_id: 'attended_event', operator: 'is', value: 'EVENT_MIXED' },
          ],
        },
      ],
    },
    criterionMembers: { c1: COMPANY_NEVENT, c2: LABEL_VIP, c3: EVENT_MIXED },
    expected: ['f2', 'f5'],
  },
  {
    name: '7. single label criterion with an ARRAY value — union of per-value sets',
    definition: {
      stanzas: [
        {
          criteria: [
            { id: 'c1', criterion_id: 'user_label', operator: 'is', value: ['vip', 'press'] },
          ],
        },
      ],
    },
    criterionMembers: { c1: LABEL_VIP_OR_PRESS },
    expected: ['f1', 'f2', 'f5'],
  },
];
