# Nevent MCP Server

A Model Context Protocol (MCP) server that gives AI agents (ChatGPT, Claude Desktop, Claude Code) direct access to Nevent's analytics and segmentation capabilities. Query BigQuery event data and build audience segments using natural language — no SQL or API knowledge required.

Supports two transport modes: **stdio** (local, Claude Desktop / Claude Code) and **HTTP** (remote, ChatGPT / Claude.ai via OAuth 2.1).

---

## Quick Start

```bash
# 1. Install
npm install

# 2. Set your JWT token
export NEVENT_JWT_TOKEN=your_nevent_jwt_token

# 3. Run
npm run dev
```

---

## Available Tools (43)

### Analytics & Segmentation (always registered)

| Tool | Category | Description |
|------|----------|-------------|
| `nevent_analytics_capabilities` | Analytics | Discover available BigQuery tables. Call first if unsure what data exists. |
| `nevent_analytics_table_schema` | Analytics | Get column definitions for a specific table (requires ADMIN role). |
| `nevent_analytics_query` | Analytics | Query a BigQuery collection with dimensions, metrics, filters, time ranges. |
| `nevent_analytics_filter_values` | Analytics | Get distinct field values to build valid analytics filters. |
| `nevent_campaign_report` | Analytics | Comprehensive campaign performance report — 13 parallel queries in one call. |
| `nevent_segmentation_criteria` | Segmentation | List all criteria available for building audience segments. |
| `nevent_dimension_values` | Segmentation | Autocomplete values for a segmentation criterion. |
| `nevent_segment_preview` | Segmentation | Preview estimated audience size without saving (always call before execute). |
| `nevent_segment_execute` | Segmentation | Execute a segment and get paginated matching contacts. |
| `nevent_help` | Meta | In-session guidance by topic (workflows, errors, tenants, analytics…). |

### Multi-tenant + Segment Management (requires `NEVENT_API_URL`)

| Tool | Category | Description |
|------|----------|-------------|
| `nevent_list_tenants` | Multi-tenant | List all tenants accessible to the authenticated user. |
| `nevent_switch_tenant` | Multi-tenant | Set the active tenant for this MCP session. |
| `nevent_reset_tenant` | Multi-tenant | Restore home tenant after a cross-tenant operation (SUPERADMIN). |
| `nevent_list_segments` | Segments | List saved segments for the active tenant. |
| `nevent_get_segment` | Segments | Get full filter definition and metadata for a segment. |
| `nevent_create_segment` | Segments | Create and persist a new audience segment. |
| `nevent_update_segment` | Segments | Modify an existing segment's name or filter definition. |

### Campaign & Template Tools (requires `MONGODB_URI`)

| Tool | Category | Description |
|------|----------|-------------|
| `nevent_list_campaigns` | Campaigns | List campaigns with status, channel, and engagement metrics. |
| `nevent_get_campaign` | Campaigns | Full campaign detail: content, metrics, tracked links. |
| `nevent_get_campaign_insights` | Campaigns | AI-generated insights and anomalies for a campaign. |
| `nevent_create_campaign` | Campaigns | Create a new campaign draft (EMAIL/SMS/WhatsApp). |
| `nevent_schedule_campaign` | Campaigns | Schedule a draft campaign for delivery (destructive — requires `confirmed=true`). |
| `nevent_list_templates` | Templates | List email templates for the active tenant. |
| `nevent_get_template` | Templates | Full template content: MJML/HTML source, subject, usage metrics. |
| `nevent_create_template` | Templates | Create a new email template. |
| `nevent_update_template` | Templates | Update an existing email template's content or tags. |
| `nevent_clone_template` | Templates | Duplicate an existing template (name gets "(Copy)" suffix). Follow with rename + update. |
| `nevent_rename_template` | Templates | Rename a template without re-rendering content (lightweight). |
| `nevent_preview_template` | Templates | Preview with merge-tag resolution against a sample user. Returns raw + personalized HTML. |
| `nevent_send_test_template` | Templates | Send a real test email via SES to up to 10 recipients. Always preview first. |
| `nevent_get_sending_profile` | Deliverability | Sender domain validation and warm-up status. |
| `nevent_get_suppressions_summary` | Deliverability | Suppressions summary with 30-day trend and reason breakdown. |

---

## Paid Media Tools (11 tools)

Expose the nev-api `/api/ads/{provider}/...` endpoints to AI agents for paid advertising analysis.

**Requirements:**
- Role: `ADMIN` | `SUPERADMIN` | `OWNER`
- Capability: `MODULE_ATTRIBUTION`
- Providers: `meta` | `google` | `tiktok`
- Tenant: resolved from the JWT (no `tenant_id` parameter)

### Tier 1 — Essential queries

| Tool | Endpoint | Description |
|------|----------|-------------|
| `nevent_paid_ads_status` | `GET /api/ads/{provider}/status` | Check if a provider account is connected and when data was last synced. Call first to confirm the integration is active. |
| `nevent_paid_ads_health` | `GET /api/ads/{provider}/health` | Always call before claiming "no data" to the user. Surfaces throttle state, feature gate enrollment (pilot allowlist), stale syncs, and tier. |
| `nevent_list_paid_campaigns` | `GET /api/ads/{provider}/campaigns` | List all synced campaigns with budget and status. Returns `campaignId` values needed by other tools. |
| `nevent_get_paid_campaign_insights` | `GET /api/ads/{provider}/campaigns/{id}/insights` | Daily metrics for a campaign: spend, impressions, CTR, CPM, CPC, ROAS, engagement rate. Date range defaults to last 7 days. |
| `nevent_paid_attribution` | `GET /api/ads/{provider}/attribution` | The most business-focused view — links campaigns to actual ticket sales and revenue via UTM matching. |

### Tier 2 — Drill-down queries

| Tool | Endpoint | Description |
|------|----------|-------------|
| `nevent_list_paid_ad_groups` | `GET /api/ads/{provider}/ad-groups` | List ad groups (ad sets), optionally filtered by campaign. Returns `adGroupId` values needed by Tier 2 tools. |
| `nevent_get_paid_ad_group_insights` | `GET /api/ads/{provider}/ad-groups/{id}/insights` | Daily metrics for an ad group. Same fields as campaign insights, level = ADSET. |
| `nevent_get_paid_ad_group_comparative_stats` | `GET /api/ads/{provider}/ad-groups/{id}/comparative-stats` | Compare an ad group vs its campaign siblings. Each metric (costPerResult, CPM, frequency, CTR) includes `campaignMean` and `ratioVsMean` (1.0 = on par, 1.3 = 30% worse). Use to detect underperforming ad sets. |
| `nevent_get_paid_ad_group_targeting` | `GET /api/ads/{provider}/ad-groups/{id}/targeting` | Full audience targeting: age, gender, geo, interests, behaviors, placements, Advantage+ flags, custom audiences, bid strategy. |
| `nevent_list_paid_ads` | `GET /api/ads/{provider}/ads` | List individual ads with UTM fields. Filter by `campaignId` and/or `adGroupId`. |
| `nevent_get_paid_ad_creative` | `GET /api/ads/{provider}/ads/{id}/creative` | Ad creative: body, title, CTA, click URL, UTM params, pre-signed S3 image/video URLs (TTL ~1h). For Dynamic Creative Ads, includes all variants. |

### Feature Gate (404 handling)

Several endpoints return HTTP **404** (not 403) when the tenant is not enrolled in the provider's insights pilot. The tools detect this and return a descriptive error:

```json
{
  "error": {
    "type": "not_found",
    "code": "feature_gate_not_enrolled",
    "message": "This tenant is not enrolled in the meta campaign insights pilot. Contact admin to enable the feature gate (MODULE_ATTRIBUTION must be active and the tenant must be added to the provider allowlist)."
  }
}
```

Affected tools: `nevent_paid_ads_health`, `nevent_get_paid_campaign_insights`, `nevent_get_paid_ad_group_insights`, `nevent_get_paid_ad_group_comparative_stats`, `nevent_get_paid_ad_group_targeting`, `nevent_get_paid_ad_creative`.

### Suggested Workflow for Paid Media

```
1. nevent_paid_ads_status          → Is the provider connected at all?
2. nevent_paid_ads_health          → Is the data fresh? Are we throttled / enrolled in the pilot?
3. nevent_list_paid_campaigns      → Discover campaignId values (required by all drill-down tools)
4. nevent_get_paid_campaign_insights   → Daily spend/CTR/ROAS per campaign
5. nevent_paid_attribution         → Revenue + tickets sold per campaign (business view)
6. nevent_list_paid_ad_groups      → Discover adGroupId values for a campaign
7. nevent_get_paid_ad_group_comparative_stats   → Detect underperforming ad sets vs siblings
8. nevent_get_paid_ad_group_targeting   → Review audience configuration of an ad set
9. nevent_list_paid_ads            → List individual ads (discover adId values)
10. nevent_get_paid_ad_creative    → Review creative copy + visuals for a specific ad
```

---

## Architecture

```
src/
├── index.ts                        # Entry point — stdio vs HTTP transport selection
├── server.ts                       # MCP server factory (transport-agnostic)
├── server-instructions.ts          # Server-level LLM instructions (session init)
├── auth/
│   ├── oauth-provider.ts           # OAuth 2.1 provider (login, token exchange, verification)
│   ├── oauth-stores.ts             # MongoDB-backed OAuth stores (codes, tokens, clients)
│   ├── token-service.ts            # JWT sign/verify with MCP_JWT_SECRET
│   └── login-page.ts               # HTML login page renderer
├── client/
│   └── nevent-client.ts            # nev-api client (tenant listing)
├── clients/
│   ├── base-client.ts              # Shared HTTP client (JWT auth, 401 auto-refresh, errors)
│   ├── data-client.ts              # nev-data-api client (data.nevent.es) with TTL caches
│   ├── paid-media-client.ts        # nev-api paid media endpoints client
│   ├── template-client.ts          # nev-api template operation endpoints (clone/rename/preview/test)
│   └── session-clients.ts          # Per-session aggregate (DataClient + PaidMediaClient + TemplateClient)
├── config/
│   ├── operation-mode.ts           # READ_ONLY | STANDARD | FULL operation guard
│   └── timeouts.ts                 # Centralised timeout constants (ms)
├── tools/
│   ├── analytics.ts                # 9 analytics + segmentation tool registrations
│   ├── campaign-actions.ts         # 2 campaign write tools (create, schedule)
│   ├── campaigns.ts                # 3 campaign read tools (list, get, insights)
│   ├── deliverability.ts           # 2 deliverability tools (sending profile, suppressions)
│   ├── help.ts                     # 1 meta-tool: nevent_help with topic-based guides
│   ├── helpers.ts                  # Shared ok/err/toErrorEnvelope/checkMode utilities
│   ├── logging.ts                  # Tool call telemetry logger (MongoDB mcp_tool_calls)
│   ├── paid-media.ts               # 11 paid media tools (ads, campaigns, ad groups)
│   ├── segments.ts                 # 4 segment tools (list, get, create, update)
│   ├── templates.ts                # 8 template tools (list, get, create, update, clone, rename, preview, send_test)
│   └── tenants.ts                  # 3 multi-tenant tools (list, switch, reset)
├── transports/
│   └── http.ts                     # Express app, OAuth endpoints, per-session MCP lifecycle
├── schemas/
│   ├── analytics.ts                # Zod schemas for analytics + segmentation tools
│   ├── campaign-actions.ts         # Zod schemas for campaign create/schedule
│   ├── campaigns.ts                # Zod schemas for campaign read tools
│   ├── deliverability.ts           # Zod schemas for deliverability tools
│   ├── paid-media.ts               # Zod schemas for paid media tools
│   ├── segments.ts                 # Zod schemas for segment tools
│   └── templates.ts                # Zod schemas for template tools
├── tests/
│   ├── data-client-caches.test.ts  # DataClient TTL cache behaviour
│   ├── error-format.test.ts        # Error envelope structure
│   ├── operation-mode.test.ts      # Operation mode guard
│   ├── paid-media.test.ts          # Paid media tool handler tests
│   ├── schemas.test.ts             # Zod schema validation
│   ├── segments.test.ts            # Segment tool handler tests
│   └── session-clients.test.ts     # JWT rotation + 401 auto-refresh tests
└── types/
    ├── analytics.ts                # BigQuery analytics request/response types
    ├── segmentation.ts             # Segmentation DSL types
    ├── templates.ts                # EmailTemplate, PreviewResponse, TestResponse types
    └── common.ts                   # Error format, pagination, HTTP response types

infra/
├── task-definition.json            # ECS Fargate task definition
└── setup.sh                        # AWS resource provisioning script
```

---

## Authentication Architecture

The server has **two independent authentication layers** that operate in sequence. Understanding this is the key to understanding the whole system.

```
ChatGPT / Claude.ai
        |
        | (1) OAuth 2.1 — signed with MCP_JWT_SECRET
        v
  ┌─────────────┐
  │  MCP Server │  mcp.nevent.ai
  └─────────────┘
        |
        | (2) nev-api JWT — obtained from POST /auth/admin/login
        v
  data.nevent.es (nev-data-api)
```

### Layer 1 — MCP OAuth (AI client to MCP server)

- ChatGPT or Claude.ai authenticates with the MCP server using OAuth 2.1.
- The MCP server runs its own authorization server at `mcp.nevent.ai`.
- Access tokens are JWTs signed with `MCP_JWT_SECRET` (`type: mcp_access_token`).
- These tokens protect all `/mcp` endpoints.
- Token expiry: 1 hour. Refresh tokens are stored in MongoDB and support rotation.
- Token revocation: refresh tokens revoked immediately; access tokens expire naturally (1-hour window is an accepted trade-off for stateless JWTs).

### Layer 2 — nev-api JWT (MCP server to data.nevent.es)

- When the user logs in through the OAuth flow, the MCP server calls `POST /auth/admin/login` on nev-api.
- nev-api returns an `access_token` signed with its own secret (`jwt.secret.key`).
- The MCP server stores this token in the user's refresh token document in MongoDB.
- Every subsequent MCP tool call uses this stored token to call `data.nevent.es` on behalf of the user.
- Each session has its own token — there is no shared service account. This provides complete tenant isolation.

### Why two separate secrets

| | MCP_JWT_SECRET | jwt.secret.key (nev-api) |
|---|---|---|
| Owned by | MCP server | nev-api |
| Signs | MCP access tokens | nev-api access tokens |
| Stored in | AWS Secrets Manager | nev-api environment |
| Protects | /mcp endpoints | data.nevent.es + all nev-api endpoints |

The keys do **not** need to match. Keeping them independent means: if one is compromised, the other layer remains secure.

### OAuth Flow (HTTP mode only)

1. AI client discovers `/.well-known/oauth-authorization-server`.
2. Client performs Dynamic Client Registration (`POST /register`).
3. Client redirects user to `GET /authorize` — the MCP server serves a Nevent login page.
4. User submits credentials. MCP server validates against `POST /auth/admin/login` on nev-api.
5. On success: authorization code issued, user redirected to client callback.
6. Client exchanges code for tokens at `POST /token` (PKCE verified by SDK).
7. Client uses Bearer token for all subsequent `/mcp` requests.

Login is credential-based only — there is no self-registration. New users must first register at `admin.nevent.es`.

---

## Multi-Tenant Support

Nevent uses a hierarchical tenant model. The MCP server exposes two tools to navigate it.

| Role | What they can see |
|------|-------------------|
| SUPERADMIN | All tenants in the system |
| OWNER | Their own tenant and all child tenants |
| ADMIN | Only their own tenant |

**How it works:**

1. Call `nevent_list_tenants` — returns `{ tenants: [{ id, name, domain, level, parentId }], count }`.
2. Call `nevent_switch_tenant` with a `tenant_id` — sets the active tenant for the session.
3. All subsequent analytics and segmentation queries route to that tenant's data.

Tenant switching is session-scoped. Because each HTTP session has its own `DataClient` instance, switching tenant in one session does not affect any other user.

ADMIN users can call `nevent_switch_tenant` but subsequent queries will fail if the target tenant differs from their own.

### Tenant Switching Contract

This section documents the exact behaviour of tenant management tools for SUPERADMIN users who work across multiple tenants.

**When you call `nevent_switch_tenant`:**

1. The MCP server calls `POST /users/tenant` on nev-api with `{ tenantId }`.
2. nev-api validates that the JWT holder has access to the target tenant and returns a **new access token + refresh token** scoped to the new tenant.
3. The MCP server updates the JWT in both `DataClient` (for analytics) and `PaidMediaClient` (for paid media) **atomically**.
4. All in-memory caches (capabilities, segmentation criteria) are **invalidated** — subsequent calls will fetch fresh data for the new tenant context.
5. `activeTenantId` is updated from the new JWT's `tenantId` claim.

**When you call `nevent_reset_tenant`:**

1. The MCP server reads `homeTenantId` — the tenant ID captured from the original JWT at session creation time.
2. It calls `POST /users/tenant` with `{ tenantId: homeTenantId }` to restore the original context.
3. Same cache invalidation and JWT rotation as `nevent_switch_tenant`.
4. If `homeTenantId` is not available (e.g. the original JWT had no `tenantId` claim), the tool returns an error.

**Invariants:**
- Tenant context is **session-scoped** — switching in one session does not affect any other user.
- The JWT rotation is atomic — if the nev-api call fails, neither client is updated.
- The tool response includes the new `active_tenant_id` so the agent can verify the switch succeeded.

---

## Common Workflows

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

## Configuration

### stdio mode (Claude Desktop, Claude Code)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NEVENT_JWT_TOKEN` | Yes | — | JWT token for authenticating with nev-data-api |
| `NEVENT_DATA_API_URL` | No | `https://data.nevent.es` | nev-data-api base URL |
| `NEVENT_OPERATION_MODE` | No | `READ_ONLY` | `READ_ONLY` \| `STANDARD` \| `FULL` |

### HTTP mode (ChatGPT, Claude.ai, remote clients)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MCP_JWT_SECRET` | Yes | — | JWT signing key for MCP access tokens (>= 32 chars) |
| `MONGODB_URI` | Yes | — | MongoDB connection URI for OAuth token storage |
| `MCP_TRANSPORT` | Yes | `stdio` | Set to `http` |
| `MCP_PORT` | No | `3000` | HTTP port |
| `MCP_SERVER_URL` | No | `http://localhost:{port}` | Public HTTPS URL of this server |
| `NEVENT_API_URL` | No | `https://api.nevent.es` | nev-api URL (auth + tenant endpoints) |
| `NEVENT_DATA_API_URL` | No | `https://data.nevent.es` | nev-data-api base URL |
| `NEVENT_OPERATION_MODE` | No | `READ_ONLY` | `READ_ONLY` \| `STANDARD` \| `FULL` |
| `MCP_ALLOWED_ORIGINS` | No | `*` | Comma-separated allowed CORS origins |

`NEVENT_JWT_TOKEN` is not used in HTTP mode. Each session obtains its own token during the OAuth flow.

---

## Usage with Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "nevent": {
      "command": "node",
      "args": ["/path/to/mcp-nevent/dist/index.js"],
      "env": {
        "NEVENT_JWT_TOKEN": "your_token_here"
      }
    }
  }
}
```

---

## Usage with Claude Code

```bash
# Add the MCP server
claude mcp add nevent -- node /path/to/mcp-nevent/dist/index.js

# Set the env var in your shell before launching Claude Code
export NEVENT_JWT_TOKEN=your_token
```

---

## Remote Mode (ChatGPT, Claude.ai)

The production deployment at `https://mcp.nevent.ai` exposes the server over HTTP with OAuth 2.1. Any MCP client that supports remote connections can connect to it.

**Endpoints:**

| Endpoint | Description |
|----------|-------------|
| `GET /.well-known/oauth-authorization-server` | OAuth server metadata |
| `GET /.well-known/oauth-protected-resource` | Protected resource metadata |
| `POST /register` | Dynamic Client Registration |
| `GET /authorize` | Login page |
| `POST /token` | Token exchange |
| `POST /revoke` | Token revocation |
| `POST /mcp` | MCP JSON-RPC (requires Bearer token) |
| `GET /mcp` | MCP SSE stream (requires Bearer token) |
| `DELETE /mcp` | Session termination |
| `GET /health` | Health check (no auth) |

**To connect from ChatGPT:** add a custom action pointing to `https://mcp.nevent.ai/mcp`. ChatGPT will follow the OAuth discovery flow automatically.

**To connect from Claude.ai:** add an integration with server URL `https://mcp.nevent.ai`.

Users must already have a Nevent admin account. There is no in-flow registration — the login page links to `admin.nevent.es` for new accounts.

---

## Deployment

The server runs as an **ECS Fargate** container on AWS.

| Resource | Value |
|----------|-------|
| Domain | `mcp.nevent.ai` |
| Region | `eu-west-1` |
| CPU / Memory | 256 vCPU / 512 MB |
| Container image | ECR `mcp-nevent:latest` |
| Secrets | AWS Secrets Manager (`mcp-jwt-secret`, `mongodb-uri`) |
| Port | 3000 (internal) → 443 (ALB) |

**CI/CD:** GitHub Actions deploys automatically on push to `main`. The workflow builds the Docker image, pushes to ECR, and updates the ECS service.

---

## Development

```bash
npm run build          # Compile TypeScript
npm run dev            # Run with tsx (no build needed, stdio mode)
npm test               # Run unit tests
npm run test:watch     # Watch mode
npm run test:coverage  # Coverage report
```

To run in HTTP mode locally:

```bash
MCP_JWT_SECRET=dev-secret-at-least-32-chars \
MONGODB_URI=mongodb://localhost:27017/mcp-nevent \
MCP_TRANSPORT=http \
npm run dev
```

---

## Workflow Tips

See the [Common Workflows](#common-workflows) section above for step-by-step guidance on analytics, segmentation, and campaign creation.

You can also call the `nevent_help` tool from within a session to get the same guidance in-context:

```
nevent_help()                        → index of all topics
nevent_help({ topic: "workflows" })  → common workflow chains
nevent_help({ topic: "errors" })     → error code reference
nevent_help({ topic: "tenants" })    → tenant switching guidance
```

---

## Observability

See [docs/observability.md](docs/observability.md) for:

- MongoDB `mcp_tool_calls` collection schema and TTL indexes
- Useful aggregation queries (top tools, error rates, latency P95, response size)
- Audit log format for write operations
- Error code reference

---

## Error Codes Glossary

All tool errors return a machine-readable `code` field for programmatic handling.

| Code | Type | Meaning | Recovery |
|------|------|---------|----------|
| `invalid_token` | `authentication_error` | JWT missing, expired, or malformed | Re-authenticate; check `NEVENT_JWT_TOKEN` |
| `forbidden` | `authentication_error` | Insufficient role (ADMIN / SUPERADMIN required) | Use an account with the required role |
| `not_found` | `not_found` | Resource does not exist or belongs to another tenant | Verify the ID; check active tenant |
| `rate_limit_exceeded` | `rate_limit_error` | Too many requests — `param` contains retry-after seconds | Wait and retry |
| `server_error` | `api_error` | nev-api 5xx — transient upstream error | Retry after exponential backoff |
| `network_error` | `api_error` | Could not reach nev-api (timeout or DNS failure) | Check connectivity; verify `NEVENT_API_URL` |
| `segment_not_found` | `not_found` | Segment ID not found in active tenant | Verify ID with `nevent_list_segments` |
| `invalid_segment_definition` | `invalid_request` | Segment DSL validation failed | Check criterion_ids against `nevent_segmentation_criteria` |
| `missing_update_fields` | `invalid_request` | Update call with no fields to change | Provide at least one of name or definition |
| `tenant_required` | `invalid_request` | Tool requires active tenant | Call `nevent_switch_tenant` first |
| `operation_mode_blocked` | `invalid_request` | Write tool called in READ_ONLY mode | Set `NEVENT_OPERATION_MODE=STANDARD` or `FULL` |
| `feature_gate_not_enrolled` | `not_found` | Tenant not enrolled in provider insights pilot | Contact admin to enable `MODULE_ATTRIBUTION` |

---

## Error Format

All errors follow a Stripe-inspired structured format:

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
