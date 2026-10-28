/**
 * NEV-1854 — pure startup gate for the bearer-passthrough write policy
 * (`assertWritesStartupAllowed`) and TOOL_OPERATIONS immutability.
 */

import { describe, it, expect } from 'vitest';
import { assertWritesStartupAllowed } from '../config/bearer-passthrough.js';
import { TOOL_OPERATIONS } from '../config/operation-mode.js';

const UNSAFE = 'MCP_BEARER_PASSTHROUGH_WRITES_UNSAFE_NO_GRANT';

describe('assertWritesStartupAllowed', () => {
  it('human without the override and no grant -> throws', () => {
    expect(() => assertWritesStartupAllowed('human', {}, false, 'FULL')).toThrow(/NEV-1855/);
  });

  it.each(['TRUE', 'True', '1', 'yes', ' true'])('human + override %j (not exactly "true") -> throws', (v) => {
    expect(() => assertWritesStartupAllowed('human', { [UNSAFE]: v }, false, 'FULL')).toThrow(/NEV-1855/);
  });

  it('human + "true" outside production -> allowed with an error-level log', () => {
    const logs = assertWritesStartupAllowed('human', { [UNSAFE]: 'true' }, false, 'FULL');
    expect(logs).toHaveLength(1);
    expect(logs[0]!.level).toBe('error');
    expect(logs[0]!.message).toMatch(/WITHOUT A WRITE GRANT/);
  });

  it('human + "true" with NODE_ENV=production -> throws', () => {
    expect(() =>
      assertWritesStartupAllowed('human', { [UNSAFE]: 'true', NODE_ENV: 'production' }, false, 'FULL')
    ).toThrow(/production/);
  });

  it('human with the grant available -> allowed with no logs', () => {
    expect(assertWritesStartupAllowed('human', { NODE_ENV: 'production' }, true, 'FULL')).toEqual([]);
  });

  it('off + "true" -> warning that the override is ignored', () => {
    const logs = assertWritesStartupAllowed('off', { [UNSAFE]: 'true' }, false, 'READ_ONLY');
    expect(logs).toEqual([{ level: 'warn', message: expect.stringMatching(/ignored/) }]);
  });

  it('off without override -> nothing, whatever the operation mode', () => {
    expect(assertWritesStartupAllowed('off', {}, false, 'READ_ONLY')).toEqual([]);
  });

  it('human + READ_ONLY operation mode -> throws', () => {
    expect(() => assertWritesStartupAllowed('human', { [UNSAFE]: 'true' }, false, 'READ_ONLY')).toThrow(/STANDARD or FULL/);
    expect(() => assertWritesStartupAllowed('human', {}, true, 'READ_ONLY')).toThrow(/STANDARD or FULL/);
  });

  it('human + STANDARD -> warns that schedule_campaign needs FULL', () => {
    const logs = assertWritesStartupAllowed('human', {}, true, 'STANDARD');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ level: 'warn' });
    expect(logs[0]!.message).toMatch(/schedule_campaign/);
  });
});

describe('createBearerPassthroughApp enforces the same gate', () => {
  it('refuses to build with writes=human and no grant/override', async () => {
    const { createBearerPassthroughApp } = await import('../transports/http-bearer-passthrough.js');
    await expect(
      createBearerPassthroughApp({
        port: 0,
        neventApiUrl: 'https://api.nevent.es',
        dataApiUrl: 'https://data.nevent.es',
        serviceKeys: ['k'.repeat(40)],
        writesMode: 'human',
        writesStartup: { env: {}, grantAvailable: false, operationMode: 'FULL' },
      })
    ).rejects.toThrow(/NEV-1855/);
  });
});

describe('TOOL_OPERATIONS', () => {
  it('is frozen: a classification cannot be mutated at runtime', () => {
    expect(Object.isFrozen(TOOL_OPERATIONS)).toBe(true);
    expect(() => {
      (TOOL_OPERATIONS as Record<string, string>)['nevent_create_segment'] = 'READ';
    }).toThrow();
    expect(TOOL_OPERATIONS['nevent_create_segment']).toBe('WRITE');
  });
});
