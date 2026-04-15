/**
 * Email template tools for the Nevent MCP Server.
 *
 * Registers 2 tools that read from the `email_templates` MongoDB collection
 * (database `nevent`) scoped to the active tenant:
 *
 *  1. nevent_list_templates — List email templates with optional filtering
 *  2. nevent_get_template   — Full detail of a single template + performance metrics
 *
 * ## Architecture
 *
 * Unlike the analytics tools (which call nev-data-api over HTTP), these tools
 * query MongoDB directly. The MongoClient is a closure-scoped singleton
 * created lazily on first use and reused across invocations.
 *
 * The active tenant ID is read from `dataClient.activeTenantId` (public field).
 * Templates are filtered by `tenantId` and soft-delete is excluded via
 * `{ deletedAt: { $exists: false } }`.
 *
 * ## Tenant guard
 *
 * Both tools fail fast when `activeTenantId` is undefined, because all
 * queries must be scoped to a tenant for data isolation.
 *
 * ## Operation Mode
 *
 * Both tools are READ operations and are therefore permitted in all modes
 * (READ_ONLY, STANDARD, FULL).
 *
 * @module tools/templates
 */

import { MongoClient, ObjectId } from 'mongodb';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DataClient } from '../clients/data-client.js';
import { ok, err, toErrorEnvelope, checkMode } from './helpers.js';
import { ListTemplatesSchema, GetTemplateSchema } from '../schemas/templates.js';

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

/**
 * Register email template tools on the MCP server.
 *
 * Requires a valid `mongoUri` to connect to the `nevent` MongoDB database.
 * Should be called during server initialization after `registerAnalyticsTools`.
 *
 * The MongoClient singleton is scoped to this closure so each call to
 * `registerTemplateTools` creates an isolated connection pool.
 *
 * @param server     — The `McpServer` instance to register tools on.
 * @param mongoUri   — MongoDB connection URI (e.g. from MONGODB_URI env var).
 * @param dataClient — The session's `DataClient` (carries `activeTenantId`).
 */
export function registerTemplateTools(
  server: McpServer,
  mongoUri: string,
  dataClient: DataClient
): void {

  // -------------------------------------------------------------------------
  // MongoDB singleton (closure-scoped — NOT module-level)
  // -------------------------------------------------------------------------

  /** Cached MongoClient instance. Created lazily on first use. */
  let mongoClient: MongoClient | null = null;

  /**
   * Return a connected MongoDB `Db` instance for the `nevent` database.
   *
   * The client is only assigned after a successful connect to avoid caching a
   * broken connection object.
   *
   * @returns The `nevent` Db instance.
   */
  async function getDb() {
    if (!mongoClient) {
      const client = new MongoClient(mongoUri);
      await client.connect();
      mongoClient = client;
    }
    return mongoClient.db('nevent');
  }

  // -------------------------------------------------------------------------
  // Tool 1: nevent_list_templates (READ)
  // -------------------------------------------------------------------------

  server.tool(
    'nevent_list_templates',
    'List email templates for the active tenant. ' +
    'Reads from MongoDB collection email_templates (DB nevent). ' +
    'Params (all optional): tags (array of strings — filter by tag, all must match), ' +
    'content_nature (string — AI classification, e.g. "promotional", "transactional"), ' +
    'limit (max 200, default 50), sort ("createdAt" | "modifiedAt" | "name", default "modifiedAt"), ' +
    'sort_order ("asc" | "desc", default "desc"). ' +
    'Returns: { templates: [{ id, name, format, tags, content_nature, content_nature_confidence, ' +
    'createdAt, createdBy, modifiedAt, modifiedBy }], count }. ' +
    'htmlBody and mjmlBody are excluded from list results — use nevent_get_template for full content. ' +
    'Soft-deleted templates are excluded. ' +
    'Use nevent_switch_tenant first to target a specific tenant.',
    ListTemplatesSchema,
    async (params) => {
      const denied = checkMode('nevent_list_templates');
      if (denied) return err(denied);

      // Fail-fast: tenant is required for data isolation
      const tenantId = dataClient.activeTenantId;
      if (!tenantId) {
        return err({
          error: {
            type: 'invalid_request',
            message: 'No active tenant. Call nevent_switch_tenant first.',
            code: 'tenant_required',
          },
        });
      }

      try {
        const db = await getDb();
        const collection = db.collection('email_templates');

        // Build MongoDB filter — always scope to tenant, always exclude soft-deleted
        const filter: Record<string, unknown> = {
          tenantId,
          deletedAt: { $exists: false },
        };

        // Tag filter: template must contain ALL provided tags
        if (params.tags && params.tags.length > 0) {
          filter['tags'] = { $all: params.tags };
        }

        // Content nature exact match
        if (params.content_nature) {
          filter['content_nature'] = params.content_nature;
        }

        // Build sort specification
        const sortField = params.sort ?? 'modifiedAt';
        const sortDir = params.sort_order === 'asc' ? 1 : -1;

        // Project only the fields needed for list view — omit large body fields
        const projection = {
          _id: 1,
          name: 1,
          format: 1,
          tags: 1,
          content_nature: 1,
          content_nature_confidence: 1,
          createdAt: 1,
          createdBy: 1,
          modifiedAt: 1,
          modifiedBy: 1,
          tenantId: 1,
        };

        const limit = params.limit ?? 50;

        const docs = await collection
          .find(filter, { projection })
          .sort({ [sortField]: sortDir })
          .limit(limit)
          .toArray();

        // Map _id (ObjectId) to plain string id
        const templates = docs.map((doc) => ({
          id: String(doc['_id']),
          name: doc['name'] ?? null,
          format: doc['format'] ?? null,
          tags: Array.isArray(doc['tags']) ? doc['tags'] : [],
          content_nature: doc['content_nature'] ?? null,
          content_nature_confidence: doc['content_nature_confidence'] ?? null,
          createdAt: doc['createdAt'] ?? null,
          createdBy: doc['createdBy'] ?? null,
          modifiedAt: doc['modifiedAt'] ?? null,
          modifiedBy: doc['modifiedBy'] ?? null,
        }));

        return ok({ templates, count: templates.length });
      } catch (caught) {
        return err(toErrorEnvelope(caught));
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool 2: nevent_get_template (READ)
  // -------------------------------------------------------------------------

  server.tool(
    'nevent_get_template',
    'Get full detail of a single email template including HTML and MJML source. ' +
    'Params: template_id (required — get from nevent_list_templates). ' +
    'Returns: { template: { id, name, format, tags, htmlBody, mjmlBody, ' +
    'content_nature, content_nature_confidence, content_nature_reasoning, ' +
    'processedImages, createdAt, createdBy, modifiedAt, modifiedBy, ' +
    'performance?: { performanceScore, metrics: { openRate, clickRate, conversionRate } } } }. ' +
    'The template must belong to the active tenant — cross-tenant access is rejected. ' +
    'Performance metrics are included when available in template_performance_index. ' +
    'htmlBody contains the compiled HTML; mjmlBody contains the MJML source used to generate it.',
    GetTemplateSchema,
    async (params) => {
      const denied = checkMode('nevent_get_template');
      if (denied) return err(denied);

      // Fail-fast: tenant is required for data isolation
      const tenantId = dataClient.activeTenantId;
      if (!tenantId) {
        return err({
          error: {
            type: 'invalid_request',
            message: 'No active tenant. Call nevent_switch_tenant first.',
            code: 'tenant_required',
          },
        });
      }

      try {
        const db = await getDb();
        const collection = db.collection('email_templates');

        // Validate and parse the template ObjectId
        // (schema-level regex ensures format; ObjectId constructor validates further)
        let objectId: ObjectId;
        try {
          objectId = new ObjectId(params.template_id);
        } catch {
          return err({
            error: {
              type: 'invalid_request',
              message: `Invalid template_id "${params.template_id}". Must be a valid MongoDB ObjectId.`,
              code: 'invalid_template_id',
              param: 'template_id',
            },
          });
        }

        // Fetch the template — scope to tenant and exclude soft-deleted
        const doc = await collection.findOne({
          _id: objectId,
          tenantId,
          deletedAt: { $exists: false },
        });

        if (!doc) {
          return err({
            error: {
              type: 'not_found',
              message: `Template "${params.template_id}" not found or does not belong to the active tenant.`,
              code: 'template_not_found',
              param: 'template_id',
            },
          });
        }

        // Build the base template response with all fields
        const template: Record<string, unknown> = {
          id: String(doc['_id']),
          name: doc['name'] ?? null,
          format: doc['format'] ?? null,
          tags: Array.isArray(doc['tags']) ? doc['tags'] : [],
          htmlBody: doc['htmlBody'] ?? null,
          mjmlBody: doc['mjmlBody'] ?? null,
          content_nature: doc['content_nature'] ?? null,
          content_nature_confidence: doc['content_nature_confidence'] ?? null,
          content_nature_reasoning: doc['content_nature_reasoning'] ?? null,
          processedImages: doc['processedImages'] ?? null,
          createdAt: doc['createdAt'] ?? null,
          createdBy: doc['createdBy'] ?? null,
          modifiedAt: doc['modifiedAt'] ?? null,
          modifiedBy: doc['modifiedBy'] ?? null,
        };

        // Enrich with performance metrics from template_performance_index.
        // Use ObjectId for the join (not string) to match the stored reference type.
        const perfCollection = db.collection('template_performance_index');
        const perfDoc = await perfCollection.findOne({
          templateId: objectId,
          tenantId,
        });

        if (perfDoc) {
          template['performance'] = {
            performanceScore: perfDoc['performanceScore'] ?? null,
            metrics: {
              openRate: perfDoc['metrics']?.['openRate'] ?? null,
              clickRate: perfDoc['metrics']?.['clickRate'] ?? null,
              conversionRate: perfDoc['metrics']?.['conversionRate'] ?? null,
            },
          };
        }

        return ok({ template });
      } catch (caught) {
        return err(toErrorEnvelope(caught));
      }
    }
  );
}
