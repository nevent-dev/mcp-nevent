/**
 * Analytics E2E Test Suite — MCP Nevent
 *
 * Tests the complete analytics flow: capabilities → schema → query
 * Validates that an AI agent can auto-discover tables, schemas, and
 * execute correct queries via the MCP tools.
 *
 * Run: NEVENT_JWT_TOKEN=<token> MONGODB_URI=<uri> npx tsx tests/analytics-e2e.test.ts
 */

import { spawn, ChildProcess } from 'child_process';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const JWT_TOKEN = process.env['NEVENT_JWT_TOKEN'];
const MONGODB_URI = process.env['MONGODB_URI'];
const NEVENT_API_URL = process.env['NEVENT_API_URL'] ?? 'https://api.nevent.es';

if (!JWT_TOKEN) {
  console.error('FATAL: Set NEVENT_JWT_TOKEN env var');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// MCP Client
// ---------------------------------------------------------------------------

interface McpResponse {
  id: number;
  result?: {
    content?: Array<{ type: string; text: string }>;
    isError?: boolean;
    tools?: Array<{ name: string }>;
    serverInfo?: { name: string };
  };
  error?: { code: number; message: string };
}

class McpTestClient {
  private proc: ChildProcess;
  private buffer = '';
  private responses = new Map<number, McpResponse>();
  private nextId = 1;

  constructor() {
    this.proc = spawn('node', ['dist/index.js'], {
      env: {
        ...process.env,
        NEVENT_JWT_TOKEN: JWT_TOKEN,
        MONGODB_URI: MONGODB_URI ?? '',
        NEVENT_API_URL,
        NEVENT_OPERATION_MODE: 'STANDARD',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout!.on('data', (data: Buffer) => {
      this.buffer += data.toString();
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as McpResponse;
          if (msg.id !== undefined) {
            this.responses.set(msg.id, msg);
          }
        } catch { /* ignore non-JSON */ }
      }
    });
  }

  private send(method: string, params?: Record<string, unknown>): number {
    const id = this.nextId++;
    const msg = { jsonrpc: '2.0', method, params: params ?? {}, id };
    this.proc.stdin!.write(JSON.stringify(msg) + '\n');
    return id;
  }

  private sendNotification(method: string, params?: Record<string, unknown>): void {
    const msg = { jsonrpc: '2.0', method, params: params ?? {} };
    this.proc.stdin!.write(JSON.stringify(msg) + '\n');
  }

  private async waitForResponse(id: number, timeoutMs = 30000): Promise<McpResponse> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const resp = this.responses.get(id);
      if (resp) return resp;
      await new Promise(r => setTimeout(r, 200));
    }
    throw new Error(`Timeout waiting for response id=${id} after ${timeoutMs}ms`);
  }

  async initialize(): Promise<void> {
    const id = this.send('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'analytics-e2e-test', version: '1.0' },
    });
    await this.waitForResponse(id);
    this.sendNotification('notifications/initialized');
    await new Promise(r => setTimeout(r, 500));
  }

  async listTools(): Promise<string[]> {
    const id = this.send('tools/list');
    const resp = await this.waitForResponse(id);
    return resp.result?.tools?.map(t => t.name) ?? [];
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<{ ok: boolean; data: unknown; raw: string }> {
    const id = this.send('tools/call', { name, arguments: args });
    const resp = await this.waitForResponse(id);

    if (resp.error) {
      return { ok: false, data: resp.error, raw: JSON.stringify(resp.error) };
    }

    const content = resp.result?.content?.[0]?.text ?? '';
    const isError = resp.result?.isError === true;

    try {
      const parsed = JSON.parse(content);
      return { ok: !isError, data: parsed, raw: content };
    } catch {
      return { ok: !isError, data: content, raw: content };
    }
  }

  kill(): void {
    this.proc.kill();
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface TestResult {
  name: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  details: string;
  durationMs: number;
}

const results: TestResult[] = [];

async function runTest(
  name: string,
  fn: (client: McpTestClient) => Promise<string>
): Promise<void> {
  const start = Date.now();
  try {
    const details = await fn(client);
    results.push({ name, status: 'PASS', details, durationMs: Date.now() - start });
    console.log(`  ✅ ${name} (${Date.now() - start}ms)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name, status: 'FAIL', details: msg, durationMs: Date.now() - start });
    console.log(`  ❌ ${name}: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let client: McpTestClient;

async function main() {
  console.log('\n🔬 Analytics E2E Test Suite\n');

  // Setup
  console.log('  Starting MCP server (stdio)...');
  client = new McpTestClient();
  await client.initialize();

  const tools = await client.listTools();
  console.log(`  ${tools.length} tools registered\n`);

  // -----------------------------------------------------------------------
  // T0: Capabilities — discover tables
  // -----------------------------------------------------------------------
  await runTest('T0: capabilities returns table list', async () => {
    const { ok, data } = await client.callTool('nevent_analytics_capabilities');
    if (!ok) throw new Error(`Failed: ${JSON.stringify(data).slice(0, 200)}`);
    const d = data as Record<string, unknown>;
    const tables = d['tables'] as Array<Record<string, unknown>>;
    if (!tables || tables.length === 0) throw new Error('No tables returned');
    const names = tables.map(t => t['name']);
    return `${tables.length} tables: ${names.join(', ')}`;
  });

  // -----------------------------------------------------------------------
  // T1: Schema — discover fields for campaigns
  // -----------------------------------------------------------------------
  await runTest('T1: table_schema returns fields for campaigns', async () => {
    const { ok, data } = await client.callTool('nevent_analytics_table_schema', { table: 'campaigns' });
    if (!ok) throw new Error(`Failed: ${JSON.stringify(data).slice(0, 200)}`);
    const d = data as Record<string, unknown>;
    // Response might be wrapped in {data: {columns: [...]}} or {columns: [...]}
    const raw = d['data'] ?? d;
    const cols = (raw as Record<string, unknown>)['columns'] ?? (raw as Record<string, unknown>)['fields'];
    if (!Array.isArray(cols)) throw new Error(`No columns found. Got: ${JSON.stringify(d).slice(0, 200)}`);
    if (cols.length === 0) throw new Error('Empty columns');
    return `${cols.length} columns`;
  });

  // -----------------------------------------------------------------------
  // T2: Schema — discover fields for purchases
  // -----------------------------------------------------------------------
  await runTest('T2: table_schema returns fields for purchases', async () => {
    const { ok, data } = await client.callTool('nevent_analytics_table_schema', { table: 'purchases' });
    if (!ok) throw new Error(`Failed: ${JSON.stringify(data).slice(0, 200)}`);
    return 'OK';
  });

  // -----------------------------------------------------------------------
  // T3: Query — count campaigns
  // -----------------------------------------------------------------------
  await runTest('T3: query campaigns count', async () => {
    const { ok, data } = await client.callTool('nevent_analytics_query', {
      collection: 'campaigns',
      metrics: [{ field: 'id', operation: 'count', alias: 'total' }],
    });
    if (!ok) throw new Error(`Failed: ${JSON.stringify(data).slice(0, 200)}`);
    const d = data as Record<string, unknown>;
    const rows = (d['data'] as unknown[]) ?? [];
    return `${rows.length} rows returned`;
  });

  // -----------------------------------------------------------------------
  // T4: Query — campaign_variable_costs with timeRange
  // -----------------------------------------------------------------------
  await runTest('T4: query campaign_metrics with timeRange', async () => {
    const { ok, data } = await client.callTool('nevent_analytics_query', {
      collection: 'campaign_metrics',
      dimensions: [{ field: 'campaign_name' }],
      metrics: [
        { field: 'total_sends', operation: 'sum', alias: 'sent' },
        { field: 'total_opens', operation: 'sum', alias: 'opens' },
        { field: 'total_clicks', operation: 'sum', alias: 'clicks' },
      ],
      timeRange: { start: '2026-01-01', end: '2026-04-30' },
      sort: { field: 'sent', order: 'desc' },
      limit: 5,
    });
    if (!ok) throw new Error(`Failed: ${JSON.stringify(data).slice(0, 200)}`);
    const d = data as Record<string, unknown>;
    const rows = (d['data'] as unknown[]) ?? [];
    return `${rows.length} campaigns with metrics`;
  });

  // -----------------------------------------------------------------------
  // T5: Query — purchases count
  // -----------------------------------------------------------------------
  await runTest('T5: query purchases count', async () => {
    const { ok, data } = await client.callTool('nevent_analytics_query', {
      collection: 'purchases',
      metrics: [{ field: 'id', operation: 'count', alias: 'total_purchases' }],
    });
    if (!ok) throw new Error(`Failed: ${JSON.stringify(data).slice(0, 200)}`);
    return 'OK';
  });

  // -----------------------------------------------------------------------
  // T6: Query — campaign attribution revenue
  // -----------------------------------------------------------------------
  await runTest('T6: query attribution revenue', async () => {
    const { ok, data } = await client.callTool('nevent_analytics_query', {
      collection: 'campaign_attribution_metrics_custom',
      dimensions: [{ field: 'campaign_name' }],
      metrics: [
        { field: 'attributed_revenue', operation: 'sum', alias: 'revenue_cents' },
        { field: 'attributed_conversions', operation: 'sum', alias: 'conversions' },
      ],
      sort: { field: 'revenue_cents', order: 'desc' },
      limit: 5,
    });
    if (!ok) throw new Error(`Failed: ${JSON.stringify(data).slice(0, 200)}`);
    return 'OK';
  });

  // -----------------------------------------------------------------------
  // T7: Query — user temperature distribution
  // -----------------------------------------------------------------------
  await runTest('T7: query user temperature levels', async () => {
    const { ok, data } = await client.callTool('nevent_analytics_query', {
      collection: 'user_temperature_levels',
      dimensions: [{ field: 'temperature_level' }],
      metrics: [{ field: 'user_id', operation: 'count', alias: 'users' }],
    });
    if (!ok) throw new Error(`Failed: ${JSON.stringify(data).slice(0, 200)}`);
    return 'OK';
  });

  // -----------------------------------------------------------------------
  // T8: Query — email usage daily with granularity
  // -----------------------------------------------------------------------
  await runTest('T8: query email_usage_daily monthly', async () => {
    const { ok, data } = await client.callTool('nevent_analytics_query', {
      collection: 'email_usage_daily',
      dimensions: [{ field: 'send_date', alias: 'month' }],
      metrics: [{ field: 'emails_sent', operation: 'sum', alias: 'total_sent' }],
      timeGranularity: 'month',
      timeRange: { start: '2026-01-01', end: '2026-04-30' },
      sort: { field: 'month', order: 'asc' },
    });
    if (!ok) throw new Error(`Failed: ${JSON.stringify(data).slice(0, 200)}`);
    return 'OK';
  });

  // -----------------------------------------------------------------------
  // T9: Query — campaign_user_interactions engagement
  // -----------------------------------------------------------------------
  await runTest('T9: query campaign_user_interactions', async () => {
    const { ok, data } = await client.callTool('nevent_analytics_query', {
      collection: 'campaign_user_interactions',
      metrics: [
        { field: 'total_sends', operation: 'sum', alias: 'sends' },
        { field: 'total_opens', operation: 'sum', alias: 'opens' },
        { field: 'total_clicks', operation: 'sum', alias: 'clicks' },
        { field: 'total_bounces', operation: 'sum', alias: 'bounces' },
      ],
    });
    if (!ok) throw new Error(`Failed: ${JSON.stringify(data).slice(0, 200)}`);
    return 'OK';
  });

  // -----------------------------------------------------------------------
  // T10: Query — short_url_clicks by country
  // -----------------------------------------------------------------------
  await runTest('T10: query short_url_clicks by country', async () => {
    const { ok, data } = await client.callTool('nevent_analytics_query', {
      collection: 'short_url_clicks',
      dimensions: [{ field: 'country' }],
      metrics: [{ field: 'id', operation: 'count', alias: 'clicks' }],
      sort: { field: 'clicks', order: 'desc' },
      limit: 10,
    });
    if (!ok) throw new Error(`Failed: ${JSON.stringify(data).slice(0, 200)}`);
    return 'OK';
  });

  // -----------------------------------------------------------------------
  // T11: No tech leaks in error messages
  // -----------------------------------------------------------------------
  await runTest('T11: error messages do not leak technology names', async () => {
    const { ok, raw } = await client.callTool('nevent_analytics_query', {
      collection: 'nonexistent_table',
      metrics: [{ field: 'id', operation: 'count' }],
    });
    // Should fail but not mention BigQuery/MongoDB
    const lower = raw.toLowerCase();
    if (lower.includes('bigquery')) throw new Error('Error message leaks "BigQuery"');
    if (lower.includes('mongodb')) throw new Error('Error message leaks "MongoDB"');
    if (lower.includes('mongo')) throw new Error('Error message leaks "Mongo"');
    return `Error returned without tech leaks (ok=${ok})`;
  });

  // -----------------------------------------------------------------------
  // T12: Filter values
  // -----------------------------------------------------------------------
  await runTest('T12: filter_values for campaigns', async () => {
    const { ok, data } = await client.callTool('nevent_analytics_filter_values', {
      collection: 'campaigns',
      filters: [{ field: 'status' }],
    });
    if (!ok) throw new Error(`Failed: ${JSON.stringify(data).slice(0, 200)}`);
    return 'OK';
  });

  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------
  client.kill();

  console.log('\n' + '='.repeat(60));
  console.log('📊 RESULTS\n');

  const pass = results.filter(r => r.status === 'PASS').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  const skip = results.filter(r => r.status === 'SKIP').length;

  for (const r of results) {
    const icon = r.status === 'PASS' ? '✅' : r.status === 'FAIL' ? '❌' : '⏭️';
    console.log(`${icon} ${r.name.padEnd(50)} ${r.durationMs}ms`);
    if (r.status === 'FAIL') {
      console.log(`   ${r.details}`);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
  console.log('='.repeat(60) + '\n');

  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
