# Nevent MCP

> Talk to your live-events CRM (campaigns, analytics, paid ads, segments, short URLs) in Claude and ChatGPT.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/mcp-nevent.svg)](https://www.npmjs.com/package/mcp-nevent)
[![Help Center](https://img.shields.io/badge/docs-help.nevent.ai-8B5CF6)](https://help.nevent.ai/en/nevent-ai/)
[![smithery badge](https://smithery.ai/badge/samuel-fraga/nevent-mcp)](https://smithery.ai/servers/samuel-fraga/nevent-mcp)

Official MCP server for [Nevent](https://nevent.ai/en) — the marketing platform for live event promoters. 63 tools across 10 groups (analytics, segmentation, campaigns, templates, deliverability, paid media, short URLs, media library, multi-tenant, and help/discovery) over **OAuth 2.1** (hosted) or **stdio** (local).

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
| Reference of all 63 tools | <https://help.nevent.ai/en/nevent-ai/developers/tools/> |
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

## Restricting OAuth clients (self-hosted HTTP)

Optional environment variables for the HTTP server:

| Variable | Default | Purpose |
|---|---|---|
| `MCP_READONLY_REDIRECT_PREFIXES` | unset | Comma-separated `redirect_uri` prefixes. A client that registered a matching redirect URI only gets read-only tools. **Every prefix must end with `/`**, for example `https://support.nevent.ai/helpbot/`. |
| `MCP_READONLY_CLIENT_IDS` | unset | Comma-separated `client_id` values restricted the same way. |
| `MCP_REFRESH_REVALIDATE` | `restricted` | `restricted`, `all` or `off`: which clients are revalidated against nev-api (`GET /auth/me`) when they refresh a token. |
| `MCP_REFRESH_MAX_LIFETIME_DAYS` | `90` | Maximum total lifetime of a refresh-token chain, counted from the original login. |

See `CHANGELOG.md` for the exact behaviour.

## Advanced: bearer-passthrough mode (trusted clients, service key required)

`MCP_AUTH_MODE=bearer-passthrough` is a second HTTP auth mode for trusted
clients that already hold a per-user nev-api JWT and want to call
MCP tools on that user's behalf — for example `nev-helpbot`, the Chatwoot
support bot, answering as the promoter currently chatting.

```bash
MCP_AUTH_MODE=bearer-passthrough \
MCP_BEARER_PASSTHROUGH_SERVICE_KEY=$(openssl rand -hex 32) \
node dist/index.js --transport=http --port=3000
```

Every request must carry BOTH the client's service key and the calling
user's own nev-api JWT:

```
X-Nevent-Service-Key: <pre-shared service key>
Authorization: Bearer <the promoter's nev-api JWT>
```

- **Service key (mandatory).** The instance may be reachable from outside, so
  a JWT alone is not enough. `MCP_BEARER_PASSTHROUGH_SERVICE_KEY` (at least 32
  characters) is required: **the server refuses to start without it.** It is
  compared in constant time (`crypto.timingSafeEqual` over SHA-256 digests)
  and checked **before** the token is introspected, so outsiders cannot make
  this server call nev-api. A missing or wrong key gets a bare `401`
  (`Unauthorized.`) with no hint of which check failed. For rotation, set
  `MCP_BEARER_PASSTHROUGH_SERVICE_KEY_PREVIOUS` to the old key while the client
  moves to the new one, then remove it. Keep it in a secret store, never in the
  repository. Requests are also capped per IP (600/min) and per token (300/min).

- **No OAuth flow, no `MCP_JWT_SECRET`, no `MONGODB_URI` required.**
  `MONGODB_URI` stays optional: set it to also enable the Mongo-backed read
  tools (campaigns/templates/deliverability), each still scoped by the
  caller's own JWT tenant.
- **Every request is verified against nev-api before anything is exposed.**
  On every request — `initialize`, `tools/list`, `tools/call`, not only at
  session start — this server calls `GET {NEVENT_API_URL}/auth/me` with the
  forwarded token. A `200` confirms the session is live and the request
  proceeds; `401`, `403`, a network error, or a timeout are all treated the
  same way — the MCP request is rejected with `401` and **no tool, no
  `tools/list`, and no session is ever created or advanced** from it. There
  is no permissive fallback: if nev-api cannot be reached to confirm the
  token, the request is refused, it is never let through anyway.
  - A successful check is cached briefly (~60 s) by a hash of the token so a
    single session does not call `/auth/me` on every message, but the cache
    never serves an entry past the token's own expiry.
  - **The token's signature is still never checked locally by this server.**
    nev-api signs session JWTs with a symmetric secret (HMAC256); shipping
    that secret here so it could be verified offline would mean compromising
    this process could forge a session for *any* Nevent user, not just read
    their data. Introspecting against nev-api avoids that trade-off entirely
    and is the only mechanism this mode uses to confirm a token is real,
    live, and unexpired. nev-data-api and nev-api additionally validate the
    token themselves on every downstream call they receive, exactly as they
    do for `stdio` mode's shared `NEVENT_JWT_TOKEN`.
- **Human and service sessions.** `GET /auth/me` also reports `principalType`
  (`HUMAN` or `SERVICE`), `effectiveTenantId` and `serviceSession`. Technical
  service sessions minted by `POST /auth/service-token` (unattended agents)
  are accepted like a human token **only with `TENANT` scope** (`PLATFORM`,
  i.e. global SUPERADMIN, is refused). The session is locked to
  `effectiveTenantId`, which comes only from this answer (never from the JWT
  payload; also correct for hierarchical admins navigating a child tenant).
  Fail-closed: an unknown `principalType`, a `SERVICE` response without
  `effectiveTenantId`, or any response with no tenant at all is refused. A
  `SERVICE` verification is cached for 10 s instead of 60 s so a disabled
  account or revoked session stops working almost immediately.
- **Verification cache.** Positive verdicts are cached (max 1000 entries, LRU,
  expired ones purged first); a token nev-api explicitly rejected (`401`/`403`)
  is remembered for ~5 s so a bad token cannot turn into one `/auth/me` call per
  request. When nev-api itself is unavailable (5xx, timeout, network) the
  request is still refused, but with `503` instead of `401`, and that outcome
  is never cached.
- **Read-only, tenant-locked.** Only READ tools are exposed — the same set as
  an OAuth read-only client, including `nevent_segment_execute` — minus the
  tenant-switching tools (`nevent_list_tenants` / `nevent_switch_tenant` /
  `nevent_reset_tenant`): a bearer-passthrough caller always operates in the
  tenant its own JWT carries. Excluded and write/delete tools never appear in
  `tools/list`.
- **Sessions are bound to their principal.** Each `Mcp-Session-Id` remembers
  the user id, principal type and effective tenant it was opened for. Every
  later request (`POST`, `GET`, `DELETE`) must carry a token that nev-api
  confirms for that same principal and tenant, otherwise it is refused with
  `403` and nothing is dispatched — a valid token of someone else cannot drive
  a session it learned the id of. When the same principal presents a different
  valid token (a refreshed human token, or a service session re-minted after
  its 30 min expiry) the session's clients switch to the new token instead of
  keeping the one from `initialize`.
- **Session isolation.** Every MCP session gets its own client instances,
  built fresh from that session's own JWT — two sessions started with
  different tokens never share a client or cached data.
- **Reachable from outside, authenticated twice.** There is no login page and
  no client registration. Caller identity is the pre-shared service key (which
  client) plus the forwarded JWT (which end user), both required on every
  request. Still prefer a restrictive firewall/security group in front of it,
  set `MCP_ALLOWED_ORIGINS` to a short list (the caller is a server, not a
  browser), and never point the public OAuth hostname (`mcp.nevent.ai`) at a
  process started in this mode. Do not log or commit the service key.

Full design rationale: `src/transports/http-bearer-passthrough.ts` and
`src/auth/session-verifier.ts`.

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
