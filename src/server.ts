/**
 * Nevent MCP Server Factory
 *
 * Provides a shared factory function `createNeventServer` that creates and
 * configures a McpServer instance with all Sprint 2 tools registered.
 * This factory is transport-agnostic: the same server instance can be
 * connected to a StdioServerTransport (CLI) or to a
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
import { registerSegmentTools } from './tools/segments.js';
import { registerCampaignTools } from './tools/campaigns.js';
import { registerTemplateTools } from './tools/templates.js';
import { registerDeliverabilityTools } from './tools/deliverability.js';
import { registerCampaignActionTools } from './tools/campaign-actions.js';

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
   * When provided, multi-tenant tools and Sprint 2 segment/campaign-action
   * tools are registered on the server.
   * When omitted, these tools are not registered (backwards-compatible).
   */
  neventApiUrl?: string;
  /**
   * MongoDB connection URI (e.g. `mongodb://host:27017` or Atlas connection string).
   * When provided, Sprint 2 MongoDB-backed tools (campaigns, templates,
   * deliverability) are registered on the server.
   * When omitted, these tools are not registered (backwards-compatible).
   */
  mongoUri?: string;
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
 * - Analytics + Segmentation (8 tools): Always registered.
 * - Multi-tenant (2 tools): Registered when neventApiUrl is provided.
 * - Segment management (3 tools): Registered when neventApiUrl is provided.
 * - Campaign read tools (3 tools): Registered when mongoUri is provided.
 * - Template tools (2 tools): Registered when mongoUri is provided.
 * - Deliverability tools (2 tools): Registered when mongoUri is provided.
 * - Campaign actions (2 tools): Registered when neventApiUrl is provided.
 *
 * @param options - Server creation options.
 * @returns A ready-to-connect McpServer with all applicable tools registered.
 */
export function createNeventServer(options: CreateNeventServerOptions): McpServer {
  const { dataClient, neventApiUrl, mongoUri } = options;

  const server = new McpServer({
    name: 'nevent-mcp',
    version: '1.0.0',
  });

  // Sprint 1: Analytics + Segmentation — always registered
  registerAnalyticsTools(server, dataClient);

  // Multi-tenant + nev-api tools — registered when neventApiUrl is provided
  if (neventApiUrl) {
    // Tenant management (list/switch)
    registerTenantTools(server, dataClient, neventApiUrl);

    // Sprint 2: Segment management (list/create/update via nev-api)
    registerSegmentTools(server, dataClient, neventApiUrl);

    // Sprint 2: Campaign actions (create/schedule via nev-api)
    registerCampaignActionTools(server, dataClient, neventApiUrl);
  }

  // Sprint 2: MongoDB-backed tools — registered when mongoUri is provided
  if (mongoUri) {
    // Campaign read tools (list/get/insights from MongoDB)
    registerCampaignTools(server, mongoUri, dataClient);

    // Email template tools (list/get from MongoDB)
    registerTemplateTools(server, mongoUri, dataClient);

    // Deliverability tools (sending profile + suppressions from MongoDB)
    registerDeliverabilityTools(server, mongoUri, dataClient);
  }

  return server;
}
