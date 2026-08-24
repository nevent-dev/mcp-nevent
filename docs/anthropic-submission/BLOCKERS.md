# Blockers and risks before submitting

Ordered by how likely each one is to cost you a rejection. Everything here was verified
against the live server, the public docs and `src/` on 2026-08-24 (v1.8.0, 59 tools).

---

## 🔴 1 — The privacy policy does not cover the connector

**Why it matters.** Anthropic's submission page says it plainly: *"Missing or incomplete
privacy policies result in immediate rejection."*

**What's there.** `https://nevent.ai/en/privacy/` is a general website/marketing policy
under Neventech (Sada, A Coruña; DPO `dpo@eritiaprivacidad.com`). It nominally touches the
five required areas, but the "what data we collect" section only refers to form fields
marked with an asterisk. It says nothing about tenant CRM data, contact records reachable
through `nevent_segment_execute`, campaign content, or the fact that an LLM client receives
this data. It never mentions MCP, Claude or the connector.

**Fix.** Add a "Nevent AI / MCP connector" section to the existing policy covering:
what tenant data the connector exposes (contacts, campaigns, segments, ad metrics), that
it is processed on Nevent's AWS eu-west-1 infrastructure, that it is not used for model
training, retention of OAuth tokens and tool-call logs, and the DPO contact. The README
already states most of this — it just isn't in the policy the reviewer will open.

**Owner:** legal/DPO. This is the longest-lead item — start it first.

---

## 🔴 2 — 21 tool descriptions use prompt-injection-shaped language

**Why it matters.** The pre-submission checklist rejects tool descriptions that
*"interfere with Claude calling other tools"* or *"tell Claude to behave in ways unrelated
to the tool's function"*, and closes with: **"Describe what the tool does. Do not tell
Claude how to behave."** Compliance acknowledgment #5 asks you to affirm exactly this.

Stating a data prerequisite is legitimate and common. What draws a flag is the imperative
register — block-capital `MANDATORY RULES`, `ALWAYS`, `NEVER`, `You MUST` — and, worse,
instructions about how to treat the *user* (`warn the user`, `surface this as a warning`,
`ALWAYS CONFIRM ... WITH THE USER`). Rewrite as description, not instruction. Same
information, indicative mood.

### Highest risk — rewrite before submitting

| Tool | Current | Suggested |
|---|---|---|
| `nevent_analytics_query` | `MANDATORY RULES: (1) ALWAYS call nevent_analytics_table_schema BEFORE querying... NEVER guess field names.` | `Field names come from nevent_analytics_table_schema; queries with unknown fields are rejected. Boolean fields use the is_true/is_false operators rather than eq.` |
| `nevent_segment_preview` | `MANDATORY RULES: ... Do NOT include modifiers unless...` | `Modifiers are optional and apply only to frequency or recency filtering; when present, time_range.value is required.` |
| `nevent_create_campaign` | `ALWAYS CONFIRM THE SEGMENT AUDIENCE COUNT WITH THE USER BEFORE...` | Drop the sentence. The draft-only behaviour and the separate `nevent_schedule_campaign` step already make the safety model clear. |
| `nevent_schedule_campaign` | `IMPORTANT: ... You MUST set confirmed=true...` | `Queues the campaign for delivery to real contacts. Requires confirmed=true, which the caller sets after obtaining user consent.` |
| `nevent_get_sending_profile` | `...warn the user before scheduling a large campaign.` | `A profile that is unvalidated or still warming limits deliverability on large sends.` |
| `nevent_get_suppressions_summary` | `A suppression rate above 2% indicates deliverability risk — surface this as a warning...` | `A suppression rate above 2% indicates deliverability risk.` |
| `nevent_paid_ads_health` | `Always call this before claiming "no data" to the user...` | `Distinguishes an empty result from a throttled integration, a stale sync or a tenant outside the pilot allowlist.` |
| `nevent_switch_tenant` / `nevent_reset_tenant` | `ALWAYS call nevent_reset_tenant when...` | `For SUPERADMIN users the switch persists in the user record; nevent_reset_tenant reverses it.` |

### Lower risk — tidy if convenient

`nevent_analytics_capabilities`, `nevent_list_campaigns`, `nevent_list_templates`,
`nevent_update_segment`, `nevent_update_template`, `nevent_preview_template`,
`nevent_paid_ads_status`, `nevent_quote_campaign`, `nevent_create_segment`,
`nevent_create_bulk_user_short_urls`, `nevent_list_short_url_destinations`,
`nevent_list_campaign_recipients`. These mostly say "call X before Y" — factual sequencing,
not behavioural instruction. Converting `Call this to discover…` into `Returns…` costs
nothing and removes the pattern entirely.

### Also worth doing

`src/server-instructions.ts` carries the same `## MANDATORY: Analytics query rules` block.
The checklist targets *tool descriptions* specifically and the MCP `instructions` field is a
legitimate protocol mechanism, so this is not a rejection risk on its own — but it is the
first thing a reviewer reads at session start. Soften it for consistency.

**Judgement call:** none of this is dishonest or malicious, and a reviewer may well pass it.
But it is cheap to fix and it is the single criterion the checklist repeats most.

---

## 🟠 3 — `nevent_analytics_query` is a custom query tool without an API reference

The checklist: *"If a tool accepts freeform endpoint paths, query strings, or request
bodies that the caller constructs, its description must include a link to or explicit name
of the target API."* `nevent_analytics_query` takes a caller-constructed collection,
dimensions, metrics and filters, so it qualifies. The description names no API.

**Fix.** One clause: `Queries the Nevent Analytics API (nev-data-api) — see
https://help.nevent.ai/en/nevent-ai/developers/tools/`. Fold it into the rewrite in #2.

---

## 🟠 4 — Broken documentation URL in the public manifest — *fixed in code, awaiting deploy*

`GET https://mcp.nevent.ai/.well-known/mcp-manifest.json` advertises
`"documentation": "https://docs.nevent.ai/mcp"`. That host does not resolve (DNS failure).
Every other public URL checked returns 200.

**Status.** Corrected in `src/transports/http.ts` (and its fixture in
`src/tests/manifest.test.ts`) to `https://help.nevent.ai/en/nevent-ai/`. **The live server
still serves the broken URL until this ships** — verify with a fresh
`curl https://mcp.nevent.ai/.well-known/mcp-manifest.json` before submitting, since a
reviewer pulling the manifest would otherwise hit it.

---

## 🟠 5 — Tool count is inconsistent across your own artifacts

| Source | Says |
|---|---|
| Live server `/health` and manifest | **59** ✅ |
| `README.md` | 59 ✅ |
| `package.json` description | 55 ❌ |
| `REVIEWER_GUIDE.md` | 55 ❌ |
| `chatgpt-app-submission.json` | 55 tool entries ❌ |

v1.8.0 added quote / destinations / campaign-metrics tools and these were not updated.
Reviewers cross-check the listing against the synced tool list; a mismatch reads as
carelessness. Fix all three, and regenerate `chatgpt-app-submission.json` if you still
intend to use it for OpenAI.

---

## 🟡 6 — The reviewer cannot functionally test the send path

`REVIEWER_GUIDE.md` puts the reviewer account in `STANDARD` mode, which blocks
`nevent_schedule_campaign` with `operation_not_permitted`. But the checklist says
*"every tool must return a successful response when called with valid parameters"*, and
under verified review a reviewer functionally tests each tool.

**Options.** Either switch the demo account to `FULL` for the review window with a demo
tenant whose sends resolve to seeded addresses, or state the limitation explicitly and
offer to enable it on request. The Step 9 text in `PORTAL-ANSWERS.md` takes the second
route — decide which you actually want.

---

## 🟡 7 — Reviewer guide leaks OpenAI-specific doubt

`REVIEWER_GUIDE.md` is shared between both directories and contains: *"As of 2026-06 the
OAuth flow from ChatGPT has not been validated end-to-end against this server."* An
Anthropic reviewer reading that sees unvalidated OAuth on a connector whose single auth
path is OAuth. Split the guide, or move Step 1b to an appendix clearly scoped to OpenAI.

---

## ⚪ 8 — Open TODOs

- **Icon.** Not in the repo. Square PNG of the Nevent mark.
- **Categories.** Pick 1–5 in the portal. Suggested order: Marketing → Sales & CRM → Data & Analytics → Productivity.
- **Slug.** `nevent` is proposed and is **permanent once published**.
- **Company legal name.** `PORTAL-ANSWERS.md` guesses "Neventech S.L." — confirm.
- **Reviewer credentials.** Demo tenant with populated synthetic data; the checklist requires *"a fully populated account"*, not an empty one.
- **Self-test.** Run all 59 tools through [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector) or as a custom connector. The portal makes you affirm you did this.
- **Team/Enterprise org.** Required for portal access — you said you'd handle it.

---

## What is already fine

- **Annotations: 59/59 complete.** `title` + `readOnlyHint` + `destructiveHint` + `openWorldHint` on every tool. See [`TOOL-AUDIT.md`](./TOOL-AUDIT.md).
- **Read/write separation.** No catch-all `api_request` tool. Reads and writes are distinct tools, and writes are further split by action (create / update / clone / rename / delete).
- **OAuth 2.1 with DCR and PKCE S256**, plus `/revoke`. Exactly what the portal expects, no coordination needed.
- **HTTPS and Origin validation.** A POST with a foreign `Origin` returns 401; unauthenticated calls return a structured `-32001` error rather than leaking.
- **First-party API.** `mcp.nevent.ai` fronts Nevent's own services — the domain matches the service.
- **Public docs are live** with 6 example prompts (3 is the minimum) plus setup and auth pages.
- **Tool names** max 42 chars, well inside the 64 limit.
- **No disqualifying use case** — no money movement, no AI media generation.
