/**
 * Nevent MCP Server Factory
 *
 * Provides a shared factory function `createNeventServer` that creates and
 * configures a McpServer instance with all Sprint 1 analytics + segmentation
 * tools registered. This factory is transport-agnostic: the same server
 * instance can be connected to a StdioServerTransport (CLI) or to a
 * StreamableHTTPServerTransport (HTTP mode).
 *
 * ## Why a factory?
 *
 * The Streamable HTTP transport creates one McpServer per session (per the SDK
 * design). Having a factory instead of a singleton lets each new session spin
 * up its own server instance without re-importing the entry point.
 *
 * @module server
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DataClient } from './clients/data-client.js';
import { registerAnalyticsTools } from './tools/analytics.js';
import { registerTenantTools } from './tools/tenants.js';

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

/**
 * Options for `createNeventServer`.
 */
export interface CreateNeventServerOptions {
  /**
   * Configured client for nev-data-api (data.nevent.es).
   * In HTTP mode this is a per-session client authenticated with the user's
   * own JWT token; in stdio mode it is a shared instance.
   */
  dataClient: DataClient;
  /**
   * Base URL of nev-api (e.g. `https://api.nevent.es`).
   * When provided, multi-tenant tools (`nevent_list_tenants`,
   * `nevent_switch_tenant`) are registered on the server.
   * When omitted, tenant tools are not registered (backwards-compatible).
   */
  neventApiUrl?: string;
}

/**
 * Creates a new McpServer instance and registers all Nevent tools against
 * the supplied `DataClient`.
 *
 * Each call to this function returns a fresh McpServer — callers are
 * responsible for connecting it to a transport.
 *
 * ## Registered tool sets
 *
 * - **Analytics + Segmentation** (8 tools): Always registered. These are the
 *   Sprint 1 tools for querying BigQuery analytics and building audience
 *   segments via nev-data-api.
 *
 * - **Multi-tenant** (2 tools): Registered when `neventApiUrl` is provided.
 *   Enables listing accessible tenants and switching the active tenant for
 *   the session.
 *
 * @param options - Server creation options (dataClient + optional neventApiUrl).
 * @returns A ready-to-connect McpServer with all tools registered.
 *
 * @example
 * ```ts
 * // stdio mode (no tenant tools)
 * const server = createNeventServer({ dataClient });
 * const transport = new StdioServerTransport();
 * await server.connect(transport);
 *
 * // HTTP mode (with tenant tools)
 * const server = createNeventServer({ dataClient, neventApiUrl: 'https://api.nevent.es' });
 * await server.connect(httpTransport);
 * ```
 */
export function createNeventServer(options: CreateNeventServerOptions): McpServer {
  const { dataClient, neventApiUrl } = options;

  const server = new McpServer({
    name: 'nevent-mcp',
    version: '1.0.0',
  });

  registerAnalyticsTools(server, dataClient);

  if (neventApiUrl) {
    registerTenantTools(server, dataClient, neventApiUrl);
  }

  return server;
}
