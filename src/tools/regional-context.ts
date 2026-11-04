/**
 * Regional settings tool for the Nevent MCP Server (nevent-work#279, L8).
 *
 * Registers `nevent_get_regional_settings`: the reporting currency, time zone, operating country and communication
 * language of the organization this session works in, and whether Nevent already applies them
 * (`I18N_TENANT_CONTEXT`). A client uses them to present amounts and dates the way the organization works; while
 * `in_use` is false the organization has not adopted them, and a client keeps the defaults it uses today.
 *
 * ## Scope
 *
 * - Read only (`READ` in TOOL_OPERATIONS, `readOnlyHint`).
 * - Only the session's own organization: the tenant comes from the session JWT (`dataClient.activeTenantId`), never
 *   from a parameter. The tool takes no input. nev-api checks the caller's reach again (403 outside it).
 * - It returns the four effective values and where each comes from, nothing else: no names or ids of other
 *   organizations (`fromTenantName`, descendants), no scheduled campaigns, no market catalog.
 *
 * ## nev-api endpoint
 *
 * `GET /tenants/{tenantId}/regional-context` (TenantRegionalContextController, nevent-work#288), roles ADMIN, OWNER and
 * SUPERADMIN. Other roles get 403, reported as `forbidden`: the client keeps its defaults.
 *
 * @module tools/regional-context
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SessionClients } from '../clients/session-clients.js';
import { TIMEOUTS } from '../config/timeouts.js';
import { ok, err, toErrorEnvelope, checkMode } from './helpers.js';

/** The four regional fields, as nev-api names them in `effective`. */
const FIELDS = ['reportingCurrency', 'timeZone', 'operatingCountry', 'communicationLanguage'] as const;

/** Output names of the fields (snake case, as the other tools). */
const OUTPUT_NAMES: Record<(typeof FIELDS)[number], string> = {
  reportingCurrency: 'reporting_currency',
  timeZone: 'time_zone',
  operatingCountry: 'operating_country',
  communicationLanguage: 'communication_language',
};

/** An effective value of nev-api: the value and where it comes from (OWN, INHERITED, MARKET_DEFAULT, PLATFORM_DEFAULT, UNSET). */
interface EffectiveValue {
  value: string | null;
  source: string;
}

/** The part of nev-api's `RegionalContextView` this tool reads. */
interface RegionalContextView {
  tenantId: string;
  flagEnabled: boolean;
  effective: Partial<Record<(typeof FIELDS)[number], EffectiveValue | null>>;
}

/** What the tool returns. */
export interface RegionalSettings {
  tenant_id: string;
  in_use: boolean;
  reporting_currency: EffectiveValue;
  time_zone: EffectiveValue;
  operating_country: EffectiveValue;
  communication_language: EffectiveValue;
}

/** Reduce nev-api's view to the four effective values, dropping who they are inherited from. */
export function toRegionalSettings(view: RegionalContextView): RegionalSettings {
  const settings: Record<string, unknown> = { tenant_id: view.tenantId, in_use: view.flagEnabled === true };
  for (const field of FIELDS) {
    const effective = view.effective?.[field];
    settings[OUTPUT_NAMES[field]] = { value: effective?.value ?? null, source: effective?.source ?? 'UNSET' };
  }
  return settings as unknown as RegionalSettings;
}

/**
 * Register the regional settings tool. It needs nev-api, so it is registered with the other nev-api tools.
 *
 * @param server         The MCP server.
 * @param sessionClients The session's clients: the JWT and the active tenant come from them.
 * @param neventApiUrl   Base URL of nev-api, e.g. `https://api.nevent.es`.
 */
export function registerRegionalContextTools(server: McpServer, sessionClients: SessionClients, neventApiUrl: string): void {
  server.tool(
    'nevent_get_regional_settings',
    "Get the regional settings of the organization you are working in: reporting currency, time zone, operating " +
      'country and communication language, each with where it comes from (own, inherited, market or platform ' +
      'default). Use them to show amounts and dates the way the organization works. When in_use is false the ' +
      'organization has not adopted them yet: keep your current defaults. Read only; takes no input.',
    {},
    { title: 'Get regional settings', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async () => {
      const denied = checkMode('nevent_get_regional_settings');
      if (denied) return err(denied);

      const tenantId = sessionClients.dataClient.activeTenantId;
      if (!tenantId) {
        return err({
          error: {
            type: 'authentication_error',
            message: 'The session has no organization: sign in again.',
            code: 'no_active_tenant',
          },
        });
      }

      try {
        const response = await fetch(`${neventApiUrl}/tenants/${encodeURIComponent(tenantId)}/regional-context`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${sessionClients.dataClient.getJwtToken()}`,
          },
          signal: AbortSignal.timeout(TIMEOUTS.DEFAULT_MS),
        });
        if (response.status === 403) {
          return err({
            error: {
              type: 'authentication_error',
              message: 'Reading the regional settings requires the ADMIN, OWNER or SUPERADMIN role.',
              code: 'forbidden',
            },
          });
        }
        if (!response.ok) {
          return err({
            error: { type: 'api_error', message: `Failed to read the regional settings: HTTP ${response.status}.`, code: 'api_error' },
          });
        }
        return ok(toRegionalSettings((await response.json()) as RegionalContextView));
      } catch (caught) {
        return err(toErrorEnvelope(caught));
      }
    },
  );
}
