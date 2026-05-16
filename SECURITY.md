# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in this repository, please report it
by sending an email to **support@nevent.ai** with the subject line `[SECURITY]`.

**Please do not open a public GitHub issue for security vulnerabilities.**

We will acknowledge receipt of your report within **72 hours** and will work
to release a fix for high-severity issues within **14 days** of confirmation.
We follow coordinated disclosure: we ask that you give us reasonable time to
address the issue before any public disclosure.

When reporting, please include:

- A description of the vulnerability and its potential impact
- Steps to reproduce (proof-of-concept code is helpful)
- Any relevant logs or screenshots (sanitized of sensitive data)

We will keep you informed of our progress and credit you in the release notes
if you wish.

---

## Scope

This security policy covers the **mcp-nevent** repository (the MCP client
server). The following are **in scope**:

- The MCP server code (OAuth 2.1 flow, token handling, tool execution)
- The stdio transport
- The Streamable HTTP transport and Express application

The following are **out of scope** for this repository and should be reported
through separate channels:

- The hosted endpoint at `mcp.nevent.ai`
- The Nevent backend APIs (`nev-api`, `nev-data-api`)
- AWS infrastructure and cloud configuration
- Any other Nevent-operated services

---

## Not in Scope

The following issue classes are **not accepted** as security vulnerabilities:

- Rate limiting and denial-of-service attacks against self-hosted instances
- Social engineering attacks
- Vulnerabilities in third-party dependencies — please report those upstream
  to the respective maintainer (e.g., the npm package author or their security
  policy)
- Theoretical issues without a practical exploit path

---

## Supported Versions

Only the **`main` branch** is actively supported. Previous releases are not
maintained and will not receive security patches.

| Branch | Supported |
|--------|-----------|
| `main` | Yes       |
| Older releases | No |

---

Thank you for helping keep Nevent and the open-source community safe.
