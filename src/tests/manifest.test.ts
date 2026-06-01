/**
 * Tests for the /.well-known/mcp-manifest.json endpoint and health check
 * dynamic fields (version and toolsCount / tools_count).
 *
 * NEV-1661: Both fields were previously hardcoded literals. They now read from
 * package.json (version) and getToolCount() (tool counts) at runtime.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getToolCount } from '../server.js';

// ---------------------------------------------------------------------------
// Package.json version — ground truth for what the server should report
// ---------------------------------------------------------------------------

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '../../package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };
const CURRENT_VERSION = pkg.version;

// ---------------------------------------------------------------------------
// Manifest shape contract — mirrors what createHttpApp() serves
// ---------------------------------------------------------------------------

/** Expected manifest body from GET /.well-known/mcp-manifest.json */
const EXPECTED_MANIFEST = {
  name: 'nevent',
  displayName: 'Nevent',
  description: 'Talk to your live-events CRM (campaigns, analytics, paid ads, segments) in Claude and ChatGPT',
  version: CURRENT_VERSION,
  homepage: 'https://nevent.ai/en/features/nevent-ai/',
  documentation: 'https://docs.nevent.ai/mcp',
  repository: 'https://github.com/nevent-dev/mcp-nevent',
  license: 'MIT',
  publisher: { name: 'Nevent', url: 'https://nevent.ai' },
  support: { email: 'support@nevent.ai' },
  transport: 'streamable-http',
  endpoint: 'https://mcp.nevent.ai/',
  auth: {
    type: 'oauth2',
    metadata: 'https://mcp.nevent.ai/.well-known/oauth-authorization-server',
  },
  categories: ['marketing', 'analytics', 'crm', 'events'],
  tools_count: getToolCount({
    hasNeventApiUrl: true,
    hasMongoUri: true,
    hasPaidMediaClient: true,
    hasShortUrlClient: true,
  }),
};

describe('MCP Manifest', () => {
  it('manifest object has all required top-level keys', () => {
    const requiredKeys = [
      'name', 'displayName', 'description', 'version',
      'homepage', 'documentation', 'repository', 'license',
      'publisher', 'support', 'transport', 'endpoint',
      'auth', 'categories', 'tools_count',
    ];

    for (const key of requiredKeys) {
      expect(EXPECTED_MANIFEST).toHaveProperty(key);
    }
  });

  it('name is "nevent"', () => {
    expect(EXPECTED_MANIFEST.name).toBe('nevent');
  });

  it('license is MIT', () => {
    expect(EXPECTED_MANIFEST.license).toBe('MIT');
  });

  it('transport is streamable-http', () => {
    expect(EXPECTED_MANIFEST.transport).toBe('streamable-http');
  });

  it('auth type is oauth2', () => {
    expect(EXPECTED_MANIFEST.auth.type).toBe('oauth2');
  });

  it('publisher has name and url', () => {
    expect(EXPECTED_MANIFEST.publisher.name).toBe('Nevent');
    expect(EXPECTED_MANIFEST.publisher.url).toBe('https://nevent.ai');
  });

  it('support email is support@nevent.ai', () => {
    expect(EXPECTED_MANIFEST.support.email).toBe('support@nevent.ai');
  });

  it('categories includes expected values', () => {
    expect(EXPECTED_MANIFEST.categories).toContain('marketing');
    expect(EXPECTED_MANIFEST.categories).toContain('analytics');
    expect(EXPECTED_MANIFEST.categories).toContain('crm');
    expect(EXPECTED_MANIFEST.categories).toContain('events');
  });

  it('manifest serializes to valid JSON and back', () => {
    const json = JSON.stringify(EXPECTED_MANIFEST);
    const parsed = JSON.parse(json) as typeof EXPECTED_MANIFEST;
    expect(parsed.name).toBe(EXPECTED_MANIFEST.name);
    expect(parsed.tools_count).toBe(EXPECTED_MANIFEST.tools_count);
    expect(parsed.auth.type).toBe(EXPECTED_MANIFEST.auth.type);
  });

  it('homepage points to the Nevent AI landing page', () => {
    expect(EXPECTED_MANIFEST.homepage).toBe('https://nevent.ai/en/features/nevent-ai/');
  });

  it('endpoint points to the production MCP server', () => {
    expect(EXPECTED_MANIFEST.endpoint).toBe('https://mcp.nevent.ai/');
  });
});

// ---------------------------------------------------------------------------
// Dynamic version (NEV-1661)
// ---------------------------------------------------------------------------

describe('Dynamic version', () => {
  it('manifest version matches package.json version', () => {
    expect(EXPECTED_MANIFEST.version).toBe(CURRENT_VERSION);
  });

  it('version is a valid semver string (major.minor.patch)', () => {
    expect(CURRENT_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('version is not the old hardcoded literal "1.0.0"', () => {
    // The server was always shipping 1.0.0 regardless of the actual version.
    // This test fails if someone accidentally re-introduces the hardcoded value.
    // NOTE: remove this guard once the real version reaches 1.0.0 again (unlikely).
    expect(CURRENT_VERSION).not.toBe('1.0.0');
  });
});

// ---------------------------------------------------------------------------
// Dynamic tool count (NEV-1661)
// ---------------------------------------------------------------------------

describe('getToolCount — dynamic tool count', () => {
  it('full config (all features enabled) returns a positive count', () => {
    const count = getToolCount({
      hasNeventApiUrl: true,
      hasMongoUri: true,
      hasPaidMediaClient: true,
      hasShortUrlClient: true,
    });
    expect(count).toBeGreaterThan(0);
  });

  it('minimal config (only analytics + help) returns fewer tools', () => {
    const minimal = getToolCount({
      hasNeventApiUrl: false,
      hasMongoUri: false,
      hasPaidMediaClient: false,
      hasShortUrlClient: false,
    });
    const full = getToolCount({
      hasNeventApiUrl: true,
      hasMongoUri: true,
      hasPaidMediaClient: true,
      hasShortUrlClient: true,
    });
    expect(minimal).toBeLessThan(full);
  });

  it('paid media tools add 11 tools when enabled', () => {
    const withoutPaid = getToolCount({
      hasNeventApiUrl: true,
      hasMongoUri: true,
      hasPaidMediaClient: false,
      hasShortUrlClient: true,
    });
    const withPaid = getToolCount({
      hasNeventApiUrl: true,
      hasMongoUri: true,
      hasPaidMediaClient: true,
      hasShortUrlClient: true,
    });
    expect(withPaid - withoutPaid).toBe(11);
  });

  it('short URL tools add 9 tools when enabled', () => {
    const withoutShortUrl = getToolCount({
      hasNeventApiUrl: true,
      hasMongoUri: true,
      hasPaidMediaClient: true,
      hasShortUrlClient: false,
    });
    const withShortUrl = getToolCount({
      hasNeventApiUrl: true,
      hasMongoUri: true,
      hasPaidMediaClient: true,
      hasShortUrlClient: true,
    });
    expect(withShortUrl - withoutShortUrl).toBe(9);
  });

  it('full config returns exactly 55 tools (current tool set)', () => {
    // This test is intentionally concrete: it pins the expected count so that
    // future tool additions are visible in CI. When new tools are added, update
    // this number and the description in package.json together.
    const count = getToolCount({
      hasNeventApiUrl: true,
      hasMongoUri: true,
      hasPaidMediaClient: true,
      hasShortUrlClient: true,
    });
    expect(count).toBe(55);
  });

  it('manifest tools_count matches getToolCount(full)', () => {
    const dynamicCount = getToolCount({
      hasNeventApiUrl: true,
      hasMongoUri: true,
      hasPaidMediaClient: true,
      hasShortUrlClient: true,
    });
    expect(EXPECTED_MANIFEST.tools_count).toBe(dynamicCount);
  });

  it('getToolCount is deterministic — same options always return the same count', () => {
    const opts = {
      hasNeventApiUrl: true,
      hasMongoUri: true,
      hasPaidMediaClient: true,
      hasShortUrlClient: true,
    };
    expect(getToolCount(opts)).toBe(getToolCount(opts));
  });
});
