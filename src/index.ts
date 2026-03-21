#!/usr/bin/env node
/**
 * Nevent MCP Server — Entry Point
 *
 * Supports two transport modes selected via `--transport` CLI argument or
 * `MCP_TRANSPORT` environment variable:
 *
 * ## stdio (default — backwards compatible)
 *
 * The original Sprint 1 behaviour: reads JSON-RPC from stdin, writes to
 * stdout. Used by Claude Desktop, Claude Code, and local MCP clients.
 *
 * ```bash
 * NEVENT_JWT_TOKEN=<token> node dist/index.js
 * NEVENT_JWT_TOKEN=<token> node dist/index.js --transport=stdio
 * ```
 *
 * ## http
 *
 * Exposes the server over Streamable HTTP with OAuth 2.1 authentication.
 * Used by remote clients such as ChatGPT, Claude.ai, and any MCP client
 * that connects over HTTPS.
 *
 * ```bash
 * NEVENT_JWT_TOKEN=<token> \
 * MCP_JWT_SECRET=<secret> \
 * MONGODB_URI=<uri> \
 * node dist/index.js --transport=http --port=3000
 * ```
 *
 * ## Environment variables
 *
 * | Variable               | Required       | Default                    | Description |
 * |------------------------|---------------|----------------------------|-------------|
 * | NEVENT_JWT_TOKEN       | Yes (both)    | —                          | JWT for nev-data-api |
 * | NEVENT_DATA_API_URL    | No            | https://data.nevent.es     | nev-data-api base URL |
 * | NEVENT_OPERATION_MODE  | No            | READ_ONLY                  | READ_ONLY / STANDARD / FULL |
 * | MCP_TRANSPORT          | No            | stdio                      | stdio or http |
 * | MCP_PORT               | No            | 3000                       | HTTP port |
 * | MCP_SERVER_URL         | No (http)     | http://localhost:{port}    | Public HTTPS URL of this server |
 * | MCP_JWT_SECRET         | Yes (http)    | —                          | JWT signing key |
 * | MONGODB_URI            | Yes (http)    | —                          | MongoDB connection URI |
 * | NEVENT_API_URL         | No (http)     | https://api.nevent.es      | nev-api URL for auth |
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DataClient } from './clients/data-client.js';
import { OPERATION_MODE } from './config/operation-mode.js';
import { createNeventServer } from './server.js';

// ---------------------------------------------------------------------------
// Shared env vars (required by both transports)
// ---------------------------------------------------------------------------

const JWT_TOKEN = process.env['NEVENT_JWT_TOKEN'];
const DATA_API_URL = process.env['NEVENT_DATA_API_URL'] ?? 'https://data.nevent.es';

if (!JWT_TOKEN) {
  console.error(
    '[nevent-mcp] FATAL: NEVENT_JWT_TOKEN environment variable is not set. ' +
    'Set it to a valid Nevent JWT token before starting the server.'
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

/**
 * Parses a single named CLI argument in the form `--name=value`.
 *
 * @param name - Argument name (without `--`).
 * @returns The value string, or `undefined` if not provided.
 */
function parseArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
}

/** Transport mode: `stdio` (default) or `http`. */
const transportArg = parseArg('transport') ?? process.env['MCP_TRANSPORT'] ?? 'stdio';

/** HTTP port (http mode only). */
const portArg = parseArg('port') ?? process.env['MCP_PORT'] ?? '3000';
const HTTP_PORT = parseInt(portArg, 10);

if (isNaN(HTTP_PORT) || HTTP_PORT < 1 || HTTP_PORT > 65535) {
  console.error(`[nevent-mcp] FATAL: Invalid port "${portArg}". Must be a number between 1 and 65535.`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Shared DataClient (both transports use the same API client)
// ---------------------------------------------------------------------------

const dataClient = new DataClient({
  baseUrl: DATA_API_URL,
  jwtToken: JWT_TOKEN,
});

// ---------------------------------------------------------------------------
// Transport selection
// ---------------------------------------------------------------------------

if (transportArg === 'http') {
  // -------------------------------------------------------------------------
  // HTTP mode
  // -------------------------------------------------------------------------

  const MCP_JWT_SECRET = process.env['MCP_JWT_SECRET'];
  const MONGODB_URI = process.env['MONGODB_URI'];
  const NEVENT_API_URL = process.env['NEVENT_API_URL'] ?? 'https://api.nevent.es';
  const MCP_SERVER_URL = process.env['MCP_SERVER_URL'] ?? `http://localhost:${HTTP_PORT}`;

  if (!MCP_JWT_SECRET) {
    console.error(
      '[nevent-mcp] FATAL: MCP_JWT_SECRET environment variable is required in HTTP mode. ' +
      'Set it to a strong random secret (>= 32 characters recommended).'
    );
    process.exit(1);
  }

  if (!MONGODB_URI) {
    console.error(
      '[nevent-mcp] FATAL: MONGODB_URI environment variable is required in HTTP mode. ' +
      'Set it to a valid MongoDB connection URI for OAuth storage.'
    );
    process.exit(1);
  }

  console.error(
    `[nevent-mcp] Starting HTTP transport v1.0.0 | ` +
    `port=${HTTP_PORT} | ` +
    `server_url=${MCP_SERVER_URL} | ` +
    `data_api=${DATA_API_URL} | ` +
    `mode=${OPERATION_MODE}`
  );

  // Dynamically import to avoid loading Express/MongoDB in stdio mode
  const { createHttpApp } = await import('./transports/http.js');

  const app = await createHttpApp({
    port: HTTP_PORT,
    mcpServerUrl: new URL(MCP_SERVER_URL),
    jwtSecret: MCP_JWT_SECRET,
    mongoUri: MONGODB_URI,
    neventApiUrl: NEVENT_API_URL,
    dataClient,
  });

  app.listen(HTTP_PORT, () => {
    console.error(`[nevent-mcp] HTTP server listening on port ${HTTP_PORT}`);
    console.error(`[nevent-mcp] MCP endpoint:    ${MCP_SERVER_URL}/mcp`);
    console.error(`[nevent-mcp] Health endpoint: ${MCP_SERVER_URL}/health`);
    console.error(`[nevent-mcp] OAuth metadata:  ${MCP_SERVER_URL}/.well-known/oauth-authorization-server`);
  });
} else {
  // -------------------------------------------------------------------------
  // stdio mode (default)
  // -------------------------------------------------------------------------

  if (transportArg !== 'stdio') {
    console.error(
      `[nevent-mcp] Unknown transport "${transportArg}". Valid values: stdio, http. Defaulting to stdio.`
    );
  }

  console.error(
    `[nevent-mcp] Starting stdio transport v1.0.0 | ` +
    `data_api=${DATA_API_URL} | ` +
    `mode=${OPERATION_MODE}`
  );

  const server = createNeventServer(dataClient);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
