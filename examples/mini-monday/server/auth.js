/**
 * Authentication: API tokens, browser sessions, app principals and the HS256
 * session tokens (JWT) that iframe apps hand to their own backends.
 *
 * Principal = { kind: "token" | "session" | "app", userId, role, scopes: Set,
 *               installId?, appId? }
 *
 * Principals are built per request from the current user record, so role
 * changes apply at once, and a deactivated user's tokens and sessions stop
 * working immediately (their sessions are also dropped, so reactivation
 * does not revive them). Apps installed on boards the user cannot access
 * are treated as unknown installs (`server/access.js` decides access).
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { boardAccess, isActive, isAdmin } from "./access.js";

/** Every scope a principal can hold. */
export const ALL_SCOPES = Object.freeze([
  "boards:read",
  "boards:write",
  "storage:read",
  "storage:write",
]);

const ISSUER = "mini-monday";
const MAX_JWT_LENGTH = 8192;
const JWT_PATTERN = /^([\w-]+)\.([\w-]+)\.([\w-]*)$/;
const API_TOKEN_PATTERN = /^[\w-]{1,512}$/;
const BEARER_PATTERN = /^Bearer\s+(\S+)$/i;
const SESSION_ID_PATTERN = /^[\w-]{43}$/;
// Browser sessions are an in-memory demo convenience: they expire after a
// day without use and the table is capped so anonymous page loads (demo
// auto-login) cannot grow it without bound.
const SESSION_IDLE_MS = 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 10_000;
const MAX_SESSION_TOKEN_TTL_SECONDS = 3600;

const isPlainObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeJson(segment) {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

const JWT_HEADER = encodeJson({ alg: "HS256", typ: "JWT" });

function assertSecret(secret) {
  const valid =
    (typeof secret === "string" || secret instanceof Uint8Array) &&
    secret.length > 0;
  if (!valid) {
    throw new TypeError("JWT secret must be a non-empty string or buffer");
  }
}

function hmac(input, secret) {
  return createHmac("sha256", secret).update(input).digest("base64url");
}

/** Compares the encoded signature text, so non-canonical encodings fail. */
function signatureMatches(input, provided, secret) {
  const expected = Buffer.from(hmac(input, secret), "utf8");
  const actual = Buffer.from(provided, "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function audienceMatches(aud, audience) {
  return aud === audience || (Array.isArray(aud) && aud.includes(audience));
}

/**
 * Signs `payload` as an HS256 JWT (base64url segments, header
 * `{ alg: "HS256", typ: "JWT" }`).
 */
export function signJwt(payload, secret) {
  if (!isPlainObject(payload)) {
    throw new TypeError("JWT payload must be a plain object");
  }
  assertSecret(secret);
  const input = `${JWT_HEADER}.${encodeJson(payload)}`;
  return `${input}.${hmac(input, secret)}`;
}

/**
 * Verifies an HS256 JWT. Only `alg: "HS256"` is accepted, the signature is
 * compared with `crypto.timingSafeEqual`, a numeric `exp` is required and
 * `aud` must match `audience` when one is given.
 * @returns {{ ok: true, payload: object } | { ok: false, reason:
 *   "malformed" | "algorithm" | "signature" | "expired" | "audience" }}
 */
export function verifyJwt(token, secret, { now = Date.now(), audience } = {}) {
  assertSecret(secret);
  if (!Number.isFinite(now)) throw new TypeError("now must be a number");
  const reject = (reason) => ({ ok: false, reason });
  const parts =
    typeof token === "string" && token.length <= MAX_JWT_LENGTH
      ? JWT_PATTERN.exec(token)
      : null;
  if (!parts) return reject("malformed");
  const header = decodeJson(parts[1]);
  if (!isPlainObject(header)) return reject("malformed");
  if (header.alg !== "HS256") return reject("algorithm");
  if (!signatureMatches(`${parts[1]}.${parts[2]}`, parts[3], secret)) {
    return reject("signature");
  }
  const payload = decodeJson(parts[2]);
  if (!isPlainObject(payload) || !Number.isFinite(payload.exp)) {
    return reject("malformed");
  }
  if (now >= payload.exp * 1000) return reject("expired");
  if (audience !== undefined && !audienceMatches(payload.aud, audience)) {
    return reject("audience");
  }
  return { ok: true, payload };
}

function knownScopes(scopes) {
  return new Set(ALL_SCOPES.filter((scope) => scopes.includes(scope)));
}

/** The current user record when it exists and is active, else null. */
function activeUser(store, userId) {
  const user = store.getUser(userId);
  return isActive(user) ? user : null;
}

function tokenPrincipal(store, authorizationHeader) {
  if (typeof authorizationHeader !== "string") return null;
  const raw = authorizationHeader.trim();
  const token = BEARER_PATTERN.exec(raw)?.[1] ?? raw;
  if (!API_TOKEN_PATTERN.test(token)) return null;
  const record = store.findApiToken(token);
  const user = record ? activeUser(store, record.user_id) : null;
  if (!user) return null;
  return {
    kind: "token",
    userId: user.id,
    role: user.role,
    scopes: knownScopes(record.scopes),
  };
}

const validSessionId = (sessionId) =>
  typeof sessionId === "string" && SESSION_ID_PATTERN.test(sessionId);

function createSessionTable(store, now) {
  // Map order is least recently used first; every use moves an entry to the
  // end, so expired entries always sit at the front.
  const sessions = new Map();
  const prune = () => {
    for (const [id, entry] of sessions) {
      if (entry.expiresAt > now() && sessions.size < MAX_SESSIONS) break;
      sessions.delete(id);
    }
  };
  const create = (userId) => {
    if (!activeUser(store, userId)) {
      throw new TypeError("Unknown or deactivated user");
    }
    prune();
    const id = randomBytes(32).toString("base64url");
    sessions.set(id, { userId, expiresAt: now() + SESSION_IDLE_MS });
    return id;
  };
  return {
    create,
    get(sessionId) {
      if (!validSessionId(sessionId)) return null;
      const entry = sessions.get(sessionId);
      if (!entry) return null;
      sessions.delete(sessionId);
      const user = activeUser(store, entry.userId);
      if (entry.expiresAt <= now() || !user) return null;
      sessions.set(sessionId, { ...entry, expiresAt: now() + SESSION_IDLE_MS });
      return {
        kind: "session",
        userId: user.id,
        role: user.role,
        scopes: new Set(ALL_SCOPES),
      };
    },
    /**
     * Ends `sessionId` and starts a session for `userId` (demo user
     * switching). An unknown or deactivated target → null, and the current
     * session stays as it was.
     */
    rotate(sessionId, userId) {
      if (!activeUser(store, userId)) return null;
      if (validSessionId(sessionId)) sessions.delete(sessionId);
      return create(userId);
    },
    end(sessionId) {
      return validSessionId(sessionId) && sessions.delete(sessionId);
    },
    /** Drops every session of `userId` (deactivation). */
    revokeUser(userId) {
      for (const [id, entry] of sessions) {
        if (entry.userId === userId) sessions.delete(id);
      }
    },
  };
}

/** The install and app when both exist and the user can see the board. */
function reachableInstall(store, user, installId) {
  const install = store.getInstall(installId);
  const app = install ? store.getApp(install.app_id) : null;
  if (!app || !user) return null;
  const board = store.getBoard(install.board_id);
  return boardAccess(store, user, board) === null ? null : { install, app };
}

function appPrincipal(store, userPrincipal, installId) {
  const isUser =
    (userPrincipal?.kind === "token" || userPrincipal?.kind === "session") &&
    userPrincipal.scopes instanceof Set;
  if (!isUser) {
    throw new TypeError("appPrincipal needs a token or session principal");
  }
  const user = activeUser(store, userPrincipal.userId);
  const found = reachableInstall(store, user, installId);
  if (!found) return null;
  const { install, app } = found;
  return {
    kind: "app",
    userId: user.id,
    role: user.role,
    scopes: new Set(app.scopes.filter((s) => userPrincipal.scopes.has(s))),
    installId: install.id,
    appId: app.id,
  };
}

function issueSessionToken(store, now, options = {}) {
  const { userId, installId, ttlSeconds = 300 } = options;
  const validTtl =
    Number.isSafeInteger(ttlSeconds) &&
    ttlSeconds >= 1 &&
    ttlSeconds <= MAX_SESSION_TOKEN_TTL_SECONDS;
  if (!validTtl) {
    throw new TypeError(
      `ttlSeconds must be an integer from 1 to ${MAX_SESSION_TOKEN_TTL_SECONDS}`,
    );
  }
  const user = activeUser(store, userId);
  const found = reachableInstall(store, user, installId);
  if (!found) return null;
  const { install, app } = found;
  const iat = Math.floor(now() / 1000);
  const exp = iat + ttlSeconds;
  const payload = {
    iss: ISSUER,
    aud: app.client_id,
    sub: user.id,
    iat,
    exp,
    dat: {
      client_id: app.client_id,
      user_id: user.id,
      account_id: "1",
      app_id: app.id,
      install_id: install.id,
      board_id: install.board_id,
      is_admin: isAdmin(user),
    },
  };
  return {
    token: signJwt(payload, app.client_secret),
    expires_at: new Date(exp * 1000).toISOString(),
  };
}

/**
 * Creates the authentication service over `store`. `now` returns epoch
 * milliseconds.
 *
 * - `authenticateApiToken(header)` accepts a raw token or `Bearer <token>`.
 * - `createBrowserSession(userId)` returns a random 32-byte base64url ID
 *   (TypeError for unknown or deactivated users).
 * - `getBrowserSession(id)` resolves the session's user on every call.
 * - `rotateBrowserSession(id, userId)` replaces a session with a new one
 *   for an active `userId` (null otherwise, keeping the old session).
 * - `endBrowserSession(id)` signs out; true when a session ended.
 * - `appPrincipal(principal, installId)` intersects the user's scopes with
 *   the app's scopes; null when the install is unknown or on a board the
 *   user cannot access.
 * - `issueSessionToken({ userId, installId, ttlSeconds = 300 })` returns
 *   `{ token, expires_at }`, or null when the user or install is unknown
 *   (or unreachable, as above).
 */
export function createAuth({ store, now = () => Date.now() } = {}) {
  if (typeof store?.getUser !== "function") {
    throw new TypeError("createAuth requires a store");
  }
  const sessions = createSessionTable(store, now);
  store.on?.((event) => {
    if (event.type !== "user_updated") return;
    for (const id of event.user_ids ?? []) {
      if (!activeUser(store, id)) sessions.revokeUser(id);
    }
  });
  return Object.freeze({
    authenticateApiToken: (header) => tokenPrincipal(store, header),
    createBrowserSession: (userId) => sessions.create(userId),
    getBrowserSession: (sessionId) => sessions.get(sessionId),
    rotateBrowserSession: (sessionId, userId) =>
      sessions.rotate(sessionId, userId),
    endBrowserSession: (sessionId) => sessions.end(sessionId),
    appPrincipal: (principal, installId) =>
      appPrincipal(store, principal, installId),
    issueSessionToken: (options) => issueSessionToken(store, now, options),
  });
}
