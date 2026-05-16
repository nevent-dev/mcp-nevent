# Nevent MCP

> Talk to your live-events CRM (campaigns, analytics, paid ads, segments) in Claude and ChatGPT.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.0.0-green.svg)](CHANGELOG.md)

---

## Quick add

### Claude.ai (recommended — hosted, no setup)

1. Open Claude.ai → Settings → Integrations
2. Add custom connector → URL: `https://mcp.nevent.ai/mcp`
3. Authorize with your Nevent admin account

<!-- screenshot: claude-ai-add-connector.png -->

### Claude Desktop / Cursor / Cline / Continue (stdio, local)

Build first if needed: `npm install && npm run build`

Add to your MCP client config:

```json
{
  "mcpServers": {
    "nevent": {
      "command": "node",
      "args": ["/path/to/mcp-nevent/dist/index.js"],
      "env": {
        "NEVENT_JWT_TOKEN": "your_nevent_jwt_token"
      }
    }
  }
}
```

For **Claude Desktop**, the config file is:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

For **Claude Code**:

```bash
claude mcp add nevent -- node /path/to/mcp-nevent/dist/index.js
export NEVENT_JWT_TOKEN=your_token
```

### ChatGPT (custom connectors)

Settings → Connectors → Add custom MCP → URL `https://mcp.nevent.ai/mcp`. The OAuth flow will prompt you to log in with your Nevent admin account.

---

## What you can ask

```
"Show me registrations for EventX broken down by ticket type"

"Which campaigns sent last month had an open rate above 30%?"

"Create a segment of all attendees who bought a VIP ticket in 2025
 but haven't opened any email in the last 90 days"

"Schedule the 'Summer Gala' email campaign for next Monday at 10:00 CET"

"Compare ROAS across our Meta ad campaigns for March"

"How many suppressions did we accumulate this month and what are the top reasons?"
```

---

## Tools (43)

### Analytics & Segmentation

| Tool | Description |
|------|-------------|
| `nevent_analytics_capabilities` | Discover available data tables — call first if unsure what data exists |
| `nevent_analytics_table_schema` | Get column definitions for a specific table |
| `nevent_analytics_query` | Query with dimensions, metrics, filters, and time ranges |
| `nevent_analytics_filter_values` | Get distinct field values to build valid filters |
| `nevent_campaign_report` | Comprehensive campaign performance report — 13 parallel queries in one call |
| `nevent_segmentation_criteria` | List all criteria available for building audience segments |
| `nevent_dimension_values` | Autocomplete values for a segmentation criterion |
| `nevent_segment_preview` | Preview estimated audience size without saving |
| `nevent_segment_execute` | Execute a segment and get paginated matching contacts |
| `nevent_help` | In-session guidance by topic (workflows, errors, tenants, analytics) |

### Multi-tenant + Segment Management

| Tool | Description |
|------|-------------|
| `nevent_list_tenants` | List all tenants accessible to the authenticated user |
| `nevent_switch_tenant` | Set the active tenant for this MCP session |
| `nevent_reset_tenant` | Restore home tenant after a cross-tenant operation (SUPERADMIN) |
| `nevent_list_segments` | List saved segments for the active tenant |
| `nevent_get_segment` | Get full filter definition and metadata for a segment |
| `nevent_create_segment` | Create and persist a new audience segment |
| `nevent_update_segment` | Modify an existing segment's name or filter definition |

### Campaigns

| Tool | Description |
|------|-------------|
| `nevent_list_campaigns` | List campaigns with status, channel, and engagement metrics |
| `nevent_get_campaign` | Full campaign detail: content, metrics, tracked links |
| `nevent_get_campaign_insights` | AI-generated insights and anomalies for a campaign |
| `nevent_create_campaign` | Create a new campaign draft (EMAIL/SMS/WhatsApp) |
| `nevent_schedule_campaign` | Schedule a draft campaign for delivery (requires `confirmed=true`) |

### Templates

| Tool | Description |
|------|-------------|
| `nevent_list_templates` | List email templates for the active tenant |
| `nevent_get_template` | Full template content: MJML/HTML source, subject, usage metrics |
| `nevent_create_template` | Create a new email template |
| `nevent_update_template` | Update an existing template's content or tags |
| `nevent_clone_template` | Duplicate an existing template |
| `nevent_rename_template` | Rename a template without re-rendering content |
| `nevent_preview_template` | Preview with merge-tag resolution against a sample user |
| `nevent_send_test_template` | Send a real test email via SES to up to 10 recipients |

### Deliverability

| Tool | Description |
|------|-------------|
| `nevent_get_sending_profile` | Sender domain validation and warm-up status |
| `nevent_get_suppressions_summary` | Suppressions summary with 30-day trend and reason breakdown |

### Paid Media (11 tools)

| Tool | Description |
|------|-------------|
| `nevent_paid_ads_status` | Check if a provider account is connected and when data last synced |
| `nevent_paid_ads_health` | Surfaces throttle state, feature gate enrollment, stale syncs |
| `nevent_list_paid_campaigns` | List all synced campaigns with budget and status |
| `nevent_get_paid_campaign_insights` | Daily metrics: spend, CTR, CPM, CPC, ROAS |
| `nevent_paid_attribution` | Links campaigns to ticket sales and revenue via UTM matching |
| `nevent_list_paid_ad_groups` | List ad groups, optionally filtered by campaign |
| `nevent_get_paid_ad_group_insights` | Daily metrics for an ad group |
| `nevent_get_paid_ad_group_comparative_stats` | Compare ad group vs campaign siblings |
| `nevent_get_paid_ad_group_targeting` | Full audience targeting config |
| `nevent_list_paid_ads` | List individual ads with UTM fields |
| `nevent_get_paid_ad_creative` | Ad creative: body, title, CTA, images/videos |

---

## How it works

```
LLM (Claude / ChatGPT)
        |
        | MCP over Streamable HTTP or stdio
        v
  ┌─────────────────┐
  │  Nevent MCP     │  mcp.nevent.ai (hosted) or local
  └─────────────────┘
        |
        | REST + JWT
        v
  Nevent APIs (analytics, campaigns, segments, paid media)
```

**OAuth 2.1** is used for hosted (HTTP) mode: the MCP server acts as an
authorization server, issuing short-lived JWT tokens after validating your
Nevent credentials. Each session is isolated — no shared service accounts.

**Privacy:** tenant data is isolated per session. Data does not leave the
Nevent infrastructure and is not used for model training.

---

## For developers

### Run locally (stdio)

```bash
npm install
npm run build
export NEVENT_JWT_TOKEN=your_token
node dist/index.js
```

### Run locally (HTTP)

```bash
npm install
npm run build
MCP_JWT_SECRET=dev-secret-at-least-32-chars \
MONGODB_URI=mongodb://localhost:27017/mcp-nevent \
MCP_TRANSPORT=http \
node dist/index.js
```

### Configuration

**stdio mode:**

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NEVENT_JWT_TOKEN` | Yes | — | JWT token for authenticating with the data API |
| `NEVENT_DATA_API_URL` | No | `https://data.nevent.es` | Data API base URL |
| `NEVENT_OPERATION_MODE` | No | `READ_ONLY` | `READ_ONLY` \| `STANDARD` \| `FULL` |

**HTTP mode:**

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MCP_JWT_SECRET` | Yes | — | JWT signing key for MCP access tokens (>= 32 chars) |
| `MONGODB_URI` | Yes | — | MongoDB connection URI for OAuth token storage |
| `MCP_TRANSPORT` | Yes | `stdio` | Set to `http` |
| `MCP_PORT` | No | `3000` | HTTP port |
| `MCP_SERVER_URL` | No | `http://localhost:{port}` | Public HTTPS URL of this server |
| `NEVENT_API_URL` | No | `https://api.nevent.es` | Nevent API URL (auth + tenant endpoints) |
| `NEVENT_DATA_API_URL` | No | `https://data.nevent.es` | Data API base URL |
| `NEVENT_OPERATION_MODE` | No | `READ_ONLY` | `READ_ONLY` \| `STANDARD` \| `FULL` |
| `MCP_ALLOWED_ORIGINS` | No | `*` | Comma-separated allowed CORS origins |

### Architecture brief

```
src/
├── index.ts                        # Entry point — stdio vs HTTP transport selection
├── server.ts                       # MCP server factory (transport-agnostic)
├── server-instructions.ts          # Server-level LLM instructions (session init)
├── auth/
│   ├── oauth-provider.ts           # OAuth 2.1 provider (login, token exchange)
│   ├── oauth-stores.ts             # MongoDB-backed OAuth stores
│   ├── token-service.ts            # JWT sign/verify with MCP_JWT_SECRET
│   └── login-page.ts               # HTML login page renderer
├── clients/
│   ├── base-client.ts              # Shared HTTP client (JWT auth, 401 auto-refresh)
│   ├── data-client.ts              # Data API client with TTL caches
│   ├── paid-media-client.ts        # Paid media endpoints client
│   ├── template-client.ts          # Template operation endpoints
│   └── session-clients.ts          # Per-session aggregate with atomic JWT rotation
├── config/
│   ├── operation-mode.ts           # READ_ONLY | STANDARD | FULL operation guard
│   └── timeouts.ts                 # Centralised timeout constants
├── tools/                          # One file per tool category
├── schemas/                        # Zod validation schemas per category
└── types/                          # TypeScript types per domain
```

Key design decisions:
- **SessionClients** provides atomic JWT rotation — if a tenant switch or 401 refresh
  fails mid-flight, neither the data client nor the paid media client is updated.
- **TTL caches** (5 min) in `DataClient` for capabilities and segmentation criteria
  reduce API calls on repeated tool invocations within a session.
- **Operation mode guard** (`READ_ONLY` / `STANDARD` / `FULL`) controls which write
  tools are available, protecting against accidental mutations.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow.

---

## Multi-tenant support

Nevent uses a hierarchical tenant model.

| Role | What they can see |
|------|-------------------|
| SUPERADMIN | All tenants in the system |
| OWNER | Their own tenant and all child tenants |
| ADMIN | Only their own tenant |

```
1. nevent_list_tenants      → list accessible tenants (returns tenant IDs)
2. nevent_switch_tenant     → set active tenant for this session
3. nevent_reset_tenant      → restore home tenant (SUPERADMIN)
```

### Tenant switching contract

**When you call `nevent_switch_tenant`:**

1. The MCP server calls the tenant-switch endpoint on the Nevent API with `{ tenantId }`.
2. The API validates that the JWT holder has access to the target tenant and returns a new access token scoped to the new tenant.
3. The MCP server updates the JWT in both `DataClient` (for analytics) and `PaidMediaClient` (for paid media) **atomically**.
4. All in-memory caches (capabilities, segmentation criteria) are **invalidated** — subsequent calls will fetch fresh data for the new tenant context.
5. `activeTenantId` is updated from the new JWT's `tenantId` claim.

**When you call `nevent_reset_tenant`:**

1. The MCP server reads `homeTenantId` — the tenant ID captured from the original JWT at session creation time.
2. It calls the tenant-switch endpoint with `{ tenantId: homeTenantId }` to restore the original context.
3. Same cache invalidation and JWT rotation as `nevent_switch_tenant`.
4. If `homeTenantId` is not available (e.g. the original JWT had no `tenantId` claim), the tool returns an error.

**Invariants:**
- Tenant context is **session-scoped** — switching in one session does not affect any other user.
- The JWT rotation is atomic — if the API call fails, neither client is updated.
- The tool response includes the new `active_tenant_id` so the agent can verify the switch succeeded.

---

## Common workflows

### Analytics: querying event data

```
1. nevent_analytics_capabilities      → discover available tables
2. nevent_analytics_table_schema      → get exact column names for your table
3. nevent_analytics_filter_values     → get valid values for filter fields
4. nevent_analytics_query             → run the query
```

### Segmentation: build and preview an audience

```
1. nevent_segmentation_criteria       → list available criterion_ids and operators
2. nevent_dimension_values            → autocomplete criterion values (e.g. event IDs)
3. nevent_segment_preview             → validate audience size before saving
4. nevent_create_segment              → persist the segment
```

### Campaign: create and schedule a send

```
1. nevent_get_sending_profile         → verify sender domain is validated
2. nevent_get_suppressions_summary    → check suppression rate (warn if > 2%)
3. nevent_list_segments               → pick target audience (get segment_id)
4. nevent_segment_preview             → confirm audience count with user
5. nevent_list_templates              → pick email template (get template_id)
6. nevent_get_template                → inspect template content before sending
7. nevent_create_campaign             → create DRAFT (no messages sent yet)
8. nevent_schedule_campaign           → schedule delivery (confirmed=true required)
```

### Performance analysis: how did a campaign perform?

```
1. nevent_list_campaigns              → find the campaign (filter by date/status)
2. nevent_get_campaign                → get full metrics (opens, clicks, bounces)
3. nevent_get_campaign_insights       → AI recommendations and anomaly detection
4. nevent_campaign_report             → deep analytics with 13 parallel queries
```

---

## Error codes glossary

All tool errors return a machine-readable `code` field for programmatic handling.

| Code | Type | Meaning | Recovery |
|------|------|---------|----------|
| `invalid_token` | `authentication_error` | JWT missing, expired, or malformed | Re-authenticate; check `NEVENT_JWT_TOKEN` |
| `forbidden` | `authentication_error` | Insufficient role (ADMIN / SUPERADMIN required) | Use an account with the required role |
| `not_found` | `not_found` | Resource does not exist or belongs to another tenant | Verify the ID; check active tenant |
| `rate_limit_exceeded` | `rate_limit_error` | Too many requests — `param` contains retry-after seconds | Wait and retry |
| `server_error` | `api_error` | Upstream API 5xx — transient error | Retry after exponential backoff |
| `network_error` | `api_error` | Could not reach upstream API (timeout or DNS failure) | Check connectivity; verify `NEVENT_API_URL` |
| `segment_not_found` | `not_found` | Segment ID not found in active tenant | Verify ID with `nevent_list_segments` |
| `invalid_segment_definition` | `invalid_request` | Segment DSL validation failed | Check criterion_ids against `nevent_segmentation_criteria` |
| `missing_update_fields` | `invalid_request` | Update call with no fields to change | Provide at least one of name or definition |
| `tenant_required` | `invalid_request` | Tool requires active tenant | Call `nevent_switch_tenant` first |
| `operation_mode_blocked` | `invalid_request` | Write tool called in READ_ONLY mode | Set `NEVENT_OPERATION_MODE=STANDARD` or `FULL` |
| `feature_gate_not_enrolled` | `not_found` | Tenant not enrolled in provider insights pilot | Contact admin to enable `MODULE_ATTRIBUTION` |

### Error format

All errors follow a structured format:

```json
{
  "error": {
    "type": "authentication_error | invalid_request | api_error | rate_limit_error | not_found",
    "message": "Human-readable explanation with actionable guidance",
    "code": "machine_readable_code",
    "param": "offending_parameter (when applicable)"
  }
}
```

---

## Roadmap

- Additional template operations (analyze performance, bulk import)
- Advanced audience builder (nested logic groups, multi-event sequences)
- Webhook tool support
- <!-- REVIEW: confirm if there are other roadmap items to surface publicly -->

---

## Links

- Landing: https://nevent.ai/en/features/nevent-ai/
- Docs (coming soon): https://docs.nevent.ai/mcp
- Support: support@nevent.ai
- License: [MIT](LICENSE)
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md)
- Security: [SECURITY.md](SECURITY.md)
