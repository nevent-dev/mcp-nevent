/**
 * JWT Token Service for Nevent MCP OAuth 2.1
 *
 * Handles generation and verification of JWT-based access tokens and refresh
 * tokens issued by the MCP OAuth server.
 *
 * ## Token design — aligned with nev-api conventions
 *
 * - **Access tokens**: HS256-signed JWTs, 1-hour expiry.
 *   Payload: `{ sub, email, role, tenantId, clientId, scopes, aud?, type: 'access_token', iss: 'https://nevent.es' }`.
 *   The `iss`, `type`, `sub`, `email`, `role`, and `tenantId` claims mirror
 *   nev-api's `TokenUtils.java` so that nev-api's `CustomAuthenticationFilter`
 *   can validate these tokens. The `type` value `mcp_access_token` is a new
 *   discriminator that distinguishes MCP tokens from regular `access_token`
 *   and `refresh_token` types used internally by nev-api.
 *
 * - **Refresh tokens**: Opaque random UUIDs stored in MongoDB. Not JWTs.
 *   This avoids exposing refresh-token metadata in the token itself and makes
 *   revocation trivially reliable (hard delete from MongoDB).
 *
 * ## Secret sharing with nev-api
 *
 * The JWT is signed with `MCP_JWT_SECRET`. For nev-api to be able to validate
 * MCP access tokens, this secret must equal nev-api's `jwt.secret.key`
 * application property. In production, both services should read this value
 * from the same AWS Secrets Manager entry.
 *
 * @module auth/token-service
 */

import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Claims embedded in every MCP access token JWT. */
export interface AccessTokenClaims {
  /** Subject — Nevent user identifier. Aligns with nev-api sub claim. */
  sub: string;
  /** User email. Aligns with nev-api email claim. */
  email: string;
  /** User role (e.g. ADMIN, SUPERADMIN). Aligns with nev-api role claim. */
  role: string;
  /** Tenant ID. Aligns with nev-api tenantId claim. */
  tenantId: string;
  /** OAuth client ID that obtained the token. */
  clientId: string;
  /** Granted scopes. */
  scopes: string[];
  /** RFC 8707 resource indicator URI (optional). */
  aud?: string;
  /**
   * Token type discriminator.
   * Value `mcp_access_token` distinguishes from nev-api's `access_token` and
   * `refresh_token` types. nev-api's `CustomAuthenticationFilter` checks
   * this field when validating tokens.
   */
  type: 'access_token';
  /**
   * Issuer. Must be `https://nevent.es` to match nev-api's expected issuer
   * in `CustomAuthenticationFilter`.
   */
  iss: string;
  /** Expiry (unix seconds) — standard JWT claim. */
  exp: number;
  /** Issued-at (unix seconds) — standard JWT claim. */
  iat: number;
}

/** Result returned when generating a new access token. */
export interface GeneratedAccessToken {
  /** The signed JWT string. */
  accessToken: string;
  /** Unix-second timestamp when the token expires. */
  expiresAt: number;
  /** Lifetime in seconds (always 3600). */
  expiresIn: number;
}

/** Result returned when generating a new refresh token. */
export interface GeneratedRefreshToken {
  /** Opaque random UUID (stored in MongoDB). */
  refreshToken: string;
}

// ---------------------------------------------------------------------------
// TokenService
// ---------------------------------------------------------------------------

/**
 * Stateless service for creating and verifying MCP OAuth JWT access tokens.
 *
 * Token claims are aligned with nev-api's `TokenUtils.java` conventions so
 * that the same JWT secret can be shared between the MCP server and nev-api,
 * enabling nev-api's `CustomAuthenticationFilter` to validate MCP tokens.
 *
 * @example
 * ```ts
 * const svc = new TokenService(process.env.MCP_JWT_SECRET!);
 * const { accessToken, expiresAt } = svc.generateAccessToken({
 *   userId: 'user_123',
 *   email: 'user@example.com',
 *   role: 'ADMIN',
 *   tenantId: 'tenant_abc',
 *   clientId: 'client_abc',
 *   scopes: ['mcp:tools'],
 * });
 * const claims = svc.verifyAccessToken(accessToken);
 * ```
 */
export class TokenService {
  private readonly secret: string;

  /** Access token lifetime in seconds. */
  static readonly ACCESS_TOKEN_TTL_SECONDS = 86400; // 24 hours

  /**
   * JWT issuer — must match nev-api's expected issuer in
   * `CustomAuthenticationFilter` (`https://nevent.es`).
   */
  static readonly ISSUER = 'https://nevent.es';

  /**
   * @param jwtSecret - HS256 signing key from `MCP_JWT_SECRET`.
   *   Must be at least 32 characters long in production.
   *   Should equal nev-api's `jwt.secret.key` for cross-service validation.
   */
  constructor(jwtSecret: string) {
    this.secret = jwtSecret;
  }

  // -------------------------------------------------------------------------
  // Access token
  // -------------------------------------------------------------------------

  /**
   * Signs and returns a new HS256 JWT access token with nev-api-compatible claims.
   *
   * @param params.userId   - Nevent user identifier (becomes JWT `sub`).
   * @param params.email    - User email address (becomes JWT `email` claim).
   * @param params.role     - User role from nev-api (becomes JWT `role` claim).
   * @param params.tenantId - Tenant ID from nev-api (becomes JWT `tenantId` claim).
   * @param params.clientId - OAuth client ID.
   * @param params.scopes   - List of granted scopes.
   * @param params.resource - Optional RFC 8707 resource indicator URL.
   * @returns Signed JWT string plus expiry metadata.
   */
  generateAccessToken(params: {
    userId: string;
    email: string;
    role: string;
    tenantId: string;
    clientId: string;
    scopes: string[];
    resource?: URL;
  }): GeneratedAccessToken {
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + TokenService.ACCESS_TOKEN_TTL_SECONDS;

    const payload: Omit<AccessTokenClaims, 'exp' | 'iat'> = {
      sub: params.userId,
      email: params.email,
      role: params.role,
      tenantId: params.tenantId,
      clientId: params.clientId,
      scopes: params.scopes,
      type: 'access_token',
      iss: TokenService.ISSUER,
      // NOTE: `aud` intentionally omitted. The SDK passes `resource` as a
      // URL object which always includes a trailing slash (e.g. "https://mcp.nevent.ai/").
      // Claude.ai compares this against the server URL without trailing slash and
      // rejects the token on mismatch. Since the MCP server validates tokens via
      // its own JWT secret (not via `aud`), omitting `aud` is safe and fixes
      // Claude.ai compatibility.
    };

    const accessToken = jwt.sign(payload, this.secret, {
      expiresIn: TokenService.ACCESS_TOKEN_TTL_SECONDS,
      algorithm: 'HS256',
    });

    return { accessToken, expiresAt, expiresIn: TokenService.ACCESS_TOKEN_TTL_SECONDS };
  }

  /**
   * Verifies and decodes an HS256 JWT access token.
   *
   * Validates that the token was signed with the correct secret and that
   * the `type` claim is `mcp_access_token`.
   *
   * @param token - The raw JWT string from the `Authorization: Bearer` header.
   * @returns Decoded `AccessTokenClaims`.
   * @throws `JsonWebTokenError` or `TokenExpiredError` if the token is invalid.
   */
  verifyAccessToken(token: string): AccessTokenClaims {
    const decoded = jwt.verify(token, this.secret, {
      algorithms: ['HS256'],
    }) as AccessTokenClaims;

    if (decoded.type !== 'access_token') {
      throw new Error('Invalid token type — expected access_token');
    }

    return decoded;
  }

  // -------------------------------------------------------------------------
  // Refresh token
  // -------------------------------------------------------------------------

  /**
   * Generates an opaque refresh token (UUID-v4). The value is stored in
   * MongoDB by the caller; this method only provides the random string.
   *
   * @returns A `GeneratedRefreshToken` with an opaque `refreshToken` string.
   */
  generateRefreshToken(): GeneratedRefreshToken {
    return { refreshToken: randomUUID() };
  }
}
