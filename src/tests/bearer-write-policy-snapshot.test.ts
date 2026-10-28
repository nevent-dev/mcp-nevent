/**
 * NEV-1854 — exact tool lists per (principal, writes flag) in
 * bearer-passthrough. The READ-only list (flag off, and SERVICE with the flag
 * on) must stay byte-for-byte the 46 tools pinned in
 * `bearer-passthrough-tool-snapshot.test.ts`; HUMAN with the flag on is those
 * 46 plus the 12 reviewed write tools.
 */

import { describe, it, expect } from 'vitest';
import { createNeventServer } from '../server.js';
import { DataClient } from '../clients/data-client.js';
import { PaidMediaClient } from '../clients/paid-media-client.js';
import { SessionClients } from '../clients/session-clients.js';
import { createBearerToolFilter, type BearerWritesMode } from '../config/bearer-passthrough.js';
import type { PrincipalType } from '../auth/session-verifier.js';

const WRITE_TOOLS = [
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

function registeredTools(principal: PrincipalType, mode: BearerWritesMode): string[] {
  const dataClient = new DataClient({ baseUrl: 'http://stub', jwtToken: 'stub' });
  const paidMediaClient = new PaidMediaClient({ baseUrl: 'http://stub', jwtToken: 'stub' });
  const sessionClients = new SessionClients(dataClient, paidMediaClient, 'http://stub');
  const server = createNeventServer({
    dataClient,
    neventApiUrl: 'http://stub',
    mongoUri: 'mongodb://127.0.0.1:1/unused',
    enableToolCallLogging: false,
    paidMediaClient,
    sessionClients,
    toolFilter: createBearerToolFilter(principal, mode),
  });
  return Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools).sort();
}

describe('bearer-passthrough per-session tool lists', () => {
  const readOnly = registeredTools('HUMAN', 'off');

  it('flag off: 46 READ tools for HUMAN and SERVICE (unchanged)', () => {
    expect(readOnly).toHaveLength(46);
    expect(registeredTools('SERVICE', 'off')).toEqual(readOnly);
  });

  it('flag on + SERVICE: still exactly the 46 READ tools', () => {
    expect(registeredTools('SERVICE', 'human')).toEqual(readOnly);
  });

  it('flag on + HUMAN: 46 READ + the 12 allowlisted writes, nothing else', () => {
    const human = registeredTools('HUMAN', 'human');
    expect(human).toEqual([...readOnly, ...WRITE_TOOLS].sort());
    expect(human).toHaveLength(58);
  });

  it('flag on + HUMAN never exposes the excluded tools', () => {
    const human = registeredTools('HUMAN', 'human');
    for (const t of [
      'nevent_upload_image',
      'nevent_delete_image',
      'nevent_reset_tenant',
      'nevent_switch_tenant',
      'nevent_list_tenants',
    ]) {
      expect(human).not.toContain(t);
    }
  });
});
