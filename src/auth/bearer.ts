/**
 * `Authorization: Bearer <token>` parsing for the bearer-passthrough mode,
 * deliberately WITHOUT regular expressions: a header made of `bearer ` plus
 * thousands of spaces cannot make a regex backtrack, because there is no
 * regex. Linear in the header length, which is also hard-capped.
 *
 * @module auth/bearer
 */

/** Longest `Authorization` header value considered at all (a JWT is ~1-2 KB). */
export const MAX_AUTHORIZATION_HEADER_LENGTH = 8192;

/**
 * Extracts the token from an `Authorization` header value.
 *
 * Accepts the scheme `Bearer` in any letter case followed by a single token.
 * Returns `undefined` (never throws) when the header is not a string, is
 * longer than {@link MAX_AUTHORIZATION_HEADER_LENGTH}, uses another scheme,
 * carries an empty token, or the token contains whitespace.
 */
export function extractBearerToken(header: unknown): string | undefined {
  if (typeof header !== 'string' || header.length > MAX_AUTHORIZATION_HEADER_LENGTH) {
    return undefined;
  }
  if (header.slice(0, 7).toLowerCase() !== 'bearer ') {
    return undefined;
  }
  const token = header.slice(7).trim();
  if (token.length === 0) {
    return undefined;
  }
  for (let i = 0; i < token.length; i++) {
    const c = token.charCodeAt(i);
    // space, tab, CR, LF, VT, FF
    if (c === 0x20 || (c >= 0x09 && c <= 0x0d)) {
      return undefined;
    }
  }
  return token;
}
