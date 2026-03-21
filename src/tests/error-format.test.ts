/**
 * Unit tests for the BaseClient error handling and formatting.
 *
 * Tests the NeventApiError class and error envelope construction
 * using real BaseClient method behavior (via a subclass test harness).
 */

import { describe, it, expect } from 'vitest';
import { NeventApiError, BaseClient } from '../clients/base-client.js';
import type { NeventErrorEnvelope } from '../types/common.js';

// ---------------------------------------------------------------------------
// NeventApiError class tests
// ---------------------------------------------------------------------------

describe('NeventApiError', () => {
  it('wraps a NeventError and exposes it on .neventError', () => {
    const neventError = {
      type: 'api_error' as const,
      message: 'Something went wrong',
      code: 'server_error',
    };
    const apiError = new NeventApiError(neventError);
    expect(apiError.neventError).toEqual(neventError);
    expect(apiError.message).toBe('Something went wrong');
    expect(apiError.name).toBe('NeventApiError');
  });

  it('is an instance of Error', () => {
    const apiError = new NeventApiError({
      type: 'not_found',
      message: 'Not found',
      code: 'not_found',
    });
    expect(apiError instanceof Error).toBe(true);
    expect(apiError instanceof NeventApiError).toBe(true);
  });

  it('preserves all error fields including optional param', () => {
    const apiError = new NeventApiError({
      type: 'invalid_request',
      message: 'Missing param',
      code: 'missing_required_param',
      param: 'collection',
    });
    expect(apiError.neventError.param).toBe('collection');
  });
});

// ---------------------------------------------------------------------------
// Error envelope serialization
// ---------------------------------------------------------------------------

describe('NeventErrorEnvelope serialization', () => {
  it('serializes to the expected JSON shape', () => {
    const envelope: NeventErrorEnvelope = {
      error: {
        type: 'rate_limit_error',
        message: 'Rate limit exceeded. Retry after 5 seconds.',
        code: 'rate_limit_exceeded',
        param: '5',
      },
    };

    const json = JSON.stringify(envelope);
    const parsed = JSON.parse(json) as NeventErrorEnvelope;

    expect(parsed.error.type).toBe('rate_limit_error');
    expect(parsed.error.message).toContain('Rate limit exceeded');
    expect(parsed.error.code).toBe('rate_limit_exceeded');
    expect(parsed.error.param).toBe('5');
  });

  it('omits undefined param field from JSON output', () => {
    const envelope: NeventErrorEnvelope = {
      error: {
        type: 'api_error',
        message: 'Server error',
        code: 'server_error',
      },
    };

    const json = JSON.stringify(envelope);
    expect(json).not.toContain('"param"');
  });
});

// ---------------------------------------------------------------------------
// BaseClient instantiation tests
// ---------------------------------------------------------------------------

describe('BaseClient', () => {
  it('trims trailing slash from baseUrl', () => {
    const client = new BaseClient({
      baseUrl: 'https://data.nevent.es/',
      jwtToken: 'test-token',
    });
    // Access private property via type assertion for testing
    const baseUrl = (client as unknown as { baseUrl: string }).baseUrl;
    expect(baseUrl).toBe('https://data.nevent.es');
  });

  it('uses default timeout of 30000ms when not specified', () => {
    const client = new BaseClient({
      baseUrl: 'https://data.nevent.es',
      jwtToken: 'test-token',
    });
    const timeoutMs = (client as unknown as { timeoutMs: number }).timeoutMs;
    expect(timeoutMs).toBe(30_000);
  });

  it('respects custom timeout', () => {
    const client = new BaseClient({
      baseUrl: 'https://data.nevent.es',
      jwtToken: 'test-token',
      timeoutMs: 5000,
    });
    const timeoutMs = (client as unknown as { timeoutMs: number }).timeoutMs;
    expect(timeoutMs).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// Error type coverage — all NeventErrorType values
// ---------------------------------------------------------------------------

describe('NeventErrorType coverage', () => {
  const errorTypes = [
    'invalid_request',
    'authentication_error',
    'api_error',
    'rate_limit_error',
    'not_found',
  ] as const;

  for (const type of errorTypes) {
    it(`can create NeventApiError with type "${type}"`, () => {
      const apiError = new NeventApiError({
        type,
        message: `Test error for ${type}`,
        code: 'test_code',
      });
      expect(apiError.neventError.type).toBe(type);
    });
  }
});
