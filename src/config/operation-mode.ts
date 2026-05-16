/**
 * Operation Mode Configuration for the Nevent MCP Server.
 *
 * Controls what categories of operations are permitted:
 *
 * - `READ_ONLY`  — Only read/query operations allowed. No side-effects. (default)
 * - `STANDARD`   — Read + write operations. No destructive deletes.
 * - `FULL`       — All operations including destructive deletes. Use with caution.
 *
 * Set via environment variable: NEVENT_OPERATION_MODE=READ_ONLY|STANDARD|FULL
 *
 * Sprint 1 tools are all READ operations and are therefore permitted in every mode.
 * Sprint 2 adds WRITE (create/update) and DELETE-equivalent (schedule) operations
 * that are gated by operation mode.
 */

export type OperationMode = 'READ_ONLY' | 'STANDARD' | 'FULL';

/**
 * The type of an individual tool operation.
 * - `READ`   — Query or inspection only (no side-effects).
 * - `WRITE`  — Creates or modifies resources.
 * - `DELETE` — Destroys resources (irreversible).
 */
export type OperationType = 'READ' | 'WRITE' | 'DELETE';

// ---------------------------------------------------------------------------
// Mode resolution
// ---------------------------------------------------------------------------

const VALID_MODES: ReadonlySet<OperationMode> = new Set<OperationMode>([
  'READ_ONLY',
  'STANDARD',
  'FULL',
]);

const rawMode = (process.env['NEVENT_OPERATION_MODE'] ?? '').toUpperCase();

/**
 * The active operation mode, resolved from NEVENT_OPERATION_MODE env var.
 * Defaults to READ_ONLY when the env var is absent or invalid.
 */
export const OPERATION_MODE: OperationMode = VALID_MODES.has(rawMode as OperationMode)
  ? (rawMode as OperationMode)
  : 'READ_ONLY';

if (rawMode && !VALID_MODES.has(rawMode as OperationMode)) {
  console.error(
    `[nevent-mcp] Invalid NEVENT_OPERATION_MODE value: "${rawMode}". ` +
    `Valid values are: READ_ONLY, STANDARD, FULL. Defaulting to READ_ONLY.`
  );
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

/**
 * Maps each tool name to its operation type.
 * All tools must be listed here. Unknown tools are fail-open (logged as warnings).
 */
const TOOL_OPERATIONS: Readonly<Record<string, OperationType>> = {
  // Sprint 1: Analytics
  nevent_analytics_query: 'READ',
  nevent_analytics_capabilities: 'READ',
  nevent_analytics_table_schema: 'READ',
  nevent_analytics_filter_values: 'READ',

  // Sprint 1: Segmentation
  nevent_segmentation_criteria: 'READ',
  nevent_segment_preview: 'READ',
  nevent_segment_execute: 'READ',
  nevent_dimension_values: 'READ',

  // Sprint 1: Multi-tenant
  nevent_list_tenants: 'READ',
  nevent_switch_tenant: 'READ',

  // Sprint 2: Segment management
  nevent_list_segments: 'READ',
  nevent_get_segment: 'READ',
  nevent_create_segment: 'WRITE',
  nevent_update_segment: 'WRITE',

  // Sprint 2: Campaign read tools
  nevent_list_campaigns: 'READ',
  nevent_get_campaign: 'READ',
  nevent_get_campaign_insights: 'READ',

  // Sprint 2: Template tools (read from MongoDB)
  nevent_list_templates: 'READ',
  nevent_get_template: 'READ',
  nevent_create_template: 'WRITE',
  nevent_update_template: 'WRITE',

  // Sprint 3: Template operations (via nev-api)
  // clone/rename/test → WRITE (create/modify resources or send real emails)
  // preview → READ (renders server-side but mutates nothing)
  nevent_clone_template: 'WRITE',
  nevent_rename_template: 'WRITE',
  nevent_preview_template: 'READ',
  nevent_send_test_template: 'WRITE',

  // Sprint 2: Deliverability tools
  nevent_get_sending_profile: 'READ',
  nevent_get_suppressions_summary: 'READ',

  // Sprint 2: Campaign actions
  // nevent_create_campaign: WRITE — requires STANDARD or FULL mode.
  // Creating campaigns in DRAFT is a write side-effect but not destructive.
  nevent_create_campaign: 'WRITE',
  // nevent_schedule_campaign: DELETE-equivalent — requires FULL mode.
  // Scheduling triggers a real send (irreversible once the window passes),
  // so we treat it with the same caution as a destructive operation.
  nevent_schedule_campaign: 'DELETE',

  // Paid Media tools (Tier 1 + Tier 2): all READ operations
  nevent_paid_ads_status: 'READ',
  nevent_paid_ads_health: 'READ',
  nevent_list_paid_campaigns: 'READ',
  nevent_get_paid_campaign_insights: 'READ',
  nevent_paid_attribution: 'READ',
  nevent_list_paid_ad_groups: 'READ',
  nevent_get_paid_ad_group_insights: 'READ',
  nevent_get_paid_ad_group_comparative_stats: 'READ',
  nevent_get_paid_ad_group_targeting: 'READ',
  nevent_list_paid_ads: 'READ',
  nevent_get_paid_ad_creative: 'READ',
};

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/**
 * Returns `true` if the given tool is permitted in the current operation mode.
 *
 * - `READ_ONLY` permits only READ tools.
 * - `STANDARD` permits READ and WRITE tools.
 * - `FULL` permits all tools.
 *
 * Unknown tools are allowed and a warning is logged (fail-open for future tools).
 *
 * @param toolName — The MCP tool name to check.
 */
export function isOperationAllowed(toolName: string): boolean {
  const operationType = TOOL_OPERATIONS[toolName];

  if (!operationType) {
    console.warn(`[nevent-mcp] Unknown tool "${toolName}". Allowing operation (fail-open).`);
    return true;
  }

  switch (OPERATION_MODE) {
    case 'READ_ONLY':
      return operationType === 'READ';
    case 'STANDARD':
      return operationType === 'READ' || operationType === 'WRITE';
    case 'FULL':
      return true;
  }
}

/**
 * Returns a descriptive, actionable error message when a tool is blocked
 * by the current operation mode.
 *
 * @param toolName — The MCP tool name that was blocked.
 */
export function getOperationDeniedMessage(toolName: string): string {
  const operationType = TOOL_OPERATIONS[toolName] ?? 'WRITE';

  if (OPERATION_MODE === 'READ_ONLY' && operationType === 'WRITE') {
    return (
      `Tool '${toolName}' is a write operation and is not permitted in READ_ONLY mode. ` +
      `Set NEVENT_OPERATION_MODE=STANDARD to enable write operations.`
    );
  }

  if (OPERATION_MODE === 'READ_ONLY' && operationType === 'DELETE') {
    return (
      `Tool '${toolName}' is a delete operation and is not permitted in READ_ONLY mode. ` +
      `Set NEVENT_OPERATION_MODE=FULL to enable delete operations.`
    );
  }

  if (OPERATION_MODE === 'STANDARD' && operationType === 'DELETE') {
    return (
      `Tool '${toolName}' is a destructive delete operation. ` +
      `Set NEVENT_OPERATION_MODE=FULL to enable delete operations (use with caution).`
    );
  }

  return `Tool '${toolName}' is not permitted in ${OPERATION_MODE} mode.`;
}
