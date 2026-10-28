/**
 * Tests for the commit SHA surfaced by GET /health.
 *
 * The SHA is injected at image build time (Docker ARG COMMIT_SHA ->
 * ENV GIT_COMMIT_SHA) and read at request time by `getCommitSha()`.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { getCommitSha } from '../transports/http.js';

describe('getCommitSha', () => {
  const original = process.env['GIT_COMMIT_SHA'];

  afterEach(() => {
    if (original === undefined) delete process.env['GIT_COMMIT_SHA'];
    else process.env['GIT_COMMIT_SHA'] = original;
  });

  it('returns GIT_COMMIT_SHA when set', () => {
    process.env['GIT_COMMIT_SHA'] = 'abc123def456';
    expect(getCommitSha()).toBe('abc123def456');
  });

  it('trims surrounding whitespace', () => {
    process.env['GIT_COMMIT_SHA'] = '  abc123  ';
    expect(getCommitSha()).toBe('abc123');
  });

  it('falls back to "unknown" when unset', () => {
    delete process.env['GIT_COMMIT_SHA'];
    expect(getCommitSha()).toBe('unknown');
  });

  it('falls back to "unknown" when blank', () => {
    process.env['GIT_COMMIT_SHA'] = '   ';
    expect(getCommitSha()).toBe('unknown');
  });
});
