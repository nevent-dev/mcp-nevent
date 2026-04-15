/**
 * Nevent MCP OAuth 2.1 Server Provider
 *
 * Implements the `OAuthServerProvider` interface from `@modelcontextprotocol/sdk`
 * to power the Nevent MCP Server's built-in OAuth authorization server.
 *
 * ## Authentication flow
 *
 * 1. MCP client discovers `/.well-known/oauth-authorization-server`.
 * 2. Client performs Dynamic Client Registration (`POST /register`).
 * 3. Client redirects user to `GET /authorize` — the SDK router invokes
 *    `provider.authorize()` which serves the Nevent login page.
 * 4. User POSTs credentials to `/authorize`. On success, credentials are
 *    validated against the Nevent API (`POST /auth/admin/login`). An
 *    authorization code is issued and the user is redirected back.
 * 5. Client exchanges code for tokens at `POST /token`. The SDK router
 *    validates PKCE then calls `provider.exchangeAuthorizationCode()`.
 * 6. Client uses Bearer token to access MCP endpoints. The SDK middleware
 *    calls `provider.verifyAccessToken()` on each request.
 *
 * ## Credential validation — aligned with nev-api
 *
 * Credentials are validated by calling `POST /auth/admin/login` on nev-api.
 * The nev-api response contains an `access_token` JWT that carries user
 * metadata (userId, email, role, tenantId). These claims are decoded and
 * embedded into the MCP access token, aligning the token format with
 * nev-api's `CustomAuthenticationFilter` expectations.
 *
 * ## Token revocation
 *
 * Access tokens are stateless JWTs with a 1-hour expiry. Immediate revocation
 * of access tokens is not supported — the 1-hour window is an accepted
 * trade-off. Only refresh tokens are stored in MongoDB and can be immediately
 * revoked. When an access token revocation is requested, a warning is logged.
 *
 * @module auth/oauth-provider
 */

import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthStores,
  AuthCodeDocument,
  RefreshTokenDocument,
} from './oauth-stores.js';
import { TokenService } from './token-service.js';
import { renderLoginPage } from './login-page.js';

// ---------------------------------------------------------------------------
// Nevent API credential validator
// ---------------------------------------------------------------------------

/** Result of a successful Nevent credential validation. */
interface NeventAuthResult {
  /** Nevent user ID (sub claim from nev-api JWT). */
  userId: string;
  /** User email address. */
  email: string;
  /** User role (e.g. ADMIN, SUPERADMIN). */
  role: string;
  /** Tenant ID. */
  tenantId: string;
  /**
   * The raw nev-api access_token returned by POST /auth/admin/login.
   * This token is valid for calling data.nevent.es (nev-data-api) on behalf
   * of the authenticated user. Stored so each MCP session can use the user's
   * own token instead of a shared service account token.
   */
  neventAccessToken: string;
}

/**
 * Validates a user's email + password against the Nevent API.
 *
 * Calls `POST /auth/admin/login` on nev-api and, on success, decodes the
 * returned `access_token` JWT to extract user metadata (userId, email, role,
 * tenantId). These values are later embedded in the MCP access token.
 *
 * A 10-second timeout is applied to the fetch call to prevent hanging on
 * nev-api availability issues.
 *
 * @param neventApiUrl - Base URL of nev-api, e.g. `https://api.nevent.es`.
 * @param email        - User's email address.
 * @param password     - User's plaintext password.
 * @returns `NeventAuthResult` on success, or `null` on failure.
 */
async function validateNeventCredentials(
  neventApiUrl: string,
  email: string,
  password: string
): Promise<NeventAuthResult | null> {
  try {
    const response = await fetch(`${neventApiUrl}/auth/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json() as Record<string, unknown>;

    // nev-api returns { loggedIn, access_token, ... }
    // The access_token is a JWT containing sub, email, role, tenantId claims.
    const accessTokenStr = data['access_token'] as string | undefined;
    if (!accessTokenStr) return null;

    // Decode (without verification) to extract user claims.
    // We trust the token because we just received it directly from nev-api
    // over an authenticated request — no need to verify the signature here.
    const decoded = jwt.decode(accessTokenStr) as Record<string, unknown> | null;
    if (!decoded) return null;

    const userId = (decoded['sub'] ?? data['userId'] ?? data['id']) as string | undefined;
    const userEmail = decoded['email'] as string | undefined;
    const userRole = decoded['role'] as string | undefined;
    const userTenantId = (decoded['tenantId'] ?? decoded['activeTenantId']) as string | undefined;

    if (!userId) return null;

    return {
      userId,
      email: userEmail ?? email,       // Fall back to form email if claim missing
      role: userRole ?? 'ADMIN',        // Default to ADMIN (login endpoint is /admin/login)
      tenantId: userTenantId ?? '',
      neventAccessToken: accessTokenStr,
    };
  } catch (err) {
    // AbortError is thrown by AbortSignal.timeout — treat as transient failure
    if (err instanceof Error && err.name === 'AbortError') {
      console.error('[nevent-mcp] Timeout calling Nevent auth API (10s)');
    } else {
      console.error('[nevent-mcp] Error calling Nevent auth API:', err);
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// NeventOAuthProvider
// ---------------------------------------------------------------------------

/** Configuration options for `NeventOAuthProvider`. */
export interface NeventOAuthProviderOptions {
  /** All MongoDB-backed OAuth stores. */
  stores: OAuthStores;
  /** JWT signing service. */
  tokenService: TokenService;
  /** Base URL of nev-api for credential validation. */
  neventApiUrl: string;
  /** Base URL of the MCP server (used in resource indicators). */
  mcpServerUrl: URL;
}

/**
 * Nevent MCP OAuth 2.1 provider.
 *
 * Implements `OAuthServerProvider` from `@modelcontextprotocol/sdk`. The SDK's
 * `mcpAuthRouter` installs all standard OAuth endpoints (`/register`,
 * `/authorize`, `/token`, `/revoke`) and delegates to this provider for
 * business logic.
 *
 * @example
 * ```ts
 * const provider = new NeventOAuthProvider({
 *   stores,
 *   tokenService: new TokenService(process.env.MCP_JWT_SECRET!),
 *   neventApiUrl: 'https://api.nevent.es',
 *   mcpServerUrl: new URL('https://mcp.nevent.es'),
 * });
 * app.use(mcpAuthRouter({ provider, issuerUrl: mcpServerUrl, scopesSupported: ['mcp:tools'] }));
 * ```
 */
export class NeventOAuthProvider implements OAuthServerProvider {
  private readonly stores: OAuthStores;
  private readonly tokenService: TokenService;
  private readonly neventApiUrl: string;
  readonly mcpServerUrl: URL;

  /** Exposed so the SDK router can use it for DCR. */
  readonly clientsStore: OAuthRegisteredClientsStore;

  constructor(options: NeventOAuthProviderOptions) {
    this.stores = options.stores;
    this.tokenService = options.tokenService;
    this.neventApiUrl = options.neventApiUrl;
    this.mcpServerUrl = options.mcpServerUrl;
    this.clientsStore = options.stores.clients;
  }

  // -------------------------------------------------------------------------
  // authorize() — Serves the login page (GET)
  // -------------------------------------------------------------------------

  /**
   * Handles the OAuth authorization endpoint (GET /authorize).
   *
   * Serves the Nevent login HTML page. The SDK calls this for the initial
   * GET request. Credential validation happens in `handleLoginPost()` which
   * is wired to POST /authorize in `http.ts`.
   *
   * @param client - The registered OAuth client making the authorization request.
   * @param params - Standard OAuth authorization parameters (PKCE, scopes, etc.).
   * @param res    - Express `Response` to write the login page to.
   */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(
      renderLoginPage({
        clientId: client.client_id,
        redirectUri: params.redirectUri,
        responseType: 'code',
        codeChallenge: params.codeChallenge,
        codeChallengeMethod: 'S256',
        scope: params.scopes?.join(' ') ?? '',
        state: params.state ?? '',
        resource: params.resource?.toString() ?? '',
        clientName: client.client_name ?? undefined,
      })
    );
  }

  // -------------------------------------------------------------------------
  // handleLoginPost() — called by the POST /authorize route in http.ts
  // -------------------------------------------------------------------------

  /**
   * Validates user credentials submitted via the HTML login form and, if
   * successful, stores an authorization code and redirects the client.
   *
   * Security: `redirect_uri` is validated against the registered client's
   * `redirect_uris` list before issuing a code. This prevents open redirect
   * attacks where a malicious `redirect_uri` could be used to steal
   * authorization codes.
   *
   * This method is NOT part of the `OAuthServerProvider` interface; it is
   * called directly by the `POST /authorize` Express route defined in
   * `http.ts`.
   *
   * Flow:
   * 1. Validate `redirect_uri` is registered for the client.
   * 2. Extract email + password from `req.body`.
   * 3. Validate against Nevent API.
   * 4. If invalid → re-render login page with error message.
   * 5. If valid → store auth code in MongoDB → redirect to `redirect_uri`.
   *
   * @param formData - Parsed form body containing credentials and OAuth params.
   * @param res      - Express `Response` to redirect or serve error page.
   */
  async handleLoginPost(
    formData: {
      email: string;
      password: string;
      client_id: string;
      redirect_uri: string;
      response_type: string;
      code_challenge: string;
      code_challenge_method: string;
      scope?: string;
      state?: string;
      resource?: string;
    },
    res: Response
  ): Promise<void> {
    const {
      email,
      password,
      client_id,
      redirect_uri,
      code_challenge,
      code_challenge_method,
      scope,
      state,
      resource,
    } = formData;

    // ---- Open redirect prevention ----
    // Validate that redirect_uri is registered for this client before doing
    // anything else. A forged redirect_uri could be used to steal auth codes.
    const client = await this.stores.clients.getClient(client_id);
    if (!client) {
      res.status(400).send('Unknown client_id');
      return;
    }
    const allowedUris: string[] = client.redirect_uris ?? [];
    if (!allowedUris.includes(redirect_uri)) {
      res.status(400).send(
        'redirect_uri is not registered for this client. ' +
        'Ensure the redirect_uri matches one of the registered redirect URIs.'
      );
      return;
    }

    // Basic input validation
    if (!email || !password) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(
        renderLoginPage({
          clientId: client_id,
          redirectUri: redirect_uri,
          responseType: 'code',
          codeChallenge: code_challenge,
          codeChallengeMethod: code_challenge_method,
          scope,
          state,
          resource,
          errorMessage: 'Email and password are required.',
          clientName: client.client_name ?? undefined,
        })
      );
      return;
    }

    // Validate credentials against Nevent API
    const authResult = await validateNeventCredentials(
      this.neventApiUrl,
      email,
      password
    );

    if (!authResult) {
      // Use a generic error message — do not distinguish user-not-found from
      // wrong-password to avoid user enumeration (security best practice).
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(
        renderLoginPage({
          clientId: client_id,
          redirectUri: redirect_uri,
          responseType: 'code',
          codeChallenge: code_challenge,
          codeChallengeMethod: code_challenge_method,
          scope,
          state,
          resource,
          errorMessage: 'Invalid email or password. If you do not have a Nevent account, register below.',
          showRegisterPrompt: true,
          clientName: client.client_name ?? undefined,
        })
      );
      return;
    }

    // Issue authorization code
    const code = randomUUID();
    const codeDoc: AuthCodeDocument = {
      code,
      clientId: client_id,
      codeChallenge: code_challenge,
      redirectUri: redirect_uri,
      scopes: scope ? scope.split(' ').filter(Boolean) : ['mcp:tools'],
      state,
      resource,
      userId: authResult.userId,
      email: authResult.email,
      role: authResult.role,
      tenantId: authResult.tenantId,
      neventAccessToken: authResult.neventAccessToken,
      createdAt: new Date(),
    };

    await this.stores.authCodes.save(codeDoc);

    // Redirect to client's redirect_uri with code
    const redirectUrl = new URL(redirect_uri);
    redirectUrl.searchParams.set('code', code);
    if (state) redirectUrl.searchParams.set('state', state);

    res.redirect(redirectUrl.toString());
  }

  // -------------------------------------------------------------------------
  // challengeForAuthorizationCode() — PKCE support
  // -------------------------------------------------------------------------

  /**
   * Returns the `code_challenge` stored alongside the given authorization code.
   * The SDK uses this to verify the `code_verifier` during the token exchange.
   *
   * @param _client           - The requesting client (unused — code uniquely
   *   identifies the challenge).
   * @param authorizationCode - The authorization code string.
   * @throws If the code is not found or expired.
   */
  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    const codeDoc = await this.stores.authCodes.find(authorizationCode);
    if (!codeDoc) {
      throw new Error('Authorization code not found or expired');
    }
    return codeDoc.codeChallenge;
  }

  // -------------------------------------------------------------------------
  // exchangeAuthorizationCode() — Token endpoint
  // -------------------------------------------------------------------------

  /**
   * Exchanges an authorization code for access + refresh tokens.
   *
   * The SDK router validates the PKCE `code_verifier` before calling this
   * method, so we only need to perform business-level validation here.
   *
   * The access token is generated with nev-api-compatible claims: `sub`,
   * `email`, `role`, `tenantId`, and `type: 'mcp_access_token'` with
   * `iss: 'https://nevent.es'`.
   *
   * Steps:
   * 1. Look up code document in MongoDB.
   * 2. Verify client matches.
   * 3. Consume (delete) the code (single-use).
   * 4. Generate JWT access token with user claims.
   * 5. Generate and store opaque refresh token.
   * 6. Return `OAuthTokens`.
   *
   * @param client            - The OAuth client performing the exchange.
   * @param authorizationCode - The authorization code to exchange.
   * @param _codeVerifier     - PKCE verifier (already checked by the SDK).
   * @param _redirectUri      - Must match original redirect_uri (checked by SDK).
   * @param resource          - Optional RFC 8707 resource indicator.
   */
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    _redirectUri?: string,
    resource?: URL
  ): Promise<OAuthTokens> {
    console.error(`[nevent-mcp] Token exchange | client=${client.client_id} code=${authorizationCode.slice(0, 8)}... resource=${resource?.toString() ?? 'none'}`);
    const codeDoc = await this.stores.authCodes.find(authorizationCode);

    if (!codeDoc) {
      console.error(`[nevent-mcp] Token exchange FAILED | code not found or expired`);
      throw new Error('Invalid or expired authorization code');
    }

    if (codeDoc.clientId !== client.client_id) {
      throw new Error('Authorization code was not issued to this client');
    }

    // Single-use: consume the code
    await this.stores.authCodes.consume(authorizationCode);

    const scopes = codeDoc.scopes;
    const resourceUrl = resource ?? (codeDoc.resource ? new URL(codeDoc.resource) : undefined);

    // Generate JWT access token with nev-api-compatible claims
    const { accessToken, expiresAt, expiresIn } = this.tokenService.generateAccessToken({
      userId: codeDoc.userId,
      email: codeDoc.email,
      role: codeDoc.role,
      tenantId: codeDoc.tenantId,
      clientId: client.client_id,
      scopes,
      resource: resourceUrl,
    });

    // Generate and store refresh token
    const { refreshToken } = this.tokenService.generateRefreshToken();
    const refreshDoc: RefreshTokenDocument = {
      token: refreshToken,
      accessToken,
      clientId: client.client_id,
      scopes,
      userId: codeDoc.userId,
      email: codeDoc.email,
      role: codeDoc.role,
      tenantId: codeDoc.tenantId,
      resource: resourceUrl?.toString(),
      // Carry the user's nev-api access_token forward so HTTP sessions can
      // look it up by userId and create a per-user DataClient.
      neventAccessToken: codeDoc.neventAccessToken,
      createdAt: new Date(),
    };
    await this.stores.refreshTokens.save(refreshDoc);

    console.error(
      `[nevent-mcp] Token issued | userId=${codeDoc.userId} clientId=${client.client_id} ` +
      `scopes=${scopes.join(',')} expiresAt=${expiresAt}`
    );

    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: expiresIn,
      scope: scopes.join(' '),
      refresh_token: refreshToken,
    };
  }

  // -------------------------------------------------------------------------
  // exchangeRefreshToken() — Refresh token endpoint
  // -------------------------------------------------------------------------

  /**
   * Exchanges a refresh token for a new access token.
   *
   * Implements token rotation: the old refresh token is consumed and a new
   * one is issued alongside the new access token.
   *
   * Scope validation: if `scopes` is provided, it must be a subset of the
   * original grant's scopes. A client cannot request additional scopes via
   * a refresh token exchange.
   *
   * @param client       - The OAuth client performing the exchange.
   * @param refreshToken - The refresh token to exchange.
   * @param scopes       - Optional scope downgrade (must be subset of original).
   * @param resource     - Optional RFC 8707 resource indicator.
   * @throws If scopes are not a subset of the original grant's scopes.
   */
  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL
  ): Promise<OAuthTokens> {
    const refreshDoc = await this.stores.refreshTokens.find(refreshToken);

    if (!refreshDoc) {
      throw new Error('Invalid or expired refresh token');
    }

    if (refreshDoc.clientId !== client.client_id) {
      throw new Error('Refresh token was not issued to this client');
    }

    // Validate that the requested scopes are a subset of the original grant.
    // A client can only downgrade scopes, never upgrade them.
    if (scopes && scopes.length > 0) {
      const originalScopes = new Set(refreshDoc.scopes);
      const invalidScopes = scopes.filter((s) => !originalScopes.has(s));
      if (invalidScopes.length > 0) {
        throw new Error(
          `Requested scopes [${invalidScopes.join(', ')}] are not a subset of the ` +
          `original grant's scopes [${refreshDoc.scopes.join(', ')}]`
        );
      }
    }

    // Consume old refresh token (token rotation)
    await this.stores.refreshTokens.consume(refreshToken);

    const grantedScopes = scopes && scopes.length > 0 ? scopes : refreshDoc.scopes;
    const resourceUrl = resource ?? (refreshDoc.resource ? new URL(refreshDoc.resource) : undefined);

    // Issue new access token with nev-api-compatible claims
    const { accessToken, expiresAt, expiresIn } = this.tokenService.generateAccessToken({
      userId: refreshDoc.userId,
      email: refreshDoc.email,
      role: refreshDoc.role,
      tenantId: refreshDoc.tenantId,
      clientId: client.client_id,
      scopes: grantedScopes,
      resource: resourceUrl,
    });

    // Issue new refresh token (rotation)
    const { refreshToken: newRefreshToken } = this.tokenService.generateRefreshToken();
    const newRefreshDoc: RefreshTokenDocument = {
      token: newRefreshToken,
      accessToken,
      clientId: client.client_id,
      scopes: grantedScopes,
      userId: refreshDoc.userId,
      email: refreshDoc.email,
      role: refreshDoc.role,
      tenantId: refreshDoc.tenantId,
      resource: resourceUrl?.toString(),
      // Carry the nev-api access_token forward through refresh token rotation.
      neventAccessToken: refreshDoc.neventAccessToken,
      createdAt: new Date(),
    };
    await this.stores.refreshTokens.save(newRefreshDoc);

    console.error(
      `[nevent-mcp] Token refreshed | userId=${refreshDoc.userId} clientId=${client.client_id} ` +
      `scopes=${grantedScopes.join(',')} expiresAt=${expiresAt}`
    );

    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: expiresIn,
      scope: grantedScopes.join(' '),
      refresh_token: newRefreshToken,
    };
  }

  // -------------------------------------------------------------------------
  // verifyAccessToken() — Bearer token validation
  // -------------------------------------------------------------------------

  /**
   * Verifies a Bearer access token and returns `AuthInfo`.
   *
   * Called by the SDK's `requireBearerAuth` middleware on every MCP request.
   * Uses JWT verification (no database lookup needed for access tokens).
   *
   * @param token - The raw access token string from the `Authorization` header.
   * @returns `AuthInfo` with `clientId`, `scopes`, and `expiresAt`.
   * @throws If the token signature is invalid or the token has expired.
   */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    try {
      const claims = this.tokenService.verifyAccessToken(token);
      console.error(`[nevent-mcp] Token verified | sub=${claims.sub} role=${claims.role} tenant=${claims.tenantId}`);
      return {
        token,
        clientId: claims.clientId,
        scopes: claims.scopes,
        expiresAt: claims.exp,
        ...(claims.aud && { resource: new URL(claims.aud) }),
      };
    } catch (verifyErr) {
      console.error(`[nevent-mcp] Token verification FAILED |`, verifyErr);
      throw verifyErr;
    }
  }

  // -------------------------------------------------------------------------
  // getNeventAccessToken() — Lookup nev-api token by userId
  // -------------------------------------------------------------------------

  /**
   * Looks up the most recently stored nev-api access_token for a given userId.
   *
   * This is used by the HTTP transport to create per-session DataClients that
   * authenticate as the logged-in user rather than using a shared service
   * account token. The token is stored in the refresh token document, so it
   * persists across MCP sessions until the refresh token expires.
   *
   * Returns `undefined` when no refresh token is found for the user (e.g.
   * before the user has completed a full OAuth flow, or after token expiry).
   *
   * @param userId - The Nevent user identifier (JWT `sub` claim).
   * @returns The nev-api access_token string, or `undefined` if not found.
   */
  async getNeventAccessToken(userId: string): Promise<string | undefined> {
    return this.stores.refreshTokens.findNeventAccessTokenByUserId(userId);
  }

  // -------------------------------------------------------------------------
  // revokeToken() — Token revocation (RFC 7009)
  // -------------------------------------------------------------------------

  /**
   * Revokes a refresh or access token.
   *
   * ## Refresh tokens
   * Refresh tokens are stored in MongoDB and can be immediately and
   * permanently revoked by deleting the document.
   *
   * ## Access tokens (stateless JWTs)
   * Access tokens are stateless JWTs and cannot be immediately invalidated.
   * They will expire naturally after at most 1 hour. This is a deliberate
   * architectural decision (Option A — stateless JWTs) accepted because:
   *   - The 1-hour window is acceptable for interactive MCP usage.
   *   - Avoiding a token denylist reduces infrastructure complexity.
   *   - Revoking the associated refresh token prevents new access tokens
   *     from being issued, which is sufficient for most revocation scenarios.
   *
   * A warning is logged when access token revocation is requested so that
   * administrators are aware of the limitation.
   *
   * @param _client - The requesting client (verified by SDK before this call).
   * @param request - Revocation request with `token` and optional `token_type_hint`.
   */
  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest
  ): Promise<void> {
    const { token, token_type_hint } = request;

    if (token_type_hint === 'refresh_token') {
      await this.stores.refreshTokens.consume(token);
      console.error(`[nevent-mcp] Refresh token revoked`);
    } else if (token_type_hint === 'access_token') {
      // Access tokens are stateless JWTs — immediate revocation is not supported.
      // The token will expire naturally within 1 hour.
      console.error(
        '[nevent-mcp] WARNING: Access token revocation requested but stateless JWTs ' +
        'cannot be revoked before expiry. The token will expire in at most 1 hour. ' +
        'To prevent new access tokens from being issued, revoke the associated refresh token.'
      );
    } else {
      // Hint not provided — try to revoke as refresh token (most common case).
      // Log a warning for access tokens since we cannot immediately revoke them.
      await this.stores.refreshTokens.consume(token).catch(() => {
        // Not a refresh token — may be an access token
        console.error(
          '[nevent-mcp] WARNING: Token not found in refresh token store. ' +
          'If this was an access token, it cannot be immediately revoked (stateless JWT). ' +
          'It will expire in at most 1 hour.'
        );
      });
    }
  }
}
