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
  /** Tenant id nev-api resolved for this user, when present. */
  tenantId?: string;
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

  const session: VerifiedSession = {
    userId,
    email: typeof body['email'] === 'string' ? body['email'] : undefined,
    name: typeof body['name'] === 'string' ? body['name'] : undefined,
    role: typeof body['role'] === 'string' ? body['role'] : undefined,
    tenantId: typeof body['tenantId'] === 'string' ? body['tenantId'] : undefined,
  };

  logger.info(
    { userId: session.userId, tenantId: session.tenantId ?? 'unknown', tokenHash: tokenHash.slice(0, 16) },
    'bearer-passthrough session verified via nev-api /auth/me'
  );

  const expMs = decodeExpMs(token);
  const expiresAtMs = expMs !== undefined ? Math.min(Date.now() + CACHE_TTL_MS, expMs) : Date.now() + CACHE_TTL_MS;
  // Only cache when the token has not already reached its own exp — an
  // already-expired token must always re-check with nev-api (which will
  // legitimately 401 it) rather than be cached at all.
  if (expiresAtMs > Date.now()) {
    verificationCache.set(tokenHash, { session, expiresAtMs });
  }

  return session;
}
