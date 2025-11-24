/**
 * Nevent API Client with JWT authentication and multi-tenant support
 */

export interface NeventClientConfig {
  baseUrl: string;
  jwtToken: string;
}

export interface ApiResponse<T> {
  data: T;
  status: number;
  ok: boolean;
}

export class NeventClient {
  private baseUrl: string;
  private jwtToken: string;

  constructor(config: NeventClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.jwtToken = config.jwtToken;
  }

  /**
   * Make an authenticated request to the Nevent API
   */
  async request<T>(
    method: string,
    path: string,
    options: {
      body?: unknown;
      params?: Record<string, string | number | boolean | undefined>;
    } = {}
  ): Promise<ApiResponse<T>> {
    const url = new URL(`${this.baseUrl}${path}`);

    // Add query parameters
    if (options.params) {
      Object.entries(options.params).forEach(([key, value]) => {
        if (value !== undefined) {
          url.searchParams.append(key, String(value));
        }
      });
    }

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.jwtToken}`,
      'Content-Type': 'application/json',
    };

    const fetchOptions: RequestInit = {
      method,
      headers,
    };

    if (options.body && method !== 'GET') {
      fetchOptions.body = JSON.stringify(options.body);
    }

    const response = await fetch(url.toString(), fetchOptions);

    let data: T;
    const contentType = response.headers.get('content-type');

    if (contentType?.includes('application/json')) {
      data = await response.json() as T;
    } else {
      data = await response.text() as unknown as T;
    }

    if (!response.ok) {
      const errorMessage = typeof data === 'object' && data !== null && 'message' in data
        ? (data as { message: string }).message
        : `HTTP ${response.status}: ${response.statusText}`;
      throw new Error(errorMessage);
    }

    return {
      data,
      status: response.status,
      ok: response.ok,
    };
  }

  // Convenience methods
  async get<T>(path: string, params?: Record<string, string | number | boolean | undefined>): Promise<T> {
    const response = await this.request<T>('GET', path, { params });
    return response.data;
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    const response = await this.request<T>('POST', path, { body });
    return response.data;
  }

  async put<T>(path: string, body?: unknown): Promise<T> {
    const response = await this.request<T>('PUT', path, { body });
    return response.data;
  }

  async patch<T>(path: string, body?: unknown): Promise<T> {
    const response = await this.request<T>('PATCH', path, { body });
    return response.data;
  }

  async delete<T>(path: string): Promise<T> {
    const response = await this.request<T>('DELETE', path);
    return response.data;
  }
}
