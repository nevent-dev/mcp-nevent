# Nevent MCP

> Talk to your live-events CRM (campaigns, analytics, paid ads, segments, short URLs) in Claude and ChatGPT.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/mcp-nevent.svg)](https://www.npmjs.com/package/mcp-nevent)
[![Help Center](https://img.shields.io/badge/docs-help.nevent.ai-8B5CF6)](https://help.nevent.ai/en/nevent-ai/)
[![smithery badge](https://smithery.ai/badge/samuel-fraga/nevent-mcp)](https://smithery.ai/servers/samuel-fraga/nevent-mcp)

Official MCP server for [Nevent](https://nevent.ai/en) — the marketing platform for live event promoters. 59 tools across 10 groups (analytics, segmentation, campaigns, templates, deliverability, paid media, short URLs, media library, multi-tenant, and help/discovery) over **OAuth 2.1** (hosted) or **stdio** (local).

📚 **Full documentation:** **<https://help.nevent.ai/en/nevent-ai/>**

---

## Install

### Hosted (recommended — no install needed)

Add `https://mcp.nevent.ai/` as a remote MCP server in your client. Works with Claude.ai, ChatGPT, Cursor, Cline, Continue and any compatible MCP client.

→ Step-by-step with screenshots: [Connect with Claude](https://help.nevent.ai/en/nevent-ai/connect-claude/) · [Connect with ChatGPT](https://help.nevent.ai/en/nevent-ai/connect-chatgpt/)

### Local (stdio via npm)

```bash
npx mcp-nevent
```

Required env: `NEVENT_JWT_TOKEN`. Optional: `NEVENT_OPERATION_MODE` (`READ_ONLY` | `STANDARD` | `FULL`).

→ Full local setup: [Local installation](https://help.nevent.ai/en/nevent-ai/developers/local-installation/)

---

## Quick add

### Claude.ai · ChatGPT (hosted, no setup)

Settings → Integrations / Connectors → Add custom MCP → URL `https://mcp.nevent.ai/`. Authorize with your Nevent admin account.

### Claude Code

```bash
# Hosted (OAuth)
claude mcp add --transport http nevent https://mcp.nevent.ai/

# Or local (stdio)
claude mcp add nevent -- node /path/to/mcp-nevent/dist/index.js
export NEVENT_JWT_TOKEN=your_token
```

→ Full guide: [Claude Code](https://help.nevent.ai/en/nevent-ai/developers/claude-code/)

### Claude Desktop

Add to `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`):

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

→ Full guide: [Claude Desktop](https://help.nevent.ai/en/nevent-ai/developers/claude-desktop/)

### Cursor · Cline · Continue · VS Code

→ Per-client setup: [Cursor, Cline, Continue, VS Code](https://help.nevent.ai/en/nevent-ai/developers/cursor-cline-continue/)

---

## What you can ask

```
"Show me registrations for EventX broken down by ticket type"

"Which campaigns sent last month had an open rate above 30%?"

"Create a segment of attendees who bought a VIP ticket in 2025
 but haven't opened any email in the last 90 days"

"Schedule the 'Summer Gala' campaign for next Monday at 10:00 CET"

"Compare ROAS across our Meta ad campaigns for March"

"Create per-user tracking links for the Summer Gala campaign
 and show me which users clicked"
```

→ More patterns: [Ready-to-use prompts](https://help.nevent.ai/en/nevent-ai/ready-to-use-prompts/) · [Use cases](https://help.nevent.ai/en/nevent-ai/use-cases/)

---

## Documentation

| Topic | Link |
|---|---|
| What Nevent AI is and how it works | <https://help.nevent.ai/en/nevent-ai/> |
| Capabilities by area (analytics, campaigns, audience, paid media…) | <https://help.nevent.ai/en/nevent-ai/what-you-can-do/> |
| End-to-end use cases | <https://help.nevent.ai/en/nevent-ai/use-cases/> |
| Permissions and security | <https://help.nevent.ai/en/nevent-ai/permissions-and-security/> |
| FAQ | <https://help.nevent.ai/en/nevent-ai/faq/> |

### For developers

| Topic | Link |
|---|---|
| Overview, transports and architecture | <https://help.nevent.ai/en/nevent-ai/developers/> |
| Local installation and env vars | <https://help.nevent.ai/en/nevent-ai/developers/local-installation/> |
| Multi-tenant model | <https://help.nevent.ai/en/nevent-ai/developers/multi-tenant/> |
| Reference of all 59 tools | <https://help.nevent.ai/en/nevent-ai/developers/tools/> |
| Troubleshooting and error codes | <https://help.nevent.ai/en/nevent-ai/developers/troubleshooting/> |

---

## How it works

```
LLM (Claude / ChatGPT / Cursor / …)
        |
        | MCP (Streamable HTTP or stdio)
        v
  ┌─────────────────┐
  │  Nevent MCP     │  mcp.nevent.ai (hosted) or local
  └─────────────────┘
        |
        | REST + JWT
        v
  Nevent APIs (analytics, campaigns, segments, paid media, short URLs)
```

**Hosted mode** uses OAuth 2.1: the MCP server issues short-lived JWT tokens after validating your Nevent credentials. Each session is isolated — no shared service accounts.

---

## Advanced: bearer-passthrough mode (internal, trusted callers only)

`MCP_AUTH_MODE=bearer-passthrough` is a second HTTP auth mode for trusted
internal services that already hold a per-user nev-api JWT and want to call
MCP tools on that user's behalf — for example `nev-helpbot`, the Chatwoot
support bot, answering as the promoter currently chatting.

```bash
MCP_AUTH_MODE=bearer-passthrough node dist/index.js --transport=http --port=3000
```

Every request must carry the calling user's own nev-api JWT:

```
Authorization: Bearer <the promoter's nev-api JWT>
```

- **No OAuth flow, no `MCP_JWT_SECRET`, no `MONGODB_URI` required.** The
  forwarded JWT is not verified by this server — exactly like `stdio` mode's
  shared `NEVENT_JWT_TOKEN` — because nev-data-api and nev-api validate it on
  every call they receive. `MONGODB_URI` stays optional: set it to also
  enable the Mongo-backed read tools (campaigns/templates/deliverability),
  each still scoped by the caller's own JWT tenant.
- **Read-only, tenant-locked.** Only READ tools are exposed, minus
  `nevent_segment_execute` (returns raw contact PII) and the tenant-switching
  tools (`nevent_list_tenants` / `nevent_switch_tenant` / `nevent_reset_tenant`)
  — a bearer-passthrough caller always operates in the tenant its own JWT
  carries. Excluded and write/delete tools never appear in `tools/list`.
- **Session isolation.** Every MCP session gets its own client instances,
  built fresh from that session's own JWT — two sessions started with
  different tokens never share a client or cached data.
- **Not for the public internet.** There is no login page, no client
  registration, and no signature check on the forwarded token. Run this mode
  only on an internal network reachable by trusted callers — never point a
  public hostname (like `mcp.nevent.ai`) at a process started this way.

Full design rationale: `src/transports/http-bearer-passthrough.ts`.

---

## Privacy

The Nevent MCP server processes tenant data on Nevent's own infrastructure
(AWS, eu-west-1). Data does not leave Nevent's infrastructure and is not
used for model training.

For details on data collection, retention, third-party sharing, and contact
information, see the full privacy policy: https://nevent.ai/en/privacy/

Security disclosure: see [`SECURITY.md`](./SECURITY.md).

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) and [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © Nevent

## Support

- **Help Center:** <https://help.nevent.ai>
- **Issues:** <https://github.com/nevent-dev/mcp-nevent/issues>
- **Email:** [support@nevent.ai](mailto:support@nevent.ai)
- **Product:** <https://nevent.ai/en>
