/**
 * Campaign performance MCP tools — 2 read tools over nev-api (MCP 1.8.0).
 *
 *  1. nevent_get_campaign_metrics     — GET /campaigns/{id}/metrics
 *  2. nevent_list_campaign_recipients — GET /campaigns/{id}/recipients
 *
 * ## Why these live next to, not inside, the analytics tools
 *
 * `nevent_campaign_report` and `nevent_analytics_query` read the analytics
 * warehouse through nev-data-api: modelled, joinable, and lagging behind the
 * send by however long the CDC/dbt pipeline takes. These two tools read the
 * operational source of truth in nev-api instead, which is what you want right
 * after a send and what you cite when the two disagree.
 *
 * Both call nev-api directly with the session's JWT, following the same pattern
 * as `tools/campaign-actions.ts`: the token comes from `dataClient.getJwtToken()`.
 *
 * Both are READ operations — available in every operation mode.
 *
 * @module tools/campaign-metrics
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DataClient } from '../clients/data-client.js';
import { ok, err, toErrorEnvelope, checkMode } from './helpers.js';
import { TIMEOUTS } from '../config/timeouts.js';
import {
  GetCampaignMetricsSchema,
  ListCampaignRecipientsSchema,
} from '../schemas/campaign-metrics.js';
import type { NeventErrorEnvelope } from '../types/common.js';

// ---------------------------------------------------------------------------
// Shared annotations
// ---------------------------------------------------------------------------

const READ_ONLY_ANNOTATIONS_BASE = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Map a non-2xx nev-api response to a structured error envelope.
 *
 * 404 is called out separately because it is the common, actionable case: the
 * agent passed a campaign id that does not exist in the active tenant, and the
 * fix is to re-resolve it via `nevent_list_campaigns` rather than to retry.
 */
async function toHttpErrorEnvelope(
  response: Response,
  action: string
): Promise<NeventErrorEnvelope> {
  const body = await response.text();

  if (response.status === 404) {
    return {
      error: {
        type: 'not_found',
        message:
          `Campaign not found. It may not exist, or it may belong to a different tenant — ` +
          `check the active tenant with nevent_list_tenants and re-resolve the ID with nevent_list_campaigns.`,
        code: 'campaign_not_found',
      },
    };
  }

  if (response.status === 403) {
    return {
      error: {
        type: 'authentication_error',
        message: `Access denied. ${action} requires ADMIN, OWNER or SUPERADMIN.`,
        code: 'forbidden',
      },
    };
  }

  return {
    error: {
      type: 'api_error',
      message: `Failed to ${action.toLowerCase()}: HTTP ${response.status}. ${body}`,
      code: 'api_error',
    },
  };
}

/** Build the standard authenticated GET init for a nev-api call. */
function authedGet(jwtToken: string): RequestInit {
  return {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${jwtToken}`,
    },
    signal: AbortSignal.timeout(TIMEOUTS.LONG_MS),
  };
}

/** Error envelope returned when the session has no usable JWT. */
const MISSING_TOKEN_ENVELOPE: NeventErrorEnvelope = {
  error: {
    type: 'authentication_error',
    message: 'No JWT token available. Authentication is required to read campaign performance.',
    code: 'missing_token',
  },
};

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

/**
 * Register the 2 campaign performance MCP tools on the MCP server.
 *
 * @param server       - The `McpServer` instance to register tools on.
 * @param dataClient   - The session's `DataClient` (used for JWT token access).
 * @param neventApiUrl - Base URL of nev-api, e.g. `https://api.nevent.es`.
 */
export function registerCampaignMetricsTools(
  server: McpServer,
  dataClient: DataClient,
  neventApiUrl: string
): void {

  // -------------------------------------------------------------------------
  // Tool 1: nevent_get_campaign_metrics
  // -------------------------------------------------------------------------
  server.tool(
    'nevent_get_campaign_metrics',
    'Get the delivery and engagement counters nev-api holds for one campaign: totalRecipients, totalSent, totalDelivered, totalBounces, totalComplaints, totalOpens, uniqueOpens, totalClicks, uniqueClicks, unsubscribes, the derived rates (openRate, clickRate, clickToOpenRate, bounceRate, unsubscribeRate) and the conversion counters (carts, purchases, revenue). This is the OPERATIONAL source of truth, read straight from nev-api — use it right after a send, and prefer it over nevent_campaign_report when the two disagree, because the report reads the analytics warehouse and lags behind by the data pipeline. Use nevent_campaign_report instead when you need to compare many campaigns, slice by dimension, or join against other analytics. Get campaign_id from nevent_list_campaigns. Follow up with nevent_list_campaign_recipients to see who is behind a number (for example which recipients bounced).',
    GetCampaignMetricsSchema,
    { title: 'Get campaign metrics', ...READ_ONLY_ANNOTATIONS_BASE },
    async (params) => {
      const denied = checkMode('nevent_get_campaign_metrics');
      if (denied) return err(denied);

      try {
        const jwtToken = dataClient.getJwtToken();
        if (!jwtToken) return err(MISSING_TOKEN_ENVELOPE);

        const response = await fetch(
          `${neventApiUrl}/campaigns/${encodeURIComponent(params.campaign_id)}/metrics`,
          authedGet(jwtToken)
        );

        if (!response.ok) {
          return err(await toHttpErrorEnvelope(response, 'Reading campaign metrics'));
        }

        return ok(await response.json());
      } catch (caught) {
        return err(toErrorEnvelope(caught));
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool 2: nevent_list_campaign_recipients
  // -------------------------------------------------------------------------
  server.tool(
    'nevent_list_campaign_recipients',
    'List the individual recipients of a campaign and what happened to each message. Use this to put names behind the aggregate numbers from nevent_get_campaign_metrics: who bounced, who clicked, who unsubscribed. Filter with status (SCHEDULED, DELIVERED, OPENED, CLICKED, BOUNCES, UNSUBSCRIBES), narrow to one audience with segment_id when the campaign targeted several segments, or find one person with search (matches name and email). Returns a paginated envelope — content (the recipient rows), page, size, totalElements, totalPages. Rows contain personal data: request the smallest page that answers the question, filter rather than paginate through everything, and do not dump full recipient lists into a summary.',
    ListCampaignRecipientsSchema,
    { title: 'List campaign recipients', ...READ_ONLY_ANNOTATIONS_BASE },
    async (params) => {
      const denied = checkMode('nevent_list_campaign_recipients');
      if (denied) return err(denied);

      try {
        const jwtToken = dataClient.getJwtToken();
        if (!jwtToken) return err(MISSING_TOKEN_ENVELOPE);

        // Backend param names differ from the agent-facing ones:
        // page_size → size, segment_id → segmentId.
        const query = new URLSearchParams();
        if (params.status !== undefined) query.set('status', params.status);
        if (params.search !== undefined) query.set('search', params.search);
        if (params.segment_id !== undefined) query.set('segmentId', params.segment_id);
        if (params.page !== undefined) query.set('page', String(params.page));
        if (params.page_size !== undefined) query.set('size', String(params.page_size));

        const queryString = query.toString();
        const url =
          `${neventApiUrl}/campaigns/${encodeURIComponent(params.campaign_id)}/recipients` +
          (queryString ? `?${queryString}` : '');

        const response = await fetch(url, authedGet(jwtToken));

        if (!response.ok) {
          return err(await toHttpErrorEnvelope(response, 'Listing campaign recipients'));
        }

        return ok(await response.json());
      } catch (caught) {
        return err(toErrorEnvelope(caught));
      }
    }
  );
}
