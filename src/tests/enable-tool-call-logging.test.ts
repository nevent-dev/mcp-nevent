/**
 * enableToolCallLogging option — NEV-1776 fix
 *
 * Verifies that the `enableToolCallLogging` flag on `createNeventServer` controls
 * whether a `ToolCallLogger` (and its underlying `MongoClient`) is ever created.
 *
 * ## Why this test exists
 *
 * The previous code in `server.ts` gated logger creation on `if (mongoUri)`.
 * Because anonymous discovery sessions pass `mongoUri: 'mongodb://stub'` (a
 * truthy string) so that tool METADATA is registered without real I/O, the
 * previous gate caused `createToolCallLogger('mongodb://stub')` + `warmUp()` to
 * fire on **every** anonymous `initialize` request. `warmUp()` is fire-and-forget
 * but still opens a `MongoClient` and triggers background DNS/connection retries
 * against the non-existent host, leaking resources per request.
 *
 * The fix adds an explicit `enableToolCallLogging?: boolean` option (default
 * `true`) and changes the gate to:
 *
 *   `if (mongoUri && enableToolCallLogging !== false)`
 *
 * Anonymous sessions in `http.ts` pass `enableToolCallLogging: false`, while
 * authenticated sessions omit it (defaulting to `true`).
 *
 * ## Test strategy
 *
 * We mock the `logging` module so that `createToolCallLogger` becomes a spy.
 * Each test calls `createNeventServer` and asserts whether the spy was or was not
 * invoked.  No real MongoDB connection is attempted in either path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module mock — intercept createToolCallLogger before server.ts imports it.
//
// vitest's module hoisting ensures this mock is applied before any `import`
// in the test file is resolved, matching the behaviour of Jest's `jest.mock`.
// ---------------------------------------------------------------------------
vi.mock('../tools/logging.js', () => {
  const mockWarmUp = vi.fn().mockResolvedValue(undefined);
  const mockLogToolCall = vi.fn();
  const mockClose = vi.fn().mockResolvedValue(undefined);

  const mockLogger = {
    warmUp: mockWarmUp,
    logToolCall: mockLogToolCall,
    close: mockClose,
  };

  return {
    createToolCallLogger: vi.fn().mockReturnValue(mockLogger),
    // applyLoggingToServer must be a no-op so we can test without patching
    // McpServer.tool() internals.
    applyLoggingToServer: vi.fn(),
    // Re-export unchanged utilities that other parts of the codebase reference
    redactSensitiveFields: (p: Record<string, unknown>) => p,
  };
});

import { createNeventServer } from '../server.js';
import { createToolCallLogger } from '../tools/logging.js';
import { DataClient } from '../clients/data-client.js';

// ---------------------------------------------------------------------------
// Shared stub helpers
// ---------------------------------------------------------------------------

/** Minimal stub DataClient that satisfies the TypeScript interface. */
function stubDataClient(): DataClient {
  return new DataClient({ baseUrl: 'http://stub.test', jwtToken: '' });
}

const STUB_MONGO_URI = 'mongodb://stub';
const REAL_MONGO_URI = 'mongodb://localhost:27017';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createNeventServer — enableToolCallLogging flag', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Anonymous path: enableToolCallLogging: false must suppress logger creation
  // -------------------------------------------------------------------------

  it('does NOT call createToolCallLogger when enableToolCallLogging is false (anonymous path)', () => {
    createNeventServer({
      dataClient: stubDataClient(),
      mongoUri: STUB_MONGO_URI,
      enableToolCallLogging: false,
    });

    expect(createToolCallLogger).not.toHaveBeenCalled();
  });

  it('does NOT call createToolCallLogger when both mongoUri and enableToolCallLogging:false are set', () => {
    // Regression guard: ensures the old `if (mongoUri)` gate is no longer
    // sufficient — the flag must also be checked.
    createNeventServer({
      dataClient: stubDataClient(),
      mongoUri: 'mongodb://stub',
      enableToolCallLogging: false,
    });

    expect(createToolCallLogger).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Authenticated path: logger must still be created when flag is omitted/true
  // -------------------------------------------------------------------------

  it('calls createToolCallLogger when mongoUri is set and enableToolCallLogging is omitted (default true)', () => {
    createNeventServer({
      dataClient: stubDataClient(),
      mongoUri: REAL_MONGO_URI,
      // enableToolCallLogging not provided — defaults to true
    });

    expect(createToolCallLogger).toHaveBeenCalledTimes(1);
    expect(createToolCallLogger).toHaveBeenCalledWith(REAL_MONGO_URI);
  });

  it('calls createToolCallLogger when mongoUri is set and enableToolCallLogging is explicitly true', () => {
    createNeventServer({
      dataClient: stubDataClient(),
      mongoUri: REAL_MONGO_URI,
      enableToolCallLogging: true,
    });

    expect(createToolCallLogger).toHaveBeenCalledTimes(1);
    expect(createToolCallLogger).toHaveBeenCalledWith(REAL_MONGO_URI);
  });

  // -------------------------------------------------------------------------
  // No mongoUri — logger must not be created regardless of flag
  // -------------------------------------------------------------------------

  it('does NOT call createToolCallLogger when mongoUri is absent (flag irrelevant)', () => {
    createNeventServer({
      dataClient: stubDataClient(),
      // mongoUri omitted
      enableToolCallLogging: true,
    });

    expect(createToolCallLogger).not.toHaveBeenCalled();
  });

  it('does NOT call createToolCallLogger when mongoUri is absent and flag is false', () => {
    createNeventServer({
      dataClient: stubDataClient(),
      // mongoUri omitted
      enableToolCallLogging: false,
    });

    expect(createToolCallLogger).not.toHaveBeenCalled();
  });
});
