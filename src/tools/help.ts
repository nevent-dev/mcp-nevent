/**
 * nevent_help — Meta-tool for in-session LLM guidance.
 *
 * Returns structured markdown guidance when the LLM is unsure which tool
 * to call or how to handle an error. Always registered regardless of
 * operation mode or configuration — it has no external dependencies.
 *
 * @module tools/help
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok } from './helpers.js';

// ---------------------------------------------------------------------------
// Help content
// ---------------------------------------------------------------------------

const HELP_INDEX = `
# Nevent MCP Help

Available topics:
- **workflows** — Common end-to-end task patterns
- **errors** — Error code meanings and LLM actions
- **tenants** — Multi-tenant guidance (switching, SUPERADMIN warnings)
- **analytics** — BigQuery analytics tools guide
- **segments** — Audience segmentation tools guide
- **campaigns** — Campaign read/write tools guide
- **templates** — Email template tools guide
- **deliverability** — Sending profile and suppressions guide
- **paid_media** — Meta/Google/TikTok paid ads tools guide

Call nevent_help with topic="<name>" for detailed guidance on any category.
`.trim();

const HELP_WORKFLOWS = `
# Common Workflows

## 1. "How are my paid ads performing?"
nevent_paid_ads_status (provider) → nevent_paid_ads_health → nevent_list_paid_campaigns → nevent_get_paid_campaign_insights → nevent_paid_attribution

## 2. "Build a high-value audience segment"
nevent_segmentation_criteria → nevent_dimension_values (discover valid values for criteria) → nevent_segment_preview (validate + estimate size) → nevent_create_segment (persist)

## 3. "Email campaign performance last week"
nevent_list_campaigns(channel=EMAIL, limit=10) → nevent_get_campaign_insights(campaign_id) OR nevent_campaign_report(campaignId)

## 4. "Compare analytics across two tenants"
nevent_list_tenants → nevent_switch_tenant(tenant_id=A) → [run queries] → nevent_switch_tenant(tenant_id=B) → [run queries] → nevent_reset_tenant

## 5. "Discover what data exists"
nevent_analytics_capabilities → nevent_analytics_table_schema(table=X) → nevent_analytics_query

## 6. "Create and schedule an email campaign"
nevent_list_segments → nevent_list_templates → nevent_create_campaign(channel=EMAIL, ...) → nevent_schedule_campaign(campaign_id, confirmed=true, scheduled_time=...)

## 7. "Deliverability health check"
nevent_get_sending_profile → nevent_get_suppressions_summary
`.trim();

const HELP_ERRORS = `
# Error Code Glossary

| Code | When it appears | LLM action | Tell user |
|------|----------------|-----------|-----------|
| feature_gate_not_enrolled | Paid media endpoints when tenant not in pilot | Do not retry | "This paid media feature is not enabled for your account. Contact your Nevent admin." |
| forbidden | Insufficient role/capability for the endpoint | Do not retry; explain role needed | "This action requires [ADMIN/SUPERADMIN/OWNER] role." |
| not_found | Resource doesn't exist OR paid media feature gate | Check ID; for paid media, treat like feature_gate | "The requested resource was not found." |
| rate_limit_exceeded | Too many requests; retryAfter may be in message | Wait retryAfter seconds, then retry once | "Rate limit reached. Retrying in X seconds." |
| operation_not_permitted | Tool blocked by READ_ONLY operation mode | Explain mode constraint | "This operation is blocked in the current mode (READ_ONLY)." |
| invalid_token | JWT expired or missing | Cannot auto-fix in stdio mode; refresh in HTTP | "Authentication failed. Your session may have expired." |
| network_error | Cannot reach data.nevent.es or api.nevent.es | Retry once after 2s | "Connection issue. Please try again." |
| unexpected_error | Unhandled exception | Log and retry once | "Unexpected error occurred. Please try again." |
| server_error | 5xx from nev-api or nev-data-api | Retry once with backoff | "Server error. Please try again in a moment." |
`.trim();

const HELP_TENANTS = `
# Multi-Tenant Guidance

## How tenant context works
- Tenant is embedded in the JWT bearer token — it is STATEFUL for the entire session.
- ALL tools (analytics, segments, campaigns, paid media) use the current JWT tenant.
- You cannot set tenant per-request — switch_tenant changes the session-wide context.

## Switching tenants
1. nevent_list_tenants — discover accessible tenant IDs
2. nevent_switch_tenant(tenant_id="TARGET_ID") — rotates the JWT for the whole session
3. Run your cross-tenant queries
4. nevent_reset_tenant — ALWAYS restore home tenant when done

## SUPERADMIN warning
- switch_tenant MUTATES the user record in the database for SUPERADMIN users.
- The switch PERSISTS until reversed — it is NOT session-scoped for SUPERADMIN.
- ALWAYS call nevent_reset_tenant after cross-tenant work.

## OWNER/ADMIN/STAFF
- Can only switch to tenants in their hierarchy subtree (max 3 levels deep).
- The switch is session-scoped (does not mutate the DB record).

## After switch_tenant
- All caches (capabilities, segmentation criteria) are automatically invalidated.
- The home_tenant_id in the switch response shows your original tenant.
`.trim();

const HELP_ANALYTICS = `
# Analytics Tools Guide

## Tool order
1. nevent_analytics_capabilities — list all tables (name, description, field count)
2. nevent_analytics_table_schema(table=X) — get full field list for table X
3. nevent_analytics_query — run the actual query

## Mandatory rules
- ALWAYS call table_schema before querying. NEVER guess field names.
- BOOLEAN fields: operator must be "is_true" or "is_false". Never "eq" with "true"/"false".
- Enum fields (e.g. purchases.state): valid values are SUCCEEDED, COMPLETE, PENDING, FAILED.

## Query parameters
- collection: table name (from capabilities)
- dimensions: fields to group by
- metrics: aggregation functions (count, sum, avg, etc.)
- timeRange: { field, from, to } — always filter by time to avoid full scans
- filters: array of { field, operator, value }
- limit: default 100, max 10000

## Segmentation tools
- nevent_segmentation_criteria — list all audience criteria with operators
- nevent_dimension_values(criterion_id) — autocomplete valid values
- nevent_segment_preview(definition) — estimate audience size without saving
- nevent_segment_execute(definition, page, page_size) — paginated contact list
`.trim();

const HELP_SEGMENTS = `
# Segment Management Tools

## Tools
- nevent_list_segments — list saved segments for the current tenant
- nevent_get_segment(segment_id) — full segment definition
- nevent_create_segment(name, definition, description?) — persist a new segment (WRITE)
- nevent_update_segment(segment_id, ...) — update name/definition (WRITE)

## Segment definition DSL
{
  stanzas: [
    {
      criteria: [
        { criterion_id: "attended_event", operator: "is", value: "EVENT_ID" }
      ]
    }
  ]
}

## Rules
- ENTITY operators (is/is_not): value can be string OR array of strings.
- Do NOT combine attendance criteria with spending criteria in the same stanza — use separate stanzas.
- Always preview before creating: nevent_segment_preview(definition) → check estimatedCount.

## Operation mode
- list/get: always allowed
- create/update: requires STANDARD or FULL operation mode
`.trim();

const HELP_CAMPAIGNS = `
# Campaign Tools Guide

## Read tools (always available)
- nevent_list_campaigns(status?, channel?, limit?) — list campaigns with filters
- nevent_get_campaign(campaign_id) — full campaign detail
- nevent_get_campaign_insights(campaign_id) — AI insights + anomaly detection
- nevent_campaign_report(campaignId, timeRange?) — 13 parallel analytics queries in one call

## Write tools (require STANDARD/FULL mode)
- nevent_create_campaign(...) — creates in DRAFT state ONLY (cannot create as SENT)
- nevent_schedule_campaign(campaign_id, scheduled_time, confirmed=true) — schedule a DRAFT

## Channel values: EMAIL | SMS | WHATSAPP
## Status values: DRAFT | SCHEDULED | SENT | PAUSED | STOPPED | EXECUTED

## Rate limits
- create_campaign: max 5 per hour per tenant (in-memory sliding window)
- schedule_campaign: requires confirmed=true (explicit confirmation gate)
`.trim();

const HELP_TEMPLATES = `
# Template Tools Guide

## Tools
- nevent_list_templates(tags?, content_nature?, limit?) — list email templates
- nevent_get_template(template_id) — full template with performance metrics
- nevent_create_template(name, subject, htmlContent, ...) — create template (WRITE)
- nevent_update_template(template_id, ...) — update template fields (WRITE)

## Content nature values: PROMOTIONAL | TRANSACTIONAL | NEWSLETTER

## Performance metrics in nevent_get_template
Returns open rate, click rate, send count from linked campaigns.
`.trim();

const HELP_DELIVERABILITY = `
# Deliverability Tools Guide

## Tools
- nevent_get_sending_profile — warm-up state, throttle settings, validated domains
- nevent_get_suppressions_summary — suppression counts by reason (lifetime + 30-day rolling)

## When to use
- Before creating/scheduling a campaign: check sending_profile for domain validation issues.
- After high bounce rates: check suppressions_summary for bounce/complaint breakdown.

## Common suppressions
- BOUNCE: hard bounces (invalid email addresses)
- COMPLAINT: spam reports
- UNSUBSCRIBE: user unsubscribes
- MANUAL: manually suppressed by admin
`.trim();

const HELP_PAID_MEDIA = `
# Paid Media Tools Guide

## Tools (11 total)
- nevent_paid_ads_status(provider) — connection status for META/GOOGLE/TIKTOK
- nevent_paid_ads_health(provider) — account health, budget, spend pacing
- nevent_list_paid_ad_accounts(provider) — available ad accounts
- nevent_list_paid_campaigns(provider, account_id?) — campaigns with performance
- nevent_get_paid_campaign_insights(provider, campaign_id) — detailed metrics
- nevent_paid_attribution(provider, campaign_id?) — attributed revenue + ROAS
- nevent_list_paid_ad_groups(provider, campaign_id) — ad groups
- nevent_get_paid_ad_group_comparative_stats(provider, ad_group_id) — period comparison
- nevent_get_paid_ad_group_targeting(provider, ad_group_id) — targeting settings
- nevent_list_paid_ads(provider, ad_group_id) — individual ads
- nevent_get_paid_ad_creative(provider, ad_id) — creative details

## Providers: META | GOOGLE | TIKTOK

## Feature gate
If you get "not_found" or "feature_gate_not_enrolled", the tenant is not enrolled
in the insights pilot. Tell the user to contact their Nevent admin.

## Roles required: ADMIN | SUPERADMIN | OWNER + capability MODULE_ATTRIBUTION
`.trim();

// ---------------------------------------------------------------------------
// Topic router
// ---------------------------------------------------------------------------

type HelpTopic = 'workflows' | 'errors' | 'tenants' | 'analytics' | 'segments' |
  'campaigns' | 'templates' | 'deliverability' | 'paid_media';

function getHelpContent(topic?: string): string {
  switch (topic as HelpTopic | undefined) {
    case 'workflows':     return HELP_WORKFLOWS;
    case 'errors':        return HELP_ERRORS;
    case 'tenants':       return HELP_TENANTS;
    case 'analytics':     return HELP_ANALYTICS;
    case 'segments':      return HELP_SEGMENTS;
    case 'campaigns':     return HELP_CAMPAIGNS;
    case 'templates':     return HELP_TEMPLATES;
    case 'deliverability':return HELP_DELIVERABILITY;
    case 'paid_media':    return HELP_PAID_MEDIA;
    default:              return HELP_INDEX;
  }
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const HelpSchema = {
  topic: z
    .enum([
      'workflows',
      'errors',
      'tenants',
      'analytics',
      'segments',
      'campaigns',
      'templates',
      'deliverability',
      'paid_media',
    ])
    .optional()
    .describe(
      'Topic to get guidance on. Omit to get an index of all available topics. ' +
      'Values: workflows | errors | tenants | analytics | segments | campaigns | templates | deliverability | paid_media'
    ),
};

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

/**
 * Register the nevent_help meta-tool on the MCP server.
 *
 * Always registered regardless of operation mode — it has no external
 * dependencies and never makes API calls.
 *
 * @param server - The McpServer instance to register the tool on.
 */
export function registerHelpTool(server: McpServer): void {
  server.tool(
    'nevent_help',
    'Get guidance when you are unsure which tool to call or how to handle an error. ' +
    'Returns structured markdown for the requested topic. ' +
    'Call with topic="workflows" for common patterns, topic="errors" for error code meanings, ' +
    'topic="tenants" for multi-tenant guidance, or topic=<category> like "paid_media" / "analytics" / "segments". ' +
    'Omit topic to get an index of all available topics.',
    HelpSchema,
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async ({ topic }) => ok({ guidance: getHelpContent(topic) })
  );
}
