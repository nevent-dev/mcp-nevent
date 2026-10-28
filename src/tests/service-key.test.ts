/**
 * Unit tests for the bearer-passthrough service key (`src/auth/service-key.ts`)
 * and for the fail-closed construction of the app without one.
 */

import { describe, it, expect } from 'vitest';
import {
  parseServiceKeys,
  isValidServiceKey,
  MIN_SERVICE_KEY_LENGTH,
  SERVICE_KEY_HEADER,
} from '../auth/service-key.js';
import { createBearerPassthroughApp } from '../transports/http-bearer-passthrough.js';

const KEY = 'a'.repeat(MIN_SERVICE_KEY_LENGTH);
const OLD = 'b'.repeat(MIN_SERVICE_KEY_LENGTH);

describe('parseServiceKeys', () => {
  it('requires a current key', () => {
    expect(() => parseServiceKeys([])).toThrow(/MCP_BEARER_PASSTHROUGH_SERVICE_KEY is required/);
    expect(() => parseServiceKeys([undefined])).toThrow(/required/);
    expect(() => parseServiceKeys(['   '])).toThrow(/required/);
  });

  it('rejects keys shorter than the minimum, without echoing them', () => {
    expect(() => parseServiceKeys(['short-secret'])).toThrow(/too short/);
    try {
      parseServiceKeys(['short-secret']);
    } catch (e) {
      expect(String(e)).not.toContain('short-secret');
    }
    expect(() => parseServiceKeys([KEY, 'tiny'])).toThrow(/SERVICE_KEY_PREVIOUS is too short/);
  });

  it('returns current first, then the optional previous key', () => {
    expect(parseServiceKeys([KEY])).toEqual([KEY]);
    expect(parseServiceKeys([` ${KEY} `, OLD])).toEqual([KEY, OLD]);
    expect(parseServiceKeys([KEY, ''])).toEqual([KEY]);
    expect(parseServiceKeys([KEY, undefined])).toEqual([KEY]);
  });

  it('fails instead of silently ignoring a third key', () => {
    expect(() => parseServiceKeys([KEY, OLD, 'c'.repeat(MIN_SERVICE_KEY_LENGTH)])).toThrow(/At most two/);
  });
});

describe('isValidServiceKey', () => {
  it('accepts the current and the previous key', () => {
    expect(isValidServiceKey(KEY, [KEY, OLD])).toBe(true);
    expect(isValidServiceKey(OLD, [KEY, OLD])).toBe(true);
  });

  it('rejects missing, empty, wrong, different-length and array values', () => {
    expect(isValidServiceKey(undefined, [KEY])).toBe(false);
    expect(isValidServiceKey('', [KEY])).toBe(false);
    expect(isValidServiceKey('c'.repeat(MIN_SERVICE_KEY_LENGTH), [KEY])).toBe(false);
    expect(isValidServiceKey(KEY + 'x', [KEY])).toBe(false);
    expect(isValidServiceKey(KEY.slice(1), [KEY])).toBe(false);
    expect(isValidServiceKey([KEY, KEY], [KEY])).toBe(false);
  });

  it('uses the lower-case header name Node exposes', () => {
    expect(SERVICE_KEY_HEADER).toBe('x-nevent-service-key');
  });
});

describe('createBearerPassthroughApp without a valid service key', () => {
  const base = { port: 0, neventApiUrl: 'https://api.nevent.es', dataApiUrl: 'https://data.nevent.es' };

  it('throws (startup must fail) when no key is configured', async () => {
    await expect(createBearerPassthroughApp({ ...base, serviceKeys: [] })).rejects.toThrow(/required/);
  });

  it('throws when more than two keys are configured', async () => {
    const k = 'k'.repeat(MIN_SERVICE_KEY_LENGTH);
    await expect(createBearerPassthroughApp({ ...base, serviceKeys: [k, k, k] })).rejects.toThrow(/At most two/);
  });

  it('throws when the key is too short', async () => {
    await expect(createBearerPassthroughApp({ ...base, serviceKeys: ['short'] })).rejects.toThrow(/too short/);
  });
});
