# Tool annotation audit — Nevent MCP v1.8.0

Generated from `src/tools/*.ts` (local constants resolved) and cross-checked against the
live server: `GET https://mcp.nevent.ai/health` reports `"toolsCount": 59`.

**Result: 59/59 tools carry `title` + `readOnlyHint` + `destructiveHint` + `openWorldHint`.**
The Anthropic annotation requirement is met — no code change needed for this criterion.

| | Count |
|---|---|
| Total tools | 59 |
| Read-only (`readOnlyHint: true`) | 43 |
| Write (`readOnlyHint: false`) | 16 |
| Destructive (`destructiveHint: true`) | 7 |
| Missing `title` or hints | 0 |
| Longest tool name | `nevent_get_paid_ad_group_comparative_stats` (42 chars, limit 64) |


## analytics (9)

| Tool | Title | readOnly | destructive | openWorld |
|---|---|---|---|---|
| `nevent_analytics_query` | Query analytics data | `true` | `false` | `false` |
| `nevent_analytics_capabilities` | Discover analytics capabilities | `true` | `false` | `false` |
| `nevent_analytics_table_schema` | Get analytics table schema | `true` | `false` | `false` |
| `nevent_analytics_filter_values` | Get analytics filter values | `true` | `false` | `false` |
| `nevent_campaign_report` | Generate campaign analytics report | `true` | `false` | `false` |
| `nevent_segmentation_criteria` | List segmentation criteria | `true` | `false` | `false` |
| `nevent_segment_preview` | Preview segment audience | `true` | `false` | `false` |
| `nevent_segment_execute` | Execute segment and get contacts | `true` | `false` | `false` |
| `nevent_dimension_values` | Get dimension values | `true` | `false` | `false` |

## campaign-actions (3)

| Tool | Title | readOnly | destructive | openWorld |
|---|---|---|---|---|
| `nevent_create_campaign` | Create campaign draft | `false` | `false` | `false` |
| `nevent_schedule_campaign` | Schedule campaign for delivery | `false` | `true` | `true` |
| `nevent_quote_campaign` | Quote campaign cost and audience | `true` | `false` | `false` |

## campaign-metrics (2)

| Tool | Title | readOnly | destructive | openWorld |
|---|---|---|---|---|
| `nevent_get_campaign_metrics` | Get campaign metrics | `true` | `false` | `false` |
| `nevent_list_campaign_recipients` | List campaign recipients | `true` | `false` | `false` |

## campaigns (3)

| Tool | Title | readOnly | destructive | openWorld |
|---|---|---|---|---|
| `nevent_list_campaigns` | List campaigns | `true` | `false` | `false` |
| `nevent_get_campaign` | Get campaign details | `true` | `false` | `false` |
| `nevent_get_campaign_insights` | Get campaign AI insights | `true` | `false` | `false` |

## deliverability (2)

| Tool | Title | readOnly | destructive | openWorld |
|---|---|---|---|---|
| `nevent_get_sending_profile` | Get sending profile | `true` | `false` | `false` |
| `nevent_get_suppressions_summary` | Get suppressions summary | `true` | `false` | `false` |

## help (1)

| Tool | Title | readOnly | destructive | openWorld |
|---|---|---|---|---|
| `nevent_help` | Get Nevent MCP help | `true` | `false` | `false` |

## media (3)

| Tool | Title | readOnly | destructive | openWorld |
|---|---|---|---|---|
| `nevent_upload_image` | Upload image to media library | `false` | `false` | `true` |
| `nevent_list_images` | List media library images | `true` | `false` | `false` |
| `nevent_delete_image` | Delete images from media library | `false` | `true` | `true` |

## paid-media (11)

| Tool | Title | readOnly | destructive | openWorld |
|---|---|---|---|---|
| `nevent_paid_ads_status` | Check paid ads connection status | `true` | `false` | `false` |
| `nevent_paid_ads_health` | Get paid ads health signals | `true` | `false` | `false` |
| `nevent_list_paid_campaigns` | List paid campaigns | `true` | `false` | `false` |
| `nevent_get_paid_campaign_insights` | Get paid campaign insights | `true` | `false` | `false` |
| `nevent_paid_attribution` | Get paid ads attribution | `true` | `false` | `false` |
| `nevent_list_paid_ad_groups` | List paid ad groups | `true` | `false` | `false` |
| `nevent_get_paid_ad_group_insights` | Get paid ad group insights | `true` | `false` | `false` |
| `nevent_get_paid_ad_group_comparative_stats` | Get paid ad group comparative stats | `true` | `false` | `false` |
| `nevent_get_paid_ad_group_targeting` | Get paid ad group targeting | `true` | `false` | `false` |
| `nevent_list_paid_ads` | List paid ads | `true` | `false` | `false` |
| `nevent_get_paid_ad_creative` | Get paid ad creative | `true` | `false` | `false` |

## segments (4)

| Tool | Title | readOnly | destructive | openWorld |
|---|---|---|---|---|
| `nevent_list_segments` | List segments | `true` | `false` | `false` |
| `nevent_get_segment` | Get segment details | `true` | `false` | `false` |
| `nevent_create_segment` | Create segment | `false` | `false` | `false` |
| `nevent_update_segment` | Update segment | `false` | `true` | `false` |

## short-urls (10)

| Tool | Title | readOnly | destructive | openWorld |
|---|---|---|---|---|
| `nevent_list_short_urls` | List short URLs | `true` | `false` | `false` |
| `nevent_get_short_url` | Get short URL details | `true` | `false` | `false` |
| `nevent_get_short_url_metrics` | Get short URL metrics | `true` | `false` | `false` |
| `nevent_get_short_url_campaign_metrics` | Get short URL campaign metrics | `true` | `false` | `false` |
| `nevent_get_short_url_clicks` | Get short URL click events | `true` | `false` | `false` |
| `nevent_list_short_url_user_links` | List short URL user links | `true` | `false` | `false` |
| `nevent_create_short_url` | Create short URL | `false` | `false` | `true` |
| `nevent_update_short_url` | Update short URL | `false` | `true` | `true` |
| `nevent_create_bulk_user_short_urls` | Create bulk user short URLs | `false` | `false` | `true` |
| `nevent_list_short_url_destinations` | List short URLs by destination | `true` | `false` | `false` |

## templates (8)

| Tool | Title | readOnly | destructive | openWorld |
|---|---|---|---|---|
| `nevent_list_templates` | List email templates | `true` | `false` | `false` |
| `nevent_get_template` | Get email template | `true` | `false` | `false` |
| `nevent_create_template` | Create email template | `false` | `false` | `false` |
| `nevent_update_template` | Update email template | `false` | `true` | `false` |
| `nevent_clone_template` | Clone email template | `false` | `false` | `false` |
| `nevent_rename_template` | Rename email template | `false` | `true` | `false` |
| `nevent_preview_template` | Preview template rendering | `true` | `false` | `false` |
| `nevent_send_test_template` | Send test email | `false` | `true` | `true` |

## tenants (3)

| Tool | Title | readOnly | destructive | openWorld |
|---|---|---|---|---|
| `nevent_list_tenants` | List accessible tenants | `true` | `false` | `false` |
| `nevent_switch_tenant` | Switch active tenant | `false` | `false` | `false` |
| `nevent_reset_tenant` | Reset to home tenant | `false` | `false` | `false` |

## The 7 destructive tools

These always prompt the user for confirmation in Claude. Verify each one behaves as annotated before submitting:

- `nevent_schedule_campaign` — Schedule campaign for delivery
- `nevent_delete_image` — Delete images from media library
- `nevent_update_segment` — Update segment
- `nevent_update_short_url` — Update short URL
- `nevent_update_template` — Update email template
- `nevent_rename_template` — Rename email template
- `nevent_send_test_template` — Send test email
