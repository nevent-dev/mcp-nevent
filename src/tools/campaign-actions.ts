/**
 * Campaign action tools for the Nevent MCP Server (NEV-1585).
 *
 * Registers 2 write/admin tools that interact with nev-api campaign endpoints:
 *
 *  1. nevent_create_campaign  — Create a campaign in DRAFT state
 *  2. nevent_schedule_campaign — Schedule a DRAFT campaign for future delivery
 *
 * ## Guardrails
 *
 * ### nevent_create_campaign
 * - Status is ALWAYS hardcoded to "DRAFT". The agent cannot create a campaign
 *   in any other state, preventing direct sends.
 * - Rate limit: maximum 5 campaigns per hour per tenant (in-memory window).
 *   The rate limit counter is incremented AFTER a successful API call to avoid
 *   penalising the tenant for network or validation errors.
 * - Rate limit key uses a SHA-256 hash of the JWT token's tail (16 chars) to
 *   avoid storing raw credential substrings in memory.
 * - Structured audit log on every successful creation.
 * - Requires STANDARD or FULL operation mode (WRITE operation type).
 *
 * ### nevent_schedule_campaign
 * - Requires `confirmed: true` (schema-level literal, rejected by Zod before
 *   the handler runs) — explicit confirmation gate.
 * - Validates that `scheduled_time` is strictly in the future.
 * - Verifies the campaign is in DRAFT status before scheduling.
 * - Structured audit log on every successful schedule.
 * - Requires FULL operation mode (DELETE-equivalent — irreversible once sent).
 *
 * ## nev-api integration
 *
 * Both tools call nev-api (NOT nev-data-api) using the JWT token stored on
 * the DataClient, accessed via an unsafe cast (same pattern as tenants.ts):
 * ```ts
 * const jwtToken = (dataClient as unknown as { jwtToken: string }).jwtToken;
 * ```
 *
 * @module tools/campaign-actions
 */

import { createHash } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DataClient } from '../clients/data-client.js';
import { ok, err, toErrorEnvelope, checkMode } from './helpers.js';
import { CreateCampaignSchema, ScheduleCampaignSchema } from '../schemas/campaign-actions.js';

// ---------------------------------------------------------------------------
// Rate limiter (in-memory, per-tenant, sliding window)
// ---------------------------------------------------------------------------

/** Window size in milliseconds — 1 hour. */
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

/** Maximum campaign creations allowed per tenant per rate limit window. */
const RATE_LIMIT_MAX_CAMPAIGNS = 5;

/** In-memory rate limit state: rateLimitKey → { count, windowStart }. */
const rateLimits = new Map<string, { count: number; windowStart: number }>();

/**
 * Check whether a rate limit key is still below the per-window maximum.
 *
 * Does NOT increment the counter — call `incrementRateLimit` only after a
 * successful API call to avoid penalising tenants for failed requests.
 *
 * @param key — The rate limit key (tenant ID or session-derived hash).
 * @returns `true` if a new creation would be within limits.
 */
function isWithinRateLimit(key: string): boolean {
  const now = Date.now();
  const entry = rateLimits.get(key);

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    return true;
  }

  return entry.count < RATE_LIMIT_MAX_CAMPAIGNS;
}

/**
 * Increment the rate limit counter for the given key.
 *
 * Starts a new window if no entry exists or the existing window has expired.
 * Should be called only after a successful API response.
 *
 * @param key — The rate limit key to increment.
 */
function incrementRateLimit(key: string): void {
  const now = Date.now();
  const entry = rateLimits.get(key);

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimits.set(key, { count: 1, windowStart: now });
  } else {
    entry.count++;
  }
}

// ---------------------------------------------------------------------------
// Campaign API types
// ---------------------------------------------------------------------------

/** Minimal shape of a campaign record from nev-api. */
interface CampaignRecord {
  /** Unique campaign identifier assigned by nev-api. */
  id: string;
  /** Human-readable campaign name. */
  name: string;
  /** Current lifecycle status. */
  status: string;
  /** Delivery channel. */
  channel?: string;
  /** Tenant owning this campaign. */
  tenantId?: string;
  /** ISO 8601 creation timestamp. */
  createdAt?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

/**
 * Register campaign action tools on the MCP server.
 *
 * Both tools call nev-api directly (not nev-data-api) because campaign
 * lifecycle management is owned by the core API service. They share the JWT
 * token from the provided `dataClient` instance.
 *
 * Parameter order follows the convention of the other Sprint 2 tools:
 * (server, dataClient, neventApiUrl).
 *
 * @param server       - The `McpServer` instance to register tools on.
 * @param dataClient   - The session's `DataClient` (used for JWT token access).
 * @param neventApiUrl - Base URL of nev-api, e.g. `https://api.nevent.es`.
 */
export function registerCampaignActionTools(
  server: McpServer,
  dataClient: DataClient,
  neventApiUrl: string
): void {

  // -------------------------------------------------------------------------
  // Tool 1: nevent_create_campaign
  // -------------------------------------------------------------------------
  server.tool(
    'nevent_create_campaign',
    'Create a new email, SMS, or WhatsApp campaign draft. The campaign is always created in DRAFT status and must be manually sent or scheduled.',
    CreateCampaignSchema,
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async (params) => {
      // --- Operation mode guard ---
      const denied = checkMode('nevent_create_campaign');
      if (denied) return err(denied);

      // --- Channel-specific field validation ---
      if (params.channel === 'EMAIL' && !params.email_subject) {
        return err({
          error: {
            type: 'invalid_request',
            message:
              'email_subject is required when channel is EMAIL. ' +
              'Provide a non-empty subject line for the campaign.',
            code: 'missing_required_field',
          },
        });
      }

      if ((params.channel === 'SMS' || params.channel === 'WHATSAPP') && !params.message) {
        return err({
          error: {
            type: 'invalid_request',
            message:
              `message is required when channel is ${params.channel}. ` +
              'Provide the message text body for the campaign.',
            code: 'missing_required_field',
          },
        });
      }

      // --- Extract JWT from DataClient ---
      const jwtToken = (dataClient as unknown as { jwtToken: string }).jwtToken;

      // --- JWT presence check ---
      if (!jwtToken) {
        return err({
          error: {
            type: 'authentication_error',
            message: 'No JWT token available. Ensure you are authenticated with a valid session.',
            code: 'missing_token',
          },
        });
      }

      // --- Build rate limit key ---
      // Use SHA-256 hash of JWT tail to avoid storing raw token bytes in memory.
      const tokenHash = createHash('sha256').update(jwtToken).digest('hex').slice(0, 16);
      const rateLimitKey = dataClient.activeTenantId ?? `session:${tokenHash}`;

      // --- Rate limit check (pre-flight — does NOT increment) ---
      if (!isWithinRateLimit(rateLimitKey)) {
        return err({
          error: {
            type: 'rate_limit_error',
            message:
              `Rate limit exceeded: maximum ${RATE_LIMIT_MAX_CAMPAIGNS} campaigns can be created ` +
              `per hour per tenant. Try again after the ${RATE_LIMIT_WINDOW_MS / 60000}-minute window resets. ` +
              'If you need to create more campaigns, review your automation logic.',
            code: 'rate_limit_exceeded',
          },
        });
      }

      try {
        // --- Build the request payload ---
        // status is ALWAYS "DRAFT" — hardcoded, never from params.
        const payload: Record<string, unknown> = {
          name: params.name,
          channel: params.channel,
          status: 'DRAFT',
        };

        if (params.email_subject !== undefined) payload['emailSubject'] = params.email_subject;
        if (params.email_body !== undefined) payload['emailBody'] = params.email_body;
        if (params.preview_text !== undefined) payload['previewText'] = params.preview_text;
        if (params.from_name !== undefined) payload['fromName'] = params.from_name;
        if (params.message !== undefined) payload['message'] = params.message;
        if (params.segment_ids !== undefined && params.segment_ids.length > 0) {
          payload['segmentIds'] = params.segment_ids;
        }
        if (params.template_id !== undefined) payload['templateId'] = params.template_id;

        // --- POST to nev-api ---
        const response = await fetch(`${neventApiUrl}/campaigns`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${jwtToken}`,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(15_000),
        });

        if (!response.ok) {
          const body = await response.text();
          return err({
            error: {
              type: response.status === 403 ? 'authentication_error' : 'api_error',
              message:
                response.status === 403
                  ? 'Access denied. Creating campaigns requires appropriate permissions.'
                  : response.status === 422
                    ? `Validation error from nev-api: ${body}`
                    : `Failed to create campaign: HTTP ${response.status}. ${body}`,
              code: response.status === 403
                ? 'forbidden'
                : response.status === 422
                  ? 'validation_error'
                  : 'api_error',
            },
          });
        }

        const campaign = await response.json() as CampaignRecord;

        // --- Increment rate limit ONLY after successful API call ---
        incrementRateLimit(rateLimitKey);

        // --- Structured audit log ---
        console.error(
          JSON.stringify({
            event: 'campaign_created',
            tool: 'nevent_create_campaign',
            campaignId: campaign.id,
            campaignName: campaign.name,
            channel: campaign.channel ?? params.channel,
            status: campaign.status,
            tenantId: campaign.tenantId ?? rateLimitKey,
            timestamp: new Date().toISOString(),
          })
        );

        return ok({
          campaign,
          message:
            `Campaign "${campaign.name}" created successfully in DRAFT state. ` +
            `Campaign ID: ${campaign.id}. ` +
            'The campaign is in DRAFT status and will not be sent until explicitly scheduled or launched.',
        });
      } catch (caught) {
        return err(toErrorEnvelope(caught));
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool 2: nevent_schedule_campaign
  // -------------------------------------------------------------------------
  server.tool(
    'nevent_schedule_campaign',
    'Schedule an existing draft campaign for sending at a specified date and time. Requires explicit confirmation.',
    ScheduleCampaignSchema,
    { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    async (params) => {
      // --- Operation mode guard ---
      const denied = checkMode('nevent_schedule_campaign');
      if (denied) return err(denied);

      // Note: params.confirmed is guaranteed to be `true` by z.literal(true)
      // in the schema — Zod rejects any other value before this handler runs.

      // --- Validate scheduled_time is in the future ---
      const scheduledDate = new Date(params.scheduled_time);
      const now = new Date();

      if (isNaN(scheduledDate.getTime())) {
        return err({
          error: {
            type: 'invalid_request',
            message:
              `Invalid scheduled_time: "${params.scheduled_time}" could not be parsed as a valid date. ` +
              'Provide an ISO 8601 datetime string, e.g. "2026-05-01T10:00:00Z".',
            code: 'invalid_date',
          },
        });
      }

      if (scheduledDate <= now) {
        return err({
          error: {
            type: 'invalid_request',
            message:
              `scheduled_time must be in the future. ` +
              `Provided: "${params.scheduled_time}" (${scheduledDate.toISOString()}). ` +
              `Current time: ${now.toISOString()}. ` +
              'Provide a datetime that is at least a few minutes from now.',
            code: 'scheduled_time_in_past',
          },
        });
      }

      // --- Extract JWT ---
      const jwtToken = (dataClient as unknown as { jwtToken: string }).jwtToken;

      // --- JWT presence check ---
      if (!jwtToken) {
        return err({
          error: {
            type: 'authentication_error',
            message: 'No JWT token available. Ensure you are authenticated with a valid session.',
            code: 'missing_token',
          },
        });
      }

      try {
        // --- Fetch current campaign state from nev-api ---
        const getResponse = await fetch(
          `${neventApiUrl}/campaigns/${encodeURIComponent(params.campaign_id)}`,
          {
            method: 'GET',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${jwtToken}`,
            },
            signal: AbortSignal.timeout(10_000),
          }
        );

        if (!getResponse.ok) {
          const body = await getResponse.text();
          return err({
            error: {
              type: getResponse.status === 404 ? 'not_found' : 'api_error',
              message:
                getResponse.status === 404
                  ? `Campaign "${params.campaign_id}" not found. Verify the campaign_id is correct.`
                  : getResponse.status === 403
                    ? 'Access denied. You do not have permission to access this campaign.'
                    : `Failed to fetch campaign: HTTP ${getResponse.status}. ${body}`,
              code: getResponse.status === 404
                ? 'campaign_not_found'
                : getResponse.status === 403
                  ? 'forbidden'
                  : 'api_error',
            },
          });
        }

        const existingCampaign = await getResponse.json() as CampaignRecord;

        // --- Verify campaign is in DRAFT status ---
        if (existingCampaign.status !== 'DRAFT') {
          return err({
            error: {
              type: 'invalid_request',
              message:
                `Campaign "${params.campaign_id}" is in "${existingCampaign.status}" status ` +
                'and cannot be scheduled. Only campaigns in DRAFT status can be scheduled. ' +
                (existingCampaign.status === 'SCHEDULED'
                  ? 'The campaign is already scheduled.'
                  : existingCampaign.status === 'SENT'
                    ? 'The campaign has already been sent.'
                    : 'Review the campaign status before attempting to schedule.'),
              code: 'invalid_campaign_status',
            },
          });
        }

        // --- PATCH campaign with scheduledTime and SCHEDULED status ---
        const patchPayload: Record<string, unknown> = {
          status: 'SCHEDULED',
          scheduledTime: params.scheduled_time,
        };

        const patchResponse = await fetch(
          `${neventApiUrl}/campaigns/${encodeURIComponent(params.campaign_id)}`,
          {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${jwtToken}`,
            },
            body: JSON.stringify(patchPayload),
            signal: AbortSignal.timeout(15_000),
          }
        );

        if (!patchResponse.ok) {
          const body = await patchResponse.text();
          return err({
            error: {
              type: patchResponse.status === 403 ? 'authentication_error' : 'api_error',
              message:
                patchResponse.status === 403
                  ? 'Access denied. Scheduling campaigns requires appropriate permissions.'
                  : patchResponse.status === 422
                    ? `Validation error from nev-api when scheduling: ${body}`
                    : `Failed to schedule campaign: HTTP ${patchResponse.status}. ${body}`,
              code: patchResponse.status === 403
                ? 'forbidden'
                : patchResponse.status === 422
                  ? 'validation_error'
                  : 'api_error',
            },
          });
        }

        const updatedCampaign = await patchResponse.json() as CampaignRecord;

        // --- Structured audit log ---
        console.error(
          JSON.stringify({
            event: 'campaign_scheduled',
            tool: 'nevent_schedule_campaign',
            campaignId: params.campaign_id,
            campaignName: updatedCampaign.name ?? existingCampaign.name,
            scheduledTime: params.scheduled_time,
            previousStatus: existingCampaign.status,
            newStatus: updatedCampaign.status,
            tenantId: updatedCampaign.tenantId ?? existingCampaign.tenantId,
            timestamp: new Date().toISOString(),
          })
        );

        return ok({
          campaign: updatedCampaign,
          message:
            `Campaign "${updatedCampaign.name ?? params.campaign_id}" scheduled successfully. ` +
            `It will be sent at ${params.scheduled_time}. ` +
            `Campaign ID: ${params.campaign_id}. Status: ${updatedCampaign.status}.`,
        });
      } catch (caught) {
        return err(toErrorEnvelope(caught));
      }
    }
  );
}
