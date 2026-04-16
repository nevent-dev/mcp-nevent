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
  protected readonly jwtToken: string;
  protected readonly timeoutMs: number;

  constructor(config: BaseClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.jwtToken = config.jwtToken;
    this.timeoutMs = config.timeoutMs ?? 30_000;
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
    console.error(`[nevent-mcp] API error | ${this.baseUrl}${path} | status=${status} | body=${JSON.stringify(body)?.slice(0, 500)}`);

    // Extract any message the API provided in the body
    const apiMessage =
      typeof body === 'object' && body !== null && 'message' in body
        ? String((body as { message: unknown }).message)
        : undefined;

    switch (status) {
      case 401:
        return new NeventApiError({
          type: 'authentication_error',
          message:
            'Authentication failed. Your JWT token is missing, expired, or invalid. ' +
            'Set the NEVENT_JWT_TOKEN environment variable with a valid token.',
          code: 'invalid_token',
        });

      case 403:
        return new NeventApiError({
          type: 'authentication_error',
          message:
            apiMessage ??
            `Access denied to ${path}. This endpoint may require elevated permissions (e.g. ADMIN role).`,
          code: 'forbidden',
        });

      case 404:
        return new NeventApiError({
          type: 'not_found',
          message: apiMessage ?? `Resource not found: ${path}`,
          code: 'not_found',
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
          code: 'rate_limit_exceeded',
          param: retryAfter !== undefined ? String(retryAfter) : undefined,
        });
      }

      default:
        return new NeventApiError({
          type: status >= 500 ? 'api_error' : 'invalid_request',
          message:
            apiMessage ??
            `HTTP ${status} error from ${path}. Check your request parameters.`,
          code: status >= 500 ? 'server_error' : 'request_error',
        });
    }
  }
}
