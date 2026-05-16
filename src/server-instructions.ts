/**
 * Server-level instructions for the Nevent MCP Server.
 *
 * These instructions are embedded in the McpServer `instructions` field and
 * surfaced to the LLM at session initialization. They provide a concise mental
 * model so the LLM can autonomously choose the right tool without needing to
 * call nevent_help on every session start.
 *
 * Keep this under ~1500 tokens. Use nevent_help for full detail.
 *
 * @module server-instructions
 */

export const NEVENT_MCP_INSTRUCTIONS = `
# Nevent MCP — Mental Model

## Tool categories
- **Analytics (9 tools):** nevent_analytics_capabilities → nevent_analytics_table_schema → nevent_analytics_query | nevent_analytics_filter_values | nevent_campaign_report | nevent_segmentation_criteria | nevent_segment_preview | nevent_segment_execute | nevent_dimension_values
- **Segments (4 tools):** nevent_list_segments | nevent_get_segment | nevent_create_segment | nevent_update_segment
- **Campaigns (5 tools):** nevent_list_campaigns | nevent_get_campaign | nevent_get_campaign_insights | nevent_create_campaign | nevent_schedule_campaign
- **Templates (4 tools):** nevent_list_templates | nevent_get_template | nevent_create_template | nevent_update_template
- **Deliverability (2 tools):** nevent_get_sending_profile | nevent_get_suppressions_summary
- **Paid Media (11 tools):** nevent_paid_ads_status | nevent_paid_ads_health | nevent_list_paid_campaigns | nevent_get_paid_campaign_insights | nevent_paid_attribution | nevent_list_paid_ad_groups | nevent_get_paid_ad_group_comparative_stats | nevent_get_paid_ad_group_targeting | nevent_list_paid_ads | nevent_get_paid_ad_creative | nevent_list_paid_ad_accounts
- **Multi-tenant (3 tools):** nevent_list_tenants | nevent_switch_tenant | nevent_reset_tenant
- **Help (1 tool):** nevent_help

## Common workflows
1. **"How are my paid ads doing?"** → nevent_paid_ads_status → nevent_paid_ads_health → nevent_list_paid_campaigns → nevent_get_paid_campaign_insights → nevent_paid_attribution
2. **"Build a segment"** → nevent_segmentation_criteria → nevent_dimension_values (for values) → nevent_segment_preview → nevent_create_segment
3. **"Email campaign performance"** → nevent_list_campaigns(channel=EMAIL) → nevent_get_campaign_insights OR nevent_campaign_report
4. **"Compare data across tenants"** → nevent_list_tenants → nevent_switch_tenant → [query] → nevent_reset_tenant
5. **"What data is available?"** → nevent_analytics_capabilities → nevent_analytics_table_schema → nevent_analytics_query

## MANDATORY: Analytics query rules
- ALWAYS call nevent_analytics_table_schema BEFORE querying to discover exact field names. NEVER guess.
- BOOLEAN fields: use operator "is_true" or "is_false". NEVER "eq" with "true"/"false".
- Enum fields (state, status): check field description for valid values.

## Tenant switching (IMPORTANT)
- Tenant comes from the JWT — it is STATEFUL for the whole session.
- nevent_switch_tenant reissues the JWT; ALL subsequent tools use the new tenant.
- SUPERADMIN: switch MUTATES the user record in the DB. ALWAYS call nevent_reset_tenant after cross-tenant work.
- OWNER/ADMIN/STAFF: limited to your hierarchy subtree (max 3 levels deep).

## Error codes → LLM actions
- \`feature_gate_not_enrolled\` (paid media): tenant not in pilot — tell user to contact admin.
- \`forbidden\`: insufficient role — explain what role is needed.
- \`rate_limit_exceeded\`: back off, retry later. retryAfter seconds may be in the message.
- \`operation_not_permitted\`: tool blocked by operation mode (e.g. READ_ONLY blocks writes).
- \`not_found\`: resource missing OR feature gate for paid media endpoints.

## Token economy
Responses can be large. Prefer filtered/paginated queries over broad ones.
Call nevent_help with a topic for detailed guidance on any category.
`.trim();
