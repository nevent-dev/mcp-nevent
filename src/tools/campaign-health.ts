/**
 * Per-campaign deliverability and unsubscribe MCP tools — 2 read tools over nev-api (MCP 1.9.0).
 *
 *  1. nevent_get_campaign_deliverability — GET /campaigns/{id}/deliverability/{summary|bounce-reasons|segment-breakdown}
 *  2. nevent_get_campaign_unsubscribes   — GET /campaigns/{id}/unsubscribes/{summary|reasons|segment-breakdown}
 *
 * These back the "Entregabilidad" and unsubscribe tabs of the campaign detail screen.
 * They are per CAMPAIGN; `nevent_get_sending_profile` and `nevent_get_suppressions_summary`
 * answer the same questions for the whole TENANT.
 *
 * nev-api requires ADMIN, OWNER or SUPERADMIN and enforces tenant scoping and channel
 * applicability (these are email metrics) in its facade, so a campaign of another tenant
 * is a 404 and a non-email campaign is refused. Both tools are READ operations.
 *
 * One tool per metric family with a `view` parameter, rather than six tools: the three
 * views of each family share the campaign and are read together.
 *
 * @module tools/campaign-health
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DataClient } from '../clients/data-client.js';
import { ok, err, toErrorEnvelope, checkMode } from './helpers.js';
import { TIMEOUTS } from '../config/timeouts.js';
import {
  GetCampaignDeliverabilitySchema,
  GetCampaignUnsubscribesSchema,
} from '../schemas/events.js';
import type { NeventErrorEnvelope } from '../types/common.js';

const READ_ONLY_ANNOTATIONS_BASE = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

const MISSING_TOKEN_ENVELOPE: NeventErrorEnvelope = {
  error: {
    type: 'authentication_error',
    message: 'No JWT token available. Authentication is required to read campaign deliverability.',
    code: 'missing_token',
  },
};

/** Map a view name to the nev-api sub-path. */
const DELIVERABILITY_PATHS = {
  summary: 'summary',
  bounce_reasons: 'bounce-reasons',
  segment_breakdown: 'segment-breakdown',
} as const;

const UNSUBSCRIBES_PATHS = {
  summary: 'summary',
  reasons: 'reasons',
  segment_breakdown: 'segment-breakdown',
} as const;

/**
 * Map a non-2xx nev-api response to a structured error envelope.
 *
 * 400/422 carry the facade's own explanation (typically that the campaign's channel is
 * not email, or the bounce family is invalid), so the body is surfaced.
 */
async function toHttpErrorEnvelope(response: Response, action: string): Promise<NeventErrorEnvelope> {
  const body = await response.text();

  if (response.status === 404) {
    return {
      error: {
        type: 'not_found',
        message:
          'Campaign not found. It may not exist, or it may belong to a different tenant — ' +
          'check the active tenant with nevent_list_tenants and re-resolve the ID with nevent_list_campaigns.',
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
  if (response.status === 400 || response.status === 422) {
    return {
      error: {
        type: 'invalid_request',
        message: `${action} was refused by nev-api: ${body}`,
        code: 'invalid_request',
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

async function authedGet(url: string, jwtToken: string): Promise<Response> {
  return fetch(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${jwtToken}`,
    },
    signal: AbortSignal.timeout(TIMEOUTS.LONG_MS),
  });
}

/**
 * Register the 2 campaign health MCP tools.
 *
 * @param server       - The `McpServer` instance to register tools on.
 * @param dataClient   - The session's `DataClient` (used for JWT token access).
 * @param neventApiUrl - Base URL of nev-api, e.g. `https://api.nevent.es`.
 */
export function registerCampaignHealthTools(
  server: McpServer,
  dataClient: DataClient,
  neventApiUrl: string
): void {

  // -------------------------------------------------------------------------
  // Tool 1: nevent_get_campaign_deliverability
  // -------------------------------------------------------------------------
  server.tool(
    'nevent_get_campaign_deliverability',
    'Email deliverability of ONE campaign (nev-api, the "Entregabilidad" tab of the campaign). view=summary (default): sent, delivered, soft bounces, hard bounces and complaints, plus a warning when something is off. view=bounce_reasons: why messages bounced, grouped by SES bounce subtype; needs bounce_type=soft|hard (call it once per family). view=segment_breakdown: delivery, soft and hard bounces per segment; empty when the campaign targeted a single segment or has no segment attribution. Use it after a send when nevent_get_campaign_metrics shows a high bounce rate, to learn whether the cause is invalid addresses (hard) or mailbox/transient problems (soft). Email campaigns only. For tenant-wide sender health use nevent_get_sending_profile and nevent_get_suppressions_summary instead; for the people behind the bounces use nevent_list_campaign_recipients(status=BOUNCES). Requires ADMIN, OWNER or SUPERADMIN.',
    GetCampaignDeliverabilitySchema,
    { title: 'Get campaign deliverability', ...READ_ONLY_ANNOTATIONS_BASE },
    async (params) => {
      const denied = checkMode('nevent_get_campaign_deliverability');
      if (denied) return err(denied);

      const view = params.view ?? 'summary';
      if (view === 'bounce_reasons' && params.bounce_type === undefined) {
        return err({
          error: {
            type: 'invalid_request',
            message: 'view=bounce_reasons needs bounce_type: "soft" or "hard".',
            code: 'bounce_type_required',
            param: 'bounce_type',
          },
        });
      }
      if (view !== 'bounce_reasons' && params.bounce_type !== undefined) {
        return err({
          error: {
            type: 'invalid_request',
            message: 'bounce_type only applies to view=bounce_reasons.',
            code: 'param_not_applicable',
            param: 'bounce_type',
          },
        });
      }

      try {
        const jwtToken = dataClient.getJwtToken();
        if (!jwtToken) return err(MISSING_TOKEN_ENVELOPE);

        const base =
          `${neventApiUrl}/campaigns/${encodeURIComponent(params.campaign_id)}/deliverability/${DELIVERABILITY_PATHS[view]}`;
        const url = view === 'bounce_reasons' ? `${base}?type=${encodeURIComponent(params.bounce_type!)}` : base;

        const response = await authedGet(url, jwtToken);
        if (!response.ok) {
          return err(await toHttpErrorEnvelope(response, 'Reading campaign deliverability'));
        }
        return ok({ view, campaign_id: params.campaign_id, data: await response.json() });
      } catch (caught) {
        return err(toErrorEnvelope(caught));
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool 2: nevent_get_campaign_unsubscribes
  // -------------------------------------------------------------------------
  server.tool(
    'nevent_get_campaign_unsubscribes',
    'Unsubscribes and spam complaints of ONE campaign (nev-api). view=summary (default): number of unsubscribes, unsubscribe rate, spam complaints and complaint rate. view=reasons: the reasons people gave when unsubscribing, grouped into canonical buckets. view=segment_breakdown: unsubscribes and complaints per segment; empty when the campaign targeted a single segment or has no segment attribution. Use it to explain a spike in nevent_get_campaign_metrics.unsubscribes or to compare how audiences reacted. Complaint rates above roughly 0.1% put sender reputation at risk: pair a high value with nevent_get_campaign_deliverability. Email campaigns only. For tenant-wide totals use nevent_get_suppressions_summary. Requires ADMIN, OWNER or SUPERADMIN.',
    GetCampaignUnsubscribesSchema,
    { title: 'Get campaign unsubscribes', ...READ_ONLY_ANNOTATIONS_BASE },
    async (params) => {
      const denied = checkMode('nevent_get_campaign_unsubscribes');
      if (denied) return err(denied);

      const view = params.view ?? 'summary';

      try {
        const jwtToken = dataClient.getJwtToken();
        if (!jwtToken) return err(MISSING_TOKEN_ENVELOPE);

        const url =
          `${neventApiUrl}/campaigns/${encodeURIComponent(params.campaign_id)}/unsubscribes/${UNSUBSCRIBES_PATHS[view]}`;

        const response = await authedGet(url, jwtToken);
        if (!response.ok) {
          return err(await toHttpErrorEnvelope(response, 'Reading campaign unsubscribes'));
        }
        return ok({ view, campaign_id: params.campaign_id, data: await response.json() });
      } catch (caught) {
        return err(toErrorEnvelope(caught));
      }
    }
  );
}
