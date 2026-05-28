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
 *   ├── POST /mcp                — MCP JSON-RPC (requireBearerAuth)
 *   ├── GET  /mcp                — MCP SSE stream (requireBearerAuth)
 *   ├── DELETE /mcp              — Session termination (requireBearerAuth)
 *   └── GET  /health             — Health check (no auth)
 * ```
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

import express, { type Request, type Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { createNeventServer } from '../server.js';
import { DataClient } from '../clients/data-client.js';
import { PaidMediaClient } from '../clients/paid-media-client.js';
import { SessionClients } from '../clients/session-clients.js';
import { TokenService } from '../auth/token-service.js';
import { NeventOAuthProvider } from '../auth/oauth-provider.js';
import { createOAuthStores } from '../auth/oauth-stores.js';
import { OPERATION_MODE } from '../config/operation-mode.js';

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
      version: '1.0.0',
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
      tools_count: 52,
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
      version: '1.0.0',
      commitSha: process.env['GIT_COMMIT_SHA'] ?? 'unknown',
      toolsCount: 52,
      activeSessions: Object.keys(activeSessions).length,
      timestamp: new Date().toISOString(),
    });
  });

  // -------------------------------------------------------------------------
  // Global middleware
  // -------------------------------------------------------------------------

  // Global request logger — captures every request before any other middleware
  app.use((req: Request, res: Response, next: () => void) => {
    const start = Date.now();
    res.on('finish', () => {
      console.error(`[nevent-mcp] ${req.method} ${req.path} | status=${res.statusCode} | ${Date.now() - start}ms | auth=${req.headers['authorization'] ? 'yes' : 'no'} | origin=${req.headers['origin'] ?? '-'}`);
    });
    next();
  });

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
    console.error(`[nevent-mcp] CORS restricted to: ${allowedOriginsEnv}`);
  } else {
    console.error('[nevent-mcp] CORS origin: * (set MCP_ALLOWED_ORIGINS for production)');
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
    console.error(`[nevent-mcp] POST /authorize | email=${req.body?.email ?? 'missing'} client_id=${req.body?.client_id ?? 'missing'} redirect_uri=${req.body?.redirect_uri ?? 'missing'}`);
    try {
      await provider.handleLoginPost(req.body as Parameters<typeof provider.handleLoginPost>[0], res);
    } catch (err) {
      console.error('[nevent-mcp] Error in POST /authorize:', err);
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
  // POST /mcp — Handle MCP JSON-RPC messages
  // -------------------------------------------------------------------------


  app.post('/', (req: Request, _res: Response, next: () => void) => {
    console.error(`[nevent-mcp] POST /mcp | session=${req.headers['mcp-session-id'] ?? 'new'} auth=${req.headers['authorization'] ? 'present' : 'missing'}`);
    next();
  }, bearerAuth, async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    try {
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

          console.error(
            `[nevent-mcp] Session clients created | userId=${sessionUserId} ` +
            `homeTenant=${sessionHomeTenantId ?? 'none'} ` +
            `tokenType=mcp_bearer mode=${OPERATION_MODE}`
          );
        } catch (tokenErr) {
          // If token verification fails at this point, the bearerAuth middleware
          // already validated it, so this should not happen in practice.
          // Fall back to creating clients without a valid token — the
          // first tool call will return a 401 from data-api.
          console.error('[nevent-mcp] Warning: Could not extract userId from bearer token:', tokenErr);
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
            console.error(`[nevent-mcp] Session initialized: ${newSessionId}`);
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
            console.error(`[nevent-mcp] Session closed: ${sid}`);
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
      console.error('[nevent-mcp] Error handling POST /mcp:', err);
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
      console.error(`[nevent-mcp] SSE resume | session=${sessionId} lastEventId=${lastEventId}`);
    }

    try {
      await activeSessions[sessionId].transport.handleRequest(req, res);
    } catch (err) {
      console.error('[nevent-mcp] Error handling GET /mcp:', err);
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

    console.error(`[nevent-mcp] Session termination requested: ${sessionId}`);

    try {
      await activeSessions[sessionId].transport.handleRequest(req, res);
    } catch (err) {
      console.error('[nevent-mcp] Error handling DELETE /mcp:', err);
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
   * Sessions older than 30 minutes are considered orphaned and removed.
   */
  const SESSION_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    const orphaned = Object.entries(activeSessions).filter(
      ([, { createdAt }]) => now - createdAt.getTime() > SESSION_MAX_AGE_MS
    );
    for (const [sid] of orphaned) {
      console.error(`[nevent-mcp] Cleaning up orphaned session: ${sid}`);
      activeSessions[sid].transport.close().catch(() => {
        // Ignore errors during cleanup — session may already be closed
      });
      delete activeSessions[sid];
    }
    if (orphaned.length > 0) {
      console.error(`[nevent-mcp] Cleaned up ${orphaned.length} orphaned session(s)`);
    }
  }, SESSION_MAX_AGE_MS);

  // Prevent the interval from keeping the process alive on graceful shutdown
  cleanupInterval.unref();

  // -------------------------------------------------------------------------
  // Shutdown function (returned to caller — NOT registered as signal handler)
  // -------------------------------------------------------------------------

  const shutdown = async (): Promise<void> => {
    console.error('[nevent-mcp] Shutting down HTTP transport...');
    clearInterval(cleanupInterval);
    const sessionIds = Object.keys(activeSessions);
    await Promise.allSettled(
      sessionIds.map(async (sid) => {
        try {
          await activeSessions[sid].transport.close();
          delete activeSessions[sid];
        } catch (err) {
          console.error(`[nevent-mcp] Error closing session ${sid}:`, err);
        }
      })
    );
    await stores.mongoClient.close();
    console.error('[nevent-mcp] HTTP transport shutdown complete');
  };

  return { app, shutdown };
}
