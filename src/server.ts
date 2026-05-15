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
import { registerPaidMediaTools } from './tools/paid-media.js';
import { PaidMediaClient } from './clients/paid-media-client.js';
import { createToolCallLogger, applyLoggingToServer } from './tools/logging.js';

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
  /**
   * Pre-configured paid media client for nev-api `/api/ads/{provider}/...` endpoints.
   * When provided, all 11 paid media tools are registered on the server.
   * When omitted, paid media tools are not registered (backwards-compatible).
   *
   * Requires roles ADMIN | SUPERADMIN | OWNER and capability MODULE_ATTRIBUTION.
   */
  paidMediaClient?: PaidMediaClient;
  /**
   * User identifier from the JWT `sub` claim.
   * When provided, stored in `mcp_tool_calls` documents for attribution.
   * When omitted, `user_id` is recorded as `null`.
   */
  userId?: string;
  /**
   * Lazy getter for the MCP session ID.
   * Called at each tool invocation time (not at server creation time) so
   * that the session ID can be resolved after the transport's first
   * `initialize` handshake assigns it.
   * When omitted, `session_id` is recorded as `null`.
   */
  getSessionId?: () => string | null;
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
 * - Template tools (2-4 tools): Registered when mongoUri is provided.
 *   create/update tools additionally require neventApiUrl.
 * - Deliverability tools (2 tools): Registered when mongoUri is provided.
 * - Campaign actions (2 tools): Registered when neventApiUrl is provided.
 * - Paid media tools (11 tools): Registered when paidMediaClient is provided.
 *
 * @param options - Server creation options.
 * @returns A ready-to-connect McpServer with all applicable tools registered.
 */
export function createNeventServer(options: CreateNeventServerOptions): McpServer {
  const { dataClient, neventApiUrl, mongoUri, paidMediaClient, userId = null, getSessionId } = options;

  const server = new McpServer({
    name: 'nevent-mcp',
    version: '1.0.0',
  });

  // ---------------------------------------------------------------------------
  // Tool call logging
  //
  // When mongoUri is provided, patch server.tool() BEFORE any tools are
  // registered so that every handler is transparently wrapped with latency
  // measurement and fire-and-forget MongoDB logging.
  //
  // `getSessionId` is a lazy getter that resolves the session ID at invocation
  // time (the session ID is not available until after the first `initialize`
  // request is processed by the transport).
  // ---------------------------------------------------------------------------
  if (mongoUri) {
    const logger = createToolCallLogger(mongoUri);
    applyLoggingToServer(server, logger, dataClient, userId, getSessionId ?? null);
  }

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

    // Email template tools (list/get from MongoDB; create/update via nev-api when available)
    registerTemplateTools(server, mongoUri, dataClient, neventApiUrl);

    // Deliverability tools (sending profile + suppressions from MongoDB)
    registerDeliverabilityTools(server, mongoUri, dataClient);
  }

  // Paid media tools (11 tools) — registered when paidMediaClient is provided
  if (paidMediaClient) {
    registerPaidMediaTools(server, paidMediaClient);
  }

  return server;
}
