/**
 * JWT Token Service for Nevent MCP OAuth 2.1
 *
 * Handles generation and verification of JWT-based access tokens and refresh
 * tokens issued by the MCP OAuth server.
 *
 * ## Token design
 *
 * - **Access tokens**: HS256-signed JWTs, 1-hour expiry.
 *   Payload: `{ sub, clientId, scopes, aud?, type: 'access' }`.
 * - **Refresh tokens**: Opaque random UUIDs stored in MongoDB. Not JWTs.
 *   This avoids exposing refresh-token metadata in the token itself and makes
 *   revocation trivially reliable.
 *
 * The signing key comes from `MCP_JWT_SECRET` environment variable. In
 * production this should be injected from AWS Secrets Manager at startup.
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
  /** Subject — Nevent user identifier. */
  sub: string;
  /** OAuth client ID that obtained the token. */
  clientId: string;
  /** Granted scopes. */
  scopes: string[];
  /** RFC 8707 resource indicator URI (optional). */
  aud?: string;
  /** Token type discriminator. */
  type: 'access';
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
 * @example
 * ```ts
 * const svc = new TokenService(process.env.MCP_JWT_SECRET!);
 * const { accessToken, expiresAt } = svc.generateAccessToken({
 *   userId: 'user_123',
 *   clientId: 'client_abc',
 *   scopes: ['mcp:tools'],
 * });
 * const claims = svc.verifyAccessToken(accessToken);
 * ```
 */
export class TokenService {
  private readonly secret: string;

  /** Access token lifetime in seconds. */
  static readonly ACCESS_TOKEN_TTL_SECONDS = 3600; // 1 hour

  /**
   * @param jwtSecret - HS256 signing key from `MCP_JWT_SECRET`.
   *   Must be at least 32 characters long in production.
   */
  constructor(jwtSecret: string) {
    this.secret = jwtSecret;
  }

  // -------------------------------------------------------------------------
  // Access token
  // -------------------------------------------------------------------------

  /**
   * Signs and returns a new HS256 JWT access token.
   *
   * @param params.userId   - Nevent user identifier (becomes JWT `sub`).
   * @param params.clientId - OAuth client ID.
   * @param params.scopes   - List of granted scopes.
   * @param params.resource - Optional RFC 8707 resource indicator URL.
   * @returns Signed JWT string plus expiry metadata.
   */
  generateAccessToken(params: {
    userId: string;
    clientId: string;
    scopes: string[];
    resource?: URL;
  }): GeneratedAccessToken {
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + TokenService.ACCESS_TOKEN_TTL_SECONDS;

    const payload: Omit<AccessTokenClaims, 'exp' | 'iat'> = {
      sub: params.userId,
      clientId: params.clientId,
      scopes: params.scopes,
      type: 'access',
      ...(params.resource && { aud: params.resource.toString() }),
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
   * @param token - The raw JWT string from the `Authorization: Bearer` header.
   * @returns Decoded `AccessTokenClaims`.
   * @throws `JsonWebTokenError` or `TokenExpiredError` if the token is invalid.
   */
  verifyAccessToken(token: string): AccessTokenClaims {
    const decoded = jwt.verify(token, this.secret, {
      algorithms: ['HS256'],
    }) as AccessTokenClaims;

    if (decoded.type !== 'access') {
      throw new Error('Invalid token type — expected access token');
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
