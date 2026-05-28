# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[1.1.0]: https://github.com/nevent-dev/mcp-nevent/releases/tag/v1.1.0
[1.0.0]: https://github.com/nevent-dev/mcp-nevent/releases/tag/v1.0.0
