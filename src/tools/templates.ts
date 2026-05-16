/**
 * Email template tools for the Nevent MCP Server.
 *
 * Registers 4 tools:
 *
 *  1. nevent_list_templates   — List email templates with optional filtering (READ, MongoDB)
 *  2. nevent_get_template     — Full detail of a single template + performance metrics (READ, MongoDB)
 *  3. nevent_create_template  — Create a new email template via nev-api (WRITE)
 *  4. nevent_update_template  — Update an existing email template via nev-api (WRITE)
 *
 * ## Architecture
 *
 * Read tools (list/get) query MongoDB directly. The MongoClient is a
 * closure-scoped singleton created lazily on first use and reused across
 * invocations.
 *
 * Write tools (create/update) call nev-api (Java Spring Boot) over HTTP using
 * the JWT token extracted from `dataClient`. This is the same pattern used by
 * `registerSegmentTools` in `src/tools/segments.ts`.
 *
 * The active tenant ID is read from `dataClient.activeTenantId` (public field).
 * Read tools filter by `tenantId` and exclude soft-deleted documents via
 * `{ deletedAt: { $exists: false } }`.
 *
 * ## Tenant guard
 *
 * Read tools fail fast when `activeTenantId` is undefined, because all
 * MongoDB queries must be scoped to a tenant for data isolation.
 *
 * ## Operation Mode
 *
 * - `nevent_list_templates`  → READ  — permitted in all modes.
 * - `nevent_get_template`    → READ  — permitted in all modes.
 * - `nevent_create_template` → WRITE — blocked in READ_ONLY mode.
 * - `nevent_update_template` → WRITE — blocked in READ_ONLY mode.
 *
 * ## Audit Logging
 *
 * Write operations emit a structured `console.error` audit log entry with:
 * toolName, tenantId, timestamp, operation, outcome, and templateId.
 *
 * @module tools/templates
 */

import { MongoClient, ObjectId } from 'mongodb';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DataClient } from '../clients/data-client.js';
import { ok, err, toErrorEnvelope, checkMode } from './helpers.js';
import { TIMEOUTS } from '../config/timeouts.js';
import {
  ListTemplatesSchema,
  GetTemplateSchema,
  CreateTemplateSchema,
  UpdateTemplateSchema,
} from '../schemas/templates.js';

// ---------------------------------------------------------------------------
// Helper: extract JWT token from DataClient
// ---------------------------------------------------------------------------

/**
 * Extract the JWT bearer token from a `DataClient` instance.
 *
 * `DataClient` inherits `jwtToken` as a protected member from `BaseClient`.
 * We access it via an unsafe cast — the same pattern used in `segments.ts` —
 * because nev-api and nev-data-api share the same bearer token.
 *
 * @param client — The session's DataClient.
 * @returns The raw JWT string for use in Authorization headers.
 */
function extractJwt(client: DataClient): string {
  return (client as unknown as { jwtToken: string }).jwtToken;
}

// ---------------------------------------------------------------------------
// Helper: project a raw template record for write-operation responses
// ---------------------------------------------------------------------------

/**
 * Project a raw template record returned by nev-api to the fields exposed
 * by MCP write-tool responses.
 *
 * We only expose a curated subset to keep the MCP response compact and avoid
 * leaking internal fields. The `_id` MongoDB field is mapped to `id` if the
 * API has not already done the conversion.
 *
 * @param raw — Raw template record from nev-api.
 * @returns Projected template with id, name, and format.
 */
function projectTemplate(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(raw['id'] ?? raw['_id'] ?? ''),
    name: raw['name'] !== undefined ? String(raw['name']) : null,
    format: raw['format'] !== undefined ? String(raw['format']) : null,
    tags: Array.isArray(raw['tags']) ? raw['tags'] : [],
  };
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

/**
 * Register all email template tools on the MCP server.
 *
 * Read tools (list/get) require `mongoUri` to connect to the `nevent` database.
 * Write tools (create/update) require `neventApiUrl` to call nev-api.
 *
 * Should be called during server initialization after `registerAnalyticsTools`.
 *
 * The MongoClient singleton is scoped to this closure so each call to
 * `registerTemplateTools` creates an isolated connection pool.
 *
 * @param server        — The `McpServer` instance to register tools on.
 * @param mongoUri      — MongoDB connection URI (e.g. from MONGODB_URI env var).
 * @param dataClient    — The session's `DataClient` (carries JWT + activeTenantId).
 * @param neventApiUrl  — Base URL of nev-api, e.g. `https://api.nevent.es`.
 *                        When provided, write tools (create/update) are registered.
 *                        When omitted, only read tools are registered.
 */
export function registerTemplateTools(
  server: McpServer,
  mongoUri: string,
  dataClient: DataClient,
  neventApiUrl?: string
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
      const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: TIMEOUTS.MONGO_CONNECT_MS });
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
    'Call this to discover available email templates before creating a campaign. Returns templates for the active tenant: id, name, tags, and whether they use MJML or HTML. Use the returned template id in nevent_create_campaign. Call nevent_get_template to inspect the full HTML/MJML source of a specific template.',
    ListTemplatesSchema,
    { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
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
    'Retrieve the full content of an email template: MJML source, rendered HTML, subject line, tags, and usage metrics (how many campaigns used this template). Call this after nevent_list_templates when the user wants to inspect, copy, or modify a template. Next step: nevent_update_template to change the content, or nevent_create_campaign to use this template in a new campaign.',
    GetTemplateSchema,
    { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
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
              message: `Invalid template_id "${params.template_id}". Must be a valid 24-character hex identifier.`,
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

  // -------------------------------------------------------------------------
  // Write tools: only registered when neventApiUrl is provided
  // -------------------------------------------------------------------------

  if (!neventApiUrl) {
    return;
  }

  // -------------------------------------------------------------------------
  // Tool 3: nevent_create_template (WRITE)
  // -------------------------------------------------------------------------

  server.tool(
    'nevent_create_template',
    'Create and persist a new email template with MJML or raw HTML content. Prefer MJML for responsive email (set content_type="MJML"). The template is saved and available for reuse across campaigns. After creation, call nevent_create_campaign with the returned template id to send it to a segment.',
    CreateTemplateSchema,
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async (params) => {
      const denied = checkMode('nevent_create_template');
      if (denied) return err(denied);

      const jwtToken = extractJwt(dataClient);
      const tenantId = dataClient.activeTenantId;

      try {
        const url = new URL(`${neventApiUrl}/templates`);
        // Disable server-side validation guards — let the agent supply raw content
        url.searchParams.set('ensureValidation', 'false');
        url.searchParams.set('strict', 'false');
        url.searchParams.set('force', 'false');

        // Build request body from provided params — only include optional fields
        // when explicitly supplied to avoid overwriting server defaults with nulls.
        const requestBody: Record<string, unknown> = {
          name: params.name,
          format: params.format,
        };

        if (params.mjml_body !== undefined) {
          requestBody['mjmlBody'] = params.mjml_body;
        }

        if (params.html_body !== undefined) {
          requestBody['htmlBody'] = params.html_body;
        }

        if (params.tags !== undefined) {
          requestBody['tags'] = params.tags;
        }

        const response = await fetch(url.toString(), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${jwtToken}`,
          },
          body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout(TIMEOUTS.LONG_MS),
        });

        if (!response.ok) {
          const body = await response.text();
          return err({
            error: {
              type:
                response.status === 401 || response.status === 403
                  ? 'authentication_error'
                  : response.status === 400
                    ? 'invalid_request'
                    : 'api_error',
              message:
                response.status === 403
                  ? 'Access denied. Creating templates requires sufficient permissions.'
                  : response.status === 401
                    ? 'Authentication failed. JWT token may be expired or invalid.'
                    : `Failed to create template: HTTP ${response.status}. ${body}`,
              code:
                response.status === 403
                  ? 'forbidden'
                  : response.status === 401
                    ? 'unauthorized'
                    : response.status === 400
                      ? 'invalid_template'
                      : 'api_error',
            },
          });
        }

        const data = await response.json() as unknown;

        // nev-api may wrap the created resource in an envelope or return it directly.
        const rawTemplate =
          data !== null &&
          typeof data === 'object' &&
          'template' in (data as Record<string, unknown>)
            ? (data as Record<string, unknown>)['template'] as Record<string, unknown>
            : (data as Record<string, unknown>);

        const template = projectTemplate(rawTemplate);

        // Audit log for write operation
        console.error(
          JSON.stringify({
            audit: true,
            tool: 'nevent_create_template',
            tenantId: tenantId ?? 'default',
            timestamp: new Date().toISOString(),
            operation: 'create',
            outcome: 'success',
            templateId: template['id'],
            templateName: template['name'],
          })
        );

        return ok({ template });
      } catch (caught) {
        return err(toErrorEnvelope(caught));
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool 4: nevent_update_template (WRITE)
  // -------------------------------------------------------------------------

  server.tool(
    'nevent_update_template',
    'Update an existing email template: change the name, MJML/HTML content, or tags. Call nevent_get_template first to inspect the current version before modifying. At least one of name, content, or tags must be provided. Note: updating a template does NOT retroactively change campaigns already sent with it.',
    UpdateTemplateSchema,
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async (params) => {
      const denied = checkMode('nevent_update_template');
      if (denied) return err(denied);

      // Runtime validation: at least one field to update must be provided.
      const updatableFields = ['name', 'format', 'mjml_body', 'html_body', 'tags'] as const;
      const hasUpdate = updatableFields.some(
        (field) => params[field as keyof typeof params] !== undefined
      );

      if (!hasUpdate) {
        return err({
          error: {
            type: 'invalid_request',
            message:
              'At least one of "name", "format", "mjml_body", "html_body", or "tags" ' +
              'must be provided for nevent_update_template.',
            code: 'missing_update_fields',
            param: 'name',
          },
        });
      }

      const jwtToken = extractJwt(dataClient);
      const tenantId = dataClient.activeTenantId;

      try {
        const url = new URL(
          `${neventApiUrl}/templates/${encodeURIComponent(params.template_id)}`
        );

        // Build request body — only include fields that were explicitly provided.
        const requestBody: Record<string, unknown> = {};

        if (params.name !== undefined) {
          requestBody['name'] = params.name;
        }

        if (params.format !== undefined) {
          requestBody['format'] = params.format;
        }

        if (params.mjml_body !== undefined) {
          requestBody['mjmlBody'] = params.mjml_body;
        }

        if (params.html_body !== undefined) {
          requestBody['htmlBody'] = params.html_body;
        }

        if (params.tags !== undefined) {
          requestBody['tags'] = params.tags;
        }

        const response = await fetch(url.toString(), {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${jwtToken}`,
          },
          body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout(TIMEOUTS.LONG_MS),
        });

        if (!response.ok) {
          const body = await response.text();
          return err({
            error: {
              type:
                response.status === 404
                  ? 'not_found'
                  : response.status === 401 || response.status === 403
                    ? 'authentication_error'
                    : response.status === 400
                      ? 'invalid_request'
                      : 'api_error',
              message:
                response.status === 404
                  ? `Template "${params.template_id}" not found or does not belong to the active tenant.`
                  : response.status === 403
                    ? 'Access denied. Updating templates requires sufficient permissions.'
                    : response.status === 401
                      ? 'Authentication failed. JWT token may be expired or invalid.'
                      : `Failed to update template: HTTP ${response.status}. ${body}`,
              code:
                response.status === 404
                  ? 'template_not_found'
                  : response.status === 403
                    ? 'forbidden'
                    : response.status === 401
                      ? 'unauthorized'
                      : response.status === 400
                        ? 'invalid_template'
                        : 'api_error',
            },
          });
        }

        const data = await response.json() as unknown;

        // nev-api may wrap the updated resource in an envelope or return it directly.
        const rawTemplate =
          data !== null &&
          typeof data === 'object' &&
          'template' in (data as Record<string, unknown>)
            ? (data as Record<string, unknown>)['template'] as Record<string, unknown>
            : (data as Record<string, unknown>);

        const template = projectTemplate(rawTemplate);

        // Audit log for write operation
        const updatedFields = updatableFields.filter(
          (field) => params[field as keyof typeof params] !== undefined
        );

        console.error(
          JSON.stringify({
            audit: true,
            tool: 'nevent_update_template',
            tenantId: tenantId ?? 'default',
            timestamp: new Date().toISOString(),
            operation: 'update',
            outcome: 'success',
            templateId: params.template_id,
            updatedFields,
          })
        );

        return ok({ template });
      } catch (caught) {
        return err(toErrorEnvelope(caught));
      }
    }
  );
}
