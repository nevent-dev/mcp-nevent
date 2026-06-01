# NEV-1652 Fair Play Audit — OpenAI ChatGPT Apps Directory

**Date:** 2026-06-01
**Scope:** All model-readable text in mcp-nevent at commit `1ccfe24`
**Rule:** OpenAI prohibits descriptions, titles, tool annotations, or other model-readable fields from manipulating how the model selects or uses other apps or their tools.

---

## Summary

| Surface category | Surfaces checked | Violations found | Verdict |
|-----------------|-----------------|-----------------|---------|
| Server `instructions` field | 1 | 0 | CLEAN |
| Tool descriptions (52 tools) | 52 | 0 | CLEAN |
| Tool titles (52 tools) | 52 | 0 | CLEAN |
| `nevent_help` content (11 sections) | 11 | 0 | CLEAN |
| Zod parameter `.describe()` calls | ~80 fields | 0 | CLEAN |
| **Total** | **~196** | **0** | **CLEAN** |

**No model-readable text was changed. No version bump was performed.**

---

## 1. Server `instructions` Field

**File:** `src/server-instructions.ts`
**Verdict:** CLEAN

The `NEVENT_MCP_INSTRUCTIONS` constant (surfaced via `McpServer` `instructions` field) contains:

- Tool category index with tool counts
- Numbered common workflow sequences (intra-server only)
- MANDATORY analytics query rules (`ALWAYS call nevent_analytics_table_schema BEFORE querying`) — these are intra-tool ordering constraints required to avoid invalid API calls, not directives to use this server over any other
- Tenant switching rules (`ALWAYS call nevent_reset_tenant`) — critical safety instruction to prevent DB mutation side-effects; not a selection directive
- Error code → LLM action table
- Token economy note: `"Prefer filtered/paginated queries over broad ones."` — refers to query style within this server's own analytics API; not a preference claim about this server vs. others

No comparative language, superlatives applied to this server, or directives to select this server over other apps.

---

## 2. Tool Descriptions

### 2.1 Analytics tools (`src/tools/analytics.ts`) — 9 tools

| Tool | Description excerpt | Verdict |
|------|---------------------|---------|
| `nevent_analytics_query` | "Query event marketing analytics..." with MANDATORY field ordering rules | CLEAN |
| `nevent_analytics_capabilities` | "Discover all available analytics tables..." | CLEAN |
| `nevent_analytics_table_schema` | "Get the full column schema for a specific analytics table..." | CLEAN |
| `nevent_analytics_filter_values` | "Get distinct values available for a field..." | CLEAN |
| `nevent_campaign_report` | "Generate a comprehensive analytics report for a single campaign. Executes 13 parallel queries..." | CLEAN |
| `nevent_segmentation_criteria` | "List all available audience segmentation criteria..." | CLEAN |
| `nevent_segment_preview` | "Preview estimated audience size..." with MANDATORY DSL rules | CLEAN |
| `nevent_segment_execute` | "Execute a segment definition and retrieve matching contacts..." | CLEAN |
| `nevent_dimension_values` | "Autocomplete values for a segmentation criterion..." | CLEAN |

The phrase `"MANDATORY RULES"` and `"ALWAYS call nevent_analytics_table_schema BEFORE querying"` appear in `nevent_analytics_query` and `nevent_segment_preview`. These are intra-server technical constraints: the analytics API returns errors if field names are guessed. They direct the model on how to use this server's own tools correctly, not to prefer this server over another.

### 2.2 Campaign read tools (`src/tools/campaigns.ts`) — 3 tools

| Tool | Description excerpt | Verdict |
|------|---------------------|---------|
| `nevent_list_campaigns` | "Call this to discover existing campaigns before reporting..." — includes suggested next steps within this server | CLEAN |
| `nevent_get_campaign` | "Retrieve the complete record of a campaign..." | CLEAN |
| `nevent_get_campaign_insights` | "Get pre-computed AI analysis for a specific campaign..." | CLEAN |

`nevent_list_campaigns` uses `"Call this to discover existing campaigns before reporting on performance or scheduling new sends"` — this scopes the tool to its literal purpose, it does not claim the tool should be used instead of another app's campaign tool.

### 2.3 Segment management tools (`src/tools/segments.ts`) — 4 tools

| Tool | Description excerpt | Verdict |
|------|---------------------|---------|
| `nevent_list_segments` | "Call this FIRST when you need to build or target an audience." | CLEAN |
| `nevent_get_segment` | "Retrieve the complete filter definition of a specific segment..." | CLEAN |
| `nevent_create_segment` | "Create and persist a new audience segment..." | CLEAN |
| `nevent_update_segment` | "Modify an existing segment's name and/or filter definition..." | CLEAN |

`"Call this FIRST when you need to build or target an audience"` — this is an intra-server workflow ordering hint (list before create), not a directive to use Nevent segmentation instead of another app's segmentation.

### 2.4 Template tools (`src/tools/templates.ts`) — 8 tools

| Tool | Description excerpt | Verdict |
|------|---------------------|---------|
| `nevent_list_templates` | "Call this to discover available email templates before creating a campaign." | CLEAN |
| `nevent_get_template` | "Retrieve the full content of an email template..." | CLEAN |
| `nevent_create_template` | "Create and persist a new email template with MJML or raw HTML content. Prefer MJML for responsive email..." | CLEAN |
| `nevent_update_template` | "Update an existing email template..." | CLEAN |
| `nevent_clone_template` | "Clone an existing email template to create a duplicate..." | CLEAN |
| `nevent_rename_template` | "Rename an email template without modifying its content..." | CLEAN |
| `nevent_preview_template` | "Preview a template with merge tags resolved... Always call before nevent_send_test_template..." | CLEAN |
| `nevent_send_test_template` | "Send a test email of the template to one or more email addresses via SES..." | CLEAN |

`"Prefer MJML for responsive email"` — technically recommends one of the two format options within this tool's own `format` parameter. This is a format best-practice note, not a preference claim directed at the model for app selection. CLEAN.

`"Always call before nevent_send_test_template"` — intra-server tool ordering for correct operation. CLEAN.

### 2.5 Deliverability tools (`src/tools/deliverability.ts`) — 2 tools

| Tool | Description excerpt | Verdict |
|------|---------------------|---------|
| `nevent_get_sending_profile` | "Call this before creating a campaign to verify the tenant is ready to send email." | CLEAN |
| `nevent_get_suppressions_summary` | "Get a deliverability health snapshot... A suppression rate above 2% indicates deliverability risk..." | CLEAN |

### 2.6 Campaign action tools (`src/tools/campaign-actions.ts`) — 2 tools

| Tool | Description excerpt | Verdict |
|------|---------------------|---------|
| `nevent_create_campaign` | "Create a new email, SMS, or WhatsApp campaign draft. PREREQUISITES:..." | CLEAN |
| `nevent_schedule_campaign` | "Schedule an existing DRAFT campaign for delivery... IMPORTANT: this is a DESTRUCTIVE action..." | CLEAN |

### 2.7 Tenant tools (`src/tools/tenants.ts`) — 3 tools

| Tool | Description excerpt | Verdict |
|------|---------------------|---------|
| `nevent_list_tenants` | "List all Nevent tenants (clients) accessible to the authenticated user." | CLEAN |
| `nevent_switch_tenant` | "Switch the active tenant for this session... SUPERADMIN: this mutates your user record in the database — the switch PERSISTS. Always call nevent_reset_tenant..." | CLEAN |
| `nevent_reset_tenant` | "Restore the original tenant context... ALWAYS call this after cross-tenant queries..." | CLEAN |

`"ALWAYS call nevent_reset_tenant"` — critical DB safety instruction for SUPERADMIN mode. Required to prevent persistent DB corruption. Not a selection directive.

### 2.8 Paid media tools (`src/tools/paid-media.ts`) — 11 tools

| Tool | Description excerpt | Verdict |
|------|---------------------|---------|
| `nevent_paid_ads_status` | "Check if a paid ads provider account... is connected. Call this first before any ads queries..." | CLEAN |
| `nevent_paid_ads_health` | "Get operational health signals... Always call this before claiming 'no data'..." | CLEAN |
| `nevent_list_paid_campaigns` | "List all paid campaigns synced from a provider..." | CLEAN |
| `nevent_get_paid_campaign_insights` | "Get daily performance metrics for a specific paid campaign..." | CLEAN |
| `nevent_paid_attribution` | "Get the most business-focused view of paid ads: links campaigns to actual ticket sales..." | CLEAN |
| `nevent_list_paid_ad_groups` | "List ad groups (ad sets) for a paid ads provider..." | CLEAN |
| `nevent_get_paid_ad_group_insights` | "Get daily performance metrics for a specific ad group..." | CLEAN |
| `nevent_get_paid_ad_group_comparative_stats` | "Compare an ad group's performance metrics against the mean of its campaign siblings..." | CLEAN |
| `nevent_get_paid_ad_group_targeting` | "Get the full audience targeting configuration for an ad group." | CLEAN |
| `nevent_list_paid_ads` | "List individual ads for a paid ads provider..." | CLEAN |
| `nevent_get_paid_ad_creative` | "Get the creative content of a specific ad..." | CLEAN |

`"Always call this before claiming 'no data' to the user"` (`nevent_paid_ads_health`) — intra-server diagnostic instruction to prevent false "no data" responses by checking health first. CLEAN.

`"For CTR: ratio > 1.0 means BETTER than siblings (higher CTR is better)"` — factual data explanation for interpreting metric values. CLEAN.

### 2.9 Short URL tools (`src/tools/short-urls.ts`) — 9 tools

| Tool | Description excerpt | Verdict |
|------|---------------------|---------|
| `nevent_list_short_urls` | "List all short URLs for the current tenant with their tracking metrics..." | CLEAN |
| `nevent_get_short_url` | "Get complete details of a specific short URL..." | CLEAN |
| `nevent_get_short_url_metrics` | "Get aggregated click analytics for a specific short URL..." | CLEAN |
| `nevent_get_short_url_campaign_metrics` | "Get aggregated click metrics across a parent short URL and all its per-user variants..." | CLEAN |
| `nevent_get_short_url_clicks` | "Get individual click event records for a specific short URL..." | CLEAN |
| `nevent_list_short_url_user_links` | "List all per-user short URL variants created under a parent..." | CLEAN |
| `nevent_create_short_url` | "Create a new short URL that redirects to the specified destination..." | CLEAN |
| `nevent_update_short_url` | "Update an existing short URL's configuration..." | CLEAN |
| `nevent_create_bulk_user_short_urls` | "Generate per-user short URL variants for an existing parent short URL..." | CLEAN |

### 2.10 Help meta-tool (`src/tools/help.ts`) — 1 tool

**Tool description:**
```
'Get guidance when you are unsure which tool to call or how to handle an error. Returns structured markdown for the requested topic. Call with topic="workflows" for common patterns, topic="errors" for error code meanings, topic="tenants" for multi-tenant guidance, or topic=<category> like "paid_media" / "analytics" / "segments". Omit topic to get an index of all available topics.'
```

**Verdict:** CLEAN. Describes the tool's function (provide guidance about this server's own tools). Does not claim superiority over other apps, does not promote selection beyond literal purpose.

**Help content sections reviewed:**

- `HELP_INDEX` — topic index. CLEAN.
- `HELP_WORKFLOWS` — intra-server workflow sequences. CLEAN.
- `HELP_ERRORS` — error code glossary for this server's errors. CLEAN.
- `HELP_TENANTS` — multi-tenant switching guide. Contains `"ALWAYS call nevent_reset_tenant"` (safety). CLEAN.
- `HELP_ANALYTICS` — query rules. Contains `"ALWAYS call table_schema before querying. NEVER guess field names."` (API correctness). CLEAN.
- `HELP_SEGMENTS` — segment DSL guide. CLEAN.
- `HELP_CAMPAIGNS` — campaign tools guide. CLEAN.
- `HELP_TEMPLATES` — template tools guide. CLEAN.
- `HELP_DELIVERABILITY` — deliverability guide. CLEAN.
- `HELP_PAID_MEDIA` — paid media guide. CLEAN.
- `HELP_SHORT_URLS` — short URL guide. CLEAN.

---

## 3. Tool Titles

All 52 tool titles (the `annotations.title` field) are functional labels:

| Titles reviewed | Pattern | Verdict |
|----------------|---------|---------|
| "Query analytics data", "Discover analytics capabilities", ... | Verb + noun describing action | CLEAN |
| "List campaigns", "Get campaign details", ... | Verb + noun describing action | CLEAN |
| "Create segment", "Update segment", ... | Verb + noun describing action | CLEAN |
| "List email templates", "Get email template", ... | Verb + noun describing action | CLEAN |
| "Check paid ads connection status", "Get paid ads health signals", ... | Verb + noun describing action | CLEAN |
| "List short URLs", "Create short URL", ... | Verb + noun describing action | CLEAN |
| "Get Nevent MCP help" | Factual self-reference | CLEAN |

No title contains comparative, superlative, or selection-promotional language.

---

## 4. Zod Parameter `.describe()` Calls

Approximately 80 parameter-level `.describe()` strings across 7 schema files were reviewed. All are:

- Type/format descriptions (e.g., `"Date in yyyy-MM-dd format, e.g. '2024-01-15'"`)
- Field constraint notes (e.g., `"Criterion ID from nevent_segmentation_criteria"`)
- Nullable/optional explanations

One notable instance in `src/schemas/analytics.ts`:
```
"Prefer the top-level `timeGranularity` field introduced in v3.19.0."
```
This refers to an internal API deprecation (prefer the newer parameter over the deprecated one within the same schema). CLEAN.

No parameter description directs the model to prefer this app over any other or broadens triggering beyond the tool's stated purpose.

---

## 5. Borderline Cases Reviewed and Cleared

### 5.1 `"Prefer MJML for responsive email"` (nevent_create_template)

This recommends one of the tool's own two format parameter values (`"html"` vs `"mjml"`). It is a technical best-practice note for email rendering, comparable to documentation saying "use UTF-8 encoding". It does not direct the model to use this tool vs. any other app's tool. CLEAN.

### 5.2 `"MANDATORY RULES"` / `"ALWAYS call..."` patterns

These appear exclusively as intra-server constraints:
- `ALWAYS call nevent_analytics_table_schema BEFORE querying` — required to avoid API field-not-found errors
- `ALWAYS call nevent_reset_tenant` — required to prevent SUPERADMIN DB mutation persistence

These are operational safety and correctness requirements for using this server's API correctly. They are not directives to the model to select this server. CLEAN.

### 5.3 `"Call this FIRST when you need to build or target an audience"` (nevent_list_segments)

This directs the model to call this tool before `nevent_create_segment` (both within this server), because the segment ID is needed. It does not say "use this instead of another app's audience tool". CLEAN.

### 5.4 `"Official Nevent MCP server"` (package.json description)

The `package.json` `description` field is npm registry metadata — not directly surfaced to the model as a tool selection hint. "Official" is factually accurate (Nevent SL builds and maintains this). Per the task constraints ("Official Nevent client" type wording is allowed because it is factually true and supports the anti-pass-through narrative). CLEAN.

### 5.5 `"Get the most business-focused view of paid ads"` (nevent_paid_attribution)

This describes what this specific tool returns relative to other paid-media tools in the same server (status vs. health vs. attribution). It does not claim superiority over another app's attribution feature. CLEAN.

---

## 6. Surfaces NOT Changed

Per the task constraints, the following were explicitly excluded from audit scope:
- `readOnlyHint`, `destructiveHint`, `openWorldHint` annotations (NEV-1651 scope, already merged)

---

## 7. Conclusion

**Zero violations found.** All 196 model-readable surfaces audited pass the OpenAI ChatGPT Apps Directory fair-play rules:

- No text claims this app is "better than", "preferred over", or "official compared to" any other app
- No text directs the model to "always use this app" or "use this instead of" another app
- Workflow ordering directives (`ALWAYS call X before Y`) are intra-server operational constraints, not inter-app selection directives
- Safety directives (`ALWAYS call nevent_reset_tenant`) are critical because SUPERADMIN switches mutate the database
- All `"best"` / `"prefer"` instances refer to technical format choices within this server's own parameters, not comparative claims against other apps
- The `nevent_help` meta-tool describes this server's own capabilities without any promotional or comparative framing

No code changes were made. This audit document is the only artifact produced by this task.
