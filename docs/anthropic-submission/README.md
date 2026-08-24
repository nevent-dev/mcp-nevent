# Anthropic Connectors Directory — submission package

Prepared 2026-08-24 against Nevent MCP **v1.8.0** (59 tools, `https://mcp.nevent.ai/`).

| Document | What it is |
|---|---|
| [`BLOCKERS.md`](./BLOCKERS.md) | **Read first.** Everything that could cost a rejection, ordered by risk, with fixes |
| [`PORTAL-ANSWERS.md`](./PORTAL-ANSWERS.md) | Copy-paste answers for all 11 steps of the submission portal |
| [`TOOL-AUDIT.md`](./TOOL-AUDIT.md) | All 59 tools with their annotations, read/write split, and the 7 destructive ones |

Submission happens at <https://claude.ai/admin-settings/directory/submissions/new>, inside
organization settings. It needs a **Team or Enterprise** org and Owner (or a custom role
with the Directory permission on Enterprise). There is no API or CLI — the portal is manual.

Reference: [submission guide](https://claude.com/docs/connectors/building/submission) ·
[pre-submission checklist](https://claude.com/docs/connectors/building/review-criteria) ·
escalations to `mcp-review@anthropic.com`.

## Suggested order

1. Kick off the privacy policy amendment (BLOCKERS #1) — longest lead time.
2. Rewrite the flagged tool descriptions and redeploy (BLOCKERS #2, #3).
3. Fix the manifest documentation URL and the tool counts (BLOCKERS #4, #5).
4. Prepare the demo tenant and reviewer credentials (BLOCKERS #6, #8).
5. Run all 59 tools through MCP Inspector.
6. Fill the portal from `PORTAL-ANSWERS.md`.
