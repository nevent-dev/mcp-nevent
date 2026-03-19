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
 * This infrastructure is in place so Sprint 2+ write tools can be gated correctly.
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
 * Sprint 1 analytics and segmentation tools are all READ.
 * Extend this map as Sprint 2+ tools are added.
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
