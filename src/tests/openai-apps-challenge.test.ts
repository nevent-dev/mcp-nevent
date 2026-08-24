/**
 * Tests for the OpenAI Apps domain verification token served at
 * GET /.well-known/openai-apps-challenge.
 *
 * The ChatGPT app submission portal probes that path and compares the response
 * body byte-for-byte against the token it issued. Anything other than the raw
 * token (JSON wrapper, HTML, trailing whitespace) fails verification.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { getOpenAiAppsChallengeToken } from '../transports/http.js';

/** Token issued by the ChatGPT app submission portal for mcp.nevent.ai. */
const ISSUED_TOKEN = 'oz2XJxKzyvVmIZD2o656SgznA5ByXQxgUlININ9Thmw';

afterEach(() => {
  delete process.env['OPENAI_APPS_CHALLENGE_TOKEN'];
});

describe('getOpenAiAppsChallengeToken', () => {
  it('returns the token issued for mcp.nevent.ai by default', () => {
    expect(getOpenAiAppsChallengeToken()).toBe(ISSUED_TOKEN);
  });

  it('has no surrounding whitespace — the body is compared verbatim', () => {
    const token = getOpenAiAppsChallengeToken();
    expect(token).toBe(token.trim());
    expect(token).not.toMatch(/\s/);
  });

  it('OPENAI_APPS_CHALLENGE_TOKEN overrides the built-in token', () => {
    process.env['OPENAI_APPS_CHALLENGE_TOKEN'] = 'rotated-token';
    expect(getOpenAiAppsChallengeToken()).toBe('rotated-token');
  });

  it('trims whitespace from the env override (avoids trailing newlines)', () => {
    process.env['OPENAI_APPS_CHALLENGE_TOKEN'] = '  rotated-token\n';
    expect(getOpenAiAppsChallengeToken()).toBe('rotated-token');
  });

  it('falls back to the built-in token when the env var is empty', () => {
    process.env['OPENAI_APPS_CHALLENGE_TOKEN'] = '   ';
    expect(getOpenAiAppsChallengeToken()).toBe(ISSUED_TOKEN);
  });
});
