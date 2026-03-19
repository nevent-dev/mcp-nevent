#!/usr/bin/env node
/**
 * Nevent MCP Server — Sprint 1: Analytics + Segmentation
 *
 * Entry point for the Model Context Protocol server that exposes Nevent's
 * analytics and segmentation capabilities to AI agents (Claude Desktop,
 * Claude Code, and any MCP-compatible client).
 *
 * ## Architecture
 * - Transport:   StdioServerTransport (reads from stdin, writes to stdout)
 * - Data client: DataClient → nev-data-api (data.nevent.es)
 * - Auth:        JWT Bearer token via NEVENT_JWT_TOKEN env var
 *
 * ## Tools (Sprint 1 — 8 tools)
 * - nevent_analytics_query          — BigQuery analytics query DSL
 * - nevent_analytics_capabilities   — Discover available tables
 * - nevent_analytics_table_schema   — Get column schema for a table
 * - nevent_analytics_filter_values  — Discover distinct field values
 * - nevent_segmentation_criteria    — List all segment criteria
 * - nevent_segment_preview          — Preview audience size (non-persisting)
 * - nevent_segment_execute          — Execute segment, get paginated contacts
 * - nevent_dimension_values         — Autocomplete values for a criterion
 *
 * ## Usage
 * ```bash
 * NEVENT_JWT_TOKEN=your_token npx tsx src/index.ts
 * ```
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DataClient } from './clients/data-client.js';
import { OPERATION_MODE } from './config/operation-mode.js';
import { registerAnalyticsTools } from './tools/analytics.js';

// ---------------------------------------------------------------------------
// Startup validation
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
// Server + client initialization
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: 'nevent-mcp',
  version: '1.0.0',
});

const dataClient = new DataClient({
  baseUrl: DATA_API_URL,
  jwtToken: JWT_TOKEN,
});

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

registerAnalyticsTools(server, dataClient);

// ---------------------------------------------------------------------------
// Transport + connection
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();

console.error(
  `[nevent-mcp] Starting server v1.0.0 | ` +
  `data_api=${DATA_API_URL} | ` +
  `mode=${OPERATION_MODE}`
);

await server.connect(transport);
