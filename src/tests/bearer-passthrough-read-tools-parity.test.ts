/**
 * Pins which READ tools reach a `bearer-passthrough` caller (an internal
 * channel such as an agent using a nev-api service session, or the
 * `nev-helpbot` support bot) and how that set relates to the OAuth
 * read-only-client policy (`client-restrictions.ts`).
 *
 * Why: the 4 READ tools added in #84 (events, sales provenance by event,
 * campaign deliverability, campaign unsubscribes) must be reachable through
 * every internal channel, and the only intentional difference between the two
 * read-only policies is none: they are identical (decision 2026-10-28,
 * `nevent_segment_execute` is exposed to both). A new READ tool that silently
 * fails to appear in one channel must fail here.
 */

import { describe, it, expect } from 'vitest';
import {
  isToolAllowedInBearerPassthrough,
  EXCLUDED_TOOLS_BEARER_PASSTHROUGH,
} from '../config/bearer-passthrough.js';
import { isToolAllowedForReadOnlyClient } from '../config/client-restrictions.js';
import { getToolOperationType } from '../config/operation-mode.js';
import { createNeventServer } from '../server.js';
import { DataClient } from '../clients/data-client.js';
import { PaidMediaClient } from '../clients/paid-media-client.js';
import { SessionClients } from '../clients/session-clients.js';

/** Builds a server (optionally filtered) and returns its registered tool names. */
function registeredTools(toolFilter?: (name: string) => boolean): string[] {
  const dataClient = new DataClient({ baseUrl: 'http://stub', jwtToken: 'stub' });
  const paidMediaClient = new PaidMediaClient({ baseUrl: 'http://stub', jwtToken: 'stub' });
  const sessionClients = new SessionClients(dataClient, paidMediaClient, 'http://stub');
  const server = createNeventServer({
    dataClient,
    neventApiUrl: 'http://stub',
    paidMediaClient,
    sessionClients,
    toolFilter,
  });
  return Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
}

const NEW_READ_TOOLS = [
  'nevent_list_events',
  'nevent_event_sales_provenance',
  'nevent_get_campaign_deliverability',
  'nevent_get_campaign_unsubscribes',
] as const;

/** Every tool the server registers with no filter and no MONGODB_URI. */
const ALL_TOOLS = registeredTools();
const READ_TOOLS = ALL_TOOLS.filter((t) => getToolOperationType(t) === 'READ');

describe('bearer-passthrough READ tool exposure', () => {
  it.each(NEW_READ_TOOLS)('exposes %s', (tool) => {
    expect(isToolAllowedInBearerPassthrough(tool)).toBe(true);
  });

  it('registers the 4 new READ tools on a real filtered server, even without MONGODB_URI', () => {
    const names = registeredTools(isToolAllowedInBearerPassthrough);
    for (const tool of NEW_READ_TOOLS) {
      expect(names).toContain(tool);
    }
  });

  it('registers every READ tool except the explicit exclusions', () => {
    const exposed = registeredTools(isToolAllowedInBearerPassthrough).sort();
    const expected = READ_TOOLS.filter((t) => !EXCLUDED_TOOLS_BEARER_PASSTHROUGH.has(t)).sort();
    expect(exposed).toEqual(expected);
    expect(exposed.length).toBeGreaterThan(NEW_READ_TOOLS.length);
  });

  it('never exposes a non-READ tool', () => {
    const writes = ALL_TOOLS.filter((t) => getToolOperationType(t) !== 'READ');
    expect(writes.length).toBeGreaterThan(0);
    for (const tool of writes) {
      expect(isToolAllowedInBearerPassthrough(tool), tool).toBe(false);
    }
  });

  it('is fail-closed for tools missing from the registry', () => {
    expect(isToolAllowedInBearerPassthrough('nevent_not_a_real_tool')).toBe(false);
  });

  it('exposes nevent_segment_execute (product decision 2026-10-28)', () => {
    expect(isToolAllowedInBearerPassthrough('nevent_segment_execute')).toBe(true);
  });

  it('is identical to the OAuth read-only-client policy for every registered tool', () => {
    for (const tool of ALL_TOOLS) {
      expect(isToolAllowedInBearerPassthrough(tool), tool).toBe(isToolAllowedForReadOnlyClient(tool));
    }
  });
});
