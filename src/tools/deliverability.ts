/**
 * Deliverability tools for the Nevent MCP Server.
 *
 * Registers 2 tools that expose email deliverability diagnostics for
 * the active tenant, querying MongoDB collections in the `nevent` database:
 *
 *  1. nevent_get_sending_profile
 *     Reads warm-up state, throttle settings and validated sending domains
 *     from three MongoDB collections and returns them as a unified profile,
 *     plus the senders a campaign can be sent with and the default sender
 *     (nev-api `GET /sender-identities/campaign-options`, nevent-work#323).
 *
 *  2. nevent_get_suppressions_summary
 *     Counts suppressions and unsubscriptions by reason (lifetime totals)
 *     plus 30-day rolling window counts, from two MongoDB collections.
 *
 * ## MongoDB connection
 *
 * The MongoClient is a closure-scoped singleton, created lazily on first use
 * and reused across tool calls. The client is only assigned after a successful
 * connect to avoid caching a broken connection object.
 *
 * ## Tenant resolution
 *
 * TenantId is read from `dataClient.activeTenantId` (public property, set via
 * `nevent_switch_tenant`). If the field is not set the tool fails fast with a
 * descriptive error asking the caller to switch tenant first.
 *
 * @module tools/deliverability
 */

import { MongoClient, type Db } from 'mongodb';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DataClient } from '../clients/data-client.js';
import { ok, err, toErrorEnvelope, checkMode } from './helpers.js';
import { GetSendingProfileSchema, GetSuppressionsSummarySchema } from '../schemas/deliverability.js';
import { TIMEOUTS } from '../config/timeouts.js';

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

/**
 * Register all deliverability tools on the MCP server.
 *
 * Both tools require a MongoDB URI to connect directly to the `nevent`
 * database. They are registered only when `mongoUri` is provided in the
 * server options; otherwise the server starts without them.
 *
 * The MongoClient singleton is scoped to this closure so each call to
 * `registerDeliverabilityTools` creates an isolated connection pool.
 *
 * Call this function once during server initialization, before connecting
 * the transport.
 *
 * @param server     — The `McpServer` instance to register tools on.
 * @param mongoUri   — MongoDB connection URI for the `nevent` database.
 * @param dataClient — The session's `DataClient` (carries `activeTenantId`).
 * @param neventApiUrl — nev-api base URL; without it the profile has no `senders` section.
 */
export function registerDeliverabilityTools(
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
   * @returns A `Db` handle for the `nevent` database.
   */
  async function getDb(): Promise<Db> {
    if (!mongoClient) {
      const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: TIMEOUTS.MONGO_CONNECT_MS });
      await client.connect();
      mongoClient = client;
    }
    return mongoClient.db('nevent');
  }

  // -------------------------------------------------------------------------
  // Tool 1: nevent_get_sending_profile
  // -------------------------------------------------------------------------
  server.tool(
    'nevent_get_sending_profile',
    'Call this before creating a campaign to verify the tenant is ready to send email. Returns: sender domain(s) and their validation status, warm-up phase (cold/warming/warmed), daily send rate cap, throttle settings, and senders: the senders an email campaign can be sent with (identityId, name, From address, default, selectable and the reasons a sender is not selectable) and the default sender (defaultIdentityId). Pass a selectable identityId as sender_identity_id to nevent_create_campaign to send with that sender; omit it to use the default. senders.perCampaign=false means the organization does not choose the sender per campaign: every campaign uses its sender. If the sending profile is not validated or still in warm-up, warn the user before scheduling a large campaign. Combine with nevent_get_suppressions_summary for a full deliverability health check.',
    GetSendingProfileSchema,
    { title: 'Get sending profile', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async (_params) => {
      const denied = checkMode('nevent_get_sending_profile');
      if (denied) return err(denied);

      // Fail-fast: tenant is required for data isolation
      const tenantId = dataClient.activeTenantId;
      if (!tenantId) {
        return err({
          error: {
            type: 'invalid_request',
            message:
              'No active tenant set. Call nevent_switch_tenant first to select a tenant, ' +
              'or use nevent_list_tenants to discover available tenant IDs.',
            code: 'tenant_required',
          },
        });
      }

      try {
        const db = await getDb();

        // ----------------------------------------------------------------
        // 1. Fetch tenantSendingProfiles document for this tenant
        // ----------------------------------------------------------------
        const profileDoc = await db
          .collection('tenantSendingProfiles')
          .findOne({ tenantId });

        // ----------------------------------------------------------------
        // 2. Fetch email_throttle_settings document for this tenant
        // ----------------------------------------------------------------
        const throttleDoc = await db
          .collection('email_throttle_settings')
          .findOne({ tenantId });

        // ----------------------------------------------------------------
        // 3. Fetch all validated domains for this tenant
        // ----------------------------------------------------------------
        const domainDocs = await db
          .collection('validated_domains')
          .find({ tenantId })
          .toArray();

        // ----------------------------------------------------------------
        // Build unified response — only include fields that exist in the doc
        // ----------------------------------------------------------------
        const result: Record<string, unknown> = { tenantId };

        // From tenantSendingProfiles
        if (profileDoc) {
          if (profileDoc['configuredRate'] !== undefined) result['configuredRate'] = profileDoc['configuredRate'];
          if (profileDoc['warmupDay'] !== undefined) result['warmupDay'] = profileDoc['warmupDay'];
          if (profileDoc['warmupStartDate'] !== undefined) result['warmupStartDate'] = profileDoc['warmupStartDate'];
          if (profileDoc['timezone'] !== undefined) result['timezone'] = profileDoc['timezone'];
          if (profileDoc['health'] !== undefined) result['health'] = profileDoc['health'];
          if (profileDoc['healthModifier'] !== undefined) result['healthModifier'] = profileDoc['healthModifier'];
        }

        // From email_throttle_settings
        if (throttleDoc) {
          const throttle: Record<string, unknown> = {};
          if (throttleDoc['currentSendRate'] !== undefined) throttle['currentSendRate'] = throttleDoc['currentSendRate'];
          if (throttleDoc['batchSize'] !== undefined) throttle['batchSize'] = throttleDoc['batchSize'];
          if (throttleDoc['delayBetweenBatches'] !== undefined) throttle['delayBetweenBatches'] = throttleDoc['delayBetweenBatches'];
          if (throttleDoc['maxSendRate'] !== undefined) throttle['maxSendRate'] = throttleDoc['maxSendRate'];
          if (throttleDoc['minSendRate'] !== undefined) throttle['minSendRate'] = throttleDoc['minSendRate'];
          if (throttleDoc['warmupMode'] !== undefined) throttle['warmupMode'] = throttleDoc['warmupMode'];
          result['throttle'] = throttle;
        }

        // From validated_domains — map to clean shape
        result['domains'] = domainDocs.map((doc) => ({
          domain: doc['domain'],
          valid: doc['valid'],
          validatedAt: doc['validatedAt'],
          lastCheckedAt: doc['lastCheckedAt'],
        }));

        // Senders a campaign can be sent with, and the default one (nevent-work#323)
        if (neventApiUrl) {
          result['senders'] = await campaignSenders(neventApiUrl, dataClient.getJwtToken());
        }

        return ok(result);
      } catch (caught) {
        return err(toErrorEnvelope(caught));
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool 2: nevent_get_suppressions_summary
  // -------------------------------------------------------------------------
  server.tool(
    'nevent_get_suppressions_summary',
    'Get a deliverability health snapshot for the active tenant: total suppressed emails (hard bounces + complaints + manual unsubscribes), 30-day trend, and breakdown by suppression reason. Call this when the user asks about list health, unsubscribe rates, or bounce issues. A suppression rate above 2% indicates deliverability risk — surface this as a warning before scheduling a large campaign.',
    GetSuppressionsSummarySchema,
    { title: 'Get suppressions summary', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async (_params) => {
      const denied = checkMode('nevent_get_suppressions_summary');
      if (denied) return err(denied);

      // Fail-fast: tenant is required for data isolation
      const tenantId = dataClient.activeTenantId;
      if (!tenantId) {
        return err({
          error: {
            type: 'invalid_request',
            message:
              'No active tenant set. Call nevent_switch_tenant first to select a tenant, ' +
              'or use nevent_list_tenants to discover available tenant IDs.',
            code: 'tenant_required',
          },
        });
      }

      try {
        const db = await getDb();

        // Date threshold: 30 days ago
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        // ----------------------------------------------------------------
        // 1. email_suppressions — only active suppressions
        // ----------------------------------------------------------------
        const suppressionBaseFilter = { tenantId, active: true };

        // Total active suppressions
        const totalSuppressions = await db
          .collection('email_suppressions')
          .countDocuments(suppressionBaseFilter);

        // Suppressions in last 30 days
        const suppressionsLast30d = await db
          .collection('email_suppressions')
          .countDocuments({
            ...suppressionBaseFilter,
            createdAt: { $gt: thirtyDaysAgo },
          });

        // Group by reason — lifetime totals
        const suppressionsByReasonPipeline = await db
          .collection('email_suppressions')
          .aggregate([
            { $match: suppressionBaseFilter },
            { $group: { _id: '$reason', count: { $sum: 1 } } },
          ])
          .toArray();

        const suppressionsByReason: Record<string, number> = {};
        for (const item of suppressionsByReasonPipeline) {
          const reasonKey = (item['_id'] as string | null) ?? 'unknown';
          suppressionsByReason[reasonKey] = item['count'] as number;
        }

        // ----------------------------------------------------------------
        // 2. email_unsubscriptions
        // ----------------------------------------------------------------
        const unsubBaseFilter = { tenantId };

        // Total unsubscriptions
        const totalUnsubscriptions = await db
          .collection('email_unsubscriptions')
          .countDocuments(unsubBaseFilter);

        // Unsubscriptions in last 30 days
        const unsubscriptionsLast30d = await db
          .collection('email_unsubscriptions')
          .countDocuments({
            ...unsubBaseFilter,
            createdAt: { $gt: thirtyDaysAgo },
          });

        // Group by reason — lifetime totals; prefer `reason`, fall back to `reasonLegacy`
        const unsubsByReasonPipeline = await db
          .collection('email_unsubscriptions')
          .aggregate([
            { $match: unsubBaseFilter },
            {
              $project: {
                resolvedReason: {
                  $ifNull: ['$reason', { $ifNull: ['$reasonLegacy', 'unknown'] }],
                },
              },
            },
            { $group: { _id: '$resolvedReason', count: { $sum: 1 } } },
          ])
          .toArray();

        const unsubsByReason: Record<string, number> = {};
        for (const item of unsubsByReasonPipeline) {
          const reasonKey = (item['_id'] as string | null) ?? 'unknown';
          unsubsByReason[reasonKey] = item['count'] as number;
        }

        // ----------------------------------------------------------------
        // Build unified response
        // ----------------------------------------------------------------
        const result = {
          suppressions: {
            total: totalSuppressions,
            last_30d: suppressionsLast30d,
            by_reason: suppressionsByReason,
          },
          unsubscriptions: {
            total: totalUnsubscriptions,
            last_30d: unsubscriptionsLast30d,
            by_reason: unsubsByReason,
          },
        };

        return ok(result);
      } catch (caught) {
        return err(toErrorEnvelope(caught));
      }
    }
  );
}

// ---------------------------------------------------------------------------
// Senders per campaign (nevent-work#323)
// ---------------------------------------------------------------------------

/** One sender as `nevent_get_sending_profile` returns it. */
export interface CampaignSenderOption {
  identityId: string;
  displayName: string | null;
  fromEmail: string | null;
  replyTo: string | null;
  domain: string | null;
  state: string;
  default: boolean;
  selectable: boolean;
  /** Why it is not selectable (nev-api blocker codes); empty when it is. */
  blockers: string[];
  warnings: string[];
}

/** The `senders` section of the sending profile. */
export interface CampaignSenders {
  perCampaign: boolean;
  defaultIdentityId: string | null;
  senders: CampaignSenderOption[];
  error?: string;
}

function codesOf(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((entry) => (entry !== null && typeof entry === 'object' ? (entry as Record<string, unknown>)['code'] : entry))
    .filter((code): code is string => typeof code === 'string');
}

/**
 * The senders an email campaign of the active tenant can be sent with, from nev-api
 * `GET /sender-identities/campaign-options` (the same list the campaign editor shows). Never throws: when the
 * call fails the section says so (`error`) and the rest of the profile is still returned.
 *
 * @param neventApiUrl — nev-api base URL.
 * @param jwtToken     — the session's token; without it the section reports the error.
 * @param fetchImpl    — injectable for tests.
 */
export async function campaignSenders(
  neventApiUrl: string,
  jwtToken: string | null | undefined,
  fetchImpl: typeof fetch = fetch
): Promise<CampaignSenders> {
  const unavailable = (error: string): CampaignSenders => ({
    perCampaign: false, defaultIdentityId: null, senders: [], error,
  });
  if (!jwtToken) return unavailable('missing_token');
  try {
    const response = await fetchImpl(`${neventApiUrl}/sender-identities/campaign-options`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${jwtToken}` },
      signal: AbortSignal.timeout(TIMEOUTS.LONG_MS),
    });
    if (!response.ok) return unavailable(`HTTP ${response.status}`);
    const body = (await response.json()) as Record<string, unknown>;
    const options = Array.isArray(body['senders']) ? (body['senders'] as Array<Record<string, unknown>>) : [];
    return {
      perCampaign: body['enabled'] === true,
      defaultIdentityId: typeof body['defaultIdentityId'] === 'string' ? body['defaultIdentityId'] : null,
      senders: options.map((option) => {
        const evaluation = (option['evaluation'] ?? {}) as Record<string, unknown>;
        return {
          identityId: String(option['identityId']),
          displayName: typeof option['displayName'] === 'string' ? option['displayName'] : null,
          fromEmail: typeof option['fromEmail'] === 'string' ? option['fromEmail'] : null,
          replyTo: typeof option['replyTo'] === 'string' ? option['replyTo'] : null,
          domain: typeof option['domain'] === 'string' ? option['domain'] : null,
          state: String(option['state']),
          default: option['default'] === true,
          selectable: option['selectable'] === true,
          blockers: codesOf(evaluation['blockers']),
          warnings: codesOf(evaluation['warnings']),
        };
      }),
    };
  } catch (caught) {
    return unavailable(caught instanceof Error ? caught.name : 'request_failed');
  }
}
