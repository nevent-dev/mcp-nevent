/**
 * Sprint 2: Campaign tools for the Nevent MCP Server.
 *
 * Registers 3 tools that query MongoDB directly (collection `campaign` and
 * related insight collections in the `nevent` database):
 *
 *  1. nevent_list_campaigns         — List campaigns with optional filters
 *  2. nevent_get_campaign           — Fetch full detail of a single campaign
 *  3. nevent_get_campaign_insights  — AI insights + anomalies for a campaign
 *
 * ## Architecture
 *
 * Unlike the Sprint 1 tools (which delegate to nev-data-api over HTTP), these
 * tools connect directly to MongoDB. This is intentional: campaign data lives
 * in MongoDB and there is no HTTP API for it in the current stack.
 *
 * A single `MongoClient` is created per register call (closure-scoped
 * singleton) and reused lazily across all tool invocations.
 *
 * ## Tenant isolation
 *
 * All queries include a `tenantId` filter derived from
 * `DataClient.activeTenantId`. This ensures that a user can only access
 * campaigns belonging to the tenant they are currently operating as.
 * If no active tenant is set, tools return an error immediately (fail-fast).
 *
 * ## Operation mode
 *
 * All three tools are READ operations and are therefore permitted in every
 * operation mode (READ_ONLY, STANDARD, FULL).
 *
 * @module tools/campaigns
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MongoClient, ObjectId } from 'mongodb';
import type { DataClient } from '../clients/data-client.js';
import { ok, err, toErrorEnvelope, checkMode } from './helpers.js';
import {
  ListCampaignsSchema,
  GetCampaignSchema,
  GetCampaignInsightsSchema,
} from '../schemas/campaigns.js';

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

/**
 * Register all Sprint 2 campaign tools on the MCP server.
 *
 * Call this function once during server initialisation before connecting
 * the transport. The function requires a valid `mongoUri` — if it is absent
 * the tools will not be registered.
 *
 * The MongoClient singleton is scoped to this closure so each call to
 * `registerCampaignTools` creates an isolated connection pool.
 *
 * @param server     — The `McpServer` instance to register tools on.
 * @param mongoUri   — Full MongoDB connection URI for direct DB access.
 * @param dataClient — The `DataClient` instance; used to read `activeTenantId`.
 */
export function registerCampaignTools(
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
   * The client is created once and reused for subsequent calls. The client
   * is only assigned after a successful connect to avoid caching a broken
   * connection object.
   *
   * @returns A connected `Db` handle for the `nevent` database.
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
  // Tool 1: nevent_list_campaigns (NEV-1581)
  // -------------------------------------------------------------------------
  server.tool(
    'nevent_list_campaigns',
    'List campaigns for the active tenant from MongoDB. ' +
    'All params optional. Params: ' +
    'status (EXECUTED|DRAFT|PAUSED|STOPPED|SCHEDULED), ' +
    'channel (EMAIL|SMS|WHATSAPP), ' +
    'date_from (ISO 8601 datetime — campaigns created on/after), ' +
    'date_to (ISO 8601 datetime — campaigns created on/before), ' +
    'limit (default 50, max 200), ' +
    'sort (createdAt|executedAt|name, default createdAt), ' +
    'sort_order (asc|desc, default desc). ' +
    'Returns: { campaigns: [{ id, name, status, channel, emailSubject, fromName, ' +
    'totalRecipients, createdAt, executedAt, metrics: { email_sent, email_delivered, ' +
    'opens, clicks, bounces, unsubscribes, email_complaints, purchases, revenue } }], count }. ' +
    'Requires active tenant (call nevent_switch_tenant first).',
    ListCampaignsSchema,
    async (params) => {
      const denied = checkMode('nevent_list_campaigns');
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
        const collection = db.collection('campaign');

        // Build MongoDB filter — always scope to tenant
        const filter: Record<string, unknown> = { tenantId };

        if (params.status) {
          filter['status'] = params.status;
        }
        if (params.channel) {
          filter['channel'] = params.channel;
        }
        if (params.date_from || params.date_to) {
          const dateFilter: Record<string, unknown> = {};
          if (params.date_from) {
            dateFilter['$gte'] = new Date(params.date_from);
          }
          if (params.date_to) {
            dateFilter['$lte'] = new Date(params.date_to);
          }
          filter['createdAt'] = dateFilter;
        }

        // Build sort
        const sortField = params.sort ?? 'createdAt';
        const sortDirection = params.sort_order === 'asc' ? 1 : -1;
        const sort: Record<string, 1 | -1> = { [sortField]: sortDirection };

        // Projection — only the fields needed for the list view
        const projection = {
          _id: 1,
          name: 1,
          status: 1,
          channel: 1,
          emailSubject: 1,
          fromName: 1,
          totalRecipients: 1,
          createdAt: 1,
          executedAt: 1,
          // Email metrics
          email_sent: 1,
          email_delivered: 1,
          opens: 1,
          clicks: 1,
          bounces: 1,
          unsubscribes: 1,
          email_complaints: 1,
          purchases: 1,
          revenue: 1,
        };

        const limit = params.limit ?? 50;
        const rawDocs = await collection
          .find(filter, { projection })
          .sort(sort)
          .limit(limit)
          .toArray();

        const campaigns = rawDocs.map((doc) => ({
          id: doc['_id']?.toString() ?? '',
          name: doc['name'] ?? null,
          status: doc['status'] ?? null,
          channel: doc['channel'] ?? null,
          emailSubject: doc['emailSubject'] ?? null,
          fromName: doc['fromName'] ?? null,
          totalRecipients: doc['totalRecipients'] ?? null,
          createdAt: doc['createdAt'] ?? null,
          executedAt: doc['executedAt'] ?? null,
          metrics: {
            email_sent: doc['email_sent'] ?? 0,
            email_delivered: doc['email_delivered'] ?? 0,
            opens: doc['opens'] ?? 0,
            clicks: doc['clicks'] ?? 0,
            bounces: doc['bounces'] ?? 0,
            unsubscribes: doc['unsubscribes'] ?? 0,
            email_complaints: doc['email_complaints'] ?? 0,
            purchases: doc['purchases'] ?? 0,
            revenue: doc['revenue'] ?? 0,
          },
        }));

        return ok({ campaigns, count: campaigns.length });
      } catch (caught) {
        return err(toErrorEnvelope(caught));
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool 2: nevent_get_campaign (NEV-1582)
  // -------------------------------------------------------------------------
  server.tool(
    'nevent_get_campaign',
    'Get complete details of a single campaign by ID from MongoDB. ' +
    'Params: campaign_id (required — MongoDB ObjectId string). ' +
    'Returns all campaign fields including full emailBody HTML, all delivery metrics, ' +
    'tracked_links, scheduling info, and audit fields. ' +
    'Verifies that the campaign belongs to the active tenant. ' +
    'Requires active tenant (call nevent_switch_tenant first).',
    GetCampaignSchema,
    async (params) => {
      const denied = checkMode('nevent_get_campaign');
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
        const collection = db.collection('campaign');

        // Parse and validate the campaign ObjectId
        let objectId: ObjectId;
        try {
          objectId = new ObjectId(params.campaign_id);
        } catch {
          return err({
            error: {
              type: 'invalid_request',
              message: `Invalid campaign_id: "${params.campaign_id}" is not a valid MongoDB ObjectId.`,
              code: 'invalid_id',
            },
          });
        }

        // Query with tenant isolation
        const doc = await collection.findOne({
          _id: objectId,
          tenantId,
        });

        if (!doc) {
          return err({
            error: {
              type: 'not_found',
              message:
                `Campaign "${params.campaign_id}" not found for the active tenant. ` +
                'Verify the campaign_id and ensure nevent_switch_tenant has been called ' +
                'with the correct tenant.',
              code: 'campaign_not_found',
            },
          });
        }

        // Map to a clean, documented response shape
        const campaign = {
          id: doc['_id']?.toString() ?? '',
          name: doc['name'] ?? null,
          status: doc['status'] ?? null,
          channel: doc['channel'] ?? null,
          active_channels: doc['active_channels'] ?? null,

          // Email content
          emailSubject: doc['emailSubject'] ?? null,
          previewText: doc['previewText'] ?? null,
          fromName: doc['fromName'] ?? null,
          mailFrom: doc['mailFrom'] ?? null,
          emailBody: doc['emailBody'] ?? null,

          // SMS/WhatsApp content
          message: doc['message'] ?? null,

          // Targeting
          segmentIds: doc['segmentIds'] ?? [],
          totalRecipients: doc['totalRecipients'] ?? null,

          // Scheduling
          scheduledTime: doc['scheduledTime'] ?? null,
          executedAt: doc['executedAt'] ?? null,
          executing_started_at: doc['executing_started_at'] ?? null,
          executing_finished_at: doc['executing_finished_at'] ?? null,

          // Full metrics
          metrics: {
            // Email metrics
            email_sent: doc['email_sent'] ?? 0,
            email_delivered: doc['email_delivered'] ?? 0,
            email_bounced: doc['email_bounced'] ?? 0,
            email_rejected: doc['email_rejected'] ?? 0,
            email_complaints: doc['email_complaints'] ?? 0,
            // SMS metrics
            sms_sent: doc['sms_sent'] ?? 0,
            sms_delivered: doc['sms_delivered'] ?? 0,
            sms_failed: doc['sms_failed'] ?? 0,
            // WhatsApp metrics
            whatsapp_sent: doc['whatsapp_sent'] ?? 0,
            whatsapp_delivered: doc['whatsapp_delivered'] ?? 0,
            whatsapp_read: doc['whatsapp_read'] ?? 0,
            // Engagement metrics
            opens: doc['opens'] ?? 0,
            clicks: doc['clicks'] ?? 0,
            bounces: doc['bounces'] ?? 0,
            unsubscribes: doc['unsubscribes'] ?? 0,
            // Conversion metrics
            purchases: doc['purchases'] ?? 0,
            revenue: doc['revenue'] ?? 0,
          },

          // Link tracking
          tracked_links: doc['tracked_links'] ?? [],

          // Audit fields
          createdAt: doc['createdAt'] ?? null,
          createdBy: doc['createdBy'] ?? null,
          modifiedAt: doc['modifiedAt'] ?? null,
        };

        return ok(campaign);
      } catch (caught) {
        return err(toErrorEnvelope(caught));
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool 3: nevent_get_campaign_insights (NEV-1582)
  // -------------------------------------------------------------------------
  server.tool(
    'nevent_get_campaign_insights',
    'Get AI-generated insights and anomaly detections for a campaign. ' +
    'Params: campaign_id (required — MongoDB ObjectId string). ' +
    'Queries two MongoDB collections: ' +
    '  campaign_insights: insights, recommendations, performanceSummary, benchmarkComparison; ' +
    '  campaign_anomalies: list of detected anomalies with anomalyType, metric, severity, ' +
    'expectedValue, actualValue, deviationPercent. ' +
    'Returns: { campaign_id, insights: {...} | null, anomalies: [...] }. ' +
    'If no insights or anomalies exist yet, the respective field will be null/empty. ' +
    'Requires active tenant (call nevent_switch_tenant first).',
    GetCampaignInsightsSchema,
    async (params) => {
      const denied = checkMode('nevent_get_campaign_insights');
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

        // Parse and validate the campaign ObjectId
        let objectId: ObjectId;
        try {
          objectId = new ObjectId(params.campaign_id);
        } catch {
          return err({
            error: {
              type: 'invalid_request',
              message: `Invalid campaign_id: "${params.campaign_id}" is not a valid MongoDB ObjectId.`,
              code: 'invalid_id',
            },
          });
        }

        // Verify the campaign exists and belongs to this tenant
        const campaignExists = await db.collection('campaign').findOne(
          { _id: objectId, tenantId },
          { projection: { _id: 1 } }
        );

        if (!campaignExists) {
          return err({
            error: {
              type: 'not_found',
              message:
                `Campaign "${params.campaign_id}" not found for the active tenant. ` +
                'Verify the campaign_id and ensure nevent_switch_tenant has been called ' +
                'with the correct tenant.',
              code: 'campaign_not_found',
            },
          });
        }

        // Query both insight collections in parallel
        // Use ObjectId for campaign_insights lookup (proper join)
        const [insightsDoc, anomalyDocs] = await Promise.all([
          db.collection('campaign_insights').findOne({ campaignId: objectId, tenantId }),
          db.collection('campaign_anomalies').find({ campaignId: objectId, tenantId }).toArray(),
        ]);

        // Shape insights response — null if no document found
        const insights = insightsDoc
          ? {
              insights: insightsDoc['insights'] ?? null,
              recommendations: insightsDoc['recommendations'] ?? null,
              performanceSummary: insightsDoc['performanceSummary'] ?? null,
              benchmarkComparison: insightsDoc['benchmarkComparison'] ?? null,
              generatedAt: insightsDoc['generatedAt'] ?? null,
            }
          : null;

        // Shape anomalies — empty array if none found
        const anomalies = anomalyDocs.map((a) => ({
          id: a['_id']?.toString() ?? '',
          anomalyType: a['anomalyType'] ?? null,
          metric: a['metric'] ?? null,
          severity: a['severity'] ?? null,
          expectedValue: a['expectedValue'] ?? null,
          actualValue: a['actualValue'] ?? null,
          deviationPercent: a['deviationPercent'] ?? null,
          detectedAt: a['detectedAt'] ?? null,
        }));

        return ok({
          campaign_id: params.campaign_id,
          insights,
          anomalies,
          anomaly_count: anomalies.length,
        });
      } catch (caught) {
        return err(toErrorEnvelope(caught));
      }
    }
  );
}
