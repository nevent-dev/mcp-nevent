/**
 * Base HTTP client with JWT authentication, error handling, and rate limit awareness.
 *
 * All nev-data-api and nev-api clients extend or compose this client.
 * It provides a typed `request()` method that handles:
 *  - Authorization header injection
 *  - JSON serialization / deserialization
 *  - Structured error mapping (Stripe-inspired format)
 *  - 429 rate-limit detection with retryAfter extraction
 *  - 401 / 403 guidance messages
 */

import type { QueryParamValue, HttpResponse } from '../types/common.js';
import type { NeventError } from '../types/common.js';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Constructor configuration for any API client built on BaseClient.
 */
export interface BaseClientConfig {
  /** Base URL without trailing slash, e.g. "https://data.nevent.es". */
  baseUrl: string;
  /** JWT Bearer token used for Authorization header. */
  jwtToken: string;
  /** Optional request timeout in milliseconds. Default: 30 000. */
  timeoutMs?: number;
  /**
   * Optional callback invoked when the server returns HTTP 401.
   * Should attempt to refresh the access token and return the new token
   * string, or `null` if refresh failed (expired, no refresh token, etc.).
   * When `null` is returned the original 401 error is propagated.
   */
  onUnauthorized?: () => Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

/**
 * Structured API error thrown by the base client.
 * Contains a fully-formed `NeventError` object suitable for serialization.
 */
export class NeventApiError extends Error {
  readonly neventError: NeventError;

  constructor(neventError: NeventError) {
    super(neventError.message);
    this.name = 'NeventApiError';
    this.neventError = neventError;
  }
}

// ---------------------------------------------------------------------------
// BaseClient implementation
// ---------------------------------------------------------------------------

/**
 * Shared HTTP client for Nevent API services.
 *
 * @example
 * ```ts
 * const client = new BaseClient({
 *   baseUrl: 'https://data.nevent.es',
 *   jwtToken: process.env.NEVENT_JWT_TOKEN!,
 * });
 * const data = await client.get<MyResponse>('/analytics/capabilities');
 * ```
 */
export class BaseClient {
  protected readonly baseUrl: string;
  protected jwtToken: string;
  protected readonly timeoutMs: number;
  private onUnauthorized?: () => Promise<string | null>;

  constructor(config: BaseClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.jwtToken = config.jwtToken;
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.onUnauthorized = config.onUnauthorized;
  }

  /**
   * Register (or replace) the callback that is invoked when the server
   * responds with HTTP 401.  Calling this after construction allows
   * `SessionClients` to wire the refresh callback without a circular
   * dependency — clients are constructed first, then the callback is
   * injected once the session holder exists.
   *
   * @param cb - Async function that attempts a token refresh and returns the
   *             new access token string, or `null` on failure.
   */
  setOnUnauthorized(cb: () => Promise<string | null>): void {
    this.onUnauthorized = cb;
  }

  /**
   * Update the JWT bearer token on this client.
   *
   * Prefer using `SessionClients.rotateJwt()` which keeps both clients in
   * sync. This public method is exposed so `SessionClients` can rotate the
   * token without resorting to `as unknown as` casts.
   *
   * @param token - The new JWT access token.
   */
  public rotateAccessToken(token: string): void {
    this.jwtToken = token;
  }

  /**
   * Get the current JWT token.
   *
   * Intended for internal use by `SessionClients` and tool handlers that need
   * to forward the bearer token to nev-api directly (e.g. for tools that use
   * `fetch()` rather than a typed client method).
   *
   * Prefer `rotateJwt()` / `rotateAccessToken()` for token updates. This
   * getter eliminates the need for `as unknown as { jwtToken: string }` casts
   * to access the otherwise-protected field.
   *
   * @returns The raw JWT string currently used for Authorization headers.
   * @internal
   */
  public getJwtToken(): string {
    return this.jwtToken;
  }

  // -------------------------------------------------------------------------
  // Core request method
  // -------------------------------------------------------------------------

  /**
   * Execute an HTTP request against the configured base URL.
   *
   * Automatically:
   * - Appends `Authorization: Bearer {token}` header
   * - Serializes `body` as JSON and sets Content-Type
   * - Deserializes the response as JSON when content-type indicates it
   * - Maps 4xx/5xx responses to typed `NeventApiError` throws
   *
   * @param method   — HTTP method (GET, POST, PUT, PATCH, DELETE)
   * @param path     — Absolute path starting with "/", e.g. "/analytics/query"
   * @param options  — Optional body and query parameters
   * @returns        Resolved `HttpResponse<T>` with typed `data`, `status`, `ok`
   * @throws         `NeventApiError` on any non-2xx response
   */
  async request<T>(
    method: string,
    path: string,
    options: {
      body?: unknown;
      params?: Record<string, QueryParamValue>;
      /** Skip the Authorization header (for public endpoints). */
      skipAuth?: boolean;
      /**
       * Internal flag — set to `true` on the retry after a successful token
       * refresh to prevent infinite 401 loops.
       * @internal
       */
      _isRetry?: boolean;
    } = {}
  ): Promise<HttpResponse<T>> {
    const url = this.buildUrl(path, options.params);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (!options.skipAuth) {
      headers['Authorization'] = `Bearer ${this.jwtToken}`;
    }

    const fetchOptions: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    };

    if (options.body !== undefined && method !== 'GET') {
      fetchOptions.body = JSON.stringify(options.body);
    }

    let response: Response;
    try {
      response = await fetch(url, fetchOptions);
    } catch (err) {
      // Network error or timeout
      const message = err instanceof Error ? err.message : 'Network error';
      throw new NeventApiError({
        type: 'api_error',
        message: `Failed to reach ${this.baseUrl}: ${message}`,
        code: 'network_error',
      });
    }

    // Parse body regardless of status — errors may include useful info
    const rawBody = await this.parseBody(response);

    // -------------------------------------------------------------------------
    // Auto-refresh on 401
    //
    // When the server returns 401 and an onUnauthorized callback is registered,
    // attempt a token refresh exactly once. A second 401 on the retry means
    // the refreshed token is also invalid — propagate the error without looping.
    // -------------------------------------------------------------------------
    if (response.status === 401 && this.onUnauthorized && !options._isRetry) {
      const newToken = await this.onUnauthorized();
      if (newToken) {
        this.jwtToken = newToken;
        return this.request<T>(method, path, { ...options, _isRetry: true });
      }
      // Refresh failed — fall through and throw the original 401 error
    }

    if (!response.ok) {
      throw this.buildApiError(response.status, rawBody, path);
    }

    return {
      data: rawBody as T,
      status: response.status,
      ok: true,
    };
  }

  // -------------------------------------------------------------------------
  // Convenience methods
  // -------------------------------------------------------------------------

  /**
   * Perform a GET request and return the response data.
   *
   * @param path   — Endpoint path, e.g. "/analytics/capabilities"
   * @param params — Optional query parameters
   */
  async get<T>(path: string, params?: Record<string, QueryParamValue>): Promise<T> {
    const response = await this.request<T>('GET', path, { params });
    return response.data;
  }

  /**
   * Perform an unauthenticated GET request (skips Authorization header).
   * Use for public endpoints that do not require a JWT token.
   */
  async getPublic<T>(path: string, params?: Record<string, QueryParamValue>): Promise<T> {
    const response = await this.request<T>('GET', path, { params, skipAuth: true });
    return response.data;
  }

  /**
   * Perform a POST request with a JSON body and return the response data.
   *
   * @param path — Endpoint path
   * @param body — Request payload (will be JSON-serialized)
   */
  async post<T>(path: string, body?: unknown): Promise<T> {
    const response = await this.request<T>('POST', path, { body });
    return response.data;
  }

  /**
   * Perform a POST request with both a JSON body and query parameters.
   * Used when an endpoint accepts body fields plus query params (e.g. ?dryRun=true).
   *
   * @param path   — Endpoint path
   * @param body   — Request payload (will be JSON-serialized)
   * @param params — Optional query parameters appended to the URL
   */
  async postWithParams<T>(
    path: string,
    body?: unknown,
    params?: Record<string, QueryParamValue>
  ): Promise<T> {
    const response = await this.request<T>('POST', path, { body, params });
    return response.data;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Build a fully-qualified URL from a path and optional query parameters.
   * Omits undefined/null values from the query string.
   */
  private buildUrl(path: string, params?: Record<string, QueryParamValue>): string {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) {
          url.searchParams.append(key, String(value));
        }
      }
    }
    return url.toString();
  }

  /**
   * Deserialize the response body.
   * Returns parsed JSON when content-type is application/json, otherwise raw text.
   */
  private async parseBody(response: Response): Promise<unknown> {
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      try {
        return await response.json() as unknown;
      } catch {
        return null;
      }
    }
    return await response.text();
  }

  /**
   * Map an HTTP error response to a typed `NeventApiError`.
   *
   * Provides developer-friendly guidance messages for common error codes:
   * - 401: Missing or expired JWT token
   * - 403: Insufficient permissions (e.g. ADMIN role required)
   * - 404: Resource not found
   * - 429: Rate limit exceeded — includes retryAfter when available
   * - 5xx: Upstream server error
   */
  private buildApiError(
    status: number,
    body: unknown,
    path: string
  ): NeventApiError {
    // Log the error for debugging — this is the only place where upstream API errors surface
    logger.error({ status, path, body: JSON.stringify(body)?.slice(0, 500) }, 'Upstream API error');

    // Extract any message, code, and type the API provided in the body.
    //
    // nev-api returns errors in two formats:
    //   { message: "..." }                                                 — simple
    //   { error: { message: "...", details: "...", code: "...", type: "..." } } — structured
    //
    // We propagate the API-supplied code and type so that callers get the
    // original machine-readable error code (e.g. "segment_not_found") rather
    // than a generic fallback, which improves LLM error recovery.
    const b = body as Record<string, unknown> | null;
    const errField = b?.error;
    const nestedError = (errField && typeof errField === 'object' ? errField : undefined) as Record<string, unknown> | undefined;
    const apiErrorString = typeof errField === 'string' ? errField : undefined;
    const apiDetails = nestedError?.details ? String(nestedError.details) : undefined;
    const apiMessage =
      apiDetails ??
      (nestedError?.message ? String(nestedError.message) : undefined) ??
      apiErrorString ??
      (b?.message ? String(b.message) : undefined);

    // Propagate machine-readable code from the API when present
    const apiCode: string | undefined =
      (nestedError?.code ? String(nestedError.code) : undefined) ??
      (b?.code ? String(b.code) : undefined) ??
      (b?.error_code ? String(b.error_code) : undefined);

    // Propagate error type from the API when present (e.g. "validation_error")
    const apiType: string | undefined =
      (nestedError?.type ? String(nestedError.type) : undefined) ??
      (b?.type ? String(b.type) : undefined);

    switch (status) {
      case 401:
        return new NeventApiError({
          type: 'authentication_error',
          message:
            apiMessage ??
            'Authentication failed. Your JWT token is missing, expired, or invalid. ' +
            'Set the NEVENT_JWT_TOKEN environment variable with a valid token.',
          code: apiCode ?? 'invalid_token',
        });

      case 403:
        return new NeventApiError({
          type: 'authentication_error',
          message:
            apiMessage ??
            `Access denied to ${path}. This endpoint may require elevated permissions (e.g. ADMIN role).`,
          code: apiCode ?? 'forbidden',
        });

      case 404:
        return new NeventApiError({
          type: 'not_found',
          message: apiMessage ?? `Resource not found: ${path}`,
          code: apiCode ?? 'not_found',
        });

      case 429: {
        const retryAfter =
          typeof body === 'object' && body !== null && 'retryAfter' in body
            ? (body as { retryAfter: unknown }).retryAfter
            : undefined;
        const retryMsg = retryAfter ? ` Retry after ${retryAfter} seconds.` : '';
        return new NeventApiError({
          type: 'rate_limit_error',
          message: `Rate limit exceeded for ${path}.${retryMsg} Reduce request frequency and try again.`,
          code: apiCode ?? 'rate_limit_exceeded',
          param: retryAfter !== undefined ? String(retryAfter) : undefined,
        });
      }

      default:
        return new NeventApiError({
          type: (apiType ?? (status >= 500 ? 'api_error' : 'invalid_request')) as NeventError['type'],
          message:
            apiMessage ??
            `HTTP ${status} error from ${path}. Check your request parameters.`,
          code: apiCode ?? (status >= 500 ? 'server_error' : 'request_error'),
        });
    }
  }
}
