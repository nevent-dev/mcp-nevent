/**
 * Structured logger for the Nevent MCP Server.
 *
 * Wraps [Pino](https://getpino.io) with project-specific defaults:
 *
 * - **JSON in production** (`NODE_ENV=production`): every log line is a
 *   single-line JSON object compatible with CloudWatch, Datadog, and any
 *   log aggregation platform.
 * - **Pretty-print in development**: `pino-pretty` renders human-readable,
 *   colourised output with standard timestamps.
 * - **Structured metadata**: each log record includes `service`, `env`, and
 *   `version` fields for easy filtering and correlation.
 * - **Automatic redaction**: sensitive fields (`authorization`, `cookie`,
 *   `jwt`, `token`, `password`, `access_token`, `refresh_token`) are replaced
 *   with `[REDACTED]` before the record is written to any destination.
 *
 * ## Usage
 *
 * ```ts
 * import { logger } from './logger.js';
 *
 * logger.info('Server starting');
 * logger.info({ port: 3000 }, 'HTTP transport ready');
 * logger.warn({ sessionCount: 42 }, 'High session count');
 * logger.error({ err }, 'Unhandled error in POST /mcp');
 * ```
 *
 * ## Log levels
 *
 * | Level   | Production | Development |
 * |---------|-----------|-------------|
 * | trace   | hidden    | hidden      |
 * | debug   | hidden    | visible     |
 * | info    | visible   | visible     |
 * | warn    | visible   | visible     |
 * | error   | visible   | visible     |
 * | fatal   | visible   | visible     |
 *
 * Override via `LOG_LEVEL` environment variable.
 *
 * @module logger
 */

import pino from 'pino';

/** `true` when running in a production environment. */
const isProd = process.env['NODE_ENV'] === 'production';

/**
 * Active log level.
 *
 * Resolved in this order:
 * 1. `LOG_LEVEL` environment variable (any valid Pino level string)
 * 2. `info` in production
 * 3. `debug` in development
 */
const level = process.env['LOG_LEVEL'] ?? (isProd ? 'info' : 'debug');

/**
 * Shared Pino logger instance.
 *
 * All application code should import this singleton rather than creating
 * additional Pino instances so that the transport (pretty vs JSON) is
 * configured in a single place.
 */
export const logger = pino({
  level,

  // -------------------------------------------------------------------------
  // Base fields — included in every log record for easier filtering.
  // -------------------------------------------------------------------------
  base: {
    service: 'mcp-nevent',
    env: process.env['NODE_ENV'] ?? 'development',
    version: process.env['npm_package_version'],
  },

  // -------------------------------------------------------------------------
  // Redaction — prevents accidental leakage of credentials into log sinks.
  //
  // Paths use Pino's fast-redact syntax. The `*` prefix covers nested objects
  // one level deep (e.g. `req.headers.authorization`, `body.token`).
  // -------------------------------------------------------------------------
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'jwt',
      'token',
      'password',
      'access_token',
      'refresh_token',
      '*.jwt',
      '*.token',
      '*.access_token',
      '*.refresh_token',
    ],
    censor: '[REDACTED]',
  },

  // -------------------------------------------------------------------------
  // Timestamps — ISO-8601 strings for readability in both modes.
  // -------------------------------------------------------------------------
  timestamp: pino.stdTimeFunctions.isoTime,

  // -------------------------------------------------------------------------
  // Level formatter — emit the level label string (e.g. "info") instead of
  // the numeric code so log aggregators can filter by label without a lookup.
  // -------------------------------------------------------------------------
  formatters: {
    level: (label: string) => ({ level: label }),
  },

  // -------------------------------------------------------------------------
  // Transport — pino-pretty only in non-production environments.
  // In production, Pino writes JSON directly to stdout (no extra worker thread).
  // -------------------------------------------------------------------------
  ...(isProd
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            singleLine: false,
          },
        },
      }),
});

/** Convenience type alias for the shared logger instance. */
export type Logger = typeof logger;
