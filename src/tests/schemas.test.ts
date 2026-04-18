/**
 * Unit tests for Sprint 1 Zod schemas.
 *
 * Covers:
 * - Valid input acceptance for each tool schema
 * - Invalid input rejection with descriptive errors
 * - Edge cases: missing required fields, out-of-range limits
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  AnalyticsQuerySchema,
  AnalyticsTableSchemaInputSchema,
  AnalyticsFilterValuesSchema,
  SegmentPreviewSchema,
  SegmentExecuteSchema,
  DimensionValuesSchema,
  SegmentDefinitionSchema,
  DimensionSchema,
  MetricSchema,
  FilterSchema,
  TimeRangeSchema,
} from '../schemas/analytics.js';

// ---------------------------------------------------------------------------
// Helpers: wrap schema records as ZodObject for testing
// ---------------------------------------------------------------------------
const AnalyticsQueryObject = z.object(AnalyticsQuerySchema);
const AnalyticsTableSchemaObject = z.object(AnalyticsTableSchemaInputSchema);
const AnalyticsFilterValuesObject = z.object(AnalyticsFilterValuesSchema);
const SegmentPreviewObject = z.object(SegmentPreviewSchema);
const SegmentExecuteObject = z.object(SegmentExecuteSchema);
const DimensionValuesObject = z.object(DimensionValuesSchema);

// ---------------------------------------------------------------------------
// DimensionSchema
// ---------------------------------------------------------------------------
describe('DimensionSchema', () => {
  it('accepts field-only dimension', () => {
    const result = DimensionSchema.safeParse({ field: 'event_id' });
    expect(result.success).toBe(true);
  });

  it('accepts dimension with alias', () => {
    const result = DimensionSchema.safeParse({ field: 'purchase_date', alias: 'date' });
    expect(result.success).toBe(true);
  });

  it('rejects missing field', () => {
    const result = DimensionSchema.safeParse({ alias: 'date' });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MetricSchema
// ---------------------------------------------------------------------------
describe('MetricSchema', () => {
  it('accepts all valid operation types', () => {
    const operations = ['sum', 'count', 'avg', 'min', 'max'] as const;
    for (const op of operations) {
      const result = MetricSchema.safeParse({ field: 'revenue', operation: op });
      expect(result.success).toBe(true);
    }
  });

  it('accepts any string operation (open type for API resilience)', () => {
    // operation is z.string() — not a closed enum — so unknown values like
    // "median" are intentionally accepted (the API decides if it is valid).
    const result = MetricSchema.safeParse({ field: 'revenue', operation: 'median' });
    expect(result.success).toBe(true);
  });

  it('rejects missing field', () => {
    const result = MetricSchema.safeParse({ operation: 'sum' });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FilterSchema
// ---------------------------------------------------------------------------
describe('FilterSchema', () => {
  it('accepts all valid operators', () => {
    const operators = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'like'] as const;
    for (const op of operators) {
      const result = FilterSchema.safeParse({ field: 'status', operator: op, value: 'active' });
      expect(result.success).toBe(true);
    }
  });

  it('accepts any string operator (open type for API resilience)', () => {
    // operator is z.string() — not a closed enum — so extended operators like
    // "contains" are intentionally accepted (the API decides if it is valid).
    const result = FilterSchema.safeParse({ field: 'status', operator: 'contains', value: 'x' });
    expect(result.success).toBe(true);
  });

  it('accepts array value for "in" operator', () => {
    const result = FilterSchema.safeParse({
      field: 'country',
      operator: 'in',
      value: ['ES', 'FR', 'IT'],
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TimeRangeSchema
// ---------------------------------------------------------------------------
describe('TimeRangeSchema', () => {
  it('accepts valid range without granularity', () => {
    const result = TimeRangeSchema.safeParse({ start: '2024-01-01', end: '2024-12-31' });
    expect(result.success).toBe(true);
  });

  it('accepts all valid granularity values', () => {
    const granularities = ['day', 'week', 'month'] as const;
    for (const g of granularities) {
      const result = TimeRangeSchema.safeParse({
        start: '2024-01-01',
        end: '2024-12-31',
        granularity: g,
      });
      expect(result.success).toBe(true);
    }
  });

  it('accepts any string granularity (open type for API resilience)', () => {
    // granularity is z.string() — not a closed enum — so extended values like
    // "hour" are intentionally accepted (the API decides if it is valid).
    const result = TimeRangeSchema.safeParse({
      start: '2024-01-01',
      end: '2024-12-31',
      granularity: 'hour',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing start', () => {
    const result = TimeRangeSchema.safeParse({ end: '2024-12-31' });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AnalyticsQuerySchema (tool 1)
// ---------------------------------------------------------------------------
describe('AnalyticsQuerySchema', () => {
  it('accepts minimal valid request (collection only)', () => {
    const result = AnalyticsQueryObject.safeParse({ collection: 'purchases' });
    expect(result.success).toBe(true);
  });

  it('accepts full valid request', () => {
    const result = AnalyticsQueryObject.safeParse({
      collection: 'purchases',
      dimensions: [{ field: 'event_id', alias: 'event' }],
      metrics: [{ field: 'total', operation: 'sum', alias: 'revenue' }],
      timeRange: { start: '2024-01-01', end: '2024-12-31', granularity: 'month' },
      filters: [{ field: 'status', operator: 'eq', value: 'completed' }],
      having: [{ field: 'revenue', operator: 'gte', value: 1000 }],
      sort: { field: 'revenue', order: 'desc' },
      limit: 50,
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing collection', () => {
    const result = AnalyticsQueryObject.safeParse({
      dimensions: [{ field: 'event_id' }],
    });
    expect(result.success).toBe(false);
  });

  it('applies default limit of 100 when not specified', () => {
    const result = AnalyticsQueryObject.safeParse({ collection: 'tickets' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(100);
    }
  });

  it('rejects limit above 1000', () => {
    const result = AnalyticsQueryObject.safeParse({ collection: 'tickets', limit: 1001 });
    expect(result.success).toBe(false);
  });

  it('accepts limit of exactly 1000', () => {
    const result = AnalyticsQueryObject.safeParse({ collection: 'tickets', limit: 1000 });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AnalyticsTableSchemaInputSchema (tool 3)
// ---------------------------------------------------------------------------
describe('AnalyticsTableSchemaInputSchema', () => {
  it('accepts valid table name', () => {
    const result = AnalyticsTableSchemaObject.safeParse({ table: 'purchases' });
    expect(result.success).toBe(true);
  });

  it('rejects missing table', () => {
    const result = AnalyticsTableSchemaObject.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AnalyticsFilterValuesSchema (tool 4)
// ---------------------------------------------------------------------------
describe('AnalyticsFilterValuesSchema', () => {
  it('accepts valid collection + filters', () => {
    const result = AnalyticsFilterValuesObject.safeParse({
      collection: 'purchases',
      filters: [{ field: 'status' }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing collection', () => {
    const result = AnalyticsFilterValuesObject.safeParse({
      filters: [{ field: 'status' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing filters array', () => {
    const result = AnalyticsFilterValuesObject.safeParse({ collection: 'purchases' });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SegmentDefinitionSchema (shared DSL)
// ---------------------------------------------------------------------------
describe('SegmentDefinitionSchema', () => {
  const validDefinition = {
    stanzas: [
      {
        criteria: [
          {
            type: 'profile_property',
            criterion_id: 'country',
            operator: 'eq',
            value: 'ES',
          },
        ],
      },
    ],
  };

  it('accepts valid segment definition', () => {
    const result = SegmentDefinitionSchema.safeParse(validDefinition);
    expect(result.success).toBe(true);
  });

  it('accepts multiple stanzas (OR logic)', () => {
    const result = SegmentDefinitionSchema.safeParse({
      stanzas: [
        {
          criteria: [{ type: 'profile_property', criterion_id: 'country', operator: 'eq', value: 'ES' }],
        },
        {
          criteria: [{ type: 'behavior', criterion_id: 'event_attended', operator: 'in', value: ['event_1'] }],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid criterion type', () => {
    const result = SegmentDefinitionSchema.safeParse({
      stanzas: [
        {
          criteria: [
            { type: 'invalid_type', criterion_id: 'country', operator: 'eq', value: 'ES' },
          ],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing stanzas', () => {
    const result = SegmentDefinitionSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('accepts criterion with optional timeframe', () => {
    const result = SegmentDefinitionSchema.safeParse({
      stanzas: [
        {
          criteria: [
            {
              type: 'behavior',
              criterion_id: 'event_attended',
              operator: 'eq',
              value: 'event_1',
              timeframe: { type: 'relative', unit: 'days', value_start: 30 },
            },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('accepts all valid criterion types', () => {
    const types = [
      'profile_property',
      'behavior',
      'communication_interaction',
      'app_interaction',
      'acquisition_source',
      'predictive',
    ] as const;

    for (const type of types) {
      const result = SegmentDefinitionSchema.safeParse({
        stanzas: [
          {
            criteria: [{ type, criterion_id: 'some_criterion', operator: 'eq', value: 'x' }],
          },
        ],
      });
      expect(result.success).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// SegmentPreviewSchema (tool 6)
// ---------------------------------------------------------------------------
describe('SegmentPreviewSchema', () => {
  const validDefinition = {
    stanzas: [
      {
        criteria: [
          { type: 'profile_property', criterion_id: 'country', operator: 'eq', value: 'ES' },
        ],
      },
    ],
  };

  it('accepts valid definition', () => {
    const result = SegmentPreviewObject.safeParse({ definition: validDefinition });
    expect(result.success).toBe(true);
  });

  it('rejects missing definition', () => {
    const result = SegmentPreviewObject.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SegmentExecuteSchema (tool 7)
// ---------------------------------------------------------------------------
describe('SegmentExecuteSchema', () => {
  const validDefinition = {
    stanzas: [
      {
        criteria: [
          { type: 'profile_property', criterion_id: 'country', operator: 'eq', value: 'ES' },
        ],
      },
    ],
  };

  it('accepts definition only (uses defaults)', () => {
    const result = SegmentExecuteObject.safeParse({ definition: validDefinition });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(0);
      expect(result.data.page_size).toBe(20);
    }
  });

  it('accepts valid page and page_size', () => {
    const result = SegmentExecuteObject.safeParse({
      definition: validDefinition,
      page: 2,
      page_size: 50,
    });
    expect(result.success).toBe(true);
  });

  it('rejects page_size above 100', () => {
    const result = SegmentExecuteObject.safeParse({
      definition: validDefinition,
      page_size: 101,
    });
    expect(result.success).toBe(false);
  });

  it('accepts page_size of exactly 100', () => {
    const result = SegmentExecuteObject.safeParse({
      definition: validDefinition,
      page_size: 100,
    });
    expect(result.success).toBe(true);
  });

  it('rejects negative page', () => {
    const result = SegmentExecuteObject.safeParse({
      definition: validDefinition,
      page: -1,
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DimensionValuesSchema (tool 8)
// ---------------------------------------------------------------------------
describe('DimensionValuesSchema', () => {
  it('accepts criterion_id only', () => {
    const result = DimensionValuesObject.safeParse({ criterion_id: 'country' });
    expect(result.success).toBe(true);
  });

  it('accepts criterion_id with search', () => {
    const result = DimensionValuesObject.safeParse({ criterion_id: 'country', search: 'Spa' });
    expect(result.success).toBe(true);
  });

  it('rejects missing criterion_id', () => {
    const result = DimensionValuesObject.safeParse({ search: 'Spa' });
    expect(result.success).toBe(false);
  });
});
