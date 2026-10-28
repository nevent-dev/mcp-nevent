/**
 * Snapshot of the EXACT tool names a bearer-passthrough session exposes
 * (with MONGODB_URI configured, i.e. the largest set).
 *
 * Purpose: a WRITE/DELETE tool reclassified as READ in `TOOL_OPERATIONS`
 * (or a new tool added as READ by mistake) would silently become reachable
 * from this externally reachable mode. Any change to the list fails here and
 * has to be reviewed on purpose: update the array only after confirming every
 * added tool is genuinely read-only.
 */

import { describe, it, expect } from 'vitest';
import { createNeventServer } from '../server.js';
import { DataClient } from '../clients/data-client.js';
import { PaidMediaClient } from '../clients/paid-media-client.js';
import { SessionClients } from '../clients/session-clients.js';
import { isToolAllowedInBearerPassthrough } from '../config/bearer-passthrough.js';

const EXPECTED_TOOLS: readonly string[] = [
  "nevent_analytics_capabilities",
  "nevent_analytics_filter_values",
  "nevent_analytics_query",
  "nevent_analytics_table_schema",
  "nevent_campaign_report",
  "nevent_dimension_values",
  "nevent_event_sales_provenance",
  "nevent_get_campaign",
  "nevent_get_campaign_deliverability",
  "nevent_get_campaign_insights",
  "nevent_get_campaign_metrics",
  "nevent_get_campaign_unsubscribes",
  "nevent_get_paid_ad_creative",
  "nevent_get_paid_ad_group_comparative_stats",
  "nevent_get_paid_ad_group_insights",
  "nevent_get_paid_ad_group_targeting",
  "nevent_get_paid_campaign_insights",
  "nevent_get_segment",
  "nevent_get_sending_profile",
  "nevent_get_short_url",
  "nevent_get_short_url_campaign_metrics",
  "nevent_get_short_url_clicks",
  "nevent_get_short_url_metrics",
  "nevent_get_suppressions_summary",
  "nevent_get_template",
  "nevent_help",
  "nevent_list_campaign_recipients",
  "nevent_list_campaigns",
  "nevent_list_events",
  "nevent_list_images",
  "nevent_list_paid_ad_groups",
  "nevent_list_paid_ads",
  "nevent_list_paid_campaigns",
  "nevent_list_segments",
  "nevent_list_short_url_destinations",
  "nevent_list_short_url_user_links",
  "nevent_list_short_urls",
  "nevent_list_templates",
  "nevent_paid_ads_health",
  "nevent_paid_ads_status",
  "nevent_paid_attribution",
  "nevent_preview_template",
  "nevent_quote_campaign",
  "nevent_segment_execute",
  "nevent_segment_preview",
  "nevent_segmentation_criteria",
];

describe('bearer-passthrough exposed tool list', () => {
  it('matches the reviewed snapshot exactly', () => {
    const dataClient = new DataClient({ baseUrl: 'http://stub', jwtToken: 'stub' });
    const paidMediaClient = new PaidMediaClient({ baseUrl: 'http://stub', jwtToken: 'stub' });
    const sessionClients = new SessionClients(dataClient, paidMediaClient, 'http://stub');
    const server = createNeventServer({
      dataClient,
      neventApiUrl: 'http://stub',
      // Never connected to: registration is lazy and call logging is off.
      mongoUri: 'mongodb://127.0.0.1:1/unused',
      enableToolCallLogging: false,
      paidMediaClient,
      sessionClients,
      toolFilter: isToolAllowedInBearerPassthrough,
    });
    const names = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools).sort();
    expect(names).toEqual([...EXPECTED_TOOLS]);
  });
});
