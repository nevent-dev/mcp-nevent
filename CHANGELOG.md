# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.7.0] - 2026-06-02

### Added
- `nevent_create_campaign` now exposes the optional `reply_to` parameter (string, valid email format, max 254 chars per RFC 5321). When provided it is sent to nev-api as `replyTo` in the campaign draft body; when absent the field is omitted entirely from the request (not sent as `null` or `undefined`) (NEV-1671).
- 7 new unit tests covering `reply_to` schema validation (valid email accepted, absent field accepted, invalid format rejected, >254 chars rejected, boundary at 254 chars) and payload wiring (`replyTo` present when provided, absent when omitted, value matches exactly).

### Notes
- `reply_to` is only meaningful for email-bearing channels (EMAIL_ONLY, EMAIL_AND_SMS, EMAIL_AND_WHATSAPP, ALL_CHANNELS, OMNICHANNEL). The backend ignores it for non-email channels.
- Backend cascade: `campaign.replyTo > tenant.emailSendingSettings.replyTo > fromEmail` — omitting `reply_to` falls back to tenant or sender defaults.
- Related to NEV-1670 (backend fix for `createDraft` persistence, merged to development, pending prod deploy). The MCP sends the field correctly now; `POST /campaigns` will persist it once NEV-1670 reaches production. `PUT /campaigns/{id}` already works correctly in all environments.
- `nevent_schedule_campaign` intentionally does NOT expose `reply_to` — scheduling does not modify campaign content.

Refs: NEV-1671

## [1.6.0] - 2026-06-02

### Fixed
- `nevent_create_campaign` was sending `"EMAIL"`, `"SMS"`, or `"WHATSAPP"` as the channel value, which does not match the `CommunicationChannel` enum in `nev-api` (11 values: `EMAIL_ONLY`, `SMS_ONLY`, `WHATSAPP_ONLY`, `PUSH_ONLY`, `EMAIL_AND_SMS`, `EMAIL_AND_WHATSAPP`, `PUSH_AND_SMS`, `PUSH_AND_WHATSAPP`, `SMS_AND_WHATSAPP`, `ALL_CHANNELS`, `OMNICHANNEL`). Jackson silently ignores or errors on unknown enum values, causing channel to be undefined or rejected since Sprint 2 (NEV-1669).
- Tool description for `nevent_create_campaign` incorrectly mentioned `from_email` as a required field. That field does not exist in the schema (NEV-1669).

### Added
- `nevent_create_campaign` now exposes all 11 `CommunicationChannel` enum values in the Zod schema. The three legacy aliases (`EMAIL`, `SMS`, `WHATSAPP`) are still accepted for backwards-compatibility and automatically mapped to `EMAIL_ONLY`, `SMS_ONLY`, `WHATSAPP_ONLY` respectively in the handler (NEV-1669).
- UTM tracking support for `nevent_create_campaign`: 6 new optional parameters — `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`, `utm_custom_params` — mapped to the backend `utmTracking` object. The `utmTracking` field is only included in the API payload when at least one UTM parameter is provided; an empty `utm_custom_params: {}` does not trigger inclusion (NEV-1669).
- 34 new unit tests covering channel enum validation, alias mapping, canonical channel passthrough, UTM payload presence/absence, and `utm_custom_params` serialisation.

### Notes
- Backwards compatible: existing code passing `"EMAIL"`, `"SMS"`, or `"WHATSAPP"` continues to work.
- Requires updating the MCP in the client (Claude Desktop / Claude CLI) after installing this release.

Refs: NEV-1669

## [1.5.0] - 2026-06-02

### Fixed
- `nevent_schedule_campaign` was using `PATCH /campaigns/{id}` with body `{ status: 'SCHEDULED', scheduledTime }`, which returned HTTP 405 because the backend has no PATCH mapping for that route. The correct endpoint is `POST /campaigns/{id}/actions/schedule` with body `{ scheduledTime }` only. The status transition to SCHEDULED is handled internally by nev-api. This regression was introduced in commit `5145ac2` (15 April 2026) and caused 100% failure rate when scheduling campaigns from Claude/MCP.

### Added
- Unit tests for `nevent_create_campaign` and `nevent_schedule_campaign` in `src/tests/campaign-actions.test.ts` (25 tests). Includes schema validation, operation mode guard, and HTTP shape regression tests for NEV-1668.

### Notes
- Requires updating the MCP in the client (Claude Desktop / Claude CLI) after installing this release to pick up the new binary.

Refs: NEV-1668

## [1.4.1] - 2026-06-01

### Fixed
- `/health` response was hardcoded to `version: "1.0.0"` regardless of the deployed version. Now reads the version from `package.json` at startup (cached for the process lifetime).
- `/health.toolsCount` and `/.well-known/mcp-manifest.json.tools_count` were the integer literal `52`. Both now call `getToolCount()` at request time, which probes the actual registration logic and returns the correct count (55 for the full HTTP feature set).
- Introduced `getToolCount(ToolCountOptions)` in `server.ts`: creates a lightweight probe `McpServer`, runs the same conditional registration paths as `createNeventServer`, and returns the registered tool count via the SDK's internal `_registeredTools` field. Safe to call repeatedly — no I/O side effects.

Refs: NEV-1661

## [1.4.0] - 2026-06-01

### Added
- 3 image management tools for the RESOURCES media library (same bucket used by the MJML editor):
  - `nevent_upload_image` — upload an image from base64 (data URL or raw base64 + mimeType) and get a CloudFront CDN URL ready for use in `<img src="...">` inside email template HTML. Enforces 5 MB decoded limit. Mode: STANDARD or FULL.
  - `nevent_list_images` — list all images stored for the current tenant (src, name, mimeType, size). Mode: READ_ONLY or higher.
  - `nevent_delete_image` — permanently delete one or more images by CDN URL. Mode: FULL only (irreversible).
- `MediaClient` — new API client for `POST /media/upload/resource`, `GET /media/resources`, `DELETE /media/resource`.
- `media` topic added to `nevent_help` (topic="media").
- `mediaClient` field on `SessionClients` — automatically wired for JWT rotation and 401 auto-refresh.

### Design decisions
- URL sources for upload explicitly excluded to prevent the MCP from acting as a third-party rehosting proxy.
- `nevent_delete_image` classified as DELETE (not WRITE) — requires FULL mode because the operation is irreversible and can break existing template HTML.

Refs: NEV-1660

## [1.3.0] - 2026-06-01

### Added
- `openWorldHint: true` on all 51 tools that call the Nevent API over HTTPS
  (analytics, campaigns, campaign-actions, segments, templates, deliverability,
  paid-media, short-urls, tenants). Required by the OpenAI ChatGPT Apps Directory
  to signal that each tool interacts with external systems.
- `openWorldHint: false` on `nevent_help` (pure local meta-tool — never makes an
  external HTTP call, returns static markdown only).

### Notes
- No existing `readOnlyHint` or `destructiveHint` values were changed.
- No tool descriptions, titles, or input schemas were modified.
- Minor version bump signals a new optional metadata field (fully backwards-compatible).

Refs: NEV-1651

## [1.2.3] - 2026-06-01

### Fixed
- OAuth /authorize submit was still blocked by CSP form-action even after v1.2.2 added the absolute URL. Chrome evaluates form-action against the full redirect chain (POST -> 302 -> client callback), so any allowlist that does not include every possible MCP client's callback origin will fail. Switched to wildcard since redirect_uri validation in the OAuth provider is the actual defense.

Refs: NEV-1648

## [1.2.2] - 2026-06-01

### Fixed
- OAuth /authorize form submit was blocked by CSP form-action 'self' when the login page is loaded in a sandboxed iframe by Claude.ai. Now declares the absolute URL https://mcp.nevent.ai alongside 'self'.

Refs: NEV-1648

## [1.2.0] - 2026-05-28

### Added
- Tool annotations: all 52 tools now declare a human-readable `title` field (capitalised, no `nevent_` prefix), surfaced in the Anthropic Connectors Directory and any MCP client that renders tool metadata
- Tool hints: 17 tools that were missing `readOnlyHint`/`destructiveHint` now declare them explicitly — 10 paid-media tools and 7 short-URL tools all set `readOnlyHint: true, destructiveHint: false`; `nevent_schedule_campaign` keeps `destructiveHint: true` as it triggers irreversible delivery

### Changed
- Bump version 1.1.1 → 1.2.0 (minor; new annotation metadata, fully backwards-compatible)

Refs: NEV-1639

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

[1.3.0]: https://github.com/nevent-dev/mcp-nevent/releases/tag/v1.3.0
[1.2.3]: https://github.com/nevent-dev/mcp-nevent/releases/tag/v1.2.3
[1.2.2]: https://github.com/nevent-dev/mcp-nevent/releases/tag/v1.2.2
[1.2.0]: https://github.com/nevent-dev/mcp-nevent/releases/tag/v1.2.0
[1.1.1]: https://github.com/nevent-dev/mcp-nevent/releases/tag/v1.1.1
[1.1.0]: https://github.com/nevent-dev/mcp-nevent/releases/tag/v1.1.0
[1.0.0]: https://github.com/nevent-dev/mcp-nevent/releases/tag/v1.0.0
