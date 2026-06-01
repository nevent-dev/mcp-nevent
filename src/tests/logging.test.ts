/**
 * Unit tests for the logging module.
 *
 * Tests the `redactSensitiveFields` utility to ensure sensitive parameter
 * values are correctly replaced with "[REDACTED]" before MongoDB persistence,
 * while non-sensitive values pass through unchanged.
 */

import { describe, it, expect } from 'vitest';
import { redactSensitiveFields } from '../tools/logging.js';

// ---------------------------------------------------------------------------
// redactSensitiveFields
// ---------------------------------------------------------------------------

describe('redactSensitiveFields', () => {
  // -------------------------------------------------------------------------
  // Flat objects
  // -------------------------------------------------------------------------

  describe('flat object — sensitive keys', () => {
    it('redacts jwt at top level', () => {
      const result = redactSensitiveFields({ jwt: 'eyJhbGci...', name: 'test' });
      expect(result['jwt']).toBe('[REDACTED]');
      expect(result['name']).toBe('test');
    });

    it('redacts token at top level', () => {
      const result = redactSensitiveFields({ token: 'secret-token', query: 'VIP' });
      expect(result['token']).toBe('[REDACTED]');
      expect(result['query']).toBe('VIP');
    });

    it('redacts password at top level', () => {
      const result = redactSensitiveFields({ password: 'p@ssw0rd' });
      expect(result['password']).toBe('[REDACTED]');
    });

    it('redacts access_token at top level', () => {
      const result = redactSensitiveFields({ access_token: 'bearer-xyz' });
      expect(result['access_token']).toBe('[REDACTED]');
    });

    it('redacts refresh_token at top level', () => {
      const result = redactSensitiveFields({ refresh_token: 'refresh-xyz' });
      expect(result['refresh_token']).toBe('[REDACTED]');
    });

    it('redacts authorization at top level', () => {
      const result = redactSensitiveFields({ authorization: 'Bearer token123' });
      expect(result['authorization']).toBe('[REDACTED]');
    });

    it('redacts cookie at top level', () => {
      const result = redactSensitiveFields({ cookie: 'session=abc123' });
      expect(result['cookie']).toBe('[REDACTED]');
    });
  });

  // -------------------------------------------------------------------------
  // Case-insensitive matching
  // -------------------------------------------------------------------------

  describe('case-insensitive key matching', () => {
    it('redacts JWT (uppercase)', () => {
      const result = redactSensitiveFields({ JWT: 'token-value' });
      expect(result['JWT']).toBe('[REDACTED]');
    });

    it('redacts Authorization (mixed case)', () => {
      const result = redactSensitiveFields({ Authorization: 'Bearer xyz' });
      expect(result['Authorization']).toBe('[REDACTED]');
    });

    it('redacts TOKEN (uppercase)', () => {
      const result = redactSensitiveFields({ TOKEN: 'secret' });
      expect(result['TOKEN']).toBe('[REDACTED]');
    });

    it('redacts Access_Token (mixed case)', () => {
      const result = redactSensitiveFields({ Access_Token: 'some-value' });
      expect(result['Access_Token']).toBe('[REDACTED]');
    });
  });

  // -------------------------------------------------------------------------
  // Non-sensitive keys — passthrough
  // -------------------------------------------------------------------------

  describe('non-sensitive keys — passthrough', () => {
    it('preserves all values when no sensitive keys present', () => {
      const input = {
        collection: 'events',
        limit: 100,
        include_inactive: false,
        segment_name: 'VIP attendees',
      };
      const result = redactSensitiveFields(input);
      expect(result).toEqual(input);
    });

    it('preserves empty object unchanged', () => {
      expect(redactSensitiveFields({})).toEqual({});
    });

    it('preserves null values for non-sensitive keys', () => {
      const result = redactSensitiveFields({ campaign_id: null, limit: null });
      expect(result['campaign_id']).toBeNull();
      expect(result['limit']).toBeNull();
    });

    it('preserves numeric values', () => {
      const result = redactSensitiveFields({ page: 1, limit: 50 });
      expect(result['page']).toBe(1);
      expect(result['limit']).toBe(50);
    });

    it('preserves boolean values', () => {
      const result = redactSensitiveFields({ confirmed: true, active: false });
      expect(result['confirmed']).toBe(true);
      expect(result['active']).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Nested objects — one level deep
  // -------------------------------------------------------------------------

  describe('nested objects — one level deep', () => {
    it('redacts token inside a nested object', () => {
      const input = { filter: { token: 'x', value: 'premium' } };
      const result = redactSensitiveFields(input);
      const filter = result['filter'] as Record<string, unknown>;
      expect(filter['token']).toBe('[REDACTED]');
      expect(filter['value']).toBe('premium');
    });

    it('redacts jwt inside a nested object', () => {
      const input = { auth: { jwt: 'eyJ...', user: 'alice' } };
      const result = redactSensitiveFields(input);
      const auth = result['auth'] as Record<string, unknown>;
      expect(auth['jwt']).toBe('[REDACTED]');
      expect(auth['user']).toBe('alice');
    });

    it('preserves non-sensitive nested keys unchanged', () => {
      const input = { options: { limit: 10, include_deleted: false } };
      const result = redactSensitiveFields(input);
      expect(result['options']).toEqual({ limit: 10, include_deleted: false });
    });

    it('does not mutate the original nested object', () => {
      const nested = { token: 'secret', name: 'test' };
      const input = { filter: nested };
      redactSensitiveFields(input);
      // Original nested object must remain unchanged
      expect(nested['token']).toBe('secret');
    });
  });

  // -------------------------------------------------------------------------
  // Arrays — elements that are plain objects are redacted one level deep
  // -------------------------------------------------------------------------

  describe('arrays — elements redacted one level deep', () => {
    it('redacts sensitive keys in array of plain objects', () => {
      const input = {
        filters: [
          { field: 'email', token: 'abc' },
          { field: 'name', value: 'Alice' },
        ],
      };
      const result = redactSensitiveFields(input);
      const filters = result['filters'] as Array<Record<string, unknown>>;
      expect(filters[0]!['token']).toBe('[REDACTED]');
      expect(filters[0]!['field']).toBe('email');
      expect(filters[1]!['value']).toBe('Alice');
    });

    it('leaves primitive array elements unchanged', () => {
      const input = { ids: [1, 2, 3], tags: ['vip', 'premium'] };
      const result = redactSensitiveFields(input);
      expect(result['ids']).toEqual([1, 2, 3]);
      expect(result['tags']).toEqual(['vip', 'premium']);
    });

    it('leaves null array elements unchanged', () => {
      const input = { values: [null, 'a', null] };
      const result = redactSensitiveFields(input);
      expect(result['values']).toEqual([null, 'a', null]);
    });

    it('handles empty array', () => {
      const result = redactSensitiveFields({ items: [] });
      expect(result['items']).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Immutability — input must not be mutated
  // -------------------------------------------------------------------------

  describe('immutability', () => {
    it('does not mutate the input object', () => {
      const input = { jwt: 'original', name: 'test' };
      redactSensitiveFields(input);
      expect(input['jwt']).toBe('original');
    });

    it('returns a new object reference', () => {
      const input = { name: 'test' };
      const result = redactSensitiveFields(input);
      expect(result).not.toBe(input);
    });
  });

  // -------------------------------------------------------------------------
  // Mixed — sensitive and non-sensitive at various levels
  // -------------------------------------------------------------------------

  describe('mixed scenarios', () => {
    it('handles a realistic analytics_query params object', () => {
      const input = {
        collection: 'events',
        timeRange: { start: '2025-01-01', end: '2025-01-31' },
        dimensions: ['event_id', 'source'],
        metrics: ['count'],
        filters: [{ field: 'channel', operator: 'eq', value: 'email' }],
      };
      const result = redactSensitiveFields(input);
      expect(result['collection']).toBe('events');
      expect(result['dimensions']).toEqual(['event_id', 'source']);
      // timeRange is a plain object — no sensitive keys inside it
      const timeRange = result['timeRange'] as Record<string, unknown>;
      expect(timeRange['start']).toBe('2025-01-01');
    });

    it('handles a create_segment params object with no sensitive keys', () => {
      const input = {
        name: 'VIP attendees Q1 2025',
        definition: { type: 'filter', field: 'ticket_type', value: 'VIP' },
        description: 'High-value segment for Q1 campaign',
      };
      const result = redactSensitiveFields(input);
      // All values pass through — nothing is sensitive
      expect(result['name']).toBe('VIP attendees Q1 2025');
      const def = result['definition'] as Record<string, unknown>;
      expect(def['value']).toBe('VIP');
    });

    it('redacts multiple sensitive fields at top level simultaneously', () => {
      const result = redactSensitiveFields({
        token: 'tok',
        password: 'pw',
        jwt: 'j',
        name: 'safe',
      });
      expect(result['token']).toBe('[REDACTED]');
      expect(result['password']).toBe('[REDACTED]');
      expect(result['jwt']).toBe('[REDACTED]');
      expect(result['name']).toBe('safe');
    });
  });
});
