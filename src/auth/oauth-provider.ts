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
 * ## Login — existing users only
 *
 * Registration is NOT supported via the MCP flow. Users must already have a
 * Nevent account. If a login attempt fails because the user doesn't exist,
 * the authorize endpoint shows a message directing them to admin.nevent.es.
 *
 * ## Credential validation
 *
 * Credentials are validated by calling `POST /auth/admin/login` on nev-api.
 * If nev-api returns a 401, the login fails. If it returns a userId / sub,
 * that identifier is embedded in the issued tokens.
 *
 * @module auth/oauth-provider
 */

import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
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
  userId: string;
}

/**
 * Validates a user's email + password against the Nevent API.
 *
 * Calls `POST /auth/admin/login` on nev-api and expects a 200 with a `userId`
 * (or `sub`) field. Returns `null` if the credentials are invalid.
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
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json() as Record<string, unknown>;
    // Support both `userId` and `sub` response field names
    const userId = (data['userId'] ?? data['sub'] ?? data['id']) as string | undefined;
    if (!userId) return null;

    return { userId };
  } catch (err) {
    console.error('[nevent-mcp] Error calling Nevent auth API:', err);
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
  // authorize() — Serves the login page (GET) or validates credentials (POST)
  // -------------------------------------------------------------------------

  /**
   * Handles the OAuth authorization endpoint.
   *
   * The SDK calls this method for BOTH the initial `GET /authorize` (to start
   * the login UI) and the `POST /authorize` form submission (to validate
   * credentials). We distinguish the two cases by checking `params` for a
   * `_credentials` field that the login form appends via a hidden field trick.
   *
   * Actually: the SDK calls `authorize()` only for `GET /authorize` and expects
   * us to redirect or serve HTML. For `POST /authorize` we add an extra Express
   * route outside the SDK that validates credentials, stores the code, and
   * redirects — that route is wired in `http.ts`.
   *
   * For `GET /authorize`, we simply render the login form; actual credential
   * validation happens in the POST handler in `http.ts`.
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
    // Serve the Nevent login page. Credential validation is handled by the
    // POST /authorize route wired in http.ts which calls handleLoginPost().
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
   * This method is NOT part of the `OAuthServerProvider` interface; it is
   * called directly by the `POST /authorize` Express route defined in
   * `http.ts`.
   *
   * Flow:
   * 1. Extract email + password from `req.body`.
   * 2. Validate against Nevent API.
   * 3. If invalid → re-render login page with error message.
   * 4. If valid → store auth code in MongoDB → redirect to `redirect_uri`.
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
      // Determine if we should show "user not found" vs "invalid password"
      // We can't distinguish reliably (security best practice), so show generic error.
      // However, we add a register callout to help new users.
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
   * @param _client          - The requesting client (unused — code uniquely
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
   * Steps:
   * 1. Look up code document in MongoDB.
   * 2. Verify client matches.
   * 3. Consume (delete) the code (single-use).
   * 4. Generate JWT access token.
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
    const codeDoc = await this.stores.authCodes.find(authorizationCode);

    if (!codeDoc) {
      throw new Error('Invalid or expired authorization code');
    }

    if (codeDoc.clientId !== client.client_id) {
      throw new Error('Authorization code was not issued to this client');
    }

    // Single-use: consume the code
    await this.stores.authCodes.consume(authorizationCode);

    const scopes = codeDoc.scopes;
    const resourceUrl = resource ?? (codeDoc.resource ? new URL(codeDoc.resource) : undefined);

    // Generate JWT access token
    const { accessToken, expiresAt, expiresIn } = this.tokenService.generateAccessToken({
      userId: codeDoc.userId,
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
      resource: resourceUrl?.toString(),
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
   * @param client       - The OAuth client performing the exchange.
   * @param refreshToken - The refresh token to exchange.
   * @param scopes       - Optional scope downgrade (must be subset of original).
   * @param resource     - Optional RFC 8707 resource indicator.
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

    // Consume old refresh token (token rotation)
    await this.stores.refreshTokens.consume(refreshToken);

    const grantedScopes = scopes ?? refreshDoc.scopes;
    const resourceUrl = resource ?? (refreshDoc.resource ? new URL(refreshDoc.resource) : undefined);

    // Issue new access token
    const { accessToken, expiresAt, expiresIn } = this.tokenService.generateAccessToken({
      userId: refreshDoc.userId,
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
      resource: resourceUrl?.toString(),
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
    const claims = this.tokenService.verifyAccessToken(token);

    return {
      token,
      clientId: claims.clientId,
      scopes: claims.scopes,
      expiresAt: claims.exp,
      ...(claims.aud && { resource: new URL(claims.aud) }),
    };
  }

  // -------------------------------------------------------------------------
  // revokeToken() — Token revocation (RFC 7009)
  // -------------------------------------------------------------------------

  /**
   * Revokes an access or refresh token.
   *
   * For access tokens: marks as revoked in `oauth_access_tokens`.
   * For refresh tokens: deletes from `oauth_refresh_tokens`.
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
    } else if (token_type_hint === 'access_token') {
      await this.stores.accessTokens.revoke(token);
    } else {
      // Try both (hint is optional per RFC 7009)
      await Promise.allSettled([
        this.stores.refreshTokens.consume(token),
        this.stores.accessTokens.revoke(token),
      ]);
    }

    console.error(`[nevent-mcp] Token revoked | hint=${token_type_hint ?? 'unknown'}`);
  }
}
