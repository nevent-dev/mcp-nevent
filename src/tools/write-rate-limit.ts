/**
 * Per-principal hourly write limit for `bearer-passthrough` (NEV-1854).
 *
 * The write tools are reachable by a model acting for a person, so a runaway
 * or injected conversation must not be able to fire unbounded writes (sends,
 * campaigns, bulk short URLs). This module keeps a sliding one-hour window of
 * write calls per `tenantId:userId` and short-circuits a WRITE/DELETE tool
 * with a clear MCP error once the budget is spent. READ tools are never
 * counted or limited.
 *
 * A call is counted only when it is going to execute: invalid arguments are
 * rejected by the SDK before the handler, and a call the operation-mode guard
 * would reject is not counted either. A handler that runs and fails IS counted.
 *
 * The budget lives in the limiter instance (one per app), NOT in the MCP
 * session, so opening a new session does not reset it. It is in memory: a
 * restart resets it, and with several instances each has its own budget.
 * Rejected attempts do not extend the window.
 *
 * @module tools/write-rate-limit
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getToolOperationType, isOperationAllowed } from '../config/operation-mode.js';

/** Env var holding the max writes per principal per hour. */
export const WRITES_PER_HOUR_ENV = 'MCP_BEARER_PASSTHROUGH_WRITES_PER_HOUR';
/** Default budget when the env var is unset. */
export const DEFAULT_WRITES_PER_HOUR = 30;
const MAX_WRITES_PER_HOUR = 1000;
const HOUR_MS = 3_600_000;
/** Above this many tracked keys, fully expired keys are purged on access. */
const PURGE_THRESHOLD = 5_000;

/** Parses `MCP_BEARER_PASSTHROUGH_WRITES_PER_HOUR`; throws on invalid input. */
export function parseWritesPerHour(raw: string | undefined): number {
  const value = (raw ?? '').trim();
  if (value === '') return DEFAULT_WRITES_PER_HOUR;
  if (!/^\d{1,5}$/.test(value)) {
    throw new Error(`${WRITES_PER_HOUR_ENV} must be a positive integer.`);
  }
  const n = Number(value);
  if (n < 1 || n > MAX_WRITES_PER_HOUR) {
    throw new Error(`${WRITES_PER_HOUR_ENV} must be between 1 and ${MAX_WRITES_PER_HOUR}.`);
  }
  return n;
}

/** Collision-free limiter key for a tenant+user pair. */
export function writeLimitKey(tenantId: string, userId: string): string {
  return JSON.stringify([tenantId, userId]);
}

/** Result of {@link WriteRateLimiter.tryConsume}. */
export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/** Sliding-window counter keyed by an opaque string. */
export class WriteRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    readonly max: number,
    private readonly windowMs: number = HOUR_MS,
    private readonly now: () => number = Date.now
  ) {}

  /** Consumes one unit for `key` if available. */
  tryConsume(key: string): RateLimitResult {
    const now = this.now();
    if (this.hits.size > PURGE_THRESHOLD) this.purge(now);
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      const retryAfterMs = recent[0]! + this.windowMs - now;
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
    }
    recent.push(now);
    this.hits.set(key, recent);
    return { allowed: true };
  }

  /**
   * Starts a periodic purge of fully expired keys so idle principals do not
   * accumulate. The timer is unref'd (never keeps the process alive); call the
   * returned function to stop it.
   */
  startPurgeTimer(intervalMs: number = 600_000): () => void {
    const timer = setInterval(() => this.purge(this.now()), intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  /** Number of tracked keys (diagnostics/tests). */
  get size(): number {
    return this.hits.size;
  }

  private purge(now: number): void {
    for (const [k, ts] of this.hits) {
      if (ts.every((t) => now - t >= this.windowMs)) this.hits.delete(k);
    }
  }
}

/**
 * Wraps the handler of every WRITE/DELETE tool registered after this call so
 * it consumes one unit of `limiter` under `key` before running. READ and
 * unclassified tools pass through untouched (unclassified ones are denied by
 * the tool filter anyway). Must run before any `register*Tools()` call.
 *
 * Apply it AFTER `applyLoggingToServer` so a rate-limited call is still logged.
 */
export function applyWriteRateLimit(
  server: McpServer,
  limiter: WriteRateLimiter,
  key: string,
  willExecute: (toolName: string) => boolean = isOperationAllowed
): void {
  const originalTool = server.tool.bind(server);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).tool = (...args: any[]): unknown => {
    const toolName = args[0] as string;
    const last = args.length - 1;
    const handler = args[last] as (...a: unknown[]) => Promise<unknown>;
    const op = getToolOperationType(toolName);
    if (typeof handler !== 'function' || op === undefined || op === 'READ') {
      return (originalTool as (...a: unknown[]) => unknown)(...args);
    }
    const limited = async (...handlerArgs: unknown[]): Promise<unknown> => {
      // The operation-mode guard inside the handler will reject this call:
      // let it answer, and do not spend budget on a call that cannot execute.
      if (!willExecute(toolName)) return handler(...handlerArgs);
      const verdict = limiter.tryConsume(key);
      if (!verdict.allowed) {
        const envelope = {
          error: {
            type: 'invalid_request',
            code: 'write_rate_limit_exceeded',
            message:
              `Write limit reached: at most ${limiter.max} write operations per hour are allowed per user. ` +
              `Nothing was executed. Retry in about ${Math.ceil(verdict.retryAfterSeconds / 60)} minute(s).`,
          },
        };
        return { content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }], isError: true };
      }
      return handler(...handlerArgs);
    };
    const newArgs = [...args];
    newArgs[last] = limited;
    return (originalTool as (...a: unknown[]) => unknown)(...newArgs);
  };
}
