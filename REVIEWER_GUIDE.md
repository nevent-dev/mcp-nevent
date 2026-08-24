# Reviewer Guide — Nevent MCP

> This guide is for reviewers from the **Anthropic Connectors Directory** and the **ChatGPT Apps Directory**.
> It covers both hosted connection paths (Step 1a for Claude.ai, Step 1b for ChatGPT) and the optional
> stdio transport (Step 2). Credentials are provided separately in the directory submission form.

## What you'll need
- Credentials provided in the submission form (email, password)
- Claude.ai, ChatGPT, Claude Desktop, or Cursor

## Step 1a — Connect the MCP in Claude.ai (Anthropic reviewers)

1. Open Claude.ai → Settings → Connectors → Add custom MCP
2. Server URL: `https://mcp.nevent.ai/`
3. Click Connect; an OAuth flow will open in a new window
4. Log in with the credentials provided in the submission form
5. If prompted for a tenant, select the one labeled as **demo** (the account has access to a single demo tenant with synthetic data)
6. Approve the requested scopes; Claude.ai will return to the chat with the connector listed as active

## Step 1b — Connect the MCP in ChatGPT (OpenAI reviewers)

1. Open ChatGPT → Settings → Connectors → Add MCP server
2. Server URL: `https://mcp.nevent.ai/`
3. Click Connect; an OAuth flow should open
4. Log in with the credentials provided in the submission form
5. If prompted for a tenant, select **demo**
6. Approve the requested scopes to complete the connection

**Note on OAuth status:** As of 2026-06 the OAuth flow from ChatGPT has not been validated end-to-end against
this server. The server implements Dynamic Client Registration (DCR), the same mechanism Claude.ai uses, so
the flow should work. If it does not auto-register or the OAuth window returns an error, contact
support@nevent.ai and we will assist during the review window.

## Step 2 — Connect the MCP locally (Claude Desktop, Cursor, ChatGPT desktop)

(Optional — only if you want to verify the stdio transport too.)

Add to your Claude Desktop / Cursor MCP config:

```json
{
  "mcpServers": {
    "nevent": {
      "command": "npx",
      "args": ["mcp-nevent@latest"],
      "env": {
        "NEVENT_JWT_TOKEN": "<obtain by completing the OAuth flow in Step 1a or Step 1b>",
        "NEVENT_OPERATION_MODE": "STANDARD"
      }
    }
  }
}
```

Note: stdio mode does not run the OAuth flow — it expects a pre-issued JWT. The hosted modes in Step 1a/1b
handle auth automatically and are the recommended paths for review.

## Step 3 — Verify the connector with one tool per category

These prompts work with any MCP-capable client (Claude.ai, ChatGPT, Claude Desktop, Cursor).
The demo tenant has synthetic data so all of them will return non-empty results:

| Category | Prompt | Tool used | Mode |
|---|---|---|---|
| Discovery | "What is this MCP and what tenants do I have access to?" | `nevent_list_tenants` | read |
| Campaigns | "List my last 5 email campaigns with their open rate" | `nevent_list_campaigns` | read |
| Reporting | "Give me a full performance report for campaign <id>" | `nevent_campaign_report` | read |
| Analytics | "What were our top engagement metrics in the last 30 days?" | `nevent_analytics_query` | read |
| Segments | "Preview the audience size for contacts who opened a campaign in the last 14 days" | `nevent_segment_preview` | read |
| Write (safe) | "Create a draft segment named 'demo-mcp-review' from that same audience" | `nevent_create_segment` | write (reversible) |
| Templates | "Clone the most recent email template under the name 'demo-mcp-review'" | `nevent_clone_template` | write (reversible) |

The reviewer account has `STANDARD` operation mode, which allows creating segments and templates but blocks irreversible actions like sending campaigns (`nevent_schedule_campaign`).

## What you should see

- Every read tool returns structured data filtered to the demo tenant.
- Write tools create new entities you can verify via the read tools.
- All requests are authenticated against the Nevent API with the OAuth token issued during Step 1a or 1b.

## Operation modes available

- `READ_ONLY` (default for new connections) — only data retrieval
- `STANDARD` (reviewer account) — adds create/update of segments, templates
- `FULL` — adds campaign sending; not exposed to reviewer account

## Privacy and data handling

- Privacy policy: https://nevent.ai/en/privacy/
- The reviewer account belongs to a tenant with **synthetic data only**. No real customer data is exposed.
- All traffic is HTTPS; OAuth tokens are scoped to the tenant.
- Source code: https://github.com/nevent-dev/mcp-nevent
- Security disclosure: see `SECURITY.md` in the repo

## Support during review

- Primary contact: Samuel Fraga, samuel.fraga@nevent.es
- Support: support@nevent.ai (handles review inquiries from both Anthropic and OpenAI review teams)

## Reference

- Full tool inventory: <https://help.nevent.ai/en/nevent-ai/developers/tools/> (55 tools)
- npm package: https://www.npmjs.com/package/mcp-nevent
- MCP Registry entry: io.github.nevent-dev/mcp-nevent
