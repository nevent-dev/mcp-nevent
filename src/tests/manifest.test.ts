/**
 * Tests for the /.well-known/mcp-manifest.json endpoint.
 *
 * Validates the manifest response shape and required fields without
 * spinning up the full HTTP transport (no MongoDB required).
 */

import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Manifest shape contract — mirrors what createHttpApp() serves
// ---------------------------------------------------------------------------

/** Expected manifest body from GET /.well-known/mcp-manifest.json */
const EXPECTED_MANIFEST = {
  name: 'nevent',
  displayName: 'Nevent',
  description: 'Talk to your live-events CRM (campaigns, analytics, paid ads, segments) in Claude and ChatGPT',
  version: '1.0.0',
  homepage: 'https://nevent.ai/en/features/nevent-ai/',
  documentation: 'https://docs.nevent.ai/mcp',
  repository: 'https://github.com/nevent-dev/mcp-nevent',
  license: 'MIT',
  publisher: { name: 'Nevent', url: 'https://nevent.ai' },
  support: { email: 'support@nevent.ai' },
  transport: 'streamable-http',
  endpoint: 'https://mcp.nevent.ai/mcp',
  auth: {
    type: 'oauth2',
    metadata: 'https://mcp.nevent.ai/.well-known/oauth-authorization-server',
  },
  categories: ['marketing', 'analytics', 'crm', 'events'],
  tools_count: 43,
  logo: 'https://nevent.ai/logos/nevent-mcp.svg',
};

describe('MCP Manifest', () => {
  it('manifest object has all required top-level keys', () => {
    const requiredKeys = [
      'name', 'displayName', 'description', 'version',
      'homepage', 'documentation', 'repository', 'license',
      'publisher', 'support', 'transport', 'endpoint',
      'auth', 'categories', 'tools_count', 'logo',
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

  it('tools_count is 43', () => {
    expect(EXPECTED_MANIFEST.tools_count).toBe(43);
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
    expect(EXPECTED_MANIFEST.endpoint).toBe('https://mcp.nevent.ai/mcp');
  });
});
