/**
 * Bearer-passthrough HTTP transport for the Nevent MCP Server
 *
 * A second, deliberately minimal HTTP transport for trusted internal callers
 * that already hold a per-user nev-api JWT and simply want to forward it —
 * one MCP session per caller JWT, no OAuth dance, no shared credential.
 *
 * ## Why this exists
 *
 * `nev-helpbot` (the Chatwoot support bot) answers on behalf of whichever
 * promoter is chatting. It already receives that promoter's nev-api JWT from
 * `nev-api` and wants to call MCP tools scoped to that promoter's own tenant —
 * not a shared service-account tenant, and not by running the OAuth 2.1 login
 * flow itself (the bot IS the trusted party; the human already authenticated
 * with nev-api).
 *
 * `MCP_AUTH_MODE=bearer-passthrough` (selected in `index.ts`) mounts THIS
 * transport instead of `transports/http.ts`'s OAuth transport:
 *
 *   - The caller's JWT arrives as `Authorization: Bearer <jwt>` on every
 *     request. Before ANYTHING else happens with it — including exposing
 *     `tools/list` or allowing a single `tools/call` — it is checked against
 *     nev-api's `GET /auth/me` via `verifySession()`
 *     (`src/auth/session-verifier.ts`). A `200` confirms the session is
 *     live; `401`/`403`/a network error/a timeout are all treated the same:
 *     the MCP request is rejected with `401` and no tool, no `tools/list`,
 *     and no session is ever created or advanced from it. This check runs
 *     on EVERY request (`initialize`, `tools/list`, `tools/call`, ...), not
 *     only at session start, though a short-lived cache
 *     (`session-verifier.ts`, ~60s, bounded by the token's own `exp`) avoids
 *     calling nev-api on every single message within that window.
 *   - Once verified, the SAME token is used, still WITHOUT local signature
 *     verification, to build that session's `DataClient` / `PaidMediaClient`
 *     — exactly like `stdio` mode's `NEVENT_JWT_TOKEN`, except the token
 *     comes from the request instead of an env var, and a fresh session
 *     (and fresh clients) is created per caller instead of one shared token
 *     for the whole process. The signature itself is intentionally never
 *     checked locally — nev-api's session JWTs are HMAC256-signed with a
 *     symmetric secret (`jwt.secret.key`); shipping that secret to this
 *     server would let anyone who compromises it forge any user's session,
 *     which is why liveness is instead confirmed by asking nev-api directly
 *     (see `session-verifier.ts` module doc). nev-data-api and nev-api also
 *     continue to validate the token on every call they receive from this
 *     server, exactly as they do for stdio mode's shared token.
 *   - Only tools that pass `isToolAllowedInBearerPassthrough()` are
 *     registered (`toolFilter` on `createNeventServer`): READ tools minus a
 *     short exclusion list (PII-bearing `nevent_segment_execute`, and the
 *     tenant-switching tools, since a bearer-passthrough client always
 *     operates in the tenant its own JWT carries). Excluded/WRITE/DELETE
 *     tools are absent from `tools/list`, not merely denied at call time.
 *   - `MONGODB_URI` and `MCP_JWT_SECRET` are NOT required: there is no OAuth
 *     store and no locally-issued token to verify. `MONGODB_URI` remains
 *     OPTIONAL — when set, it additionally enables the Mongo-backed READ
 *     tools (`nevent_list_campaigns`, `nevent_get_campaign`,
 *     `nevent_get_campaign_insights`, `nevent_list_templates`,
 *     `nevent_get_template`, `nevent_get_sending_profile`,
 *     `nevent_get_suppressions_summary`) — these read MongoDB directly and
 *     scope every query by `DataClient.activeTenantId`, which is decoded from
 *     the SAME per-request JWT, so tenant isolation holds either way. Without
 *     `MONGODB_URI` those specific tools are simply not registered, same as
 *     in OAuth mode.
 *
 * ## Isolation
 *
 * Every MCP session gets its own `DataClient` / `PaidMediaClient` /
 * `SessionClients`, built fresh from that session's own `initialize` request.
 * Two sessions started with different JWTs never share a client instance,
 * cached data, or tenant context — the same per-session-instance property the
 * OAuth transport already relies on (see `src/tests/session-clients.test.ts`
 * and the isolation tests in `src/tests/bearer-passthrough.test.ts`).
 *
 * ## NOT exposed to the internet
 *
 * There is no OAuth challenge, no login page, no client registration, and no
 * LOCAL signature check on the forwarded token — every token is checked
 * against nev-api instead (see above), which rejects anything invalid,
 * expired, or revoked, but this server still trusts whoever holds the
 * connection to only ever forward tokens on behalf of the user actually
 * chatting, never a mix-and-match of caller and token. Confining WHO can
 * reach this port at all is therefore left entirely to the deployment: this
 * transport is meant to run on an internal network reachable only by
 * trusted callers (e.g. `nev-helpbot` calling a sidecar/internal listener on
 * the `chatwoot_default` Docker network, with no port published to the
 * host), never on the public internet. Do not point `MCP_SERVER_URL`/public
 * DNS such as `mcp.nevent.ai` at a process started with
 * `MCP_AUTH_MODE=bearer-passthrough`. No API key or internal-client header
 * is layered on top of this — network isolation is the only caller
 * confinement this mode has, by design.
 *
 * @module transports/http-bearer-passthrough
 */

import express, { type Request, type Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import rateLimit from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createNeventServer, getToolCount } from '../server.js';
import { DataClient } from '../clients/data-client.js';
import { PaidMediaClient } from '../clients/paid-media-client.js';
import { SessionClients } from '../clients/session-clients.js';
import { isToolAllowedInBearerPassthrough } from '../config/bearer-passthrough.js';
import { OPERATION_MODE } from '../config/operation-mode.js';
import { logger } from '../logger.js';
import { verifySession, SessionVerificationError } from '../auth/session-verifier.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Configuration for the bearer-passthrough HTTP transport. */
export interface BearerPassthroughConfig {
  /** TCP port to listen on. */
  port: number;
  /** nev-api base URL — used for tenant-scoped nev-api calls (paid media, segments, campaign actions, media). */
  neventApiUrl: string;
  /** Base URL of nev-data-api (data.nevent.es). */
  dataApiUrl: string;
  /**
   * OPTIONAL MongoDB connection URI. When provided, enables the Mongo-backed
   * READ tools (campaigns/templates/deliverability) in addition to the
   * nev-api / nev-data-api tools that are always available. Every query
   * against it is scoped by the caller's own JWT tenant — see module doc.
   */
  mongoUri?: string;
  /**
   * Comma-separated list of allowed CORS origins. Defaults to `*`
   * (acceptable here because this transport is not meant to be internet-
   * reachable — see module doc).
   */
  allowedOrigins?: string;
}

/** Result of `createBearerPassthroughApp()` — app plus a shutdown function. */
export interface BearerPassthroughAppResult {
  /** Configured Express application. */
  app: express.Application;
  /** Graceful shutdown function — closes all active sessions. */
  shutdown: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// JWT claim extraction (no signature verification — see module doc)
// ---------------------------------------------------------------------------

/**
 * Decodes a JWT payload without verifying its signature and extracts the
 * `sub` (user id) and `tenantId` claims used to build the session's clients.
 *
 * We never verify the signature here: this server does not own the signing
 * key for the forwarded token (it belongs to nev-api) and does not need to —
 * nev-data-api and nev-api validate the token themselves on every call. This
 * mirrors `decodeJwtTenantId` in `src/clients/session-clients.ts` (used for
 * the same purpose during `nevent_switch_tenant`) and the stdio transport's
 * own JWT decode in `src/index.ts`.
 *
 * @param token — Raw JWT string (without the `Bearer ` prefix).
 */
export function decodeJwtClaims(token: string): { sub?: string; tenantId?: string } {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return {};
    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8')
    ) as Record<string, unknown>;
    const sub = typeof payload['sub'] === 'string' ? payload['sub'] : undefined;
    const tenantIdClaim = payload['tenantId'] ?? payload['activeTenantId'];
    const tenantId = typeof tenantIdClaim === 'string' ? tenantIdClaim : undefined;
    return { sub, tenantId };
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// createBearerPassthroughApp()
// ---------------------------------------------------------------------------

/**
 * Creates and configures the Express application for `bearer-passthrough`
 * mode. See the module doc comment for the full design rationale.
 *
 * @param config — Bearer-passthrough transport configuration.
 */
export async function createBearerPassthroughApp(
  config: BearerPassthroughConfig
): Promise<BearerPassthroughAppResult> {
  const app = express();

  app.set('trust proxy', 1);

  app.use(
    helmet({
      // API-only transport (no login page, no HTML) — Helmet's secure
      // defaults are sufficient; no CSP relaxation is needed here.
      crossOriginEmbedderPolicy: false,
    })
  );

  app.use(
    pinoHttp({
      logger,
      customLogLevel: (_req: import('http').IncomingMessage, res: import('http').ServerResponse, err?: Error) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      customSuccessMessage: (req: import('http').IncomingMessage, res: import('http').ServerResponse) =>
        `${req.method ?? '-'} ${req.url ?? '-'} ${res.statusCode}`,
      customErrorMessage: (req: import('http').IncomingMessage, res: import('http').ServerResponse, err: Error) =>
        `${req.method ?? '-'} ${req.url ?? '-'} ${res.statusCode}: ${err.message}`,
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

  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  const corsOrigin: cors.CorsOptions['origin'] = config.allowedOrigins
    ? config.allowedOrigins.split(',').map((o) => o.trim()).filter(Boolean)
    : '*';

  app.use(
    cors({
      origin: corsOrigin,
      exposedHeaders: ['Mcp-Session-Id'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Mcp-Session-Id', 'Last-Event-ID'],
    })
  );

  const mcpRateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 600,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Rate limit exceeded. Please slow down your requests.' },
    validate: { trustProxy: false, xForwardedForHeader: false },
  });

  // ---------------------------------------------------------------------------
  // Session registry
  // ---------------------------------------------------------------------------

  const activeSessions: Record<string, {
    transport: StreamableHTTPServerTransport;
    createdAt: Date;
  }> = {};

  const toolsCount = getToolCount({
    hasNeventApiUrl: true,
    hasMongoUri: Boolean(config.mongoUri),
    hasPaidMediaClient: true,
    // ShortUrlClient is provided via SessionClients (see below) — its READ
    // tools (list/get short URLs and their metrics) go through the same
    // toolFilter as everything else.
    hasShortUrlClient: true,
    toolFilter: isToolAllowedInBearerPassthrough,
  });

  app.get('/health', (_req: Request, res: Response): void => {
    res.json({
      status: 'ok',
      service: 'nevent-mcp',
      transport: 'http',
      authMode: 'bearer-passthrough',
      mode: OPERATION_MODE,
      toolsCount,
      activeSessions: Object.keys(activeSessions).length,
      timestamp: new Date().toISOString(),
    });
  });

  /**
   * Requires a well-formed `Authorization: Bearer <token>` header. Does NOT
   * verify the token — that is `verifyIntrospectedSession()`'s job, which
   * always runs immediately after this middleware. Responds 401 (matching
   * the shape the MCP SDK's `requireBearerAuth` uses) when absent or
   * malformed.
   */
  function requireBearerHeader(req: Request, res: Response, next: () => void): void {
    const authHeader = req.headers['authorization'];
    const match = typeof authHeader === 'string' ? /^Bearer\s+(.+)$/i.exec(authHeader) : null;
    if (!match || !match[1]) {
      res.status(401).json({
        jsonrpc: '2.0',
        error: {
          code: -32001,
          message:
            'Authentication required. Provide the calling user\'s nev-api JWT as `Authorization: Bearer <jwt>`.',
        },
        id: null,
      });
      return;
    }
    next();
  }

  /**
   * Confirms the bearer token is currently accepted by nev-api
   * (`GET /auth/me`, via `verifySession()`) before letting the request reach
   * session dispatch. Runs on EVERY request — `initialize`, `tools/list`,
   * `tools/call`, session close — not only when a session is first created,
   * so a token that is later revoked or expires mid-session stops working
   * (bounded by the short verification cache TTL) rather than continuing to
   * work for up to 30 minutes on the strength of a check made at
   * `initialize` time.
   *
   * MUST run after `requireBearerHeader` (which guarantees a well-formed
   * `Bearer <token>` header is present). Fail-closed: any rejection —
   * `401`/`403` from nev-api, a network error, or a timeout — is answered
   * with `401` here and `next()` is never called, so no tool, no
   * `tools/list`, and no session progress ever results from an unverified
   * token.
   */
  async function verifyIntrospectedSession(req: Request, res: Response, next: () => void): Promise<void> {
    const authHeader = req.headers['authorization'] as string;
    const token = authHeader.replace(/^Bearer\s+/i, '');
    try {
      await verifySession(token, config.neventApiUrl);
      next();
    } catch (err) {
      const message = err instanceof SessionVerificationError ? err.message : 'Session verification failed';
      logger.warn({ err: message }, 'bearer-passthrough request rejected — session verification failed');
      res.status(401).json({
        jsonrpc: '2.0',
        error: {
          code: -32001,
          message: 'Invalid, expired, or unverifiable session. Re-authenticate with nev-api and retry.',
        },
        id: null,
      });
    }
  }

  app.post('/', mcpRateLimiter, requireBearerHeader, verifyIntrospectedSession, async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    try {
      if (sessionId && activeSessions[sessionId]) {
        await activeSessions[sessionId].transport.handleRequest(req, res, req.body);
        return;
      }

      if (!sessionId && isInitializeRequest(req.body)) {
        const authHeader = req.headers['authorization'] ?? '';
        const bearerToken = authHeader.replace(/^Bearer\s+/i, '');
        const { tenantId } = decodeJwtClaims(bearerToken);

        // Fresh clients for THIS session, built from THIS request's token.
        // No shared state with any other session — see module doc.
        const dataClient = new DataClient(
          { baseUrl: config.dataApiUrl, jwtToken: bearerToken },
          tenantId
        );
        const paidMediaClient = new PaidMediaClient({
          baseUrl: config.neventApiUrl,
          jwtToken: bearerToken,
        });
        const sessionClients = new SessionClients(
          dataClient,
          paidMediaClient,
          config.neventApiUrl,
          tenantId
        );

        // `verifyIntrospectedSession` middleware already confirmed this
        // exact token against nev-api /auth/me for this request (cache hit
        // here in the common case) — reuse that authoritative identity for
        // the "session starting" log line instead of the unverified JWT
        // `sub` claim. The token itself is never logged.
        const verified = await verifySession(bearerToken, config.neventApiUrl);

        logger.info(
          {
            userId: verified.userId,
            email: verified.email ?? 'unknown',
            tenantId: verified.tenantId ?? tenantId ?? 'unknown',
            mode: OPERATION_MODE,
          },
          'bearer-passthrough session starting'
        );

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId: string) => {
            logger.info({ sessionId: newSessionId }, 'bearer-passthrough session initialized');
            activeSessions[newSessionId] = { transport, createdAt: new Date() };
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && activeSessions[sid]) {
            logger.info({ sessionId: sid }, 'bearer-passthrough session closed');
            delete activeSessions[sid];
          }
        };

        const mcpServer = createNeventServer({
          dataClient,
          neventApiUrl: config.neventApiUrl,
          mongoUri: config.mongoUri,
          paidMediaClient,
          sessionClients,
          userId: verified.userId,
          getSessionId: () => transport.sessionId ?? null,
          // Only READ tools minus the PII/tenant-switching exclusions — see
          // src/config/bearer-passthrough.ts.
          toolFilter: isToolAllowedInBearerPassthrough,
        });
        await mcpServer.connect(transport);

        await transport.handleRequest(req, res, req.body);
        return;
      }

      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
        id: null,
      });
    } catch (err) {
      logger.error({ err }, 'Error handling POST / (bearer-passthrough)');
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  app.get('/', mcpRateLimiter, requireBearerHeader, verifyIntrospectedSession, async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !activeSessions[sessionId]) {
      res.status(400).send('Invalid or missing Mcp-Session-Id header');
      return;
    }
    try {
      await activeSessions[sessionId].transport.handleRequest(req, res);
    } catch (err) {
      logger.error({ err }, 'Error handling GET / (bearer-passthrough)');
      if (!res.headersSent) {
        res.status(500).send('Internal server error');
      }
    }
  });

  app.delete('/', mcpRateLimiter, requireBearerHeader, verifyIntrospectedSession, async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !activeSessions[sessionId]) {
      res.status(400).send('Invalid or missing Mcp-Session-Id header');
      return;
    }
    try {
      await activeSessions[sessionId].transport.handleRequest(req, res);
    } catch (err) {
      logger.error({ err }, 'Error handling DELETE / (bearer-passthrough)');
      if (!res.headersSent) {
        res.status(500).send('Error processing session termination');
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Orphaned session cleanup — same 30-minute TTL as the OAuth transport.
  // ---------------------------------------------------------------------------

  const SESSION_MAX_AGE_MS = 30 * 60 * 1000;
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    const orphaned = Object.entries(activeSessions).filter(
      ([, { createdAt }]) => now - createdAt.getTime() > SESSION_MAX_AGE_MS
    );
    for (const [sid] of orphaned) {
      logger.info({ sessionId: sid }, 'Cleaning up orphaned bearer-passthrough session');
      activeSessions[sid].transport.close().catch(() => {
        // Ignore errors during cleanup — session may already be closed
      });
      delete activeSessions[sid];
    }
  }, SESSION_MAX_AGE_MS);
  cleanupInterval.unref();

  const shutdown = async (): Promise<void> => {
    logger.info('Shutting down bearer-passthrough HTTP transport...');
    clearInterval(cleanupInterval);
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
    logger.info('bearer-passthrough HTTP transport shutdown complete');
  };

  return { app, shutdown };
}
