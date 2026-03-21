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
 *   ├── DELETE /mcp              — Session termination
 *   └── GET  /health             — Health check (no auth)
 * ```
 *
 * ## Session management
 *
 * Each MCP client session gets its own `StreamableHTTPServerTransport` and
 * `McpServer` instance. Sessions are keyed by `Mcp-Session-Id` header. The
 * SDK's `sessionIdGenerator` assigns UUIDs on initialization.
 *
 * ## Rate limiting
 *
 * `express-rate-limit` is applied on all `/mcp` and `/authorize` endpoints to
 * prevent brute-force attacks.
 *
 * @module transports/http
 */

import express, { type Request, type Response } from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { createNeventServer } from '../server.js';
import { DataClient } from '../clients/data-client.js';
import { TokenService } from '../auth/token-service.js';
import { NeventOAuthProvider } from '../auth/oauth-provider.js';
import { createOAuthStores } from '../auth/oauth-stores.js';

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
  /** nev-api base URL for credential validation. */
  neventApiUrl: string;
  /** DataClient used to create per-session MCP servers. */
  dataClient: DataClient;
}

// ---------------------------------------------------------------------------
// Transport registry
// ---------------------------------------------------------------------------

/** Active MCP transport sessions, keyed by session ID. */
const activeSessions: Record<string, StreamableHTTPServerTransport> = {};

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
});

/** Moderate rate limiter for MCP JSON-RPC endpoints. */
const mcpRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120, // 120 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Rate limit exceeded. Please slow down your requests.' },
});

// ---------------------------------------------------------------------------
// createHttpApp()
// ---------------------------------------------------------------------------

/**
 * Creates and configures the Express application with all MCP and OAuth routes.
 *
 * This is the main entry point for HTTP transport. Call `app.listen()` on the
 * returned app to start accepting connections.
 *
 * @param config - HTTP transport configuration.
 * @returns A promise resolving to the configured Express `Application`.
 *
 * @example
 * ```ts
 * const app = await createHttpApp({
 *   port: 3000,
 *   mcpServerUrl: new URL('https://mcp.nevent.es'),
 *   jwtSecret: process.env.MCP_JWT_SECRET!,
 *   mongoUri: process.env.MONGODB_URI!,
 *   neventApiUrl: 'https://api.nevent.es',
 *   dataClient,
 * });
 * app.listen(config.port, () => console.log('Listening on :3000'));
 * ```
 */
export async function createHttpApp(config: HttpTransportConfig): Promise<express.Application> {
  const app = express();

  // -------------------------------------------------------------------------
  // Global middleware
  // -------------------------------------------------------------------------

  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  // CORS: expose Mcp-Session-Id so browser-based clients can read it
  app.use(
    cors({
      origin: '*',
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
  // OAuth 2.1 router (SDK-managed endpoints)
  // -------------------------------------------------------------------------

  // Install all standard OAuth endpoints at the application root:
  //   GET  /.well-known/oauth-authorization-server
  //   GET  /.well-known/oauth-protected-resource/<path>
  //   POST /register
  //   GET  /authorize   → calls provider.authorize() (serves login page)
  //   POST /token
  //   POST /revoke
  app.use(
    authRateLimiter,
    mcpAuthRouter({
      provider,
      issuerUrl: config.mcpServerUrl,
      scopesSupported: ['mcp:tools'],
      resourceName: 'Nevent MCP Server',
    })
  );

  // -------------------------------------------------------------------------
  // POST /authorize — custom handler for HTML form submission
  // -------------------------------------------------------------------------

  /**
   * The SDK's `GET /authorize` handler calls `provider.authorize()` which
   * serves the login HTML. When the user submits the form, the browser POSTs
   * to `/authorize`. The SDK does NOT handle this POST natively for the
   * "login page served by provider" pattern, so we handle it here.
   */
  app.post('/authorize', authRateLimiter, async (req: Request, res: Response): Promise<void> => {
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

  app.post('/mcp', mcpRateLimiter, bearerAuth, async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    try {
      // Reuse existing session transport
      if (sessionId && activeSessions[sessionId]) {
        await activeSessions[sessionId].handleRequest(req, res, req.body);
        return;
      }

      // New initialization request — must not have a session ID
      if (!sessionId && isInitializeRequest(req.body)) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId: string) => {
            console.error(`[nevent-mcp] Session initialized: ${newSessionId}`);
            activeSessions[newSessionId] = transport;
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

        // Create a fresh MCP server for this session and connect it
        const mcpServer = createNeventServer(config.dataClient);
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

  app.get('/mcp', mcpRateLimiter, bearerAuth, async (req: Request, res: Response): Promise<void> => {
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
      await activeSessions[sessionId].handleRequest(req, res);
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

  app.delete('/mcp', bearerAuth, async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!sessionId || !activeSessions[sessionId]) {
      res.status(400).send('Invalid or missing Mcp-Session-Id header');
      return;
    }

    console.error(`[nevent-mcp] Session termination requested: ${sessionId}`);

    try {
      await activeSessions[sessionId].handleRequest(req, res);
    } catch (err) {
      console.error('[nevent-mcp] Error handling DELETE /mcp:', err);
      if (!res.headersSent) {
        res.status(500).send('Error processing session termination');
      }
    }
  });

  // -------------------------------------------------------------------------
  // GET /health — Health check (no auth required)
  // -------------------------------------------------------------------------

  /**
   * Health check endpoint. Returns 200 with a JSON body when the server is
   * running. Useful for AWS ELB/ALB health checks and container orchestration
   * liveness probes.
   */
  app.get('/health', (_req: Request, res: Response): void => {
    res.json({
      status: 'ok',
      service: 'nevent-mcp',
      transport: 'http',
      activeSessions: Object.keys(activeSessions).length,
      timestamp: new Date().toISOString(),
    });
  });

  // -------------------------------------------------------------------------
  // Graceful shutdown
  // -------------------------------------------------------------------------

  const shutdown = async (): Promise<void> => {
    console.error('[nevent-mcp] Shutting down HTTP transport...');
    const sessionIds = Object.keys(activeSessions);
    await Promise.allSettled(
      sessionIds.map(async (sid) => {
        try {
          await activeSessions[sid].close();
          delete activeSessions[sid];
        } catch (err) {
          console.error(`[nevent-mcp] Error closing session ${sid}:`, err);
        }
      })
    );
    await stores.mongoClient.close();
    console.error('[nevent-mcp] HTTP transport shutdown complete');
  };

  process.on('SIGTERM', () => void shutdown().then(() => process.exit(0)));
  process.on('SIGINT', () => void shutdown().then(() => process.exit(0)));

  return app;
}
