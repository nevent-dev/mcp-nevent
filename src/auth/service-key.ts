/**
 * Shared service key for the `bearer-passthrough` HTTP auth mode.
 *
 * bearer-passthrough is reachable from outside any private network, and the
 * user's nev-api JWT alone only proves WHO the end user is, not that the
 * caller is a client Nevent authorised (today: `nev-helpbot`). Every request
 * must therefore also carry a pre-shared secret in {@link SERVICE_KEY_HEADER}.
 * It is checked BEFORE the token is introspected against nev-api, so
 * outsiders cannot make this server hammer nev-api.
 *
 * ## Rotation
 *
 * Two keys are accepted at once: the current one
 * (`MCP_BEARER_PASSTHROUGH_SERVICE_KEY`, required) and an optional previous
 * one (`MCP_BEARER_PASSTHROUGH_SERVICE_KEY_PREVIOUS`). To rotate: deploy the
 * server with new = current and old = previous, move the client to the new
 * key, then drop the previous one.
 *
 * ## Comparison
 *
 * Candidate and configured keys are hashed with SHA-256 and the digests are
 * compared with `crypto.timingSafeEqual`: constant length (no length oracle)
 * and constant time. All configured keys are always compared (no early exit).
 *
 * @module auth/service-key
 */

import { createHash, timingSafeEqual } from 'node:crypto';

/** HTTP header carrying the service key. */
export const SERVICE_KEY_HEADER = 'x-nevent-service-key';

/** Env var holding the current service key. */
export const SERVICE_KEY_ENV = 'MCP_BEARER_PASSTHROUGH_SERVICE_KEY';

/** Env var holding the previous service key (rotation window only). */
export const SERVICE_KEY_PREVIOUS_ENV = 'MCP_BEARER_PASSTHROUGH_SERVICE_KEY_PREVIOUS';

/** Minimum accepted length of a service key (e.g. `openssl rand -hex 32` is 64). */
export const MIN_SERVICE_KEY_LENGTH = 32;

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Validates and normalises the configured keys. Throws with an actionable
 * message (never containing a key) when none is configured or one is too
 * short; callers treat that as a fatal startup error.
 *
 * @param current  — current key (required).
 * @param previous — previous key, accepted during rotation (optional).
 * @returns the list of configured keys, current first.
 */
export function parseServiceKeys(current: string | undefined, previous?: string): string[] {
  const cur = current?.trim();
  if (!cur) {
    throw new Error(
      `${SERVICE_KEY_ENV} is required in bearer-passthrough mode (min ${MIN_SERVICE_KEY_LENGTH} chars, e.g. \`openssl rand -hex 32\`).`
    );
  }
  const keys = [cur];
  const prev = previous?.trim();
  if (prev) keys.push(prev);
  for (const [i, key] of keys.entries()) {
    if (key.length < MIN_SERVICE_KEY_LENGTH) {
      throw new Error(
        `${i === 0 ? SERVICE_KEY_ENV : SERVICE_KEY_PREVIOUS_ENV} is too short (min ${MIN_SERVICE_KEY_LENGTH} chars).`
      );
    }
  }
  return keys;
}

/**
 * Returns `true` when `candidate` equals one of `configuredKeys`, in constant
 * time with respect to the key contents and without short-circuiting.
 */
export function isValidServiceKey(candidate: string | string[] | undefined, configuredKeys: readonly string[]): boolean {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  const candidateDigest = digest(candidate);
  let ok = false;
  for (const key of configuredKeys) {
    if (timingSafeEqual(candidateDigest, digest(key))) ok = true;
  }
  return ok;
}
