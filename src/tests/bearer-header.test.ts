/**
 * `extractBearerToken` (`src/auth/bearer.ts`): regex-free Authorization
 * parsing for bearer-passthrough (CodeQL js/polynomial-redos).
 */

import { describe, it, expect } from 'vitest';
import { extractBearerToken, MAX_AUTHORIZATION_HEADER_LENGTH } from '../auth/bearer.js';

describe('extractBearerToken', () => {
  it('extracts the token for any letter case of the scheme', () => {
    expect(extractBearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(extractBearerToken('bearer abc')).toBe('abc');
    expect(extractBearerToken('BEARER abc')).toBe('abc');
    expect(extractBearerToken('BeArEr abc')).toBe('abc');
  });

  it('trims surrounding whitespace around the token', () => {
    expect(extractBearerToken('Bearer    abc  ')).toBe('abc');
    expect(extractBearerToken('Bearer \tabc\t')).toBe('abc');
  });

  it('rejects other schemes, missing or empty tokens and non-strings', () => {
    expect(extractBearerToken(undefined)).toBeUndefined();
    expect(extractBearerToken(['Bearer abc'])).toBeUndefined();
    expect(extractBearerToken('')).toBeUndefined();
    expect(extractBearerToken('Bearer')).toBeUndefined();
    expect(extractBearerToken('Bearer ')).toBeUndefined();
    expect(extractBearerToken('Bearer      ')).toBeUndefined();
    expect(extractBearerToken('Basic abc')).toBeUndefined();
    expect(extractBearerToken('Bearerabc')).toBeUndefined();
    expect(extractBearerToken('abc')).toBeUndefined();
  });

  it('rejects a token with internal whitespace', () => {
    expect(extractBearerToken('Bearer abc def')).toBeUndefined();
    expect(extractBearerToken('Bearer abc\tdef')).toBeUndefined();
    expect(extractBearerToken('Bearer abc\ndef')).toBeUndefined();
  });

  it('rejects an over-long header without scanning it', () => {
    expect(extractBearerToken('Bearer ' + 'a'.repeat(MAX_AUTHORIZATION_HEADER_LENGTH))).toBeUndefined();
  });

  it('handles pathological space-filled headers in linear time (no backtracking)', () => {
    const attacks = [
      'bearer ' + ' '.repeat(MAX_AUTHORIZATION_HEADER_LENGTH - 7),
      'bearer ' + ' '.repeat(MAX_AUTHORIZATION_HEADER_LENGTH - 20) + 'x y',
      'bearer ' + 'a '.repeat((MAX_AUTHORIZATION_HEADER_LENGTH - 7) / 2),
    ];
    const start = performance.now();
    for (let i = 0; i < 200; i++) {
      for (const a of attacks) extractBearerToken(a);
    }
    expect(performance.now() - start).toBeLessThan(500);
    for (const a of attacks) expect(extractBearerToken(a)).toBeUndefined();
  });
});
