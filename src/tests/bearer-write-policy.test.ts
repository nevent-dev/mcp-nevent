/**
 * NEV-1854 — per-session write policy in `bearer-passthrough`.
 *
 * HUMAN = READ + explicit write allowlist (only when the writes flag is
 * `human`); SERVICE = READ only, always. Writes are OFF by default.
 */

import { describe, it, expect } from 'vitest';
import {
  BEARER_WRITE_ALLOWLIST_HUMAN,
  EXCLUDED_TOOLS_BEARER_PASSTHROUGH,
  ALWAYS_DENIED_TOOLS_BEARER_PASSTHROUGH,
  createBearerToolFilter,
  isToolAllowedForSession,
  isToolAllowedInBearerPassthrough,
  parseBearerWritesMode,
  type BearerWritesMode,
} from '../config/bearer-passthrough.js';
import { TOOL_OPERATIONS } from '../config/operation-mode.js';

const EXPECTED_ALLOWLIST = [
  'nevent_clone_template',
  'nevent_create_bulk_user_short_urls',
  'nevent_create_campaign',
  'nevent_create_segment',
  'nevent_create_short_url',
  'nevent_create_template',
  'nevent_rename_template',
  'nevent_schedule_campaign',
  'nevent_send_test_template',
  'nevent_update_segment',
  'nevent_update_short_url',
  'nevent_update_template',
];

const ALWAYS_OUT = [
  'nevent_upload_image',
  'nevent_delete_image',
  'nevent_reset_tenant',
  'nevent_switch_tenant',
  'nevent_list_tenants',
];

const allTools = Object.keys(TOOL_OPERATIONS);

describe('write allowlist', () => {
  it('is exactly the v1 list (12 names, exact)', () => {
    expect([...BEARER_WRITE_ALLOWLIST_HUMAN].sort()).toEqual(EXPECTED_ALLOWLIST);
  });

  it('only contains tools classified in TOOL_OPERATIONS as WRITE (or schedule_campaign as DELETE)', () => {
    for (const t of BEARER_WRITE_ALLOWLIST_HUMAN) {
      const op = TOOL_OPERATIONS[t];
      expect(op, t).toBeDefined();
      if (t === 'nevent_schedule_campaign') expect(op).toBe('DELETE');
      else expect(op, t).toBe('WRITE');
    }
  });

  it('never overlaps the always-denied tools', () => {
    for (const t of ALWAYS_OUT) {
      expect(BEARER_WRITE_ALLOWLIST_HUMAN.has(t)).toBe(false);
      expect(ALWAYS_DENIED_TOOLS_BEARER_PASSTHROUGH.has(t)).toBe(true);
    }
    expect(EXCLUDED_TOOLS_BEARER_PASSTHROUGH.has('nevent_list_tenants')).toBe(true);
  });
});

describe('parseBearerWritesMode', () => {
  it('defaults to off when unset or empty', () => {
    expect(parseBearerWritesMode(undefined)).toBe('off');
    expect(parseBearerWritesMode('')).toBe('off');
    expect(parseBearerWritesMode('   ')).toBe('off');
  });
  it('accepts off and human (case/space-insensitive)', () => {
    expect(parseBearerWritesMode('off')).toBe('off');
    expect(parseBearerWritesMode(' HUMAN ')).toBe('human');
  });
  it('rejects anything else (fail-closed, no silent fallback)', () => {
    for (const v of ['all', 'true', '1', 'service', 'human,service']) {
      expect(() => parseBearerWritesMode(v), v).toThrow(/MCP_BEARER_PASSTHROUGH_WRITES/);
    }
  });
});

describe('isToolAllowedForSession matrix', () => {
  const modes: BearerWritesMode[] = ['off', 'human'];
  const principals = ['HUMAN', 'SERVICE'] as const;

  for (const mode of modes) {
    for (const principalType of principals) {
      describe(`writes=${mode} principal=${principalType}`, () => {
        const writesEnabled = mode === 'human' && principalType === 'HUMAN';
        for (const tool of allTools) {
          const isRead = TOOL_OPERATIONS[tool] === 'READ';
          const alwaysDenied = ALWAYS_OUT.includes(tool);
          const inAllowlist = EXPECTED_ALLOWLIST.includes(tool);
          const expected = alwaysDenied ? false : isRead || (writesEnabled && inAllowlist);
          it(`${tool} -> ${expected}`, () => {
            expect(isToolAllowedForSession(tool, { principalType }, mode)).toBe(expected);
          });
        }
      });
    }
  }

  it('denies an unclassified tool in every combination (fail-closed)', () => {
    for (const mode of modes) {
      for (const principalType of principals) {
        expect(isToolAllowedForSession('nevent_not_classified', { principalType }, mode)).toBe(false);
      }
    }
  });

  it('denies an unknown principal type (fail-closed)', () => {
    expect(
      isToolAllowedForSession('nevent_create_segment', { principalType: 'ROBOT' as never }, 'human')
    ).toBe(false);
  });

  it('writes=off is exactly the legacy READ-only predicate for both principals', () => {
    for (const tool of [...allTools, 'nevent_not_classified']) {
      for (const principalType of principals) {
        expect(isToolAllowedForSession(tool, { principalType }, 'off')).toBe(
          isToolAllowedInBearerPassthrough(tool)
        );
      }
    }
  });
});

describe('createBearerToolFilter', () => {
  it('binds principal and mode', () => {
    const humanOn = createBearerToolFilter('HUMAN', 'human');
    const serviceOn = createBearerToolFilter('SERVICE', 'human');
    expect(humanOn('nevent_create_campaign')).toBe(true);
    expect(serviceOn('nevent_create_campaign')).toBe(false);
    expect(serviceOn('nevent_list_campaigns')).toBe(true);
  });
});
