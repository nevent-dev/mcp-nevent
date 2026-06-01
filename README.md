# Nevent MCP

> Talk to your live-events CRM (campaigns, analytics, paid ads, segments, short URLs) in Claude and ChatGPT.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/mcp-nevent.svg)](https://www.npmjs.com/package/mcp-nevent)
[![Help Center](https://img.shields.io/badge/docs-help.nevent.ai-8B5CF6)](https://help.nevent.ai/en/nevent-ai/)

Official MCP server for [Nevent](https://nevent.ai/en) — the marketing platform for live event promoters. 52 tools across 9 categories (campaigns, analytics, segmentation, paid media, deliverability, short URLs, multi-tenant, templates) over **OAuth 2.1** (hosted) or **stdio** (local).

📚 **Full documentation:** **<https://help.nevent.ai/en/nevent-ai/>**

---

## Install

### Hosted (recommended — no install needed)

Add `https://mcp.nevent.ai/mcp` as a remote MCP server in your client. Works with Claude.ai, ChatGPT, Cursor, Cline, Continue and any compatible MCP client.

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

Settings → Integrations / Connectors → Add custom MCP → URL `https://mcp.nevent.ai/mcp`. Authorize with your Nevent admin account.

### Claude Code

```bash
# Hosted (OAuth)
claude mcp add --transport http nevent https://mcp.nevent.ai/mcp

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
| Reference of all 52 tools | <https://help.nevent.ai/en/nevent-ai/developers/tools/> |
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
