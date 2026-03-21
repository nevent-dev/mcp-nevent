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

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

/**
 * Creates a new McpServer instance and registers all Nevent tools against
 * the supplied `DataClient`.
 *
 * Each call to this function returns a fresh McpServer — callers are
 * responsible for connecting it to a transport.
 *
 * @param dataClient - Configured client for nev-data-api (data.nevent.es).
 * @returns A ready-to-connect McpServer with all tools registered.
 *
 * @example
 * ```ts
 * const server = createNeventServer(dataClient);
 * const transport = new StdioServerTransport();
 * await server.connect(transport);
 * ```
 */
export function createNeventServer(dataClient: DataClient): McpServer {
  const server = new McpServer({
    name: 'nevent-mcp',
    version: '1.0.0',
  });

  registerAnalyticsTools(server, dataClient);

  return server;
}
