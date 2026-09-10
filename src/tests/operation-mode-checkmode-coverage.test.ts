/**
 * Regression guard: every `checkMode('someToolName')` call site in
 * `src/tools/*.ts` must have a matching entry in the real `TOOL_OPERATIONS`
 * registry (`src/config/operation-mode.ts`).
 *
 * ## Why this test exists
 *
 * The commit that flipped `isOperationAllowed()` from fail-open to
 * fail-closed silently broke `nevent_campaign_report` (called `checkMode()`
 * but had no `TOOL_OPERATIONS` entry) in production on mcp.nevent.ai. The
 * existing `operation-mode.test.ts` only exercises the generic policy logic
 * against a handful of hand-picked tool names — it never cross-checks the
 * real call sites in `src/tools/*.ts` against the real registry, so a tool
 * that calls `checkMode()` but was never classified sails through unnoticed.
 *
 * This test closes that gap by statically scanning every real tool file for
 * `checkMode('...')` call sites, then asserting — against the real,
 * imported `TOOL_OPERATIONS` table (via `getToolOperationType`), not a
 * synthetic fixture — that each one is classified.
 *
 * If you add a new tool that calls `checkMode()`, you MUST add a matching
 * entry to `TOOL_OPERATIONS` in `src/config/operation-mode.ts` or this test
 * will fail.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getToolOperationType } from '../config/operation-mode.js';

const TOOLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools');

/**
 * Matches `checkMode('toolName')` or `checkMode("toolName")` call sites with
 * a literal string argument. Deliberately does NOT match dynamic arguments
 * (e.g. `checkMode(toolName)`) — every real call site in the codebase passes
 * a literal, and a dynamic call site would need a different (manual) audit
 * strategy anyway.
 */
const CHECK_MODE_CALL_RE = /checkMode\(\s*['"]([a-zA-Z0-9_]+)['"]\s*\)/g;

/**
 * Extracts every literal `checkMode('...')` argument found in `source`,
 * skipping lines that are clearly comments (JSDoc `*` lines or `//` line
 * comments) so example snippets in doc comments do not count as real call
 * sites.
 */
function extractCheckModeCallsites(source: string): string[] {
  const names: string[] = [];
  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//')) {
      continue;
    }
    for (const match of line.matchAll(CHECK_MODE_CALL_RE)) {
      names.push(match[1]);
    }
  }
  return names;
}

function listToolFiles(): string[] {
  return readdirSync(TOOLS_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => join(TOOLS_DIR, f));
}

describe('checkMode() call sites vs TOOL_OPERATIONS registry', () => {
  const toolFiles = listToolFiles();

  it('finds at least one tool file to scan (sanity check the scan itself works)', () => {
    expect(toolFiles.length).toBeGreaterThan(0);
  });

  it('discovers real checkMode() call sites (sanity check the regex works)', () => {
    const allCallsites = toolFiles.flatMap((file) =>
      extractCheckModeCallsites(readFileSync(file, 'utf-8'))
    );
    // The reviewer counted 58 real call sites pre-fix (nevent_help does not
    // call checkMode() at all, so it is intentionally NOT covered by this
    // count). Assert a generous floor so this test fails loudly if the scan
    // itself ever stops finding real call sites (e.g. after a refactor that
    // renames checkMode or changes the call convention).
    expect(allCallsites.length).toBeGreaterThanOrEqual(50);
  });

  for (const file of listToolFiles()) {
    const callsites = extractCheckModeCallsites(readFileSync(file, 'utf-8'));
    const uniqueNames = [...new Set(callsites)];

    for (const toolName of uniqueNames) {
      it(`${toolName} (called via checkMode() in ${file.split('/').pop()}) is classified in TOOL_OPERATIONS`, () => {
        expect(
          getToolOperationType(toolName),
          `checkMode('${toolName}') is called in ${file}, but '${toolName}' has no entry in ` +
            `TOOL_OPERATIONS (src/config/operation-mode.ts). Because isOperationAllowed() is ` +
            `fail-closed, this tool is silently DENIED in every operation mode and every ` +
            `transport (oauth, stdio, bearer-passthrough) until it is classified.`
        ).toBeDefined();
      });
    }
  }
});
