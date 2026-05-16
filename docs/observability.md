# Nevent MCP — Observability Guide

This document describes the logging, telemetry, and debugging capabilities
built into the Nevent MCP server.

---

## Tool Call Logging (MongoDB)

When `MONGODB_URI` is set, every MCP tool invocation is persisted to the
`nevent.mcp_tool_calls` collection in MongoDB. Logging is **fire-and-forget**
— it never blocks the tool response.

### Document Schema

```ts
interface ToolCallDocument {
  tenant_id: string | null;       // Active tenant at call time
  tenant_id_active: string | null;// Duplicate of tenant_id (for aggregation)
  user_id: string | null;         // JWT `sub` claim
  tool_name: string;              // e.g. "nevent_analytics_query"
  status: 'ok' | 'error';
  error_code: string | null;      // Machine-readable code from error envelope
  error_message: string | null;   // Truncated to 200 chars
  latency_ms: number;             // End-to-end handler time
  session_id: string | null;      // MCP session ID (HTTP mode only)
  params_summary: object;         // PII-free parameter shape
  response_size_bytes: number | null; // UTF-8 byte count of response text
  timestamp: Date;                // UTC, used for TTL index
  date: string;                   // "YYYY-MM-DD" for daily aggregation
}
```

### Indexes

| Index | Purpose |
|-------|---------|
| `{ timestamp: 1 }` + TTL 90 days | Automatic document expiry |
| `{ tenant_id: 1, timestamp: -1 }` | Per-tenant timeline queries |
| `{ tool_name: 1, timestamp: -1 }` | Per-tool usage analytics |
| `{ date: 1, tool_name: 1 }` | Daily aggregation (usage reports) |

Indexes are created lazily on first tool call (or eagerly via `warmUp()` if
called during server initialization).

### Connection Warm-Up

In production the MongoDB logger warm-up is called at startup:

```ts
void logger.warmUp(); // fire-and-forget, swallows errors
```

This pre-establishes the connection and creates indexes so the **first tool
call does not pay the ~200 ms cold-start cost**.

---

## Useful Queries

### Top tools by usage (last 7 days)

```js
db.mcp_tool_calls.aggregate([
  { $match: { timestamp: { $gte: new Date(Date.now() - 7 * 86400000) } } },
  { $group: { _id: '$tool_name', count: { $sum: 1 }, avg_latency: { $avg: '$latency_ms' } } },
  { $sort: { count: -1 } }
])
```

### Error rate per tool (last 24 h)

```js
db.mcp_tool_calls.aggregate([
  { $match: { timestamp: { $gte: new Date(Date.now() - 86400000) } } },
  { $group: {
    _id: '$tool_name',
    total: { $sum: 1 },
    errors: { $sum: { $cond: [{ $eq: ['$status', 'error'] }, 1, 0] } }
  }},
  { $addFields: { error_rate: { $divide: ['$errors', '$total'] } } },
  { $sort: { error_rate: -1 } }
])
```

### Slowest tool calls (P95 latency)

```js
db.mcp_tool_calls.aggregate([
  { $match: { timestamp: { $gte: new Date(Date.now() - 86400000) } } },
  { $group: {
    _id: '$tool_name',
    p95_latency: { $percentile: { input: '$latency_ms', p: [0.95], method: 'approximate' } }
  }},
  { $sort: { p95_latency: -1 } }
])
```

### Largest responses (token economy tracking)

```js
db.mcp_tool_calls.aggregate([
  { $match: { status: 'ok', response_size_bytes: { $gt: 0 } } },
  { $group: {
    _id: '$tool_name',
    avg_bytes: { $avg: '$response_size_bytes' },
    max_bytes: { $max: '$response_size_bytes' }
  }},
  { $sort: { avg_bytes: -1 } },
  { $limit: 10 }
])
```

### Per-tenant usage (active tenants)

```js
db.mcp_tool_calls.aggregate([
  { $match: { timestamp: { $gte: new Date(Date.now() - 30 * 86400000) } } },
  { $group: { _id: '$tenant_id_active', calls: { $sum: 1 } } },
  { $sort: { calls: -1 } }
])
```

---

## Audit Logs (console.error)

Write operations (create/update segment, create/schedule campaign, create/update
template) emit a structured JSON audit log entry to `stderr`:

```json
{
  "audit": true,
  "tool": "nevent_create_segment",
  "tenantId": "tenant_abc123",
  "timestamp": "2025-05-15T10:30:00.000Z",
  "operation": "create",
  "outcome": "success",
  "segmentId": "seg_001",
  "segmentName": "VIP attendees"
}
```

These appear in CloudWatch Logs (ECS deployment) or in your process manager's
stderr stream. Filter with: `jq 'select(.audit == true)'`.

---

## HTTP Transport: Request Logging

In HTTP mode, the Express server logs each request:

```
[nevent-mcp] POST /mcp 200 142ms session=sess_abc123
```

Session lifecycle events are also logged:

```
[nevent-mcp] Session initialized | session_id=sess_abc123 | user=user_456
[nevent-mcp] Session closed | session_id=sess_abc123
```

---

## Environment Variables Affecting Observability

| Variable | Effect |
|----------|--------|
| `MONGODB_URI` | Enables MongoDB tool call logging. Required for HTTP mode. |
| `NEVENT_OPERATION_MODE` | Affects which tool calls are permitted (READ_ONLY / STANDARD / FULL). |
| `MCP_JWT_SECRET` | JWT signing secret. Required for HTTP mode OAuth. |

---

## Error Code Reference

All tool errors use the `NeventError` structure:

```ts
interface NeventError {
  type: 'authentication_error' | 'invalid_request' | 'not_found' |
        'rate_limit_error' | 'api_error' | 'permission_denied';
  message: string;
  code: string;   // Machine-readable, e.g. "segment_not_found"
  param?: string; // Field name that caused the error, when applicable
}
```

Common error codes:

| Code | Meaning |
|------|---------|
| `invalid_token` | JWT missing, expired, or malformed |
| `forbidden` | Insufficient role (ADMIN / SUPERADMIN required) |
| `not_found` | Resource does not exist or belongs to another tenant |
| `rate_limit_exceeded` | Too many requests; includes `param` with retry-after seconds |
| `server_error` | nev-api 5xx — transient, retry after backoff |
| `segment_not_found` | Segment ID not found in active tenant |
| `invalid_segment_definition` | Segment DSL validation failed |
| `missing_update_fields` | Update call with no fields to change |
| `tenant_required` | Tool requires active tenant (call nevent_switch_tenant first) |
| `operation_mode_blocked` | Write tool called in READ_ONLY mode |
| `network_error` | Could not reach nev-api (timeout or DNS failure) |
