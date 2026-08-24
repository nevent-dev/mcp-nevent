# Anthropic Connectors Directory — portal answers

Copy-paste answers for every step of the submission portal at
<https://claude.ai/admin-settings/directory/submissions/new>.

Character limits are enforced by the portal; the counts below are already verified.
Anything marked **[TODO]** needs a human decision or an asset that does not exist yet.

> Two review tiers exist. Every submission is auto-scanned and listed as a **community
> connector** by default. Anthropic escalates listings it judges highly useful to
> **verified** review, where a reviewer functionally tests every tool. You do not opt in —
> prepare as if verified review will happen.

---

## Step 1 — Introduction

Nothing to enter. Confirms the portal accepts remote MCP servers only. Nevent MCP is a
remote streamable-HTTP server, so this is the correct path.

## Step 2 — Connection

| Field | Answer |
|---|---|
| Server URL | `https://mcp.nevent.ai/` |
| Transport | **Streamable HTTP** |
| Same URL for every user? | **Yes** — all tenants connect to the same endpoint; isolation is per-JWT, not per-URL |

Verified live: `GET /health` → `{"status":"ok","version":"1.8.0","toolsCount":59}`.

## Step 3 — Tools

Tools sync automatically from the connected server. Expect **59 tools**, grouped as
43 read-only / 16 write. No tool is missing `title` or its hint — see
[`TOOL-AUDIT.md`](./TOOL-AUDIT.md).

⚠️ **Check the count the portal reports.** 14 tools (campaigns, templates, deliverability)
only register when `mongoUri` is configured. Production has it — a local stdio run without
it exposes only 46. If the portal shows fewer than 59, the connected environment is wrong.

## Step 4 — Listing

**Server name** (limit 100) — 6 chars:

```
Nevent
```

**Tagline** (limit 55) — 52 chars:

```
Campaigns, segments and ad analytics for live events
```

**Description** (limit 2000) — 1,132 chars:

```
Nevent is the marketing platform for live event promoters — festivals, concerts, venues and clubs. This connector brings your Nevent workspace into Claude so you can work through your event marketing in plain language instead of clicking through dashboards.

Ask how a campaign performed and get open, click, bounce and conversion numbers broken down by segment. Build an audience by describing it ("VIP buyers from 2025 who haven't opened an email in 90 days"), preview its size before committing, and save it as a reusable segment. Draft email, SMS, WhatsApp and push campaigns, quote what a send will cost in credits before scheduling it, and check your sending domain's warm-up state and suppression rate before a large send.

It also covers paid media — Meta, Google and TikTok campaign insights, ad-group breakdowns and attribution back to ticket sales — plus tracked short links with per-user click attribution, an email template library with merge-tag previews, and your media asset library.

Sending a campaign always requires explicit confirmation, and connections default to read-only until you widen the permission mode.
```

| Field | Answer |
|---|---|
| Categories (1–5) | **[TODO]** pick from the portal list. Priority order: Marketing → Sales & CRM → Data & Analytics → Productivity |
| Documentation URL | `https://help.nevent.ai/en/nevent-ai/` (verified HTTP 200) |
| Privacy policy URL | `https://nevent.ai/en/privacy/` (verified HTTP 200 — **but see BLOCKERS.md #1**) |
| Support contact | `support@nevent.ai` |
| Icon | **[TODO]** — not in the repo. Needs the Nevent mark as a square PNG |
| URL slug | `nevent` — **permanent once published, cannot be changed** |

## Step 5 — Use cases

**Primary use cases:**

```
Event promoters use Nevent in Claude for four recurring jobs.

Campaign reporting: pull performance for a send or a date range — opens, clicks, bounces, unsubscribes, revenue attribution — and compare campaigns without exporting anything.

Audience building: describe a target audience in natural language, preview how many contacts match before saving, then persist it as a segment reusable across future campaigns.

Pre-send checks: quote the credit cost and eligible audience of a campaign, verify the sending domain is validated and out of warm-up, and check the suppression rate before committing to a large send.

Paid media review: read Meta, Google and TikTok campaign and ad-group performance side by side with owned-channel results, and attribute paid spend back to ticket sales.
```

**What users need before connecting:**

```
An active Nevent account with access to at least one tenant. Roles STAFF and above can read; segment and template writes require ADMIN or OWNER. Paid media tools additionally require the tenant's Meta, Google or TikTok ad account to be connected in Nevent, and are currently gated to tenants enrolled in the paid-media pilot. No installation, API key or configuration is needed — authentication happens through OAuth at connection time.
```

**Does the connector read data, write data, or both?** → **Both** (43 read, 16 write).

## Step 6 — Company

| Field | Answer |
|---|---|
| Company name | Neventech S.L. — **[VERIFY]** exact registered name |
| Website | `https://nevent.ai/en` |
| Primary contact | Samuel Fraga · samuel.fraga@nevent.es |

## Step 7 — Authentication

**OAuth with Dynamic Client Registration (DCR).** Verified live against the server:

| Endpoint | Value |
|---|---|
| `/.well-known/oauth-protected-resource` | `resource: https://mcp.nevent.ai/`, `scopes_supported: ["mcp:tools"]` |
| `/.well-known/oauth-authorization-server` | issuer `https://mcp.nevent.ai/` |
| Registration | `POST /register` (DCR) |
| Authorization | `GET /authorize` · PKCE `S256` |
| Token | `POST /token` · grants `authorization_code`, `refresh_token` |
| Revocation | `POST /revoke` |

DCR is supported out of the box by Anthropic — no coordination with the review team needed.
Tools do **not** prompt for auth on demand; the session is authenticated up front.

## Step 8 — Data handling

| Question | Answer |
|---|---|
| Whose API does the connector call? | **Our own first-party APIs.** `mcp.nevent.ai` fronts Nevent's own services (nev-api, nev-data-api) — the domain matches the service, as the policy requires |
| Personal health data? | **No** |
| Sponsored content? | **No** |
| Financial transactions? | **No.** Campaign credits are an internal balance; the connector reads and quotes them but moves no money |
| AI media generation? | **No** |

Data processing summary for the free-text field:

```
Tenant data is processed on Nevent's own AWS infrastructure in eu-west-1. The connector holds no data of its own: it issues short-lived JWTs scoped to a single tenant after OAuth, forwards each tool call to Nevent's first-party APIs, and returns the response. There are no shared service accounts — every session is isolated. No conversation content is stored, and no data is used for model training.
```

## Step 9 — Test & launch

Point the reviewer at [`REVIEWER_GUIDE.md`](../../REVIEWER_GUIDE.md), which already carries
the connection steps and a prompt per tool category. Paste this into the portal field:

```
Reviewer account: [TODO — email] / [TODO — password]

1. Claude.ai → Settings → Connectors → Add custom MCP
2. Server URL: https://mcp.nevent.ai/
3. Connect. An OAuth window opens; log in with the credentials above.
4. If a tenant picker appears, choose the tenant labelled "demo".
5. Approve the "mcp:tools" scope. The connector appears as active.

The account is scoped to a single demo tenant populated with synthetic data — campaigns with real engagement metrics, segments, templates, short links and paid-media history. No production customer data is reachable from it.

The account runs in STANDARD operation mode: read tools and reversible writes (create segment, clone template, create short URL) work; irreversible sends (nevent_schedule_campaign) are blocked at the mode gate and return operation_not_permitted. To functionally test the send path, tell us and we will switch the account to FULL for the review window.

Suggested walkthrough:
- "What is this MCP and what tenants do I have access to?" → nevent_list_tenants
- "List my last 5 email campaigns with their open rate" → nevent_list_campaigns
- "Give me a full performance report for campaign <id>" → nevent_campaign_report
- "What were our top engagement metrics in the last 30 days?" → nevent_analytics_query
- "Preview the audience of contacts who opened a campaign in the last 14 days" → nevent_segment_preview
- "Create a draft segment named 'demo-mcp-review' from that audience" → nevent_create_segment
- "How are our Meta ads performing this month?" → nevent_paid_ads_status → nevent_list_paid_campaigns

Support during review: support@nevent.ai and samuel.fraga@nevent.es (same-day response).
```

**Self-test confirmation.** The portal asks you to confirm you have run every tool yourself,
via MCP Inspector or as a custom connector. **[TODO — do this before submitting.](./BLOCKERS.md)**

## Step 10 — Compliance

Seven acknowledgments, all required. Pre-checked against the current state of the server:

| # | Acknowledgment | Status |
|---|---|---|
| 1 | Directory guidelines | OK — see BLOCKERS.md for the two open items |
| 2 | First-party API usage | OK — `mcp.nevent.ai` fronts Nevent's own APIs |
| 3 | No financial transactions | OK — no money movement |
| 4 | No AI media generation | OK |
| 5 | No prompt injection in tool descriptions | ⚠️ **Review needed — BLOCKERS.md #2** |
| 6 | No conversation data collection | OK — the server logs tool calls and parameters, never conversation content |
| 7 | Public documentation | OK — `help.nevent.ai` is live with 6 example prompts |

## Step 11 — Review

Final read-through. The portal flags short answers as quality warnings and passes them to
reviewers, so keep the long-form answers above intact rather than trimming them.

---

## Allowed link URIs (optional field)

Only relevant if the server uses `ui/open-link`. It does not today — leave blank. If added
later, declare only origins Nevent owns: `https://nevent.ai`, `https://help.nevent.ai`,
`https://mcp.nevent.ai`.

## Carousel screenshots

Only required for **MCP Apps** (servers that surface interactive UI). Nevent MCP returns
text/JSON, so it is a plain remote MCP server and screenshots are **not required**.
If you want them for the listing anyway: PNG, ≥1000px wide, 3–5 images, cropped to the
response with the prompt excluded, each paired with its prompt text supplied separately.
