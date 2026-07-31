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

// ---------------------------------------------------------------------------
// Tool count helper
// ---------------------------------------------------------------------------

/**
 * Describes which optional feature groups are active at runtime.
 * Used by `getToolCount` to compute the exact number of registered tools
 * without spawning a real McpServer session.
 */
export interface ToolCountOptions {
  /** Whether a neventApiUrl is configured (enables tenant, segment, campaign-action, media tools). */
  hasNeventApiUrl: boolean;
  /** Whether a mongoUri is configured (enables campaign, template, deliverability tools). */
  hasMongoUri: boolean;
  /** Whether a paidMediaClient is available (enables 11 paid media tools). */
  hasPaidMediaClient: boolean;
  /** Whether a shortUrlClient is available (enables 9 short URL tools). */
  hasShortUrlClient: boolean;
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DataClient } from './clients/data-client.js';
import { SessionClients } from './clients/session-clients.js';
import { registerAnalyticsTools } from './tools/analytics.js';
import { registerTenantTools } from './tools/tenants.js';
import { registerSegmentTools } from './tools/segments.js';
import { registerCampaignTools } from './tools/campaigns.js';
import { registerTemplateTools } from './tools/templates.js';
import { registerDeliverabilityTools } from './tools/deliverability.js';
import { registerCampaignActionTools } from './tools/campaign-actions.js';
import { registerPaidMediaTools } from './tools/paid-media.js';
import { registerShortUrlTools } from './tools/short-urls.js';
import { registerMediaTools } from './tools/media.js';
import { PaidMediaClient } from './clients/paid-media-client.js';
import { ShortUrlClient } from './clients/short-url-client.js';
import { MediaClient } from './clients/media-client.js';
import { TemplateClient } from './clients/template-client.js';
import { createToolCallLogger, applyLoggingToServer } from './tools/logging.js';
import { registerHelpTool } from './tools/help.js';
import { NEVENT_MCP_INSTRUCTIONS } from './server-instructions.js';

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
   * Pre-configured short URL client for nev-api `/admin/short-url/...` endpoints.
   * When provided, all 9 short URL tools are registered on the server.
   * When omitted, short URL tools are not registered (backwards-compatible).
   *
   * Requires roles ADMIN | OWNER | SUPERADMIN.
   */
  shortUrlClient?: ShortUrlClient;
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
  /**
   * Optional pre-built SessionClients aggregate.
   * When provided, used directly for tenant tools (maintains shared token state).
   * When omitted, a SessionClients is constructed from dataClient + paidMediaClient.
   */
  sessionClients?: SessionClients;
  /**
   * Whether to enable tool call logging to MongoDB.
   *
   * When `true` (the default) and `mongoUri` is provided, a `ToolCallLogger` is
   * instantiated and every tool handler is transparently wrapped to persist
   * latency and outcome data to the `mcp_tool_calls` collection.
   *
   * Set to `false` for sessions that must not open a MongoDB connection — most
   * importantly anonymous discovery sessions, which pass a stub URI so that
   * tool METADATA is registered without real I/O.  Setting this flag avoids
   * creating a `MongoClient` against the stub host and eliminates the background
   * DNS/connection retries that `warmUp()` would otherwise trigger.
   *
   * @default true
   */
  enableToolCallLogging?: boolean;
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
 * - Analytics + Segmentation (9 tools): Always registered.
 * - Meta help tool (1 tool): Always registered.
 * - Multi-tenant (3 tools): Registered when neventApiUrl is provided.
 * - Segment management (4 tools): Registered when neventApiUrl is provided.
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
  const {
    dataClient,
    neventApiUrl,
    mongoUri,
    paidMediaClient,
    shortUrlClient,
    userId = null,
    getSessionId,
    sessionClients: providedSessionClients,
    enableToolCallLogging = true,
  } = options;

  const server = new McpServer(
    { name: 'nevent-mcp', version: '1.0.0' },
    { instructions: NEVENT_MCP_INSTRUCTIONS }
  );

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
  if (mongoUri && enableToolCallLogging !== false) {
    const logger = createToolCallLogger(mongoUri);
    applyLoggingToServer(server, logger, dataClient, userId, getSessionId ?? null);

    // Warm up the MongoDB logger connection in the background so the first
    // tool call does not incur the cold-start ~200ms penalty.
    // Fire-and-forget — errors are swallowed internally by the logger.
    void logger.warmUp();
  }

  // Sprint 1: Analytics + Segmentation — always registered
  registerAnalyticsTools(server, dataClient);

  // Meta-tool: always registered, no external dependencies
  registerHelpTool(server);

  // Multi-tenant + nev-api tools — registered when neventApiUrl is provided
  if (neventApiUrl) {
    // Build or reuse SessionClients — ensures all clients share token state
    const sc = providedSessionClients ?? new SessionClients(
      dataClient,
      paidMediaClient ?? new PaidMediaClient({ baseUrl: neventApiUrl, jwtToken: '' }),
      neventApiUrl
    );

    // Tenant management (list/switch/reset)
    registerTenantTools(server, sc, neventApiUrl);

    // Sprint 2: Segment management (list/get/create/update via nev-api)
    registerSegmentTools(server, dataClient, neventApiUrl);

    // Sprint 2: Campaign actions (create/schedule via nev-api)
    registerCampaignActionTools(server, dataClient, neventApiUrl);
  }

  // Sprint 2: MongoDB-backed tools — registered when mongoUri is provided
  if (mongoUri) {
    // Campaign read tools (list/get/insights from MongoDB)
    registerCampaignTools(server, mongoUri, dataClient);

    // Email template tools (list/get from MongoDB; create/update/clone/rename/preview/test via nev-api)
    // Pass templateClient from SessionClients when available for the 4 new operation tools.
    const templateClient = providedSessionClients?.templateClient;
    registerTemplateTools(server, mongoUri, dataClient, neventApiUrl, templateClient);

    // Deliverability tools (sending profile + suppressions from MongoDB)
    registerDeliverabilityTools(server, mongoUri, dataClient);
  }

  // Paid media tools (11 tools) — registered when paidMediaClient is provided
  if (paidMediaClient) {
    registerPaidMediaTools(server, paidMediaClient);
  }

  // Short URL tools (9 tools) — registered when shortUrlClient is provided
  // Prefer shortUrlClient from providedSessionClients when available (HTTP mode)
  const effectiveShortUrlClient = shortUrlClient ?? providedSessionClients?.shortUrlClient;
  if (effectiveShortUrlClient) {
    registerShortUrlTools(server, effectiveShortUrlClient);
  }

  // Media tools (3 tools) — registered when neventApiUrl is provided.
  // The mediaClient lives on SessionClients (HTTP mode) or is constructed
  // on-demand in stdio mode from the existing nev-api URL + JWT.
  // Prefer mediaClient from providedSessionClients when available (HTTP mode).
  const effectiveMediaClient = providedSessionClients?.mediaClient;
  if (effectiveMediaClient) {
    registerMediaTools(server, effectiveMediaClient);
  } else if (neventApiUrl) {
    // stdio mode: construct a standalone MediaClient sharing the same JWT as
    // DataClient (same bearer token — both target nev-api).
    const standaloneMediaClient = new MediaClient({
      baseUrl: neventApiUrl,
      jwtToken: dataClient.getJwtToken(),
    });
    registerMediaTools(server, standaloneMediaClient);
  }

  return server;
}

// ---------------------------------------------------------------------------
// Tool count probe
// ---------------------------------------------------------------------------

/**
 * Returns the number of tools that would be registered given the supplied
 * feature flags.
 *
 * Internally creates a lightweight "probe" McpServer, runs the same
 * conditional registration logic as `createNeventServer` (minus MongoDB
 * logging which has I/O side effects), and reads the internal
 * `_registeredTools` Map size.
 *
 * ## Why not cache this at startup?
 *
 * Called at request time (inside `/health` and `/.well-known/mcp-manifest.json`
 * handlers) so the count always reflects the runtime feature flags rather than
 * a snapshot taken at module load time. The probe is cheap — tool registration
 * is purely synchronous and involves no I/O.
 *
 * @param opts - Feature flags describing which optional groups are active.
 * @returns The exact number of tools registered under those flags.
 */
export function getToolCount(opts: ToolCountOptions): number {
  const { hasNeventApiUrl, hasMongoUri, hasPaidMediaClient, hasShortUrlClient } = opts;

  // Stub clients satisfy the TypeScript types but are never called —
  // registration functions only capture references, they don't invoke clients.
  const stubDataClient = new DataClient(
    { baseUrl: 'http://stub', jwtToken: 'stub' }
  );

  const probe = new McpServer(
    { name: 'nevent-mcp-probe', version: '0.0.0' },
    { instructions: '' }
  );

  // Always registered
  registerAnalyticsTools(probe, stubDataClient);
  registerHelpTool(probe);

  if (hasNeventApiUrl) {
    const stubPaidMediaClient = new PaidMediaClient({ baseUrl: 'http://stub', jwtToken: 'stub' });
    const stubSessionClients = new SessionClients(stubDataClient, stubPaidMediaClient, 'http://stub');
    registerTenantTools(probe, stubSessionClients, 'http://stub');
    registerSegmentTools(probe, stubDataClient, 'http://stub');
    registerCampaignActionTools(probe, stubDataClient, 'http://stub');
  }

  if (hasMongoUri) {
    registerCampaignTools(probe, 'mongodb://stub', stubDataClient);
    // Pass a stub TemplateClient when neventApiUrl is available so that the
    // 4 operation tools (clone/rename/preview/send_test) are registered in the
    // count just as they would be in a real HTTP session.
    const stubTemplateClient = hasNeventApiUrl
      ? new TemplateClient({ baseUrl: 'http://stub', jwtToken: 'stub' })
      : undefined;
    registerTemplateTools(probe, 'mongodb://stub', stubDataClient, hasNeventApiUrl ? 'http://stub' : undefined, stubTemplateClient);
    registerDeliverabilityTools(probe, 'mongodb://stub', stubDataClient);
  }

  if (hasPaidMediaClient) {
    const stubPaidMediaClient = new PaidMediaClient({ baseUrl: 'http://stub', jwtToken: 'stub' });
    registerPaidMediaTools(probe, stubPaidMediaClient);
  }

  if (hasShortUrlClient) {
    const stubShortUrlClient = new ShortUrlClient({ baseUrl: 'http://stub', jwtToken: 'stub' });
    registerShortUrlTools(probe, stubShortUrlClient);
  }

  // Media tools: registered when neventApiUrl is provided (same as createNeventServer)
  if (hasNeventApiUrl) {
    const stubMediaClient = new MediaClient({ baseUrl: 'http://stub', jwtToken: 'stub' });
    registerMediaTools(probe, stubMediaClient);
  }

  // Access the SDK's internal tool registry via the known private field.
  // The MCP SDK (v1.x) stores registered tools in `_registeredTools`.
  // In ESM builds this is a plain object keyed by tool name; in CJS builds it
  // is a Map. We handle both: prefer Object.keys (works for both types).
  // There is no public API for the count; using the internal field is
  // intentional and the field name is stable across the SDK versions we use.
  const internal = probe as unknown as { _registeredTools: Record<string, unknown> };
  return Object.keys(internal._registeredTools).length;
}
