/**
 * HTTP Transport for the Nevent MCP Server
 *
 * Implements a production-ready Express application that exposes the MCP server
 * over the Streamable HTTP transport defined in the MCP specification.
 *
 * ## Architecture
 *
 * ```
 * Express app
 *   ├── mcpAuthRouter()          — OAuth 2.1 endpoints (SDK-managed)
 *   │     ├── GET  /.well-known/oauth-authorization-server
 *   │     ├── GET  /.well-known/oauth-protected-resource
 *   │     ├── POST /register  (DCR)
 *   │     ├── GET  /authorize  → NeventOAuthProvider.authorize() (login page)
 *   │     └── POST /token
 *   │
 *   ├── POST /authorize (custom) → NeventOAuthProvider.handleLoginPost()
 *   │
 *   ├── POST /mcp                — MCP JSON-RPC (lazyAuthMiddleware, NEV-1776)
 *   │     ├── with Bearer token  → requireBearerAuth (unchanged)
 *   │     └── without token      → discovery-only (initialize, tools/list, ping…)
 *   │           → anonymous McpServer probe (stub clients, full tool metadata)
 *   ├── GET  /mcp                — MCP SSE stream (requireBearerAuth, always)
 *   ├── DELETE /mcp              — Session termination (requireBearerAuth, always)
 *   └── GET  /health             — Health check (no auth)
 * ```
 *
 * ## Lazy auth / public discovery (NEV-1776)
 *
 * MCP directory scanners (Smithery, Glama, PulseMCP) send `initialize` +
 * `tools/list` without a Bearer token. Previously the server returned 401 to
 * ALL requests, causing Smithery to show "No capabilities found".
 *
 * The `lazyAuthMiddleware` allows unauthenticated requests through if — and
 * only if — every JSON-RPC method in the body is in `DISCOVERY_METHODS`.
 * Execution methods (e.g. `tools/call`) without a token still return 401
 * with the standard `WWW-Authenticate` challenge to trigger the OAuth flow.
 *
 * Anonymous sessions are backed by a stub McpServer (no real credentials,
 * no business data) and expire after 5 minutes. A stricter
 * `discoveryRateLimiter` (30 req/min) applies to all unauthenticated requests.
 *
 * ## Session management
 *
 * Each MCP client session gets its own `StreamableHTTPServerTransport` and
 * `McpServer` instance. Sessions are keyed by `Mcp-Session-Id` header. The
 * SDK's `sessionIdGenerator` assigns UUIDs on initialization.
 *
 * A background interval prunes orphaned sessions (those not cleaned up via
 * transport close events) every 30 minutes to prevent memory leaks.
 *
 * ## Security headers
 *
 * `helmet` is applied as the first `app.use()` call so every response —
 * including error pages from downstream middleware — carries the configured
 * security headers: `Content-Security-Policy`, `Strict-Transport-Security`,
 * `X-Frame-Options`, `X-Content-Type-Options`, `Cross-Origin-*`, etc.
 *
 * ## Rate limiting
 *
 * `express-rate-limit` is applied on all `/mcp` and `/authorize` endpoints to
 * prevent brute-force attacks.
 *
 * ## CORS
 *
 * The `MCP_ALLOWED_ORIGINS` environment variable controls CORS. Set it to a
 * comma-separated list of allowed origins for production deployments.
 * Defaults to `*` for local development.
 *
 * Production example:
 * ```
 * MCP_ALLOWED_ORIGINS=https://claude.ai,https://chatgpt.com
 * ```
 *
 * ## Signal handling
 *
 * `createHttpApp()` returns a `shutdown()` function. Signal handlers
 * (`SIGTERM`, `SIGINT`) are registered in `index.ts` — NOT here — so that
 * the same server can be started and stopped by tests without registering
 * duplicate process-level handlers.
 *
 * @module transports/http
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import rateLimit from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { createNeventServer, getToolCount } from '../server.js';
import { DataClient } from '../clients/data-client.js';
import { PaidMediaClient } from '../clients/paid-media-client.js';
import { SessionClients } from '../clients/session-clients.js';
import { TokenService } from '../auth/token-service.js';
import { NeventOAuthProvider } from '../auth/oauth-provider.js';
import { createOAuthStores } from '../auth/oauth-stores.js';
import { OPERATION_MODE } from '../config/operation-mode.js';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Lazy auth — public discovery constants
// ---------------------------------------------------------------------------

/**
 * JSON-RPC methods that MCP directory scanners (Smithery, Glama, PulseMCP)
 * send during capability discovery. These are safe to serve without a Bearer
 * token because they expose only tool metadata — never user data or side
 * effects.
 *
 * Any other method (e.g. `tools/call`) arriving without Authorization will
 * receive a 401 with `WWW-Authenticate`, which triggers the standard OAuth
 * flow in real MCP clients.
 */
export const DISCOVERY_METHODS = new Set([
  'initialize',
  'notifications/initialized',
  'ping',
  'tools/list',
  'prompts/list',
  'resources/list',
]);

/**
 * Anonymous session TTL in milliseconds.
 *
 * Discovery sessions hold no credentials and carry no user data. They are
 * cleaned up aggressively (5 minutes) so they do not accumulate in memory
 * when scanners open many parallel probes.
 */
const ANON_SESSION_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Package metadata — read once at module load time, cached for the process
// lifetime. Never re-read on each request.
// ---------------------------------------------------------------------------

/**
 * Semantic version string read from package.json at startup.
 * Used in /health and /.well-known/mcp-manifest.json responses so that
 * deployed containers always report their actual version rather than the
 * hardcoded string that was present before NEV-1661.
 */
const PKG_VERSION: string = (() => {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '../../package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };
  return pkg.version;
})();

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Configuration for the HTTP transport server.
 */
export interface HttpTransportConfig {
  /** TCP port to listen on. Default: `3000`. */
  port: number;
  /** Public HTTPS URL of the MCP server (used in OAuth metadata). */
  mcpServerUrl: URL;
  /** JWT signing secret for access tokens. */
  jwtSecret: string;
  /** MongoDB connection URI for OAuth stores. */
  mongoUri: string;
  /** nev-api base URL for credential validation and tenant endpoints. */
  neventApiUrl: string;
  /** Base URL of nev-data-api (data.nevent.es). */
  dataApiUrl: string;
}

/** Result of `createHttpApp()` — app plus a shutdown function. */
export interface HttpAppResult {
  /** Configured Express application. */
  app: express.Application;
  /**
   * Graceful shutdown function. Closes all active sessions and the MongoDB
   * connection. Should be called on SIGTERM / SIGINT from `index.ts`.
   */
  shutdown: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Transport registry
// ---------------------------------------------------------------------------

/**
 * Active MCP transport sessions, keyed by session ID.
 *
 * Each entry holds the transport, the session's DataClient (authenticated
 * with the user's own nev-api JWT), and the creation timestamp for cleanup.
 */
const activeSessions: Record<string, {
  transport: StreamableHTTPServerTransport;
  dataClient: DataClient;
  createdAt: Date;
}> = {};

// ---------------------------------------------------------------------------
// Rate limiters
// ---------------------------------------------------------------------------

/** Strict rate limiter for the auth endpoints (prevents brute-force). */
const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // 20 auth attempts per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts. Please try again in 15 minutes.' },
  // Suppress validation warnings for X-Forwarded-For when behind AWS ALB.
  // Trust proxy is set on the app (`app.set('trust proxy', 1)`), so the
  // forwarded IP is expected and safe to use for rate-limiting.
  validate: { trustProxy: false, xForwardedForHeader: false },
});

/** Moderate rate limiter for MCP JSON-RPC endpoints. */
const mcpRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 600, // 600 requests per minute per IP (Claude.ai sends many requests per tool call)
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Rate limit exceeded. Please slow down your requests.' },
  // Suppress validation warnings for X-Forwarded-For when behind AWS ALB.
  // Trust proxy is set on the app (`app.set('trust proxy', 1)`), so the
  // forwarded IP is expected and safe to use for rate-limiting.
  validate: { trustProxy: false, xForwardedForHeader: false },
});

/**
 * Strict rate limiter for unauthenticated discovery requests (NEV-1776).
 *
 * Directory scanners (Smithery, Glama, PulseMCP) typically send at most a
 * handful of probes per minute. 30 req/min per IP is generous for legitimate
 * scanners while still blocking abusive anonymous traffic.
 */
const discoveryRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 anonymous requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many discovery requests. Please try again in a minute.' },
  validate: { trustProxy: false, xForwardedForHeader: false },
});

// ---------------------------------------------------------------------------
// createHttpApp()
// ---------------------------------------------------------------------------

/**
 * Creates and configures the Express application with all MCP and OAuth routes.
 *
 * Returns both the Express app and a `shutdown()` function. Signal handlers
 * are NOT registered here — they belong in `index.ts` to avoid registering
 * duplicate process-level handlers when the module is imported multiple times
 * (e.g., in tests).
 *
 * @param config - HTTP transport configuration.
 * @returns A promise resolving to `{ app, shutdown }`.
 *
 * @example
 * ```ts
 * const { app, shutdown } = await createHttpApp({ ... });
 * app.listen(3000);
 * process.on('SIGTERM', () => void shutdown().then(() => process.exit(0)));
 * ```
 */
export async function createHttpApp(config: HttpTransportConfig): Promise<HttpAppResult> {
  const app = express();

  // -------------------------------------------------------------------------
  // Proxy trust (must be set before any middleware that reads IP addresses)
  // -------------------------------------------------------------------------

  // The app runs behind an AWS Application Load Balancer which sets the
  // X-Forwarded-For header. Without this setting, express-rate-limit throws
  // ERR_ERL_UNEXPECTED_X_FORWARDED_FOR because Express does not trust the
  // forwarded IP by default. Value `1` means trust the first proxy hop (ALB).
  app.set('trust proxy', 1);

  // -------------------------------------------------------------------------
  // Security headers (Helmet) — applied first so every response gets them,
  // including error responses from downstream middleware.
  //
  // Design choices:
  //   • contentSecurityPolicy: restrictive defaults with 'self' for default,
  //     script, connect sources. styleSrc keeps 'unsafe-inline' because the
  //     OAuth login page (src/auth/login-page.ts) uses a <style> block and
  //     inline style="" attributes. fontSrc allows Google Fonts CDN. imgSrc
  //     allows external logos served on the login page (Nevent wordmark,
  //     Claude/ChatGPT client icons from CDNs).
  //     TODO: migrate login page to a nonce-based approach and drop
  //     'unsafe-inline' from styleSrc.
  //   • crossOriginEmbedderPolicy: disabled — COEP is not meaningful for an
  //     LLM/MCP API endpoint; enabling it would block clients that do not
  //     send CORP headers on their sub-resources.
  //   • hsts: 1 year + includeSubDomains, no preload flag (preload requires
  //     manual submission to hstspreload.org; can be enabled later).
  // -------------------------------------------------------------------------

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: [
            "'self'",
            "'unsafe-inline'", // required: login page uses <style> block + inline style attrs
            'https://fonts.googleapis.com',
          ],
          fontSrc: ["'self'", 'https://fonts.gstatic.com'],
          imgSrc: [
            "'self'",
            'data:',
            'https://admin.nevent.es',       // Nevent wordmark on login page
            'https://avatars.slack-edge.com', // Claude logo on login page
            'https://upload.wikimedia.org',   // ChatGPT logo on login page
          ],
          connectSrc: ["'self'"],
          frameAncestors: ["'none'"],
          // Allow form submits to any URL. The MCP server is a public OAuth provider
          // serving multiple MCP clients (Claude.ai, ChatGPT, Cursor, etc.). The real
          // defense is redirect_uri validation in oauth-provider.ts against the
          // client's DCR registration. CSP form-action is only defense-in-depth here.
          // Without wildcard, Chrome blocks the OAuth flow because it evaluates
          // form-action against the full redirect chain (POST -> 302 -> client callback).
          formAction: ['*'],
        },
      },
      crossOriginEmbedderPolicy: false,
      hsts: {
        maxAge: 31536000,       // 1 year
        includeSubDomains: true,
        preload: false,
      },
    })
  );

  // -------------------------------------------------------------------------
  // MCP manifest — publicly accessible, no auth required.
  // Enables MCP client discovery (e.g. Claude.ai connector directory).
  // -------------------------------------------------------------------------

  app.get('/.well-known/mcp-manifest.json', (_req: Request, res: Response): void => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json({
      name: 'nevent',
      displayName: 'Nevent',
      description: 'Talk to your live-events CRM (campaigns, analytics, paid ads, segments) in Claude and ChatGPT',
      version: PKG_VERSION,
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
    });
  });

  // -------------------------------------------------------------------------
  // Health check — MUST be before any rate limiter or logger middleware
  // ALB sends health checks every 30s; mixing them into the rate limiter
  // pool can cause 429s that mark the target as unhealthy.
  // -------------------------------------------------------------------------

  app.get('/health', (_req: Request, res: Response): void => {
    res.json({
      status: 'ok',
      service: 'nevent-mcp',
      transport: 'http',
      version: PKG_VERSION,
      commitSha: process.env['GIT_COMMIT_SHA'] ?? 'unknown',
      toolsCount: getToolCount({
        hasNeventApiUrl: true,
        hasMongoUri: true,
        hasPaidMediaClient: true,
        hasShortUrlClient: true,
      }),
      activeSessions: Object.keys(activeSessions).length,
      timestamp: new Date().toISOString(),
    });
  });

  // -------------------------------------------------------------------------
  // HTTP request logger (pino-http)
  //
  // Mounted after Helmet so security headers are already applied when the
  // logger middleware runs. Emits one structured log line per request with
  // method, URL, status code, response time, and a unique request ID.
  //
  // The `req.headers.authorization` field is redacted by the shared logger's
  // redact list, so tokens never appear in the log sink.
  // -------------------------------------------------------------------------

  app.use(
    pinoHttp({
      logger,
      /**
       * Assign log level based on response outcome:
       * - 5xx or thrown error → error
       * - 4xx → warn
       * - everything else → info
       */
      customLogLevel: (_req: import('http').IncomingMessage, res: import('http').ServerResponse, err?: Error) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      /** Human-readable success summary line. */
      customSuccessMessage: (req: import('http').IncomingMessage, res: import('http').ServerResponse) =>
        `${req.method ?? '-'} ${req.url ?? '-'} ${res.statusCode}`,
      /** Human-readable error summary line. */
      customErrorMessage: (req: import('http').IncomingMessage, res: import('http').ServerResponse, err: Error) =>
        `${req.method ?? '-'} ${req.url ?? '-'} ${res.statusCode}: ${err.message}`,
      /** Trim request serialisation to avoid duplicating header data. */
      serializers: {
        req: (req: import('pino-std-serializers').SerializedRequest) => ({
          method: req.method,
          url: req.url,
          remoteAddress: req.remoteAddress,
        }),
        res: (res: import('pino-std-serializers').SerializedResponse) => ({ statusCode: res.statusCode }),
      },
    })
  );

  // -------------------------------------------------------------------------
  // Global middleware
  // -------------------------------------------------------------------------

  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  // CORS: expose Mcp-Session-Id so browser-based clients can read it.
  //
  // The `MCP_ALLOWED_ORIGINS` environment variable controls allowed origins.
  // In development, leave it unset to default to `*`.
  // In production, set it to a comma-separated list of allowed origins, e.g.:
  //   MCP_ALLOWED_ORIGINS=https://claude.ai,https://chatgpt.com
  const allowedOriginsEnv = process.env['MCP_ALLOWED_ORIGINS'];
  const corsOrigin: cors.CorsOptions['origin'] = allowedOriginsEnv
    ? allowedOriginsEnv.split(',').map((o) => o.trim()).filter(Boolean)
    : '*';

  if (allowedOriginsEnv) {
    logger.info({ allowedOrigins: allowedOriginsEnv }, 'CORS restricted to configured origins');
  } else {
    logger.warn('CORS origin: * — set MCP_ALLOWED_ORIGINS for production');
  }

  app.use(
    cors({
      origin: corsOrigin,
      exposedHeaders: ['Mcp-Session-Id'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Mcp-Session-Id', 'Last-Event-ID'],
    })
  );

  // -------------------------------------------------------------------------
  // OAuth stores + provider
  // -------------------------------------------------------------------------

  const stores = await createOAuthStores(config.mongoUri);
  const tokenService = new TokenService(config.jwtSecret);

  const provider = new NeventOAuthProvider({
    stores,
    tokenService,
    neventApiUrl: config.neventApiUrl,
    mcpServerUrl: config.mcpServerUrl,
  });

  // -------------------------------------------------------------------------
  // POST /authorize — custom handler for HTML form submission
  //
  // IMPORTANT: This MUST be registered BEFORE the mcpAuthRouter because the
  // SDK's authorization handler uses `router.all('/')` on `/authorize`, which
  // intercepts both GET and POST. If the SDK handler runs first on a POST,
  // it calls `provider.authorize()` which re-renders the login page instead
  // of processing the submitted credentials via `handleLoginPost()`.
  // -------------------------------------------------------------------------

  app.post('/authorize', authRateLimiter, async (req: Request, res: Response): Promise<void> => {
    logger.info(
      {
        // email is not a secret, but we omit it here to avoid PII in logs by default.
        // client_id and redirect_uri are safe to log for audit traceability.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        client_id: req.body?.client_id ?? 'missing',
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        redirect_uri: req.body?.redirect_uri ?? 'missing',
      },
      'POST /authorize'
    );
    try {
      await provider.handleLoginPost(req.body as Parameters<typeof provider.handleLoginPost>[0], res);
    } catch (err) {
      logger.error({ err }, 'Error in POST /authorize');
      if (!res.headersSent) {
        res.status(500).send('Internal server error during authorization');
      }
    }
  });

  // -------------------------------------------------------------------------
  // OAuth 2.1 router (SDK-managed endpoints)
  // -------------------------------------------------------------------------

  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: config.mcpServerUrl,
      scopesSupported: ['mcp:tools'],
      resourceName: 'Nevent MCP Server',
    })
  );

  // -------------------------------------------------------------------------
  // Bearer auth middleware for MCP endpoints
  // -------------------------------------------------------------------------

  const bearerAuth = requireBearerAuth({
    verifier: provider,
    requiredScopes: [],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(config.mcpServerUrl),
  });

  // -------------------------------------------------------------------------
  // Anonymous discovery sessions (NEV-1776)
  //
  // Directory scanners (Smithery, Glama, PulseMCP) send `initialize` +
  // `tools/list` without a Bearer token. We serve them from lightweight
  // anonymous sessions backed by a stub McpServer (no real credentials,
  // no business data). Anonymous sessions are short-lived (ANON_SESSION_MAX_AGE_MS)
  // and cleaned up by the same orphan-cleanup interval used for real sessions.
  // -------------------------------------------------------------------------

  /** Registry of active anonymous (unauthenticated) discovery sessions. */
  const anonSessions: Record<string, {
    transport: StreamableHTTPServerTransport;
    createdAt: Date;
  }> = {};

  // -------------------------------------------------------------------------
  // Lazy auth middleware (NEV-1776)
  //
  // Replaces the direct `bearerAuth` call on POST /. Decision tree:
  //
  //   1. Request has Authorization header → full bearerAuth (unchanged behaviour).
  //   2. Request has no Authorization AND existing mcp-session-id that belongs
  //      to an anonymous session → allow (scanner resuming discovery).
  //   3. Request has no Authorization AND is a new initialize request → allow
  //      (scanner starting a fresh discovery probe) — hits discoveryRateLimiter.
  //   4. Request has no Authorization AND all JSON-RPC methods in the body are
  //      in DISCOVERY_METHODS → allow (scanner sending tools/list on anon session).
  //   5. Anything else without Authorization → 401 with WWW-Authenticate,
  //      triggering the standard OAuth flow in real MCP clients.
  //
  // The WWW-Authenticate header format matches what `requireBearerAuth` emits
  // so that existing OAuth clients (Claude.ai, ChatGPT) see the same challenge.
  // -------------------------------------------------------------------------

  /**
   * Returns true when every JSON-RPC method in the body (single request or
   * batch array) is in the `DISCOVERY_METHODS` allowlist.
   */
  function isDiscoveryOnly(body: unknown): boolean {
    if (!body || typeof body !== 'object') return false;
    const requests = Array.isArray(body) ? body : [body];
    return requests.every((r) => {
      if (!r || typeof r !== 'object') return false;
      const method = (r as Record<string, unknown>)['method'];
      return typeof method === 'string' && DISCOVERY_METHODS.has(method);
    });
  }

  /**
   * 401 response that matches the WWW-Authenticate format emitted by the SDK's
   * `requireBearerAuth`. Keeps the challenge consistent so real MCP clients
   * (Claude.ai, ChatGPT) can parse it and launch the OAuth flow.
   */
  function send401(res: Response): void {
    const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(config.mcpServerUrl);
    res.setHeader(
      'WWW-Authenticate',
      `Bearer realm="Nevent MCP Server", resource_metadata="${resourceMetadataUrl.toString()}"`
    );
    res.status(401).json({
      jsonrpc: '2.0',
      error: {
        code: -32001,
        message: 'Authentication required. Please authenticate via OAuth 2.1 to use this method.',
      },
      id: null,
    });
  }

  /**
   * Middleware that conditionally requires Bearer auth or allows anonymous
   * discovery requests through to the POST / handler.
   *
   * See the decision tree in the block comment above.
   */
  const lazyAuthMiddleware = (req: Request, res: Response, next: NextFunction): void => {
    const hasAuth = Boolean(req.headers['authorization']);

    if (hasAuth) {
      // Authenticated path — delegate to the SDK's bearerAuth middleware.
      // Cast next to satisfy the SDK's RequestHandler typing which uses the
      // Express NextFunction under the hood.
      bearerAuth(req, res, next as Parameters<typeof bearerAuth>[2]);
      return;
    }

    // Unauthenticated path — check if this is a resuming anon session.
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (sessionId && anonSessions[sessionId]) {
      // Scanner is resuming an existing anonymous session.
      next();
      return;
    }

    // New request without auth. Allow only discovery-safe methods.
    if (isDiscoveryOnly(req.body)) {
      // Apply the stricter anonymous rate limiter before allowing through.
      discoveryRateLimiter(req, res, next);
      return;
    }

    // Non-discovery method without a Bearer token → 401.
    send401(res);
  };

  // -------------------------------------------------------------------------
  // POST /mcp — Handle MCP JSON-RPC messages
  // -------------------------------------------------------------------------

  app.post('/', (req: Request, _res: Response, next: () => void) => {
    logger.debug(
      {
        sessionId: req.headers['mcp-session-id'] ?? 'new',
        auth: req.headers['authorization'] ? 'present' : 'missing',
      },
      'POST /mcp'
    );
    next();
  }, lazyAuthMiddleware, async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const hasAuth = Boolean(req.headers['authorization']);

    try {
      // ------------------------------------------------------------------
      // Anonymous discovery path (NEV-1776)
      //
      // Requests that passed lazyAuthMiddleware without a Bearer token are
      // handled here. They interact with lightweight anonymous sessions
      // backed by stub clients — no user data, no side effects.
      // ------------------------------------------------------------------
      if (!hasAuth) {
        // Resume an existing anonymous session.
        if (sessionId && anonSessions[sessionId]) {
          await anonSessions[sessionId].transport.handleRequest(req, res, req.body);
          return;
        }

        // New anonymous discovery session (initialize request).
        if (!sessionId && isInitializeRequest(req.body)) {
          logger.info({ mode: OPERATION_MODE }, 'Anonymous discovery session starting');

          // Build a stub server with all tools registered using the same
          // technique as getToolCount() — stub clients are never called
          // during discovery (tools/list only reads metadata, not data).
          const stubDataClient = new DataClient({ baseUrl: config.dataApiUrl, jwtToken: '' });
          const stubPaidMediaClient = new PaidMediaClient({ baseUrl: config.neventApiUrl, jwtToken: '' });
          const stubSessionClients = new SessionClients(
            stubDataClient,
            stubPaidMediaClient,
            config.neventApiUrl,
          );

          const anonServer = createNeventServer({
            dataClient: stubDataClient,
            neventApiUrl: config.neventApiUrl,
            mongoUri: config.mongoUri,
            paidMediaClient: stubPaidMediaClient,
            sessionClients: stubSessionClients,
            // No userId/getSessionId — anonymous sessions have no attribution.
          });

          const anonTransport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (newSessionId: string) => {
              logger.info({ sessionId: newSessionId, type: 'anonymous' }, 'Anonymous discovery session initialized');
              anonSessions[newSessionId] = {
                transport: anonTransport,
                createdAt: new Date(),
              };
            },
          });

          anonTransport.onclose = () => {
            const sid = anonTransport.sessionId;
            if (sid && anonSessions[sid]) {
              logger.info({ sessionId: sid, type: 'anonymous' }, 'Anonymous session closed');
              delete anonSessions[sid];
            }
          };

          await anonServer.connect(anonTransport);
          await anonTransport.handleRequest(req, res, req.body);
          return;
        }

        // Unauthenticated non-discovery request — should not reach here
        // because lazyAuthMiddleware already blocked it, but guard for safety.
        send401(res);
        return;
      }

      // ------------------------------------------------------------------
      // Authenticated path (unchanged behaviour)
      // ------------------------------------------------------------------

      // Reuse existing session transport
      if (sessionId && activeSessions[sessionId]) {
        await activeSessions[sessionId].transport.handleRequest(req, res, req.body);
        return;
      }

      // New initialization request — must not have a session ID
      if (!sessionId && isInitializeRequest(req.body)) {
        // ------------------------------------------------------------------
        // Per-session DataClient: authenticate as the logged-in user.
        //
        // The MCP bearer token contains the user's `sub` (userId) claim.
        // We look up the nev-api access_token stored during the OAuth flow
        // for that userId and create a DataClient with it. This means all
        // data-api calls in this session use the user's own credentials
        // instead of a shared service account token.
        //
        // Fallback: if the nev-api token is not found (e.g. the refresh
        // token has expired or was revoked), we use the MCP access token
        // itself as a best-effort fallback. The MCP access token shares the
        // same JWT claims as the nev-api token (same secret + same issuer),
        // so data-api can validate it.
        // ------------------------------------------------------------------
        let sessionDataClient: DataClient;
        let sessionPaidMediaClient: PaidMediaClient;
        let sessionUserId: string | null = null;
        let sessionHomeTenantId: string | undefined;

        try {
          const authHeader = req.headers['authorization'] ?? '';
          const bearerToken = authHeader.replace(/^Bearer\s+/i, '');
          const claims = tokenService.verifyAccessToken(bearerToken);
          sessionUserId = claims.sub;
          sessionHomeTenantId = claims.tenantId ?? undefined;

          // Use the MCP bearer token directly for data-api calls.
          // The MCP token shares the same JWT secret as the upstream API and has a 24h TTL,
          // while the upstream access_token stored during OAuth login expires in only
          // 10 minutes (short expiry by design).
          // data.nevent.es accepts both token types via the upstream API's authentication filter.
          const effectiveToken = bearerToken;

          sessionDataClient = new DataClient(
            {
              baseUrl: config.dataApiUrl,
              jwtToken: effectiveToken,
            },
            sessionHomeTenantId
          );

          // Paid media client uses the same MCP bearer token to authenticate
          // against nev-api /api/ads/* endpoints. Tenant is resolved from the JWT.
          sessionPaidMediaClient = new PaidMediaClient({
            baseUrl: config.neventApiUrl,
            jwtToken: effectiveToken,
          });

          logger.info(
            {
              userId: sessionUserId,
              homeTenant: sessionHomeTenantId ?? 'none',
              tokenType: 'mcp_bearer',
              mode: OPERATION_MODE,
            },
            'Session clients created'
          );
        } catch (tokenErr) {
          // If token verification fails at this point, the bearerAuth middleware
          // already validated it, so this should not happen in practice.
          // Fall back to creating clients without a valid token — the
          // first tool call will return a 401 from data-api.
          logger.warn({ err: tokenErr }, 'Could not extract userId from bearer token — falling back to empty token');
          sessionDataClient = new DataClient({
            baseUrl: config.dataApiUrl,
            jwtToken: '',
          });
          sessionPaidMediaClient = new PaidMediaClient({
            baseUrl: config.neventApiUrl,
            jwtToken: '',
          });
        }

        // Build SessionClients aggregate — ensures JWT rotation propagates
        // to both DataClient and PaidMediaClient atomically, and caches are
        // invalidated on tenant switch.
        const sessionClients = new SessionClients(
          sessionDataClient,
          sessionPaidMediaClient,
          config.neventApiUrl,
          sessionHomeTenantId
        );

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId: string) => {
            logger.info({ sessionId: newSessionId }, 'Session initialized');
            activeSessions[newSessionId] = {
              transport,
              dataClient: sessionDataClient,
              createdAt: new Date(),
            };
          },
        });

        // Clean up session on transport close
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && activeSessions[sid]) {
            logger.info({ sessionId: sid }, 'Session closed');
            delete activeSessions[sid];
          }
        };

        // Create a fresh MCP server for this session using the per-session SessionClients.
        // Pass userId and a lazy getSessionId getter so the tool call logger can
        // attribute logs to the correct user and session.
        // getSessionId is lazy because transport.sessionId is only assigned after
        // the first initialize request is processed.
        const mcpServer = createNeventServer({
          dataClient: sessionDataClient,
          neventApiUrl: config.neventApiUrl,
          mongoUri: config.mongoUri,
          paidMediaClient: sessionPaidMediaClient,
          sessionClients,
          userId: sessionUserId ?? undefined,
          getSessionId: () => transport.sessionId ?? null,
        });
        await mcpServer.connect(transport);

        // Handle the initialization request
        await transport.handleRequest(req, res, req.body);
        return;
      }

      // Invalid request: has session ID but no matching session, or POST without init
      res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Bad Request: No valid session ID provided',
        },
        id: null,
      });
    } catch (err) {
      logger.error({ err }, 'Error handling POST /mcp');
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  // -------------------------------------------------------------------------
  // GET /mcp — SSE stream for server-initiated messages
  // -------------------------------------------------------------------------

  app.get('/', bearerAuth, async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!sessionId || !activeSessions[sessionId]) {
      res.status(400).send('Invalid or missing Mcp-Session-Id header');
      return;
    }

    const lastEventId = req.headers['last-event-id'];
    if (lastEventId) {
      logger.debug({ sessionId, lastEventId }, 'SSE resume');
    }

    try {
      await activeSessions[sessionId].transport.handleRequest(req, res);
    } catch (err) {
      logger.error({ err }, 'Error handling GET /mcp');
      if (!res.headersSent) {
        res.status(500).send('Internal server error');
      }
    }
  });

  // -------------------------------------------------------------------------
  // DELETE /mcp — Session termination
  // -------------------------------------------------------------------------

  app.delete('/', bearerAuth, async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!sessionId || !activeSessions[sessionId]) {
      res.status(400).send('Invalid or missing Mcp-Session-Id header');
      return;
    }

    logger.info({ sessionId }, 'Session termination requested');

    try {
      await activeSessions[sessionId].transport.handleRequest(req, res);
    } catch (err) {
      logger.error({ err }, 'Error handling DELETE /mcp');
      if (!res.headersSent) {
        res.status(500).send('Error processing session termination');
      }
    }
  });

  // Health check is registered at the top of the middleware stack (before rate limiters).

  // -------------------------------------------------------------------------
  // Orphaned session cleanup (every 30 minutes)
  // -------------------------------------------------------------------------

  /**
   * Periodic cleanup for sessions that were not closed via the transport
   * `onclose` event (e.g., clients that disconnected without a DELETE /mcp).
   * Authenticated sessions older than 30 minutes are considered orphaned.
   * Anonymous discovery sessions use the shorter ANON_SESSION_MAX_AGE_MS TTL
   * (5 minutes) since they hold no state worth preserving.
   */
  const SESSION_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes
  const cleanupInterval = setInterval(() => {
    const now = Date.now();

    // Clean up orphaned authenticated sessions (30-minute TTL).
    const orphaned = Object.entries(activeSessions).filter(
      ([, { createdAt }]) => now - createdAt.getTime() > SESSION_MAX_AGE_MS
    );
    for (const [sid] of orphaned) {
      logger.info({ sessionId: sid }, 'Cleaning up orphaned session');
      activeSessions[sid].transport.close().catch(() => {
        // Ignore errors during cleanup — session may already be closed
      });
      delete activeSessions[sid];
    }
    if (orphaned.length > 0) {
      logger.info({ count: orphaned.length }, 'Orphaned sessions cleaned up');
    }

    // Clean up expired anonymous discovery sessions (5-minute TTL).
    const expiredAnon = Object.entries(anonSessions).filter(
      ([, { createdAt }]) => now - createdAt.getTime() > ANON_SESSION_MAX_AGE_MS
    );
    for (const [sid] of expiredAnon) {
      logger.info({ sessionId: sid, type: 'anonymous' }, 'Cleaning up expired anonymous session');
      anonSessions[sid].transport.close().catch(() => {
        // Ignore errors during cleanup
      });
      delete anonSessions[sid];
    }
    if (expiredAnon.length > 0) {
      logger.info({ count: expiredAnon.length }, 'Expired anonymous sessions cleaned up');
    }
  }, SESSION_MAX_AGE_MS);

  // Prevent the interval from keeping the process alive on graceful shutdown
  cleanupInterval.unref();

  // -------------------------------------------------------------------------
  // Shutdown function (returned to caller — NOT registered as signal handler)
  // -------------------------------------------------------------------------

  const shutdown = async (): Promise<void> => {
    logger.info('Shutting down HTTP transport...');
    clearInterval(cleanupInterval);

    // Close all authenticated sessions.
    const sessionIds = Object.keys(activeSessions);
    await Promise.allSettled(
      sessionIds.map(async (sid) => {
        try {
          await activeSessions[sid].transport.close();
          delete activeSessions[sid];
        } catch (err) {
          logger.error({ err, sessionId: sid }, 'Error closing session during shutdown');
        }
      })
    );

    // Close all anonymous discovery sessions.
    const anonSessionIds = Object.keys(anonSessions);
    await Promise.allSettled(
      anonSessionIds.map(async (sid) => {
        try {
          await anonSessions[sid].transport.close();
          delete anonSessions[sid];
        } catch (err) {
          logger.warn({ err, sessionId: sid }, 'Error closing anonymous session during shutdown');
        }
      })
    );

    await stores.mongoClient.close();
    logger.info('HTTP transport shutdown complete');
  };

  return { app, shutdown };
}
