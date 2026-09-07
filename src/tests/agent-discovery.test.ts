/**
 * Tests for the public agent-discovery documents served by the HTTP transport.
 *
 * Mirrors the repo's testing style: the builders in `agent-discovery.ts` are
 * pure functions, so the contract each spec imposes (RFC 9309 robots.txt,
 * RFC 9264 linkset, SEP-1649 server card, ARD catalog, auth.md, RFC 8288 Link
 * header) is asserted directly on their output without booting Express.
 */

import { describe, it, expect } from 'vitest';
import {
  DOCS_URL,
  SUPPORT_EMAIL,
  absoluteUrl,
  buildAgentAuthMetadata,
  buildApiCatalog,
  buildArdCatalog,
  buildAuthMarkdown,
  buildLandingHtml,
  buildLandingMarkdown,
  buildLinkHeader,
  buildMcpServerCard,
  buildRobotsTxt,
  buildSitemapXml,
} from '../transports/agent-discovery.js';

/** Public base URL as configured in production. */
const BASE_URL = new URL('https://mcp.nevent.ai/');

/** Same host configured without a trailing slash — a valid `MCP_SERVER_URL`. */
const BASE_URL_NO_SLASH = new URL('https://mcp.nevent.ai');

const OPTIONS = { version: '1.8.0', toolsCount: 59 };

// ---------------------------------------------------------------------------
// URL building
// ---------------------------------------------------------------------------

describe('absoluteUrl', () => {
  it('builds absolute URLs from the configured base', () => {
    expect(absoluteUrl(BASE_URL, '/robots.txt')).toBe('https://mcp.nevent.ai/robots.txt');
  });

  it('produces the same URL whether or not the base has a trailing slash', () => {
    expect(absoluteUrl(BASE_URL_NO_SLASH, '/auth.md')).toBe(absoluteUrl(BASE_URL, '/auth.md'));
  });

  it('keeps nested well-known paths intact', () => {
    expect(absoluteUrl(BASE_URL, '/.well-known/mcp/server-card.json')).toBe(
      'https://mcp.nevent.ai/.well-known/mcp/server-card.json'
    );
  });
});

// ---------------------------------------------------------------------------
// Link header (RFC 8288)
// ---------------------------------------------------------------------------

describe('buildLinkHeader', () => {
  const header = buildLinkHeader(BASE_URL);

  it('advertises the API catalog with the RFC 9727 relation', () => {
    expect(header).toContain('<https://mcp.nevent.ai/.well-known/api-catalog>; rel="api-catalog"');
  });

  it('points at the service description, documentation and status endpoints', () => {
    expect(header).toContain('rel="service-desc"');
    expect(header).toContain(`<${DOCS_URL}>; rel="service-doc"`);
    expect(header).toContain('<https://mcp.nevent.ai/health>; rel="status"');
  });

  it('uses absolute targets in angle brackets, comma separated', () => {
    for (const value of header.split(', ')) {
      expect(value).toMatch(/^<https:\/\/[^>]+>; rel="[a-z-]+"/);
    }
  });
});

// ---------------------------------------------------------------------------
// robots.txt (RFC 9309) + Content Signals
// ---------------------------------------------------------------------------

describe('buildRobotsTxt', () => {
  const robots = buildRobotsTxt(BASE_URL);

  it('opens with a wildcard group so every crawler matches a rule', () => {
    expect(robots).toContain('User-agent: *');
  });

  it('declares content signals: search and ai-input allowed, ai-training declined', () => {
    expect(robots).toContain('Content-Signal: search=yes, ai-input=yes, ai-train=no');
  });

  it('disallows training crawlers', () => {
    for (const agent of ['GPTBot', 'ClaudeBot', 'Google-Extended', 'CCBot']) {
      const group = robots.slice(robots.indexOf(`User-agent: ${agent}`));
      expect(group.split('\n\n')[0]).toContain('Disallow: /');
    }
  });

  it('allows search and user-initiated agents', () => {
    for (const agent of ['OAI-SearchBot', 'ChatGPT-User', 'Claude-User', 'PerplexityBot', 'Googlebot']) {
      const group = robots.slice(robots.indexOf(`User-agent: ${agent}`));
      expect(group.split('\n\n')[0]).toContain('Allow: /$');
    }
  });

  it('keeps the OAuth endpoints out of the crawl', () => {
    expect(robots).toContain('Disallow: /authorize');
    expect(robots).toContain('Disallow: /token');
    expect(robots).toContain('Disallow: /register');
  });

  it('references the sitemap with an absolute URL', () => {
    expect(robots).toContain('Sitemap: https://mcp.nevent.ai/sitemap.xml');
  });

  it('every directive line is a `field: value` pair or a comment', () => {
    for (const line of robots.split('\n')) {
      if (line === '' || line.startsWith('#')) continue;
      expect(line).toMatch(/^[A-Za-z-]+: \S/);
    }
  });
});

// ---------------------------------------------------------------------------
// sitemap.xml
// ---------------------------------------------------------------------------

describe('buildSitemapXml', () => {
  const sitemap = buildSitemapXml(BASE_URL, '2026-09-07');

  it('is a sitemaps.org 0.9 urlset', () => {
    expect(sitemap.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(sitemap).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(sitemap.trimEnd().endsWith('</urlset>')).toBe(true);
  });

  it('lists the canonical public URLs, absolute and on the configured host', () => {
    expect(sitemap).toContain('<loc>https://mcp.nevent.ai/</loc>');
    expect(sitemap).toContain('<loc>https://mcp.nevent.ai/auth.md</loc>');
    expect(sitemap).toContain('<loc>https://mcp.nevent.ai/.well-known/api-catalog</loc>');
  });

  it('lists no authenticated or OAuth route', () => {
    for (const path of ['/authorize', '/token', '/register', '/mcp']) {
      expect(sitemap).not.toContain(`${path}<`);
    }
  });

  it('stamps lastmod as a plain date', () => {
    expect(sitemap).toContain('<lastmod>2026-09-07</lastmod>');
  });
});

// ---------------------------------------------------------------------------
// API catalog (RFC 9727 / RFC 9264)
// ---------------------------------------------------------------------------

describe('buildApiCatalog', () => {
  const catalog = buildApiCatalog(BASE_URL) as {
    linkset: Array<Record<string, unknown>>;
  };

  it('is a linkset with one anchor per API', () => {
    expect(Array.isArray(catalog.linkset)).toBe(true);
    expect(catalog.linkset).toHaveLength(1);
    expect(catalog.linkset[0]?.['anchor']).toBe('https://mcp.nevent.ai/');
  });

  it('carries service-desc, service-doc and status relations', () => {
    const entry = catalog.linkset[0] as Record<string, Array<{ href: string; type?: string }>>;
    expect(entry['service-desc']?.[0]?.href).toBe('https://mcp.nevent.ai/.well-known/mcp-manifest.json');
    expect(entry['service-doc']?.[0]?.href).toBe(DOCS_URL);
    expect(entry['status']?.[0]?.href).toBe('https://mcp.nevent.ai/health');
  });

  it('gives every link target an href', () => {
    const entry = catalog.linkset[0] as Record<string, unknown>;
    for (const [rel, targets] of Object.entries(entry)) {
      if (rel === 'anchor') continue;
      for (const target of targets as Array<{ href?: string }>) {
        expect(target.href).toBeTruthy();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// MCP server card (SEP-1649)
// ---------------------------------------------------------------------------

describe('buildMcpServerCard', () => {
  const card = buildMcpServerCard(BASE_URL, OPTIONS) as {
    serverInfo: Record<string, unknown>;
    transport: Record<string, unknown>;
    capabilities: Record<string, unknown>;
    authentication: Record<string, unknown>;
  };

  it('identifies the server by name and version', () => {
    expect(card.serverInfo['name']).toBe('io.github.nevent-dev/mcp-nevent');
    expect(card.serverInfo['version']).toBe('1.8.0');
  });

  it('declares the streamable-http transport endpoint', () => {
    expect(card.transport['type']).toBe('streamable-http');
    expect(card.transport['url']).toBe('https://mcp.nevent.ai/');
  });

  it('declares tool capabilities', () => {
    expect(card.capabilities['tools']).toEqual({ listChanged: true });
  });

  it('points at both OAuth metadata documents and the auth guide', () => {
    expect(card.authentication['type']).toBe('oauth2');
    expect(card.authentication['authorizationServerMetadata']).toBe(
      'https://mcp.nevent.ai/.well-known/oauth-authorization-server'
    );
    expect(card.authentication['protectedResourceMetadata']).toBe(
      'https://mcp.nevent.ai/.well-known/oauth-protected-resource'
    );
    expect(card.authentication['instructions']).toBe('https://mcp.nevent.ai/auth.md');
  });

  it('reports the live tool count rather than a hardcoded literal', () => {
    expect(buildMcpServerCard(BASE_URL, { version: '9.9.9', toolsCount: 3 })['toolsCount']).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// ARD catalog
// ---------------------------------------------------------------------------

describe('buildArdCatalog', () => {
  const ard = buildArdCatalog(BASE_URL, OPTIONS) as {
    specVersion: string;
    host: Record<string, unknown>;
    entries: Array<Record<string, unknown>>;
  };

  it('declares a spec version and a host block', () => {
    expect(ard.specVersion).toBeTruthy();
    expect(ard.host['domain']).toBe('mcp.nevent.ai');
  });

  it('gives every entry a urn:air identifier scoped to the host', () => {
    for (const entry of ard.entries) {
      expect(entry['id']).toMatch(/^urn:air:mcp\.nevent\.ai:[a-z-]+:[a-z-]+$/);
    }
  });

  it('gives every entry a display name, an IANA media type and exactly one of url/data', () => {
    for (const entry of ard.entries) {
      expect(entry['displayName']).toBeTruthy();
      expect(entry['type']).toMatch(/^[a-z]+\/[a-z0-9.+-]+$/);
      expect('url' in entry).toBe(true);
      expect('data' in entry).toBe(false);
    }
  });

  it('gives every entry 2-5 representative queries for semantic indexing', () => {
    for (const entry of ard.entries) {
      const queries = entry['representativeQueries'] as string[];
      expect(queries.length).toBeGreaterThanOrEqual(2);
      expect(queries.length).toBeLessThanOrEqual(5);
    }
  });
});

// ---------------------------------------------------------------------------
// auth.md and agent_auth metadata
// ---------------------------------------------------------------------------

describe('buildAuthMarkdown', () => {
  const authMd = buildAuthMarkdown(BASE_URL);

  it('documents the registration, authorization and token endpoints', () => {
    expect(authMd).toContain('https://mcp.nevent.ai/register');
    expect(authMd).toContain('https://mcp.nevent.ai/authorize');
    expect(authMd).toContain('https://mcp.nevent.ai/token');
  });

  it('states the identity and credential types and the PKCE requirement', () => {
    expect(authMd).toContain('OAuth 2.1 access token');
    expect(authMd).toContain('PKCE');
    expect(authMd).toContain('Dynamic Client Registration');
  });

  it('gives a revocation path and a support contact', () => {
    expect(authMd).toContain('## Revocation');
    expect(authMd).toContain(SUPPORT_EMAIL);
  });
});

describe('buildAgentAuthMetadata', () => {
  const agentAuth = buildAgentAuthMetadata(BASE_URL);

  it('exposes the registration URI and the instructions document', () => {
    expect(agentAuth['register_uri']).toBe('https://mcp.nevent.ai/register');
    expect(agentAuth['instructions_uri']).toBe('https://mcp.nevent.ai/auth.md');
  });

  it('declares identity types, credential types and a revocation contact', () => {
    expect(agentAuth['identity_types']).toEqual(['human']);
    expect(agentAuth['credential_types']).toEqual(['oauth2_access_token']);
    expect(agentAuth['revocation_contact']).toBe(`mailto:${SUPPORT_EMAIL}`);
  });
});

// ---------------------------------------------------------------------------
// Landing page
// ---------------------------------------------------------------------------

describe('buildLandingHtml', () => {
  const html = buildLandingHtml(BASE_URL, OPTIONS);

  it('is a complete HTML document with a title, description and canonical', () => {
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<title>Nevent MCP server</title>');
    expect(html).toContain('<meta name="description"');
    expect(html).toContain('<link rel="canonical" href="https://mcp.nevent.ai/">');
  });

  it('renders the live version and tool count', () => {
    expect(html).toContain('59 tools, version 1.8.0');
  });

  it('links the discovery documents so a crawler can follow them', () => {
    expect(html).toContain('https://mcp.nevent.ai/.well-known/mcp/server-card.json');
    expect(html).toContain('https://mcp.nevent.ai/auth.md');
  });

  it('uses no external assets or scripts (strict CSP from helmet)', () => {
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<link rel="stylesheet"');
  });
});

describe('buildLandingMarkdown', () => {
  const markdown = buildLandingMarkdown(BASE_URL, OPTIONS);

  it('carries the same substance as the HTML page without markup', () => {
    expect(markdown.startsWith('# Nevent MCP server')).toBe(true);
    expect(markdown).toContain('59 tools, version 1.8.0');
    expect(markdown).toContain('https://mcp.nevent.ai/auth.md');
    expect(markdown).not.toContain('<div');
  });
});
