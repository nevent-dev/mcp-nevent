/**
 * JWT verification for `bearer-passthrough` HTTP auth mode, by introspection
 * against nev-api's `GET /auth/me`.
 *
 * ## Why introspection instead of local signature verification
 *
 * nev-api signs session JWTs with HMAC256 (`TokenUtils.getAlgorithm()`,
 * secret `jwt.secret.key`, issuer `https://nevent.es`) — a SYMMETRIC
 * algorithm. Verifying the signature locally would require shipping that
 * same secret to this server. Because the secret is symmetric, holding it
 * here would mean anyone who compromises this process could forge a session
 * for ANY Nevent user, not just read their data. That trade-off is rejected:
 * this module never receives, stores, or checks `jwt.secret.key`.
 *
 * Instead, every forwarded token is checked against nev-api itself via
 * `GET /auth/me` — an authenticated endpoint (see
 * `AuthMeRestController` / `PublicEndpointRules` in nev-api) that returns
 * `200` with the caller's identity when the token is valid and unexpired,
 * and `401` otherwise. This server never decides validity on its own; it
 * asks the system of record on every un-cached check.
 *
 * ## Fail-closed
 *
 * Anything other than a clean `200` — `401`, `403`, a 5xx, a network error,
 * or a timeout — is treated as "not verified". There is no fallback that
 * lets a request through when nev-api cannot be reached; see
 * `verifySession()`.
 *
 * ## Caching
 *
 * A successful verification is cached briefly (`CACHE_TTL_MS`) so that a
 * single MCP session does not call `/auth/me` on every `tools/list` /
 * `tools/call` request. The cache key is a SHA-256 hash of the token (never
 * the raw token, so it never appears in memory dumps or, if this module is
 * ever logged carelessly, in log output as a lookup key). Every cache read
 * additionally checks the token's own unverified `exp` claim: an entry is
 * NEVER served past the token's own expiry, no matter how recently it was
 * verified. `exp` is used only to bound cache lifetime, never as the
 * authority on validity — that authority is always nev-api's `200`/`401`.
 *
 * @module auth/session-verifier
 */

import { createHash } from 'node:crypto';
import { TIMEOUTS } from '../config/timeouts.js';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Identity confirmed by nev-api's `GET /auth/me` for a forwarded token.
 * Mirrors nev-api's `AuthMeResponse` (`AuthMeRestController.java`).
 */
export interface VerifiedSession {
  /** nev-api user id (`AuthMeResponse.id`). */
  userId: string;
  /** User email, when present on the response. */
  email?: string;
  /** User display name, when present on the response. */
  name?: string;
  /** Role assigned to the user (ADMIN, SUPERADMIN, OWNER, STAFF, USER, ...). */
  role?: string;
  /**
   * Tenant id nev-api reports for this user (`AuthMeResponse.tenantId`). For a
   * human this is the user's stored home tenant; do NOT use it to scope data
   * access — use {@link resolveScopeTenantId} instead.
   */
  tenantId?: string;
  /**
   * `HUMAN` (a person logged in) or `SERVICE` (technical service session
   * minted by `POST /auth/service-token` for unattended agents). Defaults to
   * `HUMAN` when nev-api predates `principalType` (older deployments).
   */
  principalType: PrincipalType;
  /**
   * Tenant the token actually acts in (`AuthMeResponse.effectiveTenantId`):
   * the session tenant for service sessions, the navigation tenant for
   * hierarchical admins (ADMIN/OWNER/STAFF with an `activeTenantId`).
   * Authoritative for tenant scoping when present.
   */
  effectiveTenantId?: string;
  /** Service session context, present only for `SERVICE` principals. */
  serviceSession?: VerifiedServiceSession;
}

/** Principal kinds reported by nev-api's `GET /auth/me`. */
export type PrincipalType = 'HUMAN' | 'SERVICE';

/** Subset of nev-api's `ServiceSessionView` this server cares about. */
export interface VerifiedServiceSession {
  sessionId?: string;
  /** `API` or `BROWSER`. */
  channel?: string;
  /** `TENANT` (bound to one tenant and descendants) or `PLATFORM`. */
  scope?: string;
  /** Tenant of the service session. */
  tenantId?: string;
}

/**
 * Returns the tenant that every tenant-scoped client of the MCP session must
 * be locked to: nev-api's `effectiveTenantId` when present (authoritative,
 * resolved server-side from the live token/session), otherwise the
 * `tenantId` it reported. `undefined` means nev-api gave no tenant at all.
 */
export function resolveScopeTenantId(session: VerifiedSession): string | undefined {
  return session.effectiveTenantId ?? session.tenantId;
}

/**
 * Thrown by `verifySession()` whenever the token could not be confirmed
 * valid — an explicit `401`/`403` from nev-api, a non-2xx/4xx status, a
 * network error, or a timeout. The transport MUST treat every case the same
 * way: refuse the request with `401` and expose nothing.
 */
export class SessionVerificationError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'SessionVerificationError';
  }
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/** How long a successful verification may be reused, at most. */
const CACHE_TTL_MS = 60_000;

/**
 * Shorter reuse window for `SERVICE` principals. Service credentials carry a
 * documented revocation guarantee (disable / revoke-sessions / tenant switch
 * stop the very next request at nev-api), so this server must not mask a
 * revocation for a full minute.
 */
const SERVICE_CACHE_TTL_MS = 10_000;

interface CacheEntry {
  session: VerifiedSession;
  /** Wall-clock time (ms) after which this entry must no longer be served. */
  expiresAtMs: number;
}

/** Keyed by SHA-256 hex digest of the token — never the raw token. */
const verificationCache = new Map<string, CacheEntry>();

/** Hashes a token for use as a cache key/log field. Never logs the raw token. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Best-effort, UNVERIFIED decode of a JWT's `exp` claim (seconds since
 * epoch), used ONLY to cap how long a cache entry may live. This is not a
 * security decision — nev-api's `200`/`401` response is what actually
 * decides validity — it just avoids serving a cached "valid" verdict past
 * the point where the token itself claims to expire.
 */
function decodeExpMs(token: string): number | undefined {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return undefined;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    const exp = payload['exp'];
    return typeof exp === 'number' ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/** Clears the verification cache. Exposed for tests only. */
export function _clearVerificationCacheForTests(): void {
  verificationCache.clear();
}

// ---------------------------------------------------------------------------
// /auth/me response parsing
// ---------------------------------------------------------------------------

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Builds a {@link VerifiedSession} from a `200` `/auth/me` body.
 *
 * Fail-closed rules (all throw {@link SessionVerificationError}):
 *  - `principalType` present but neither `HUMAN` nor `SERVICE` — an unknown
 *    kind of principal is never given tool access by default.
 *  - `SERVICE` without an `effectiveTenantId` — a service session always
 *    acts in exactly one tenant; without it the tenant lock cannot be
 *    established.
 *
 * `SERVICE` principals are accepted (both `TENANT` and `PLATFORM` scope):
 * every tool exposed here is READ-only and locked to the session tenant via
 * `effectiveTenantId`, tenant-discovery/switching tools are excluded, and
 * nev-api / nev-data-api re-validate the live service session on every
 * downstream call.
 */
function parseVerifiedSession(userId: string, body: Record<string, unknown>): VerifiedSession {
  const rawPrincipal = body['principalType'];
  let principalType: PrincipalType = 'HUMAN';
  if (rawPrincipal !== undefined && rawPrincipal !== null) {
    if (rawPrincipal !== 'HUMAN' && rawPrincipal !== 'SERVICE') {
      throw new SessionVerificationError('nev-api /auth/me returned an unknown principalType');
    }
    principalType = rawPrincipal;
  }

  const effectiveTenantId = str(body['effectiveTenantId']);
  if (principalType === 'SERVICE' && !effectiveTenantId) {
    throw new SessionVerificationError('nev-api /auth/me service session is missing "effectiveTenantId"');
  }

  const rawService = body['serviceSession'];
  let serviceSession: VerifiedServiceSession | undefined;
  if (principalType === 'SERVICE' && rawService && typeof rawService === 'object') {
    const svc = rawService as Record<string, unknown>;
    serviceSession = {
      sessionId: str(svc['sessionId']),
      channel: str(svc['channel']),
      scope: str(svc['scope']),
      tenantId: str(svc['tenantId']),
    };
  }

  return {
    userId,
    email: str(body['email']),
    name: str(body['name']),
    role: str(body['role']),
    tenantId: str(body['tenantId']),
    principalType,
    effectiveTenantId,
    serviceSession,
  };
}

// ---------------------------------------------------------------------------
// verifySession()
// ---------------------------------------------------------------------------

/**
 * Confirms that `token` is currently accepted by nev-api, by calling
 * `GET {neventApiUrl}/auth/me`.
 *
 * - `200` → resolves with the caller's identity (also cached briefly).
 * - Anything else (`401`, `403`, other status, network error, timeout) →
 *   rejects with `SessionVerificationError`. Callers MUST treat this as
 *   "refuse the request" — there is no degraded/permissive path.
 *
 * @param token — Raw JWT (without the `Bearer ` prefix).
 * @param neventApiUrl — nev-api base URL, e.g. `https://api.nevent.es`.
 */
export async function verifySession(token: string, neventApiUrl: string): Promise<VerifiedSession> {
  const tokenHash = hashToken(token);

  const cached = verificationCache.get(tokenHash);
  if (cached && cached.expiresAtMs > Date.now()) {
    return cached.session;
  }

  let response: Response;
  try {
    response = await fetch(`${neventApiUrl.replace(/\/$/, '')}/auth/me`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUTS.AUTH_MS),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Network error';
    logger.warn({ tokenHash: tokenHash.slice(0, 16), err: message }, 'auth/me verification failed (network/timeout)');
    throw new SessionVerificationError(`Failed to reach nev-api /auth/me: ${message}`, err);
  }

  if (!response.ok) {
    logger.warn(
      { tokenHash: tokenHash.slice(0, 16), status: response.status },
      'auth/me verification rejected'
    );
    // Any non-2xx (401 invalid/expired, 403, 5xx, ...) is fail-closed.
    throw new SessionVerificationError(`nev-api /auth/me returned ${response.status}`);
  }

  let body: Record<string, unknown>;
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid JSON';
    throw new SessionVerificationError(`Failed to parse nev-api /auth/me response: ${message}`, err);
  }

  const userId = typeof body['id'] === 'string' ? body['id'] : undefined;
  if (!userId) {
    throw new SessionVerificationError('nev-api /auth/me response is missing "id"');
  }

  const session = parseVerifiedSession(userId, body);

  logger.info(
    {
      userId: session.userId,
      principalType: session.principalType,
      tenantId: resolveScopeTenantId(session) ?? 'unknown',
      tokenHash: tokenHash.slice(0, 16),
    },
    'bearer-passthrough session verified via nev-api /auth/me'
  );

  const ttl = session.principalType === 'SERVICE' ? SERVICE_CACHE_TTL_MS : CACHE_TTL_MS;
  const expMs = decodeExpMs(token);
  const expiresAtMs = expMs !== undefined ? Math.min(Date.now() + ttl, expMs) : Date.now() + ttl;
  // Only cache when the token has not already reached its own exp — an
  // already-expired token must always re-check with nev-api (which will
  // legitimately 401 it) rather than be cached at all.
  if (expiresAtMs > Date.now()) {
    verificationCache.set(tokenHash, { session, expiresAtMs });
  }

  return session;
}
