# Contributing to Nevent MCP

Thank you for your interest in contributing! This guide covers everything you
need to get started.

Please read our [Code of Conduct](CODE_OF_CONDUCT.md) before participating.

---

## Getting started locally

```bash
# 1. Clone the repo
git clone https://github.com/nevent-dev/mcp-nevent.git
cd mcp-nevent

# 2. Install dependencies
npm install

# 3. Build (TypeScript → dist/)
npm run build

# 4. Run tests
npm test
```

To run in **stdio mode** (no external services needed):

```bash
export NEVENT_JWT_TOKEN=your_token
npm run dev
```

To run in **HTTP mode** locally:

```bash
MCP_JWT_SECRET=dev-secret-at-least-32-chars \
MONGODB_URI=mongodb://localhost:27017/mcp-nevent \
MCP_TRANSPORT=http \
npm run dev
```

---

## Branch naming

| Type | Pattern | Example |
|------|---------|---------|
| Feature | `feat/short-description` | `feat/add-webhook-tool` |
| Bug fix | `fix/short-description` | `fix/session-leak-on-401` |
| Documentation | `docs/short-description` | `docs/update-contributing` |
| Chore / infra | `chore/short-description` | `chore/update-dependencies` |
| Refactor | `refactor/short-description` | `refactor/extract-base-client` |
| Tests | `test/short-description` | `test/manifest-endpoint` |

Branch from `main` and open PRs targeting `main`.

---

## Commit format

This project uses [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).

Every commit **must** include a `Signed-off-by` trailer (Developer Certificate
of Origin). Add it automatically with:

```bash
git commit -s -m "feat: add my change"
```

This produces:

```
feat: add my change

Signed-off-by: Your Name <your@email.com>
```

**Types:** `feat`, `fix`, `docs`, `refactor`, `test`, `chore`

**Examples:**

```
feat: add nevent_list_webhooks tool

fix: handle 401 on session refresh correctly

docs: document operation mode guard in README
```

---

## Tests

Pull requests without tests will not be accepted unless the change is
documentation-only.

```bash
npm test               # Run all tests
npm run test:watch     # Watch mode
npm run test:coverage  # Coverage report
```

Tests live in `src/tests/`. Use [Vitest](https://vitest.dev/).

---

## Code review process

1. Open a PR with a clear title and description.
2. At least **1 approving review** from a maintainer is required.
3. All CI checks must be green (build, lint, tests).
4. Do not force-push to the PR branch after requesting review.
5. A maintainer will merge once all conditions are met.

---

## Checklist for adding a new MCP tool

Adding a tool involves several coordinated files. Please follow this checklist:

- [ ] **Schema** — add a Zod schema in `src/schemas/<category>.ts`
- [ ] **Types** — add request/response types in `src/types/<category>.ts` (if needed)
- [ ] **Client** — add the HTTP call in the appropriate client under `src/clients/`
- [ ] **Tool registration** — register the tool in `src/tools/<category>.ts`
- [ ] **Operation mode guard** — call `checkMode()` if the tool writes data
- [ ] **`server-instructions.ts`** — add the tool to the server-level LLM instructions
- [ ] **`help.ts`** — add the tool to the relevant help topic if user-facing
- [ ] **README** — add the tool to the tools table with a one-line description
- [ ] **Tests** — add at least one unit test covering the handler

---

## How to run the MCP server

### stdio (Claude Desktop / Claude Code / Cursor / Cline / Continue)

```bash
export NEVENT_JWT_TOKEN=your_token
node dist/index.js
```

Or add to your Claude Desktop config:

```json
{
  "mcpServers": {
    "nevent": {
      "command": "node",
      "args": ["/path/to/mcp-nevent/dist/index.js"],
      "env": {
        "NEVENT_JWT_TOKEN": "your_token"
      }
    }
  }
}
```

### HTTP (remote clients with OAuth 2.1)

```bash
MCP_JWT_SECRET=your-secret \
MONGODB_URI=mongodb://... \
MCP_TRANSPORT=http \
MCP_SERVER_URL=https://your-domain.com \
node dist/index.js
```

---

## Reporting issues

Use the [issue templates](.github/ISSUE_TEMPLATE/) to report bugs, request
features, or ask questions.

For security vulnerabilities, do **not** open a public issue. See
[SECURITY.md](SECURITY.md) instead.

---

## Developer Certificate of Origin

By contributing, you certify that your contribution complies with the
[Developer Certificate of Origin (DCO) 1.1](https://developercertificate.org/).
This is enforced via the `Signed-off-by` trailer on each commit (see above).
