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
 * Requires a shared JWT token (`NEVENT_JWT_TOKEN`) because stdio mode has
 * no per-user authentication flow.
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
 * In HTTP mode each MCP session is authenticated with the user's own nev-api
 * JWT token (obtained during the OAuth flow), so `NEVENT_JWT_TOKEN` is NOT
 * required. Each session gets its own `DataClient` instance.
 *
 * ```bash
 * MCP_JWT_SECRET=<secret> \
 * MONGODB_URI=<uri> \
 * node dist/index.js --transport=http --port=3000
 * ```
 *
 * ## Environment variables
 *
 * | Variable               | Required            | Default                    | Description |
 * |------------------------|---------------------|----------------------------|-------------|
 * | NEVENT_JWT_TOKEN       | Yes (stdio only)    | —                          | Shared JWT for nev-data-api (stdio mode) |
 * | NEVENT_DATA_API_URL    | No                  | https://data.nevent.es     | nev-data-api base URL |
 * | NEVENT_OPERATION_MODE  | No                  | READ_ONLY                  | READ_ONLY / STANDARD / FULL |
 * | MCP_TRANSPORT          | No                  | stdio                      | stdio or http |
 * | MCP_PORT               | No                  | 3000                       | HTTP port |
 * | MCP_SERVER_URL         | No (http)           | http://localhost:{port}    | Public HTTPS URL of this server |
 * | MCP_JWT_SECRET         | Yes (http)          | —                          | JWT signing key |
 * | MONGODB_URI            | Yes (http)          | —                          | MongoDB connection URI |
 * | NEVENT_API_URL         | No (http)           | https://api.nevent.es      | nev-api URL for auth + tenant endpoints |
 * | MCP_ALLOWED_ORIGINS    | No (http)           | * (all)                    | Comma-separated allowed CORS origins |
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DataClient } from './clients/data-client.js';
import { PaidMediaClient } from './clients/paid-media-client.js';
import { ShortUrlClient } from './clients/short-url-client.js';
import { SessionClients } from './clients/session-clients.js';
import { OPERATION_MODE } from './config/operation-mode.js';
import { createNeventServer } from './server.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Shared env vars
// ---------------------------------------------------------------------------

const DATA_API_URL = process.env['NEVENT_DATA_API_URL'] ?? 'https://data.nevent.es';

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
  logger.fatal({ port: portArg }, `FATAL: Invalid port "${portArg}". Must be a number between 1 and 65535.`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Transport selection
// ---------------------------------------------------------------------------

if (transportArg === 'http') {
  // -------------------------------------------------------------------------
  // HTTP mode
  //
  // Each MCP session gets its own per-user DataClient — NEVENT_JWT_TOKEN is
  // NOT required here. The user's nev-api access_token is obtained during
  // the OAuth login flow and stored in the refresh token document.
  // -------------------------------------------------------------------------

  const MCP_JWT_SECRET = process.env['MCP_JWT_SECRET'];
  const MONGODB_URI = process.env['MONGODB_URI'];
  const NEVENT_API_URL = process.env['NEVENT_API_URL'] ?? 'https://api.nevent.es';
  const MCP_SERVER_URL = process.env['MCP_SERVER_URL'] ?? `http://localhost:${HTTP_PORT}`;

  if (!MCP_JWT_SECRET) {
    logger.fatal(
      'FATAL: MCP_JWT_SECRET environment variable is required in HTTP mode. ' +
      'Set it to a strong random secret (>= 32 characters recommended).'
    );
    process.exit(1);
  }

  if (!MONGODB_URI) {
    logger.fatal(
      'FATAL: MONGODB_URI environment variable is required in HTTP mode. ' +
      'Set it to a valid MongoDB connection URI for OAuth storage.'
    );
    process.exit(1);
  }

  logger.info(
    {
      port: HTTP_PORT,
      serverUrl: MCP_SERVER_URL,
      dataApi: DATA_API_URL,
      neventApi: NEVENT_API_URL,
      mode: OPERATION_MODE,
      auth: 'per-session',
    },
    'Starting HTTP transport v1.0.0'
  );

  // Dynamically import to avoid loading Express/MongoDB in stdio mode
  const { createHttpApp } = await import('./transports/http.js');

  const { app, shutdown } = await createHttpApp({
    port: HTTP_PORT,
    mcpServerUrl: new URL(MCP_SERVER_URL),
    jwtSecret: MCP_JWT_SECRET,
    mongoUri: MONGODB_URI,
    neventApiUrl: NEVENT_API_URL,
    dataApiUrl: DATA_API_URL,
  });

  // Register signal handlers here (NOT inside createHttpApp) to avoid
  // registering duplicate handlers when the module is imported multiple times
  // (e.g., in tests or when using dynamic imports).
  process.on('SIGTERM', () => void shutdown().then(() => process.exit(0)));
  process.on('SIGINT', () => void shutdown().then(() => process.exit(0)));

  app.listen(HTTP_PORT, () => {
    logger.info(
      {
        port: HTTP_PORT,
        mcpEndpoint: `${MCP_SERVER_URL}/mcp`,
        healthEndpoint: `${MCP_SERVER_URL}/health`,
        oauthMetadata: `${MCP_SERVER_URL}/.well-known/oauth-authorization-server`,
      },
      'HTTP server listening'
    );
  });
} else {
  // -------------------------------------------------------------------------
  // stdio mode (default)
  //
  // Uses a shared JWT token for all requests — NEVENT_JWT_TOKEN is required.
  // -------------------------------------------------------------------------

  if (transportArg !== 'stdio') {
    logger.warn(
      { transport: transportArg },
      `Unknown transport "${transportArg}". Valid values: stdio, http. Defaulting to stdio.`
    );
  }

  const JWT_TOKEN = process.env['NEVENT_JWT_TOKEN'];

  if (!JWT_TOKEN) {
    logger.fatal(
      'FATAL: NEVENT_JWT_TOKEN environment variable is not set. ' +
      'In stdio mode a shared JWT token is required to authenticate with nev-data-api. ' +
      'Set NEVENT_JWT_TOKEN to a valid Nevent JWT token before starting the server.'
    );
    process.exit(1);
  }

  logger.info(
    { dataApi: DATA_API_URL, mode: OPERATION_MODE },
    'Starting stdio transport v1.0.0'
  );

  const NEVENT_API_URL = process.env['NEVENT_API_URL'] ?? 'https://api.nevent.es';
  const MONGODB_URI = process.env['MONGODB_URI'];

  // Decode JWT to extract homeTenantId (no verification — we trust our own env var)
  let homeTenantId: string | undefined;
  try {
    const jwt = await import('jsonwebtoken');
    const decoded = jwt.default.decode(JWT_TOKEN) as Record<string, unknown> | null;
    homeTenantId = decoded?.['tenantId'] as string | undefined;
  } catch { /* ignore */ }

  const dataClient = new DataClient(
    { baseUrl: DATA_API_URL, jwtToken: JWT_TOKEN },
    homeTenantId
  );

  // Paid media client — uses the same JWT and nev-api base URL
  const paidMediaClient = new PaidMediaClient({
    baseUrl: NEVENT_API_URL,
    jwtToken: JWT_TOKEN,
  });

  // Short URL client — uses the same JWT and nev-api base URL
  const shortUrlClient = new ShortUrlClient({
    baseUrl: NEVENT_API_URL,
    jwtToken: JWT_TOKEN,
  });

  // Build SessionClients so all clients share token state
  const sessionClients = new SessionClients(
    dataClient,
    paidMediaClient,
    NEVENT_API_URL,
    homeTenantId
  );

  const server = createNeventServer({
    dataClient,
    neventApiUrl: NEVENT_API_URL,
    mongoUri: MONGODB_URI,
    paidMediaClient,
    shortUrlClient,
    sessionClients,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
