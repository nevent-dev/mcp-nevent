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
 *   - Only tools that pass the per-session predicate
 *     (`isToolAllowedForSession()`, bound with `createBearerToolFilter()`) are
 *     registered (`toolFilter` on `createNeventServer`): READ tools minus a
 *     short exclusion list (the tenant discovery/switching tools, since a bearer-passthrough client always
 *     operates in the tenant its own JWT carries). Excluded/WRITE/DELETE
 *     tools are absent from `tools/list`, not merely denied at call time.
 *     With `writesMode: 'human'` (NEV-1854) a HUMAN session additionally gets
 *     the closed write allowlist; SERVICE sessions never do.
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
 * chatting, never a mix-and-match of caller and token.
 *
 * Because the listener may be reachable from outside (no private network is
 * assumed), a JWT alone is not enough: every request must also present a
 * pre-shared service key in `X-Nevent-Service-Key` (`src/auth/service-key.ts`),
 * checked BEFORE the token is introspected and compared in constant time.
 * Request pipeline: per-IP cap → service key → bearer header present →
 * per-token cap → `/auth/me` introspection (positive cache, short negative
 * cache) → session/principal binding. Do not point the public OAuth hostname
 * (`mcp.nevent.ai`) at a process started in this mode.
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
import { createNeventServer } from '../server.js';
import { DataClient } from '../clients/data-client.js';
import { PaidMediaClient } from '../clients/paid-media-client.js';
import { SessionClients } from '../clients/session-clients.js';
import { WriteRateLimiter, DEFAULT_WRITES_PER_HOUR } from '../tools/write-rate-limit.js';
import { createBearerToolFilter, type BearerWritesMode } from '../config/bearer-passthrough.js';
import { OPERATION_MODE } from '../config/operation-mode.js';
import { logger } from '../logger.js';
import { PKG_VERSION, getCommitSha } from './http.js';
import { createHash } from 'node:crypto';
import {
  verifySession,
  resolveScopeTenantId,
  unverifiedTokenExpiryMs,
  SessionVerificationError,
  type PrincipalType,
  type VerifiedSession,
} from '../auth/session-verifier.js';
import { extractBearerToken } from '../auth/bearer.js';
import { SERVICE_KEY_HEADER, isValidServiceKey, parseServiceKeys } from '../auth/service-key.js';

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
   * Pre-shared service key(s) every request must present in the
   * `X-Nevent-Service-Key` header: the current key first, optionally the
   * previous one (rotation). REQUIRED — `createBearerPassthroughApp` throws
   * when empty or when a key is shorter than the minimum. See
   * `src/auth/service-key.ts`.
   */
  serviceKeys: readonly string[];
  /**
   * Max requests per minute per bearer token (default 300). Exposed so tests
   * can exercise the limiter without sending hundreds of requests.
   */
  tokenRateLimitPerMinute?: number;
  /**
   * Comma-separated list of allowed CORS origins. When unset (the normal
   * case: the caller is a server, not a browser) CORS is disabled and no
   * `Access-Control-Allow-Origin` header is emitted. A literal `*` entry is
   * ignored. CORS is not an authentication control either way.
   */
  allowedOrigins?: string;
  /**
   * Write policy (NEV-1854). `off` (default): every session is READ-only.
   * `human`: HUMAN sessions also get the write allowlist; SERVICE stays
   * READ-only. See `src/config/bearer-passthrough.ts`.
   */
  writesMode?: BearerWritesMode;
  /**
   * Max write operations per principal (tenant + user) per hour when
   * `writesMode` is `human`. Default `DEFAULT_WRITES_PER_HOUR`. READ is never
   * limited.
   */
  writesPerHour?: number;
}

/** Result of `createBearerPassthroughApp()` — app plus a shutdown function. */
export interface BearerPassthroughAppResult {
  /** Configured Express application. */
  app: express.Application;
  /** Graceful shutdown function — closes all active sessions. */
  shutdown: () => Promise<void>;
  /** Number of live MCP sessions (diagnostics/tests; `/health` no longer reports it). */
  activeSessionCount: () => number;
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
  // Fail-closed at construction: a bearer-passthrough app without a valid
  // service key must not exist (it would be open to anyone holding a JWT).
  const serviceKeys = parseServiceKeys(config.serviceKeys);
  const writesMode: BearerWritesMode = config.writesMode ?? 'off';
  // One limiter for the whole app: the budget survives new MCP sessions.
  const writeLimiter = new WriteRateLimiter(config.writesPerHour ?? DEFAULT_WRITES_PER_HOUR);

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

  // Minimal liveness probe (load balancer / orchestrator). Deliberately
  // unauthenticated but reveals nothing about tools, sessions or mode.
  app.get('/health', (_req: Request, res: Response): void => {
    res.json({ status: 'ok', version: PKG_VERSION, commitSha: getCommitSha() });
  });

  /**
   * Global cap per client IP, applied to EVERY request first (including
   * those that will fail the service-key check), so a single address cannot
   * brute-force the key or flood the server.
   */
  const ipRateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 600,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Rate limit exceeded. Please slow down your requests.' },
    validate: { trustProxy: false, xForwardedForHeader: false },
  });

  /**
   * Service-key gate. Missing or wrong key → `401` with NO detail (same body
   * as any other auth failure, so it does not reveal which check failed), and
   * no outbound call to nev-api is made.
   */
  function requireServiceKey(req: Request, res: Response, next: () => void): void {
    if (!isValidServiceKey(req.headers[SERVICE_KEY_HEADER], serviceKeys)) {
      res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unauthorized.' },
        id: null,
      });
      return;
    }
    next();
  }

  // Anonymous traffic is stopped here, BEFORE any body parsing: per-IP cap,
  // then the service key. Only callers holding the key reach express.json().
  app.use(ipRateLimiter, requireServiceKey);

  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  // The caller is a server (no browser), so CORS is OFF unless an explicit
  // allowlist is configured: without MCP_ALLOWED_ORIGINS no
  // Access-Control-Allow-Origin header is ever emitted. Never `*`.
  const allowedOriginList = (config.allowedOrigins ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0 && o !== '*');
  if (allowedOriginList.length > 0) {
    app.use(
      cors({
        origin: allowedOriginList,
        exposedHeaders: ['Mcp-Session-Id'],
        allowedHeaders: ['Content-Type', 'Authorization', 'Mcp-Session-Id', 'Last-Event-ID', 'X-Nevent-Service-Key'],
      })
    );
  }

  /**
   * Per-token cap. Runs after the service-key gate, so its buckets are only
   * ever created by callers that hold the key. Keyed by a hash of the bearer
   * (never the raw token): one chatty end user cannot starve the others, which
   * they would if everyone behind the bot shared a single IP bucket.
   */
  const tokenRateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: config.tokenRateLimitPerMinute ?? 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Rate limit exceeded. Please slow down your requests.' },
    keyGenerator: (req: Request): string =>
      createHash('sha256')
        .update(String(req.headers['authorization'] ?? ''))
        .digest('hex'),
    validate: { trustProxy: false, xForwardedForHeader: false, keyGeneratorIpFallback: false },
  });

  // ---------------------------------------------------------------------------
  // Session registry
  // ---------------------------------------------------------------------------

  /**
   * One entry per MCP session. Besides the transport it records the
   * principal the session was opened for, so every later request can be
   * checked against it (see `bindRequestToSession`).
   */
  interface BearerSession {
    transport: StreamableHTTPServerTransport;
    createdAt: Date;
    /** nev-api user id (human, or the technical user of a service account). */
    userId: string;
    principalType: PrincipalType;
    /** Tenant the session is locked to (`resolveScopeTenantId` at initialize). */
    tenantId: string;
    /** The bearer currently applied to the session's clients. */
    token: string;
    sessionClients: SessionClients;
    dataClient: DataClient;
  }
  const activeSessions = new Map<string, BearerSession>();

  /**
   * Requires a well-formed `Authorization: Bearer <token>` header. Does NOT
   * verify the token — that is `verifyIntrospectedSession()`'s job, which
   * always runs immediately after this middleware. Responds 401 (matching
   * the shape the MCP SDK's `requireBearerAuth` uses) when absent or
   * malformed.
   */
  function requireBearerHeader(req: Request, res: Response, next: () => void): void {
    const bearerToken = extractBearerToken(req.headers['authorization']);
    if (bearerToken === undefined) {
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
    res.locals['bearerToken'] = bearerToken;
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
    const token = res.locals['bearerToken'] as string;
    try {
      res.locals['verifiedSession'] = await verifySession(token, config.neventApiUrl);
      next();
    } catch (err) {
      const message = err instanceof SessionVerificationError ? err.message : 'Session verification failed';
      const unavailable = err instanceof SessionVerificationError && err.kind === 'unavailable';
      logger.warn({ err: message, unavailable }, 'bearer-passthrough request rejected — session verification failed');
      if (unavailable) {
        // nev-api could not be asked (5xx / timeout / network). Still
        // fail-closed — nothing is exposed — but a healthy caller should
        // retry later rather than re-authenticate.
        res.status(503).json({
          jsonrpc: '2.0',
          error: { code: -32002, message: 'Session verification temporarily unavailable. Retry shortly.' },
          id: null,
        });
        return;
      }
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

  /**
   * Binds every request that names an existing `Mcp-Session-Id` to the
   * principal that opened that session. Runs right after
   * `verifyIntrospectedSession`, so the identity it compares is the one
   * nev-api just confirmed for THIS request's token (never the JWT payload).
   *
   * - Different user id, principal type or effective tenant than the session
   *   was opened with → `403`, nothing is dispatched. A valid token for
   *   someone else (or for another tenant) can therefore never drive a
   *   session it does not own, even if it learned the session id.
   * - Same principal and tenant presenting a different token (e.g. a service
   *   session re-minted after its 30 min expiry, or a refreshed human token)
   *   → the new token replaces the one held by the session's clients
   *   (`SessionClients.rotateJwt`), so downstream calls use the live token
   *   instead of the one captured at `initialize`. "Same principal" is the
   *   user id, not the service session id: a re-minted service session has a
   *   new session id by design.
   *
   * Requests without a session id, or with an unknown one, pass through
   * untouched (initialize / the existing 400 paths).
   */
  function bindRequestToSession(req: Request, res: Response, next: () => void): void {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const session = sessionId ? activeSessions.get(sessionId) : undefined;
    if (!session) {
      next();
      return;
    }

    const verified = res.locals['verifiedSession'] as VerifiedSession | undefined;
    const token = res.locals['bearerToken'] as string;
    const scopeTenant = verified ? resolveScopeTenantId(verified) : undefined;

    if (
      !verified ||
      verified.userId !== session.userId ||
      verified.principalType !== session.principalType ||
      scopeTenant !== session.tenantId
    ) {
      logger.warn(
        { sessionId, sessionUserId: session.userId, sessionTenantId: session.tenantId ?? 'unknown' },
        'bearer-passthrough request rejected — token does not belong to the principal/tenant that opened the session'
      );
      res.status(403).json({
        jsonrpc: '2.0',
        error: {
          code: -32003,
          message: 'This MCP session belongs to a different user or tenant. Open a new session with your own token.',
        },
        id: null,
      });
      return;
    }

    if (token !== session.token) {
      // Rotate only to a token that outlives the one the session holds: an
      // older (but still valid) token of the same principal must not roll the
      // session back to a credential that expires sooner.
      const newExp = unverifiedTokenExpiryMs(token);
      const currentExp = unverifiedTokenExpiryMs(session.token);
      if (newExp !== undefined && (currentExp === undefined || newExp > currentExp)) {
        // The tenant is pinned to the verified one: a rotation can never
        // move the session to whatever tenant the new token's claims name.
        session.sessionClients.rotateJwt(token, session.tenantId);
        session.token = token;
        logger.info({ sessionId, userId: session.userId }, 'bearer-passthrough session token rotated');
      }
    }
    next();
  }

  app.post('/', requireBearerHeader, tokenRateLimiter, verifyIntrospectedSession, bindRequestToSession, async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    try {
      // Everything below depends on the identity nev-api confirmed for THIS
      // request's token. The middleware chain guarantees both values exist;
      // checking them here keeps session creation explicitly conditional on
      // verified state rather than on anything in the request body.
      const verified = res.locals['verifiedSession'] as VerifiedSession | undefined;
      const bearerToken = res.locals['bearerToken'] as string | undefined;
      if (!verified || !bearerToken) {
        res.status(401).json({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Invalid, expired, or unverifiable session. Re-authenticate with nev-api and retry.' },
          id: null,
        });
        return;
      }

      // A request naming a session continues that session (already bound to
      // this principal by `bindRequestToSession`) or is refused.
      if (sessionId !== undefined) {
        const existing = activeSessions.get(sessionId);
        if (!existing) {
          res.status(400).json({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
            id: null,
          });
          return;
        }
        await existing.transport.handleRequest(req, res, req.body);
        return;
      }

      // No session id: the only acceptable request is `initialize`.
      if (!isInitializeRequest(req.body)) {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
          id: null,
        });
        return;
      }

      {
        // `verifyIntrospectedSession` already confirmed this exact token
        // against nev-api /auth/me for this request and stored the verdict:
        // that response — never the unverified JWT payload — is the authority
        // for WHO the caller is and WHICH tenant the session is locked to
        // (`effectiveTenantId`). `parseVerifiedSession` guarantees a tenant is
        // present, so there is no fallback to JWT claims. The token itself is
        // never logged.
        const tenantId = resolveScopeTenantId(verified) as string;

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

        logger.info(
          {
            userId: verified.userId,
            principalType: verified.principalType,
            tenantId: tenantId ?? 'unknown',
            mode: OPERATION_MODE,
          },
          'bearer-passthrough session starting'
        );

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId: string) => {
            logger.info({ sessionId: newSessionId }, 'bearer-passthrough session initialized');
            activeSessions.set(newSessionId, {
              transport,
              createdAt: new Date(),
              userId: verified.userId,
              principalType: verified.principalType,
              // Compared against nev-api's answer on every later request.
              tenantId,
              token: bearerToken,
              sessionClients,
              dataClient,
            });
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && activeSessions.has(sid)) {
            logger.info({ sessionId: sid }, 'bearer-passthrough session closed');
            activeSessions.delete(sid);
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
          // Per-session policy from the principal verified against /auth/me:
          // READ tools (+ the HUMAN write allowlist when enabled), minus the
          // always-denied tools — see src/config/bearer-passthrough.ts.
          toolFilter: createBearerToolFilter(verified.principalType, writesMode),
          // Audit: principal kind + verified tenant on every logged call.
          principalLog: { principalType: verified.principalType, effectiveTenantId: tenantId },
          // Hourly write budget per tenant+user, only when writes are on.
          ...(writesMode === 'human'
            ? { writeRateLimit: { limiter: writeLimiter, key: `${tenantId}:${verified.userId}` } }
            : {}),
        });
        await mcpServer.connect(transport);

        await transport.handleRequest(req, res, req.body);
      }
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

  app.get('/', requireBearerHeader, tokenRateLimiter, verifyIntrospectedSession, bindRequestToSession, async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !activeSessions.has(sessionId)) {
      res.status(400).send('Invalid or missing Mcp-Session-Id header');
      return;
    }
    try {
      await activeSessions.get(sessionId)!.transport.handleRequest(req, res);
    } catch (err) {
      logger.error({ err }, 'Error handling GET / (bearer-passthrough)');
      if (!res.headersSent) {
        res.status(500).send('Internal server error');
      }
    }
  });

  app.delete('/', requireBearerHeader, tokenRateLimiter, verifyIntrospectedSession, bindRequestToSession, async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !activeSessions.has(sessionId)) {
      res.status(400).send('Invalid or missing Mcp-Session-Id header');
      return;
    }
    try {
      await activeSessions.get(sessionId)!.transport.handleRequest(req, res);
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

  // Clean JSON errors for failures raised by middleware (notably malformed
  // JSON bodies) instead of Express's default HTML handler, which would also
  // leak a stack trace outside production.
  app.use((err: unknown, _req: Request, res: Response, next: (e?: unknown) => void): void => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const type = (err as { type?: string } | null)?.type;
    if (type === 'entity.parse.failed') {
      res.status(400).json({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error: invalid JSON body.' }, id: null });
      return;
    }
    if (type === 'entity.too.large') {
      res.status(413).json({ jsonrpc: '2.0', error: { code: -32600, message: 'Request body too large.' }, id: null });
      return;
    }
    logger.error({ err }, 'Unhandled error in bearer-passthrough app');
    res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
  });

  const SESSION_MAX_AGE_MS = 30 * 60 * 1000;
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    const orphaned = [...activeSessions.entries()].filter(
      ([, { createdAt }]) => now - createdAt.getTime() > SESSION_MAX_AGE_MS
    );
    for (const [sid] of orphaned) {
      logger.info({ sessionId: sid }, 'Cleaning up orphaned bearer-passthrough session');
      activeSessions.get(sid)!.transport.close().catch(() => {
        // Ignore errors during cleanup — session may already be closed
      });
      activeSessions.delete(sid);
    }
  }, SESSION_MAX_AGE_MS);
  cleanupInterval.unref();

  const shutdown = async (): Promise<void> => {
    logger.info('Shutting down bearer-passthrough HTTP transport...');
    clearInterval(cleanupInterval);
    const sessionIds = [...activeSessions.keys()];
    await Promise.allSettled(
      sessionIds.map(async (sid) => {
        try {
          await activeSessions.get(sid)!.transport.close();
          activeSessions.delete(sid);
        } catch (err) {
          logger.error({ err, sessionId: sid }, 'Error closing session during shutdown');
        }
      })
    );
    logger.info('bearer-passthrough HTTP transport shutdown complete');
  };

  return { app, activeSessionCount: () => activeSessions.size, shutdown };
}
