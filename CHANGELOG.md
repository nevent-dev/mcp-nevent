# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.0] - 2026-05-28

### Added
- Tool annotations: all 52 tools now declare a human-readable `title` field (capitalised, no `nevent_` prefix), surfaced in the Anthropic Connectors Directory and any MCP client that renders tool metadata
- Tool hints: 17 tools that were missing `readOnlyHint`/`destructiveHint` now declare them explicitly — 10 paid-media tools and 7 short-URL tools all set `readOnlyHint: true, destructiveHint: false`; `nevent_schedule_campaign` keeps `destructiveHint: true` as it triggers irreversible delivery

### Changed
- Bump version 1.1.1 → 1.2.0 (minor; new annotation metadata, fully backwards-compatible)

## [1.1.1] - 2026-05-28

### Fixed
- Added missing `mcpName` field in `package.json` required by the MCP Registry validation (`io.github.nevent-dev/mcp-nevent`). v1.1.0 was published successfully to npm but failed to register in the MCP Registry due to this missing metadata.

## [1.1.0] - 2026-05-28

### Added
- 9 Short URL tools (Tier 1+2+3): list, get, metrics (overall + per-campaign), clicks, user links, create, update, bulk user short URLs
- `mcp-nevent` published to npm registry
- Listed in the official MCP Registry as `io.github.nevent-dev/mcp-nevent`
- GitHub Action for auto-publish on `v*` tags

### Fixed
- Manifest endpoint URL — server listens on `/`, not `/mcp`
- Segments preview/execute were broken due to missing auto-generated DSL IDs; now propagates API error strings instead of generic 500

## [1.0.0] - 2026-05-16

### Added

- Initial public release
- 43 MCP tools across 8 categories (analytics, segments, campaigns, templates, deliverability, paid media, multi-tenant, meta)
- Streamable HTTP transport with OAuth 2.1
- stdio transport for Claude Desktop / Claude Code / Cursor / Cline / Continue
- SessionClients with atomic JWT rotation + auto-refresh on 401
- Caching for capabilities and segmentation criteria (5 min TTL)

### Notes

- Previous versions were internal-only and are not documented here

[1.2.0]: https://github.com/nevent-dev/mcp-nevent/releases/tag/v1.2.0
[1.1.1]: https://github.com/nevent-dev/mcp-nevent/releases/tag/v1.1.1
[1.1.0]: https://github.com/nevent-dev/mcp-nevent/releases/tag/v1.1.0
[1.0.0]: https://github.com/nevent-dev/mcp-nevent/releases/tag/v1.0.0
