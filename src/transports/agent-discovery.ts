/**
 * Agent discovery documents for the Nevent MCP server.
 *
 * `mcp.nevent.ai` is an API host: every meaningful route is JSON-RPC behind
 * OAuth, so crawlers and agent-readiness scanners used to see nothing but a
 * `401`. This module builds the small set of public, machine-readable
 * documents that let an agent (or a crawler) find out what lives here without
 * authenticating:
 *
 * | Path                                  | Media type                  | Spec        |
 * |---------------------------------------|-----------------------------|-------------|
 * | `/robots.txt`                         | `text/plain`                | RFC 9309    |
 * | `/sitemap.xml`                        | `application/xml`           | sitemaps.org|
 * | `/auth.md`                            | `text/markdown`             | auth.md     |
 * | `/.well-known/api-catalog`            | `application/linkset+json`  | RFC 9727    |
 * | `/.well-known/mcp/server-card.json`   | `application/json`          | SEP-1649    |
 * | `/.well-known/ai-catalog.json`        | `application/json`          | ARD         |
 * | `/` (Accept: text/html or markdown)   | `text/html` / `text/markdown` | —         |
 *
 * Everything here is a **pure builder**: each function takes the public base
 * URL (and, where relevant, the version and tool count) and returns a string
 * or a plain object. Route registration lives in `transports/http.ts`, which
 * keeps this module unit-testable without booting Express.
 *
 * None of these documents expose tenant data — they describe the server, not
 * its contents.
 *
 * @module transports/agent-discovery
 */

/** Human-facing documentation for the Nevent MCP server. */
export const DOCS_URL = 'https://help.nevent.ai/en/nevent-ai/';

/** Marketing page for the product this server belongs to. */
export const HOMEPAGE_URL = 'https://nevent.ai/en/features/nevent-ai/';

/** Public source repository. */
export const REPO_URL = 'https://github.com/nevent-dev/mcp-nevent';

/** Support inbox published in every discovery document. */
export const SUPPORT_EMAIL = 'support@nevent.ai';

/**
 * Joins a path onto the public base URL.
 *
 * `config.mcpServerUrl` is normally `https://mcp.nevent.ai/`, but callers may
 * configure it with or without a trailing slash, so normalise both sides
 * instead of string-concatenating.
 */
export function absoluteUrl(baseUrl: URL, path: string): string {
  return new URL(path.replace(/^\//, ''), baseUrl.href.endsWith('/') ? baseUrl : new URL(`${baseUrl.href}/`)).href;
}

// ---------------------------------------------------------------------------
// Link header (RFC 8288)
// ---------------------------------------------------------------------------

/**
 * Builds the `Link` response header advertising the discovery documents.
 *
 * Sent on **every** response — including the `401` that unauthenticated MCP
 * calls receive — so an agent that bounces off auth still learns where the
 * catalog, the docs and the auth instructions are. Relation types are the
 * IANA-registered ones (`api-catalog` from RFC 9727, `service-desc`,
 * `service-doc`, `status`, `describedby`, `terms-of-service`, `license`).
 */
export function buildLinkHeader(baseUrl: URL): string {
  const link = (path: string, rel: string, type?: string): string => {
    const target = path.startsWith('http') ? path : absoluteUrl(baseUrl, path);
    return `<${target}>; rel="${rel}"${type ? `; type="${type}"` : ''}`;
  };

  return [
    link('/.well-known/api-catalog', 'api-catalog', 'application/linkset+json'),
    link('/.well-known/mcp-manifest.json', 'service-desc', 'application/json'),
    link('/.well-known/mcp/server-card.json', 'describedby', 'application/json'),
    link('/auth.md', 'describedby', 'text/markdown'),
    link(DOCS_URL, 'service-doc', 'text/html'),
    link('/health', 'status', 'application/json'),
    link(REPO_URL, 'license', 'text/html'),
  ].join(', ');
}

// ---------------------------------------------------------------------------
// robots.txt (RFC 9309) + Content Signals
// ---------------------------------------------------------------------------

/**
 * AI crawlers that collect corpora for model **training**. Disallowed, in line
 * with the `ai-train=no` content signal below.
 */
const AI_TRAINING_CRAWLERS = [
  'GPTBot',
  'ClaudeBot',
  'Google-Extended',
  'Applebot-Extended',
  'CCBot',
  'Meta-ExternalAgent',
  'Bytespider',
  'Amazonbot',
  'Diffbot',
  'omgili',
];

/**
 * Search and user-initiated AI agents. Allowed: they surface this server to
 * people looking for it, which is exactly what the host is for.
 */
const AI_SEARCH_AND_USER_AGENTS = [
  'OAI-SearchBot',
  'ChatGPT-User',
  'Claude-User',
  'Claude-SearchBot',
  'PerplexityBot',
  'Perplexity-User',
  'Googlebot',
  'Bingbot',
];

/**
 * Renders `/robots.txt`.
 *
 * Three things happen here:
 *
 * 1. **Crawl rules.** The public discovery documents are allowed; the OAuth
 *    endpoints (`/authorize`, `/token`, `/register`) are disallowed — they are
 *    stateful, rate-limited and useless to a crawler.
 * 2. **Content Signals** (contentsignals.org) declare intent per group:
 *    `search=yes, ai-input=yes, ai-train=no`. Nevent wants agents to *find and
 *    use* this server, not to train on it.
 * 3. **A `Sitemap:` line** pointing at the public URL list.
 */
export function buildRobotsTxt(baseUrl: URL): string {
  const lines: string[] = [
    '# robots.txt for the Nevent MCP server (RFC 9309)',
    `# Docs: ${DOCS_URL}`,
    `# Contact: ${SUPPORT_EMAIL}`,
    '#',
    '# Content Signals (https://contentsignals.org/):',
    '#   search    = yes — index this host so people can find the connector',
    '#   ai-input  = yes — agents may read these pages to answer a user',
    '#   ai-train  = no  — do not use this content to train generative models',
    '',
    'User-agent: *',
    'Content-Signal: search=yes, ai-input=yes, ai-train=no',
    'Allow: /$',
    'Allow: /auth.md',
    'Allow: /health',
    'Allow: /robots.txt',
    'Allow: /sitemap.xml',
    'Allow: /.well-known/',
    'Disallow: /authorize',
    'Disallow: /token',
    'Disallow: /register',
    '',
    '# Model-training crawlers — declined (see ai-train=no above).',
  ];

  for (const agent of AI_TRAINING_CRAWLERS) {
    lines.push('', `User-agent: ${agent}`, 'Content-Signal: search=yes, ai-input=yes, ai-train=no', 'Disallow: /');
  }

  lines.push('', '# Search and user-initiated agents — welcome.');

  for (const agent of AI_SEARCH_AND_USER_AGENTS) {
    lines.push(
      '',
      `User-agent: ${agent}`,
      'Content-Signal: search=yes, ai-input=yes, ai-train=no',
      'Allow: /$',
      'Allow: /auth.md',
      'Allow: /.well-known/',
      'Disallow: /authorize',
      'Disallow: /token',
      'Disallow: /register'
    );
  }

  lines.push('', `Sitemap: ${absoluteUrl(baseUrl, '/sitemap.xml')}`, '');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// sitemap.xml
// ---------------------------------------------------------------------------

/** Public, crawlable URLs on this host. Everything else is JSON-RPC or OAuth. */
const SITEMAP_PATHS = [
  '/',
  '/auth.md',
  '/.well-known/mcp-manifest.json',
  '/.well-known/mcp/server-card.json',
  '/.well-known/api-catalog',
  '/.well-known/ai-catalog.json',
];

/**
 * Renders `/sitemap.xml` (sitemaps.org 0.9).
 *
 * Short by design: an API host has a handful of canonical public documents,
 * and listing them is what makes the `Sitemap:` line in robots.txt useful.
 * `lastmod` is the deploy date — the documents change when the server does.
 */
export function buildSitemapXml(baseUrl: URL, lastmod: string): string {
  const entries = SITEMAP_PATHS.map(
    (path) =>
      `  <url>\n    <loc>${absoluteUrl(baseUrl, path)}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>`
  ).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
}

// ---------------------------------------------------------------------------
// API catalog (RFC 9727 / RFC 9264 linkset)
// ---------------------------------------------------------------------------

/**
 * Builds `/.well-known/api-catalog` as an RFC 9264 linkset.
 *
 * One anchor — the MCP endpoint itself — carrying `service-desc` (the MCP
 * manifest and server card), `service-doc` (the help center), `status` (the
 * health endpoint) and `author` (support contact).
 */
export function buildApiCatalog(baseUrl: URL): Record<string, unknown> {
  const self = absoluteUrl(baseUrl, '/');

  return {
    linkset: [
      {
        anchor: self,
        'service-desc': [
          {
            href: absoluteUrl(baseUrl, '/.well-known/mcp-manifest.json'),
            type: 'application/json',
            title: 'Nevent MCP manifest',
          },
          {
            href: absoluteUrl(baseUrl, '/.well-known/mcp/server-card.json'),
            type: 'application/json',
            title: 'Nevent MCP server card (SEP-1649)',
          },
        ],
        'service-doc': [
          { href: DOCS_URL, type: 'text/html', title: 'Nevent MCP documentation' },
          { href: REPO_URL, type: 'text/html', title: 'Source repository' },
        ],
        status: [
          { href: absoluteUrl(baseUrl, '/health'), type: 'application/json', title: 'Health check' },
        ],
        describedby: [
          { href: absoluteUrl(baseUrl, '/auth.md'), type: 'text/markdown', title: 'Agent authentication guide' },
          {
            href: absoluteUrl(baseUrl, '/.well-known/oauth-protected-resource'),
            type: 'application/json',
            title: 'OAuth 2.1 protected resource metadata',
          },
        ],
        author: [{ href: `mailto:${SUPPORT_EMAIL}`, title: 'Nevent support' }],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// MCP server card (SEP-1649)
// ---------------------------------------------------------------------------

/**
 * Builds `/.well-known/mcp/server-card.json`.
 *
 * SEP-1649 is still in review (modelcontextprotocol/modelcontextprotocol#2127),
 * so this sticks to the fields the proposal has been stable on: `serverInfo`,
 * a transport endpoint and `capabilities`. Additional metadata is namespaced
 * under keys that mirror the MCP manifest so the two never disagree.
 */
export function buildMcpServerCard(
  baseUrl: URL,
  options: { version: string; toolsCount: number }
): Record<string, unknown> {
  return {
    serverInfo: {
      name: 'io.github.nevent-dev/mcp-nevent',
      title: 'Nevent',
      version: options.version,
      description:
        'Talk to your live-events CRM (campaigns, analytics, paid ads, segments, short URLs, media library) in Claude and ChatGPT',
      websiteUrl: HOMEPAGE_URL,
      documentationUrl: DOCS_URL,
      repositoryUrl: REPO_URL,
    },
    transport: {
      type: 'streamable-http',
      url: absoluteUrl(baseUrl, '/'),
    },
    capabilities: {
      tools: { listChanged: true },
    },
    authentication: {
      type: 'oauth2',
      authorizationServerMetadata: absoluteUrl(baseUrl, '/.well-known/oauth-authorization-server'),
      protectedResourceMetadata: absoluteUrl(baseUrl, '/.well-known/oauth-protected-resource'),
      scopesSupported: ['mcp:tools'],
      dynamicClientRegistration: true,
      instructions: absoluteUrl(baseUrl, '/auth.md'),
    },
    toolsCount: options.toolsCount,
    categories: ['marketing', 'analytics', 'crm', 'events'],
    publisher: { name: 'Nevent', url: 'https://nevent.ai' },
    support: { email: SUPPORT_EMAIL },
    license: 'MIT',
  };
}

// ---------------------------------------------------------------------------
// ARD — Agentic Resource Discovery (/.well-known/ai-catalog.json)
// ---------------------------------------------------------------------------

/**
 * Builds `/.well-known/ai-catalog.json` per agenticresourcediscovery.org.
 *
 * Each entry gets a `urn:air:` identifier, an IANA media type, exactly one of
 * `url`/`data`, and `representativeQueries` — short natural-language phrases
 * registries embed to decide when this server is relevant to a user's request.
 */
export function buildArdCatalog(
  baseUrl: URL,
  options: { version: string; toolsCount: number }
): Record<string, unknown> {
  const host = baseUrl.hostname;
  const urn = (namespace: string, name: string): string => `urn:air:${host}:${namespace}:${name}`;

  return {
    specVersion: '0.1',
    host: {
      name: 'Nevent',
      domain: host,
      description:
        'Marketing platform for live event promoters — campaigns, audience segmentation, paid media and attribution.',
      url: 'https://nevent.ai',
      contact: `mailto:${SUPPORT_EMAIL}`,
    },
    entries: [
      {
        id: urn('mcp', 'nevent'),
        displayName: 'Nevent MCP server',
        description: `Model Context Protocol server exposing ${options.toolsCount} tools over Streamable HTTP with OAuth 2.1: campaign analytics, audience segmentation, email/SMS/WhatsApp campaigns, templates, deliverability, paid media and short URLs.`,
        type: 'application/json',
        url: absoluteUrl(baseUrl, '/.well-known/mcp/server-card.json'),
        version: options.version,
        representativeQueries: [
          'How did my last email campaign perform?',
          'Build an audience segment of people who attended a festival last year',
          'What is the ROAS of my Meta Ads campaign for this event?',
          'Schedule an SMS campaign for ticket holders',
          'Which short URL drove the most ticket sales?',
        ],
      },
      {
        id: urn('docs', 'help-center'),
        displayName: 'Nevent MCP documentation',
        description:
          'Setup guides for connecting Nevent to Claude, ChatGPT, Claude Code and other MCP clients, plus a reference for every tool.',
        type: 'text/html',
        url: DOCS_URL,
        representativeQueries: [
          'How do I connect Nevent to Claude?',
          'How do I install the Nevent MCP server locally?',
          'Which Nevent MCP tools are available?',
        ],
      },
      {
        id: urn('auth', 'agent-registration'),
        displayName: 'Agent authentication instructions',
        description:
          'How an autonomous agent registers an OAuth 2.1 client (dynamic client registration) and obtains an access token for the Nevent MCP server.',
        type: 'text/markdown',
        url: absoluteUrl(baseUrl, '/auth.md'),
        representativeQueries: [
          'How does an agent authenticate with Nevent?',
          'Does Nevent support dynamic client registration?',
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// auth.md
// ---------------------------------------------------------------------------

/**
 * Renders `/auth.md` — the human- and agent-readable registration guide
 * (workos.com/auth-md).
 *
 * Deliberately concrete: an agent reading this should be able to complete
 * dynamic client registration and the authorization code + PKCE flow without
 * touching the help center.
 */
export function buildAuthMarkdown(baseUrl: URL): string {
  const url = (path: string): string => absoluteUrl(baseUrl, path);

  return `# Authentication — Nevent MCP server

The Nevent MCP server is an OAuth 2.1 protected resource. Every tool call
requires an access token issued to a Nevent admin account. Discovery calls
(\`initialize\`, \`tools/list\`, \`ping\`) are served without a token so clients can
inspect capabilities before asking a user to log in.

- **MCP endpoint:** \`${url('/')}\` (Streamable HTTP)
- **Authorization server metadata:** \`${url('/.well-known/oauth-authorization-server')}\`
- **Protected resource metadata:** \`${url('/.well-known/oauth-protected-resource')}\`
- **Scopes:** \`mcp:tools\`
- **Support:** ${SUPPORT_EMAIL}

## Identity and credential types

| Property | Value |
| --- | --- |
| Identity type | Human user (Nevent admin account) acting through an agent |
| Credential type | OAuth 2.1 access token (Bearer, JWT) |
| Grant type | \`authorization_code\` with PKCE (S256) |
| Client registration | Dynamic Client Registration (RFC 7591) |
| Token endpoint auth | \`none\` (public client) |

There is no machine-to-machine credential: a token always represents a real
Nevent user, and every tool call is scoped to the tenants that user can access.

## Register a client

Dynamic client registration is open — no pre-approval, no API key:

\`\`\`http
POST ${url('/register')}
Content-Type: application/json

{
  "client_name": "Your agent",
  "redirect_uris": ["https://your-agent.example/callback"],
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none"
}
\`\`\`

The response contains the \`client_id\` to use in the authorization request.

## Obtain a token

1. Redirect the user to \`${url('/authorize')}\` with \`response_type=code\`,
   your \`client_id\`, \`redirect_uri\`, \`code_challenge\` and
   \`code_challenge_method=S256\`.
2. The user signs in with their Nevent admin credentials on a Nevent-hosted page.
   Credentials are never seen by the client.
3. Exchange the returned \`code\` at \`${url('/token')}\` together with the
   \`code_verifier\`.
4. Send the access token as \`Authorization: Bearer <token>\` on every MCP request.

A request without a valid token receives \`401\` with a \`WWW-Authenticate\`
challenge carrying \`resource_metadata\`, which is the standard trigger to start
this flow.

## Revocation

Access is revoked by disabling the Nevent admin account, or by contacting
${SUPPORT_EMAIL}. Tokens are short-lived; refresh tokens stop working as soon as
the underlying account loses access.

## Read-only operation

Set the \`NEVENT_OPERATION_MODE\` environment variable to \`READ_ONLY\` on a local
(stdio) install to expose only non-mutating tools. On the hosted server the mode
is fixed by the deployment.

Full documentation: ${DOCS_URL}
`;
}

// ---------------------------------------------------------------------------
// `agent_auth` block merged into the OAuth authorization server metadata
// ---------------------------------------------------------------------------

/**
 * Extra metadata merged into `/.well-known/oauth-authorization-server`.
 *
 * RFC 8414 allows additional members, and the auth.md convention expects an
 * `agent_auth` block there so an agent can learn the registration story from
 * the document it already fetches for OAuth.
 */
export function buildAgentAuthMetadata(baseUrl: URL): Record<string, unknown> {
  return {
    register_uri: absoluteUrl(baseUrl, '/register'),
    instructions_uri: absoluteUrl(baseUrl, '/auth.md'),
    identity_types: ['human'],
    credential_types: ['oauth2_access_token'],
    supported_grant_types: ['authorization_code', 'refresh_token'],
    pkce_required: true,
    revocation_contact: `mailto:${SUPPORT_EMAIL}`,
    documentation_uri: DOCS_URL,
  };
}

// ---------------------------------------------------------------------------
// Public landing page (HTML + Markdown)
// ---------------------------------------------------------------------------

/** Rows rendered in both the HTML and the Markdown landing page. */
function landingLinks(baseUrl: URL): Array<{ label: string; href: string; note: string }> {
  return [
    {
      label: 'MCP manifest',
      href: absoluteUrl(baseUrl, '/.well-known/mcp-manifest.json'),
      note: 'Client discovery metadata',
    },
    {
      label: 'MCP server card',
      href: absoluteUrl(baseUrl, '/.well-known/mcp/server-card.json'),
      note: 'SEP-1649 server card',
    },
    {
      label: 'API catalog',
      href: absoluteUrl(baseUrl, '/.well-known/api-catalog'),
      note: 'RFC 9727 linkset',
    },
    {
      label: 'AI catalog',
      href: absoluteUrl(baseUrl, '/.well-known/ai-catalog.json'),
      note: 'ARD capability manifest',
    },
    {
      label: 'Authentication guide',
      href: absoluteUrl(baseUrl, '/auth.md'),
      note: 'OAuth 2.1 + dynamic client registration',
    },
    { label: 'Health', href: absoluteUrl(baseUrl, '/health'), note: 'Service status' },
    { label: 'Documentation', href: DOCS_URL, note: 'Help center' },
    { label: 'Source', href: REPO_URL, note: 'GitHub repository' },
  ];
}

/**
 * Renders the public landing page served on `GET /` to browsers and crawlers.
 *
 * Styled to match the OAuth login page (Poppins, the Nevent gradient) and free
 * of external assets and scripts, so it renders under the strict CSP applied by
 * Helmet.
 */
export function buildLandingHtml(baseUrl: URL, options: { version: string; toolsCount: number }): string {
  const rows = landingLinks(baseUrl)
    .map(
      (item) =>
        `        <li><a href="${item.href}">${item.label}</a><span>${item.note}</span></li>`
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nevent MCP server</title>
<meta name="description" content="Official Model Context Protocol server for Nevent — talk to your live-events CRM (campaigns, analytics, paid ads, segments) from Claude and ChatGPT.">
<link rel="canonical" href="${absoluteUrl(baseUrl, '/')}">
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 3rem 1.5rem;
    font-family: Poppins, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    line-height: 1.6;
    color: #1a1a2e;
    background: #f7f7fb;
  }
  main { max-width: 44rem; margin: 0 auto; }
  h1 { font-size: 1.9rem; margin: 0 0 .25rem; }
  .badge {
    display: inline-block; padding: .15rem .6rem; border-radius: 999px;
    background: linear-gradient(45deg, #2c1dd0, #975cf8); color: #fff;
    font-size: .75rem; letter-spacing: .04em; text-transform: uppercase;
  }
  .lede { font-size: 1.05rem; color: #444; }
  h2 { font-size: 1.05rem; margin: 2.2rem 0 .6rem; text-transform: uppercase; letter-spacing: .06em; color: #6b6b80; }
  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    background: #ece9fb; padding: .1rem .35rem; border-radius: 4px; font-size: .92em;
  }
  ul { list-style: none; margin: 0; padding: 0; }
  li { padding: .55rem 0; border-bottom: 1px solid #e4e2ee; display: flex; flex-wrap: wrap; gap: .5rem 1rem; }
  li span { color: #6b6b80; font-size: .9rem; }
  a { color: #2c1dd0; }
  footer { margin-top: 2.5rem; color: #6b6b80; font-size: .85rem; }
  @media (prefers-color-scheme: dark) {
    body { background: #14141f; color: #ececf5; }
    .lede { color: #b9b9cc; }
    code { background: #262639; }
    li { border-bottom-color: #2c2c40; }
    a { color: #a98cff; }
  }
</style>
</head>
<body>
<main>
  <span class="badge">Model Context Protocol</span>
  <h1>Nevent MCP server</h1>
  <p class="lede">
    Talk to your live-events CRM — campaigns, analytics, paid ads, segments, short URLs
    and media — from Claude, ChatGPT and any MCP client.
    ${options.toolsCount} tools, version ${options.version}.
  </p>

  <h2>Connect</h2>
  <p>
    Add <code>${absoluteUrl(baseUrl, '/')}</code> as a remote MCP server
    (Streamable HTTP). Authorize with your Nevent admin account — the server
    uses OAuth 2.1 with dynamic client registration.
  </p>

  <h2>For agents and crawlers</h2>
  <ul>
${rows}
  </ul>

  <footer>
    This host serves the MCP protocol. It stores no public content and exposes no
    tenant data without an authenticated session. Questions: ${SUPPORT_EMAIL}.
  </footer>
</main>
</body>
</html>
`;
}

/**
 * Markdown rendering of the landing page, served on `GET /` when the client
 * sends `Accept: text/markdown`.
 *
 * Same content as {@link buildLandingHtml} without the markup an agent would
 * have to strip.
 */
export function buildLandingMarkdown(baseUrl: URL, options: { version: string; toolsCount: number }): string {
  const rows = landingLinks(baseUrl)
    .map((item) => `| [${item.label}](${item.href}) | ${item.note} |`)
    .join('\n');

  return `# Nevent MCP server

Talk to your live-events CRM — campaigns, analytics, paid ads, segments, short
URLs and media — from Claude, ChatGPT and any MCP client.
${options.toolsCount} tools, version ${options.version}.

## Connect

Add \`${absoluteUrl(baseUrl, '/')}\` as a remote MCP server (Streamable HTTP).
Authorize with your Nevent admin account — the server uses OAuth 2.1 with
dynamic client registration.

## For agents and crawlers

| Resource | Notes |
| --- | --- |
${rows}

---

This host serves the MCP protocol. It stores no public content and exposes no
tenant data without an authenticated session. Questions: ${SUPPORT_EMAIL}.
`;
}
