/**
 * SessionClients — aggregates the per-session API clients and owns token state.
 *
 * In HTTP mode each MCP session has one `SessionClients` instance, holding
 * a `DataClient` (for nev-data-api) and a `PaidMediaClient` (for nev-api paid
 * media endpoints). Both clients share the same bearer JWT; when the token is
 * rotated (e.g. during `nevent_switch_tenant`) both must be updated atomically.
 *
 * Additionally, `SessionClients` stores the `refreshToken` captured during
 * login / initial OAuth exchange and implements a `refreshAccessToken()` helper
 * that can be registered as an `onUnauthorized` callback inside both clients.
 *
 * ## Tenant reset
 *
 * `homeTenantId` is captured once at session creation from the JWT initial
 * claims. The `nevent_reset_tenant` tool uses this value to switch back to the
 * home tenant after a cross-tenant operation.
 *
 * ## Cache invalidation
 *
 * Any time the JWT is rotated (i.e. the tenant context changes), cached data
 * from the previous tenant must be discarded. `rotateJwt` calls
 * `dataClient.clearAllCaches()` automatically.
 *
 * @module clients/session-clients
 */

import { DataClient } from './data-client.js';
import { PaidMediaClient } from './paid-media-client.js';
import { TIMEOUTS } from '../config/timeouts.js';

// ---------------------------------------------------------------------------
// JWT helpers
// ---------------------------------------------------------------------------

/**
 * Decode a JWT payload (without signature verification) and extract the
 * `tenantId` claim. Returns `undefined` if decoding fails or claim is absent.
 *
 * We never verify the signature here because we already trust the token
 * (it was just issued by our own nev-api). Signature verification happens at
 * the transport layer.
 *
 * @param token - Raw JWT string.
 */
function decodeJwtTenantId(token: string): string | undefined {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return undefined;
    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8')
    ) as Record<string, unknown>;
    return (payload['tenantId'] ?? payload['activeTenantId']) as string | undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// SessionClients
// ---------------------------------------------------------------------------

/**
 * Aggregate holder for the two per-session API clients.
 *
 * Both `dataClient` and `paidMediaClient` are exposed as public fields so
 * callers can use them directly. Use `rotateJwt` / `rotateTokens` to update
 * the bearer token in both clients atomically.
 */
export class SessionClients {
  /** Client for nev-data-api (analytics, segmentation). */
  readonly dataClient: DataClient;

  /** Client for nev-api paid media endpoints. */
  readonly paidMediaClient: PaidMediaClient;

  /**
   * The tenant ID from the JWT at session creation time.
   * Used by `nevent_reset_tenant` to restore the original tenant context.
   */
  readonly homeTenantId: string | undefined;

  /**
   * Base URL of nev-api — required to call the token refresh endpoint.
   * Set during construction; never mutated.
   */
  private readonly neventApiUrl: string;

  /**
   * The refresh token captured during tenant switch or initial login.
   * `undefined` when no refresh token has been received yet (stdio mode or
   * older login sessions that pre-date refresh token support).
   */
  private refreshToken: string | undefined;

  /**
   * Construct a new `SessionClients` instance.
   *
   * @param dataClient      - Pre-configured client for nev-data-api.
   * @param paidMediaClient - Pre-configured client for nev-api paid media.
   * @param neventApiUrl    - Base URL of nev-api, used for token refresh calls.
   * @param homeTenantId    - Tenant ID from the initial JWT claims.
   * @param refreshToken    - Optional refresh token captured at session start.
   */
  constructor(
    dataClient: DataClient,
    paidMediaClient: PaidMediaClient,
    neventApiUrl: string,
    homeTenantId?: string,
    refreshToken?: string
  ) {
    this.dataClient = dataClient;
    this.paidMediaClient = paidMediaClient;
    this.neventApiUrl = neventApiUrl;
    this.homeTenantId = homeTenantId;
    this.refreshToken = refreshToken;
  }

  // -------------------------------------------------------------------------
  // Token rotation
  // -------------------------------------------------------------------------

  /**
   * Update the bearer JWT in both clients atomically and invalidate caches.
   *
   * Call this whenever a new access token is obtained (tenant switch, refresh).
   * After rotation, any tenant-specific cached data from the previous JWT
   * context is discarded via `dataClient.clearAllCaches()`.
   *
   * @param newAccessToken - The new bearer JWT to apply to both clients.
   */
  rotateJwt(newAccessToken: string): void {
    (this.dataClient as unknown as { jwtToken: string }).jwtToken = newAccessToken;
    (this.paidMediaClient as unknown as { jwtToken: string }).jwtToken = newAccessToken;
    // Invalidate cached data that was scoped to the previous tenant
    this.dataClient.clearAllCaches();
    // Update activeTenantId to reflect the new JWT's tenant claim
    const newTenantId = decodeJwtTenantId(newAccessToken);
    if (newTenantId !== undefined) {
      this.dataClient.activeTenantId = newTenantId;
    }
  }

  /**
   * Update both the access token and the refresh token.
   *
   * @param newAccessToken  - The new bearer JWT.
   * @param newRefreshToken - The new refresh token (may be the same value on
   *                          some providers that issue long-lived refresh tokens).
   */
  rotateTokens(newAccessToken: string, newRefreshToken: string): void {
    this.rotateJwt(newAccessToken);
    this.refreshToken = newRefreshToken;
  }

  // -------------------------------------------------------------------------
  // Refresh token support
  // -------------------------------------------------------------------------

  /**
   * Attempt to exchange the stored refresh token for a new access token.
   *
   * Called automatically by `BaseClient.request()` on a 401 response when
   * this method has been registered as `onUnauthorized`. Returns the new
   * access token string on success, or `null` on failure (expired refresh
   * token, network error, no refresh token stored).
   *
   * @returns New access token on success, `null` on failure.
   */
  async refreshAccessToken(): Promise<string | null> {
    if (!this.refreshToken) {
      return null;
    }

    try {
      const response = await fetch(`${this.neventApiUrl}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: this.refreshToken }),
        signal: AbortSignal.timeout(TIMEOUTS.AUTH_MS),
      });

      if (!response.ok) {
        console.error(
          `[nevent-mcp] Token refresh failed: HTTP ${response.status}`
        );
        return null;
      }

      const data = (await response.json()) as Record<string, unknown>;
      const newAccessToken = (data['access_token'] ?? data['accessToken']) as
        | string
        | undefined;
      const newRefreshToken = (data['refresh_token'] ?? data['refreshToken']) as
        | string
        | undefined;

      if (!newAccessToken) {
        console.error('[nevent-mcp] Token refresh: no access_token in response');
        return null;
      }

      // Persist both tokens
      this.rotateTokens(newAccessToken, newRefreshToken ?? this.refreshToken);

      console.error('[nevent-mcp] Token refreshed successfully');
      return newAccessToken;
    } catch (err) {
      console.error('[nevent-mcp] Token refresh error:', err);
      return null;
    }
  }
}
