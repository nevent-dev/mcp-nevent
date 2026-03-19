# Nevent MCP Server

A Model Context Protocol (MCP) server that gives AI agents (Claude Desktop, Claude Code) direct access to Nevent's analytics and segmentation capabilities. Query BigQuery event data and build audience segments using natural language — no SQL or API knowledge required.

## Quick Start

```bash
# 1. Install
npm install

# 2. Set your JWT token
export NEVENT_JWT_TOKEN=your_nevent_jwt_token

# 3. Run
npm run dev
```

## Available Tools (Sprint 1)

| Tool | Description |
|------|-------------|
| `nevent_analytics_capabilities` | Discover available BigQuery tables. Call first if unsure what data exists. |
| `nevent_analytics_table_schema` | Get column definitions for a specific table (requires ADMIN role). |
| `nevent_analytics_query` | Query a BigQuery collection with dimensions, metrics, filters, time ranges. |
| `nevent_analytics_filter_values` | Get distinct field values to build valid analytics filters. |
| `nevent_segmentation_criteria` | List all criteria available for building audience segments. |
| `nevent_dimension_values` | Autocomplete values for a segmentation criterion. |
| `nevent_segment_preview` | Preview estimated audience size without saving (always call before execute). |
| `nevent_segment_execute` | Execute a segment and get paginated matching contacts. |

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NEVENT_JWT_TOKEN` | Yes | — | JWT token for authentication |
| `NEVENT_DATA_API_URL` | No | `https://data.nevent.es` | nev-data-api base URL |
| `NEVENT_OPERATION_MODE` | No | `READ_ONLY` | `READ_ONLY` \| `STANDARD` \| `FULL` |

Sprint 1 tools are all read-only — `READ_ONLY` mode is appropriate for all use cases.

## Usage with Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "nevent": {
      "command": "node",
      "args": ["/path/to/mcp-nevent/dist/index.js"],
      "env": {
        "NEVENT_JWT_TOKEN": "your_token_here"
      }
    }
  }
}
```

## Usage with Claude Code

```bash
# In your project, add to .claude/mcp.json or use the CLI
claude mcp add nevent -- node /path/to/mcp-nevent/dist/index.js
# Then set the env var in your shell before launching Claude Code
export NEVENT_JWT_TOKEN=your_token
```

## Development

```bash
npm run build        # Compile TypeScript
npm run dev          # Run with tsx (no build needed)
npm test             # Run unit tests (68 tests)
npm run test:watch   # Watch mode
npm run test:coverage # Coverage report
```

## Architecture

```
src/
├── index.ts                # MCP server entrypoint
├── clients/
│   ├── base-client.ts      # Shared HTTP client (JWT auth, error handling)
│   └── data-client.ts      # nev-data-api client (data.nevent.es)
├── config/
│   └── operation-mode.ts   # READ_ONLY | STANDARD | FULL guard
├── tools/
│   └── analytics.ts        # 8 Sprint 1 tool registrations
├── schemas/
│   └── analytics.ts        # Zod validation schemas
└── types/
    ├── analytics.ts         # BigQuery analytics types
    ├── segmentation.ts      # Segmentation DSL types
    └── common.ts            # Error format, pagination, HTTP types
```

## Error Format

All errors follow a Stripe-inspired structured format:

```json
{
  "error": {
    "type": "authentication_error | invalid_request | api_error | rate_limit_error | not_found",
    "message": "Human-readable explanation with actionable guidance",
    "code": "machine_readable_code",
    "param": "offending_parameter (when applicable)"
  }
}
```

## Workflow Tips

For best results with analytics queries:
1. Call `nevent_analytics_capabilities` to see available tables
2. Call `nevent_analytics_table_schema` for a specific table to see column names
3. Call `nevent_analytics_filter_values` to see valid filter values
4. Call `nevent_analytics_query` with the correct field names

For segmentation:
1. Call `nevent_segmentation_criteria` to see available criteria and operators
2. Call `nevent_dimension_values` with a `criterion_id` to see valid values
3. Call `nevent_segment_preview` to validate your segment definition
4. Call `nevent_segment_execute` to get the full paginated contact list
