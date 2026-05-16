/**
 * Tool call logging module for the Nevent MCP Server.
 *
 * Provides fire-and-forget MongoDB persistence for every MCP tool invocation.
 * Logs are written to the `mcp_tool_calls` collection in the `nevent` database
 * and retained for 90 days via a TTL index.
 *
 * ## Design decisions
 *
 * - **Fire-and-forget**: logging NEVER blocks the tool response. Errors during
 *   log insertion are caught silently so a MongoDB issue never degrades the
 *   user-facing tool.
 *
 * - **Closure-scoped singleton**: the `MongoClient` is created once inside
 *   `createToolCallLogger` and reused across all subsequent log inserts.
 *   This mirrors the pattern used in campaigns.ts, templates.ts, and
 *   deliverability.ts.
 *
 * - **Privacy-first params_summary**: full parameter bodies are NEVER stored.
 *   Only a lightweight, PII-free summary is kept (see `summarizeParams`).
 *
 * - **Transparent wrapping**: `applyLoggingToServer` monkey-patches the
 *   `McpServer.tool()` method so that EVERY handler registered after the
 *   patch is automatically wrapped, without touching any individual tool file.
 *
 * ## Indexes created on first use
 *
 * | Index | Purpose |
 * |-------|---------|
 * | `{ timestamp: 1 }` + TTL 90d | Automatic document expiry |
 * | `{ tenant_id: 1, timestamp: -1 }` | Per-tenant timeline queries |
 * | `{ tool_name: 1, timestamp: -1 }` | Per-tool usage analytics |
 * | `{ date: 1, tool_name: 1 }` | Daily aggregation queries |
 *
 * @module tools/logging
 */

import { MongoClient, type Collection } from 'mongodb';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DataClient } from '../clients/data-client.js';
import { TIMEOUTS } from '../config/timeouts.js';

// ---------------------------------------------------------------------------
// Document shape
// ---------------------------------------------------------------------------

/**
 * Document stored in the `mcp_tool_calls` collection for each tool invocation.
 */
export interface ToolCallDocument {
  /** Tenant ID from DataClient.activeTenantId at the time of the call. */
  tenant_id: string | null;
  /** User identifier from the JWT `sub` claim. */
  user_id: string | null;
  /** MCP tool name, e.g. "nevent_analytics_query". */
  tool_name: string;
  /** Outcome of the tool invocation. */
  status: 'ok' | 'error';
  /** Short error code if the tool returned isError=true, otherwise null. */
  error_code: string | null;
  /** Truncated error message (max 200 chars), or null on success. */
  error_message: string | null;
  /** End-to-end handler execution time in milliseconds. */
  latency_ms: number;
  /** MCP session ID, if available in the tool call metadata. */
  session_id: string | null;
  /**
   * Lightweight parameter summary — no PII.
   * Only shape/count information, never raw values.
   */
  params_summary: Record<string, unknown>;
  /**
   * Approximate response payload size in bytes (UTF-8 length of the JSON text).
   * Null when the response contains no content (e.g. empty content array).
   * Used to track token-heavy tools and detect unexpectedly large payloads.
   */
  response_size_bytes: number | null;
  /**
   * The active tenant ID at the time of the call, duplicated here for
   * convenience in aggregation pipelines that group by tenant (avoids
   * joining with session documents). Mirrors `tenant_id`.
   */
  tenant_id_active: string | null;
  /** UTC timestamp when the tool was called. Used for the TTL index. */
  timestamp: Date;
  /** ISO date string "YYYY-MM-DD" for easy daily aggregation. */
  date: string;
}

// ---------------------------------------------------------------------------
// Logger factory
// ---------------------------------------------------------------------------

/**
 * Return type of `createToolCallLogger`.
 */
export interface ToolCallLogger {
  /**
   * Fire-and-forget function that inserts a `ToolCallDocument` into MongoDB.
   * Never throws — all errors are caught and suppressed internally.
   *
   * @param data - Partial document (fields merged with timestamp/date).
   */
  logToolCall: (data: Omit<ToolCallDocument, 'timestamp' | 'date'>) => void;
  /**
   * Warm up the MongoDB connection in the background (fire-and-forget).
   *
   * Call this during server initialization (without await) to pre-establish
   * the MongoDB connection so the first tool call does not pay the ~200ms
   * cold-start cost. Errors are silently suppressed — warm-up is best-effort.
   */
  warmUp: () => Promise<void>;
  /**
   * Close the underlying MongoClient.
   * Call during graceful shutdown to flush pending operations.
   */
  close: () => Promise<void>;
}

/**
 * Create a `ToolCallLogger` backed by the given MongoDB URI.
 *
 * The `MongoClient` and index creation are deferred until the first call to
 * `logToolCall`, so startup cost is zero if no tools are called.
 *
 * @param mongoUri - Full MongoDB connection URI.
 * @returns A `ToolCallLogger` with `logToolCall` and `close` methods.
 *
 * @example
 * ```ts
 * const logger = createToolCallLogger(process.env.MONGODB_URI!);
 * logger.logToolCall({ tool_name: 'nevent_analytics_query', status: 'ok', ... });
 * ```
 */
export function createToolCallLogger(mongoUri: string): ToolCallLogger {
  /** Lazily-initialised MongoDB client. */
  let client: MongoClient | null = null;

  /** Cached collection handle, set after first successful connect + index create. */
  let collection: Collection<ToolCallDocument> | null = null;

  /** Tracks whether indexes have been created in this process lifetime. */
  let indexesCreated = false;

  /**
   * Lazily connect to MongoDB and return the `mcp_tool_calls` collection.
   * Creates TTL and compound indexes on first access.
   *
   * @returns Initialized collection handle.
   */
  async function getCollection(): Promise<Collection<ToolCallDocument>> {
    if (collection) {
      return collection;
    }

    const mongoClient = new MongoClient(mongoUri, { serverSelectionTimeoutMS: TIMEOUTS.MONGO_CONNECT_MS });
    await mongoClient.connect();
    client = mongoClient;

    const col = mongoClient
      .db('nevent')
      .collection<ToolCallDocument>('mcp_tool_calls');

    // Create indexes only once per process to avoid repeated round-trips.
    if (!indexesCreated) {
      await Promise.all([
        // TTL index — documents expire after 90 days
        col.createIndex(
          { timestamp: 1 },
          { expireAfterSeconds: 90 * 24 * 3600, background: true }
        ),
        // Per-tenant timeline
        col.createIndex(
          { tenant_id: 1, timestamp: -1 },
          { background: true }
        ),
        // Per-tool usage
        col.createIndex(
          { tool_name: 1, timestamp: -1 },
          { background: true }
        ),
        // Daily aggregation
        col.createIndex(
          { date: 1, tool_name: 1 },
          { background: true }
        ),
      ]);
      indexesCreated = true;
    }

    collection = col;
    return col;
  }

  /**
   * Insert a tool call log document asynchronously (fire-and-forget).
   * Errors during insert are silently suppressed — logging must NEVER
   * impact the tool response returned to the user.
   *
   * @param data - Tool call metadata (excluding timestamp/date, added here).
   */
  function logToolCall(data: Omit<ToolCallDocument, 'timestamp' | 'date'>): void {
    const now = new Date();
    const doc: ToolCallDocument = {
      ...data,
      timestamp: now,
      date: now.toISOString().slice(0, 10), // "YYYY-MM-DD"
    };

    // Fire-and-forget: intentionally not awaited
    getCollection()
      .then((col) => col.insertOne(doc))
      .catch(() => {
        // Silently suppress all logging errors — a MongoDB issue must not
        // degrade the user-facing MCP tool response.
      });
  }

  /**
   * Close the underlying `MongoClient`.
   * Should be called during graceful shutdown.
   */
  async function close(): Promise<void> {
    if (client) {
      await client.close();
      client = null;
      collection = null;
    }
  }

  /**
   * Warm up the MongoDB connection in the background.
   *
   * Calls `getCollection()` to pre-establish the connection and create indexes.
   * Errors are silently suppressed — this is a best-effort optimization.
   * Call without `await` (fire-and-forget) during server start.
   */
  async function warmUp(): Promise<void> {
    try {
      await getCollection();
    } catch {
      // Silently suppress — warm-up failures are non-fatal
    }
  }

  return { logToolCall, warmUp, close };
}

// ---------------------------------------------------------------------------
// Parameter summarizer (PII-safe)
// ---------------------------------------------------------------------------

/**
 * Build a lightweight, PII-free summary of tool call parameters.
 *
 * The goal is to capture enough structural information for analytics
 * (e.g. which filters were applied, whether a time range was provided)
 * without storing any user-supplied values that might contain personal data.
 *
 * Tool-specific rules take precedence over the generic fallback.
 *
 * @param toolName - The name of the tool being called.
 * @param params   - Raw parameter object from the tool handler.
 * @returns        A plain object safe to store in MongoDB.
 */
export function summarizeParams(
  toolName: string,
  params: Record<string, unknown>
): Record<string, unknown> {
  switch (toolName) {
    case 'nevent_analytics_query':
      return {
        collection: params['collection'] ?? null,
        has_time_range: Boolean(params['timeRange']),
        dimensions_count: Array.isArray(params['dimensions']) ? params['dimensions'].length : 0,
        metrics_count: Array.isArray(params['metrics']) ? params['metrics'].length : 0,
        filters_count: Array.isArray(params['filters']) ? params['filters'].length : 0,
      };

    case 'nevent_analytics_table_schema':
      return {
        table: params['table'] ?? null,
      };

    case 'nevent_analytics_filter_values':
      return {
        collection: params['collection'] ?? null,
        filters_count: Array.isArray(params['filters']) ? params['filters'].length : 0,
      };

    case 'nevent_list_campaigns':
      return {
        status: params['status'] ?? null,
        channel: params['channel'] ?? null,
        has_date_range: Boolean(params['date_from'] || params['date_to']),
        limit: params['limit'] ?? null,
      };

    case 'nevent_get_campaign':
    case 'nevent_get_campaign_insights':
      return {
        // Only log that a campaign_id was provided, not the value itself
        has_campaign_id: Boolean(params['campaign_id']),
      };

    case 'nevent_list_templates':
      return {
        has_tags: Array.isArray(params['tags']) && params['tags'].length > 0,
        content_nature: params['content_nature'] ?? null,
        limit: params['limit'] ?? null,
      };

    case 'nevent_get_template':
      return {
        has_template_id: Boolean(params['template_id']),
      };

    case 'nevent_list_segments':
      return {
        param_count: Object.keys(params).length,
      };

    case 'nevent_create_segment':
      return {
        has_name: Boolean(params['name']),
        has_definition: Boolean(params['definition']),
        has_description: Boolean(params['description']),
      };

    case 'nevent_update_segment':
      return {
        has_name: params['name'] !== undefined,
        has_definition: params['definition'] !== undefined,
      };

    case 'nevent_create_campaign':
      return {
        channel: params['channel'] ?? null,
        has_subject: Boolean(params['email_subject']),
        has_message: Boolean(params['message']),
        has_segments: Array.isArray(params['segment_ids']) && params['segment_ids'].length > 0,
        has_template: Boolean(params['template_id']),
      };

    case 'nevent_schedule_campaign':
      return {
        has_campaign_id: Boolean(params['campaign_id']),
        confirmed: params['confirmed'] === true,
      };

    case 'nevent_switch_tenant':
      // tenant_id IS the purpose of this call — safe to log
      return {
        has_tenant_id: Boolean(params['tenant_id']),
      };

    default:
      // Generic fallback: only log parameter count
      return {
        param_count: Object.keys(params).length,
      };
  }
}

// ---------------------------------------------------------------------------
// Server patching
// ---------------------------------------------------------------------------

/**
 * Context accessor type — returns the current tenant, user, and session IDs
 * for a given tool invocation.
 */
export interface LoggingContext {
  /** Active tenant ID, if set. */
  tenant_id: string | null;
  /** User identifier from the JWT `sub` claim. */
  user_id: string | null;
  /** MCP session ID, if available. */
  session_id: string | null;
}

/**
 * Apply transparent tool call logging to an MCP server by monkey-patching
 * the `McpServer.tool()` method.
 *
 * Every tool registered AFTER this call will have its handler automatically
 * wrapped to:
 *  1. Record the start time before calling the original handler.
 *  2. Detect success/error from the response's `isError` flag.
 *  3. Call `logToolCall` asynchronously (fire-and-forget).
 *
 * The original `server.tool` method is preserved and called correctly.
 * This does NOT modify any individual tool file.
 *
 * ## Usage
 *
 * ```ts
 * const logger = createToolCallLogger(mongoUri);
 * applyLoggingToServer(server, logger, dataClient, sessionId);
 * // Now register tools — all handlers will be wrapped automatically
 * registerAnalyticsTools(server, dataClient);
 * ```
 *
 * @param server        - The `McpServer` instance to patch.
 * @param logger        - Logger returned by `createToolCallLogger`.
 * @param dataClient    - DataClient for reading `activeTenantId`.
 * @param userId        - User identifier from the JWT `sub` claim.
 * @param getSessionId  - Optional getter for the MCP session ID. Called at
 *                        invocation time so the session ID can be resolved
 *                        lazily (it may not be assigned until after the first
 *                        `initialize` request is handled by the transport).
 */
export function applyLoggingToServer(
  server: McpServer,
  logger: ToolCallLogger,
  dataClient: DataClient,
  userId: string | null,
  getSessionId: (() => string | null) | null = null
): void {
  // Store reference to the original `tool` method so we can call it
  // within the wrapper without infinite recursion.
  const originalTool = server.tool.bind(server);

  /**
   * Replacement `tool()` method. Accepts any overload of the original
   * McpServer.tool signature by forwarding the handler argument through
   * the logging wrapper.
   *
   * The McpServer.tool() method has multiple overloads depending on whether
   * schemas and annotations are provided. We capture the last argument as
   * the handler function.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).tool = (...args: any[]): unknown => {
    const toolName = args[0] as string;

    // The handler is always the last argument — find it by type
    const lastArgIndex = args.length - 1;
    const originalHandler = args[lastArgIndex] as (params: Record<string, unknown>) => Promise<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>;

    if (typeof originalHandler !== 'function') {
      // Safety: if the last arg is not a function, forward unchanged
      return (originalTool as (...a: unknown[]) => unknown)(...args);
    }

    /**
     * Wrapped handler that measures latency, detects errors, and fires
     * an async log insert before returning the original result.
     */
    const wrappedHandler = async (params: Record<string, unknown>) => {
      const start = Date.now();
      let result: Awaited<ReturnType<typeof originalHandler>>;

      try {
        result = await originalHandler(params);
      } catch (thrown) {
        // Handler threw an exception (should be rare — most handlers catch internally)
        const latency = Date.now() - start;
        const message = thrown instanceof Error ? thrown.message.slice(0, 200) : 'unknown';
        const activeTenantId = dataClient.activeTenantId ?? null;

        logger.logToolCall({
          tenant_id: activeTenantId,
          tenant_id_active: activeTenantId,
          user_id: userId,
          tool_name: toolName,
          status: 'error',
          error_code: 'handler_exception',
          error_message: message,
          latency_ms: latency,
          session_id: getSessionId ? getSessionId() : null,
          params_summary: summarizeParams(toolName, params),
          response_size_bytes: null,
        });

        throw thrown;
      }

      const latency = Date.now() - start;
      const isError = result.isError === true;
      const activeTenantId = dataClient.activeTenantId ?? null;

      // Try to extract error code from structured error envelope
      let errorCode: string | null = null;
      let errorMessage: string | null = null;

      if (isError && result.content && result.content.length > 0) {
        try {
          const parsed = JSON.parse(result.content[0].text) as Record<string, unknown>;
          const error = parsed['error'] as Record<string, unknown> | undefined;
          if (error) {
            errorCode = typeof error['code'] === 'string' ? error['code'] : null;
            errorMessage = typeof error['message'] === 'string'
              ? error['message'].slice(0, 200)
              : null;
          }
        } catch {
          // Non-JSON error content — leave errorCode/errorMessage null
        }
      }

      // Measure response payload size for token-economy tracking
      let responseSizeBytes: number | null = null;
      if (result.content && result.content.length > 0 && result.content[0].text) {
        try {
          responseSizeBytes = Buffer.byteLength(result.content[0].text, 'utf8');
        } catch {
          // Ignore — size measurement is best-effort
        }
      }

      logger.logToolCall({
        tenant_id: activeTenantId,
        tenant_id_active: activeTenantId,
        user_id: userId,
        tool_name: toolName,
        status: isError ? 'error' : 'ok',
        error_code: errorCode,
        error_message: errorMessage,
        latency_ms: latency,
        session_id: getSessionId ? getSessionId() : null,
        params_summary: summarizeParams(toolName, params),
        response_size_bytes: responseSizeBytes,
      });

      return result;
    };

    // Replace the last argument (handler) with our wrapped version
    const newArgs = [...args];
    newArgs[lastArgIndex] = wrappedHandler;

    return (originalTool as (...a: unknown[]) => unknown)(...newArgs);
  };
}
