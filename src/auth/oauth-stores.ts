/**
 * MongoDB-backed OAuth 2.1 stores for the Nevent MCP Server.
 *
 * Three stores are implemented:
 *
 * 1. `MongoClientStore`      — Persists registered OAuth clients (Dynamic Client
 *    Registration, RFC 7591). Collection: `oauth_clients`.
 *
 * 2. `MongoAuthCodeStore`    — Short-lived authorization codes (5-minute TTL
 *    enforced via MongoDB TTL index). Collection: `oauth_auth_codes`.
 *
 * 3. `MongoRefreshTokenStore` — Long-lived refresh tokens (30-day TTL).
 *    Collection: `oauth_refresh_tokens`.
 *
 * ## Token revocation design (stateless access tokens)
 *
 * Access tokens are short-lived stateless JWTs (1-hour expiry). We deliberately
 * do NOT store access tokens in MongoDB. This means:
 *   - No per-request database lookup for bearer token validation (JWT-only).
 *   - Access token revocation has up to a 1-hour window. This is an accepted
 *     trade-off: users who are logged out may continue to use the MCP server
 *     until their access token expires naturally.
 *   - Refresh tokens ARE stored in MongoDB and can be immediately revoked,
 *     which prevents new access tokens from being issued.
 *
 * Decision: Option A (stateless JWTs) was chosen over a Redis/MongoDB denylist
 * because the MCP server is primarily used interactively; a 1-hour revocation
 * window is acceptable for this use case.
 *
 * All collections live in the database referenced by `MONGODB_URI`. The
 * `initialize()` method creates TTL indexes on first startup; it is safe to
 * call repeatedly (MongoDB `createIndex` is idempotent).
 *
 * @module auth/oauth-stores
 */

import { Collection, Db, MongoClient } from 'mongodb';
import { logger } from '../logger.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';

// ---------------------------------------------------------------------------
// Document shapes
// ---------------------------------------------------------------------------

/** MongoDB document for a registered OAuth client. */
interface ClientDocument {
  client_id: string;
  client_id_issued_at: number;
  client_secret?: string;
  client_secret_expires_at?: number;
  redirect_uris: string[];
  grant_types?: string[];
  response_types?: string[];
  client_name?: string;
  client_uri?: string;
  token_endpoint_auth_method?: string;
  scope?: string;
  [key: string]: unknown;
}

/** MongoDB document for an authorization code. */
export interface AuthCodeDocument {
  /** The authorization code value. */
  code: string;
  /** Associated client ID. */
  clientId: string;
  /** PKCE code challenge (S256). */
  codeChallenge: string;
  /** Redirect URI used during the authorization request. */
  redirectUri: string;
  /** Requested scopes. */
  scopes: string[];
  /** Optional OAuth state parameter. */
  state?: string;
  /** Optional RFC 8707 resource indicator. */
  resource?: string;
  /** Sub (user identifier) for the authenticated Nevent user. */
  userId: string;
  /** User email from nev-api login response. */
  email: string;
  /** User role from nev-api login response (e.g. ADMIN, SUPERADMIN). */
  role: string;
  /** Tenant ID from nev-api login response. */
  tenantId: string;
  /**
   * The raw nev-api access_token received during login.
   * Stored here so it can be propagated to the refresh token document during
   * the code exchange, and later used to create per-session DataClients.
   */
  neventAccessToken?: string;
  /** Creation timestamp — used for TTL index (5-minute expiry). */
  createdAt: Date;
}

/** MongoDB document for a refresh token. */
export interface RefreshTokenDocument {
  /** The refresh token value. */
  token: string;
  /** Access token that was issued alongside this refresh token. */
  accessToken: string;
  /** Associated client ID. */
  clientId: string;
  /** Scopes granted to this token pair. */
  scopes: string[];
  /** Sub (user identifier). */
  userId: string;
  /** User email from nev-api login response. */
  email: string;
  /** User role from nev-api login response (e.g. ADMIN, SUPERADMIN). */
  role: string;
  /** Tenant ID from nev-api login response. */
  tenantId: string;
  /** Optional RFC 8707 resource indicator. */
  resource?: string;
  /**
   * The raw nev-api access_token for this user, carried forward from the
   * authorization code. Used to create per-session DataClients in HTTP mode
   * so that each session authenticates with the user's own token rather than
   * a shared service account token.
   */
  neventAccessToken?: string;
  /** Creation timestamp — used for TTL index (30-day expiry). */
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// MongoClientStore
// ---------------------------------------------------------------------------

/**
 * Persistent store for registered OAuth 2.1 clients.
 *
 * Implements `OAuthRegisteredClientsStore` from the MCP SDK so it can be
 * plugged directly into `OAuthServerProvider.clientsStore`.
 *
 * @example
 * ```ts
 * const store = new MongoClientStore(db);
 * await store.initialize();
 * const client = await store.getClient('my-client-id');
 * ```
 */
export class MongoClientStore implements OAuthRegisteredClientsStore {
  private collection: Collection<ClientDocument>;

  constructor(db: Db) {
    this.collection = db.collection<ClientDocument>('oauth_clients');
  }

  /**
   * Creates required MongoDB indexes. Safe to call on every startup.
   */
  async initialize(): Promise<void> {
    await this.collection.createIndex({ client_id: 1 }, { unique: true });
  }

  /**
   * Returns the full client information for the given client ID, or `undefined`
   * if not found.
   *
   * @param clientId - The client ID to look up.
   */
  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const doc = await this.collection.findOne({ client_id: clientId });
    if (!doc) return undefined;
    // Strip MongoDB's internal _id field
    const { _id, ...rest } = doc as ClientDocument & { _id: unknown };
    return rest as unknown as OAuthClientInformationFull;
  }

  /**
   * Persists a newly registered client document.
   *
   * @param client - Client metadata without `client_id` and `client_id_issued_at`
   *   (the SDK generates these before calling `registerClient`).
   */
  async registerClient(
    client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>
  ): Promise<OAuthClientInformationFull> {
    const now = Math.floor(Date.now() / 1000);
    const doc: ClientDocument = {
      ...(client as unknown as ClientDocument),
      client_id: (client as unknown as Record<string, string>)['client_id'] ?? crypto.randomUUID(),
      client_id_issued_at: now,
    };
    await this.collection.insertOne(doc);
    const { _id, ...result } = doc as ClientDocument & { _id: unknown };
    return result as unknown as OAuthClientInformationFull;
  }
}

// ---------------------------------------------------------------------------
// MongoAuthCodeStore
// ---------------------------------------------------------------------------

/**
 * Short-lived store for OAuth 2.1 authorization codes.
 *
 * A TTL index on `createdAt` ensures codes expire automatically after
 * 5 minutes — even if the application crashes mid-flow.
 *
 * @example
 * ```ts
 * const store = new MongoAuthCodeStore(db);
 * await store.initialize();
 * await store.save({ code: 'abc', clientId: '...', ... });
 * const codeData = await store.find('abc');
 * ```
 */
export class MongoAuthCodeStore {
  private collection: Collection<AuthCodeDocument>;

  constructor(db: Db) {
    this.collection = db.collection<AuthCodeDocument>('oauth_auth_codes');
  }

  /**
   * Creates the TTL index (5-minute expiry) and a unique index on `code`.
   * Idempotent — safe to call on every startup.
   */
  async initialize(): Promise<void> {
    await this.collection.createIndex({ code: 1 }, { unique: true });
    // MongoDB TTL: documents expire 300 seconds (5 min) after `createdAt`
    await this.collection.createIndex({ createdAt: 1 }, { expireAfterSeconds: 300 });
  }

  /**
   * Saves a new authorization code document.
   *
   * @param doc - Full authorization code document (caller generates the code).
   */
  async save(doc: AuthCodeDocument): Promise<void> {
    await this.collection.insertOne(doc);
  }

  /**
   * Retrieves an authorization code document without deleting it.
   *
   * @param code - The authorization code string.
   */
  async find(code: string): Promise<AuthCodeDocument | undefined> {
    const doc = await this.collection.findOne({ code });
    return doc ?? undefined;
  }

  /**
   * Deletes an authorization code (single-use enforcement).
   *
   * @param code - The authorization code string to delete.
   */
  async consume(code: string): Promise<void> {
    await this.collection.deleteOne({ code });
  }
}

// ---------------------------------------------------------------------------
// MongoRefreshTokenStore
// ---------------------------------------------------------------------------

/**
 * Persistent store for OAuth 2.1 refresh tokens.
 *
 * A TTL index expires tokens after 30 days. Revocation is also supported via
 * the `consume()` method (hard delete).
 *
 * @example
 * ```ts
 * const store = new MongoRefreshTokenStore(db);
 * await store.initialize();
 * ```
 */
export class MongoRefreshTokenStore {
  private collection: Collection<RefreshTokenDocument>;

  constructor(db: Db) {
    this.collection = db.collection<RefreshTokenDocument>('oauth_refresh_tokens');
  }

  /**
   * Creates indexes. Idempotent — safe to call on every startup.
   */
  async initialize(): Promise<void> {
    await this.collection.createIndex({ token: 1 }, { unique: true });
    // 30-day TTL for refresh tokens
    await this.collection.createIndex({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });
  }

  /**
   * Saves a new refresh token document.
   *
   * @param doc - Full refresh token document.
   */
  async save(doc: RefreshTokenDocument): Promise<void> {
    await this.collection.insertOne(doc);
  }

  /**
   * Retrieves a refresh token document.
   *
   * @param token - The refresh token string.
   */
  async find(token: string): Promise<RefreshTokenDocument | undefined> {
    const doc = await this.collection.findOne({ token });
    return doc ?? undefined;
  }

  /**
   * Deletes a refresh token (called after exchange for a new access token).
   *
   * @param token - The refresh token to delete.
   */
  async consume(token: string): Promise<void> {
    await this.collection.deleteOne({ token });
  }

  /**
   * Returns the nev-api access_token stored alongside the most recently
   * issued refresh token for a given userId.
   *
   * Used by the HTTP transport to resolve the per-user DataClient token
   * when initializing a new MCP session.
   *
   * @param userId - The Nevent user identifier (JWT `sub` claim).
   * @returns The `neventAccessToken` string, or `undefined` if not found.
   */
  async findNeventAccessTokenByUserId(userId: string): Promise<string | undefined> {
    const doc = await this.collection.findOne(
      { userId, neventAccessToken: { $exists: true } },
      { sort: { createdAt: -1 } } // Most recently issued token wins
    );
    return doc?.neventAccessToken ?? undefined;
  }
}

// ---------------------------------------------------------------------------
// Store container + MongoDB lifecycle
// ---------------------------------------------------------------------------

/** All OAuth stores bundled together for convenient dependency injection. */
export interface OAuthStores {
  clients: MongoClientStore;
  authCodes: MongoAuthCodeStore;
  refreshTokens: MongoRefreshTokenStore;
  /** Underlying Mongo client — caller can call .close() on shutdown. */
  mongoClient: MongoClient;
}

/**
 * Connects to MongoDB, creates all store instances, and runs `initialize()`
 * on each store to ensure indexes exist.
 *
 * Connection options include timeouts and pool sizing appropriate for
 * production use. Values are conservative to fail fast on connection issues.
 *
 * @param mongoUri - MongoDB connection URI (must be set in `MONGODB_URI`).
 * @returns Ready-to-use stores and the underlying MongoClient.
 *
 * @throws Will throw if the MongoDB connection fails.
 */
export async function createOAuthStores(mongoUri: string): Promise<OAuthStores> {
  const mongoClient = new MongoClient(mongoUri, {
    connectTimeoutMS: 10000,
    serverSelectionTimeoutMS: 10000,
    maxPoolSize: 10,
  });
  await mongoClient.connect();
  const db = mongoClient.db();

  const clients = new MongoClientStore(db);
  const authCodes = new MongoAuthCodeStore(db);
  const refreshTokens = new MongoRefreshTokenStore(db);

  // Initialize indexes in parallel
  await Promise.all([
    clients.initialize(),
    authCodes.initialize(),
    refreshTokens.initialize(),
  ]);

  logger.info('OAuth MongoDB stores initialized');

  return { clients, authCodes, refreshTokens, mongoClient };
}
