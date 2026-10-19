/**
 * Shared test helpers: real host and apps servers over an in-memory store,
 * plus small HTTP clients for GraphQL, browser sessions, raw requests and
 * SSE streams, a response double for the event hub, and ways to act as any
 * seeded user (`sessionFor`, `tokenFor`, `as`).
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { request as httpRequest } from "node:http";
import { ALL_SCOPES } from "../server/auth.js";
import { startServers } from "../server/http.js";
import { createStore } from "../server/store.js";
import { renderText } from "../server/store/activity.js";

/**
 * A stored rich text (notification `text`, activity `from_text`/`to_text`)
 * as a viewer who sees everyone reads it.
 */
export const plainText = (store, text) =>
  renderText(text, (id) => store.getUser(id)?.name ?? "Someone");

/** A stored activity entry with its texts rendered (`plainText`). */
export const plainEntry = (store, entry) => ({
  ...entry,
  actor_label:
    entry.actor_id === null
      ? entry.actor_label
      : plainText(store, [{ user_id: entry.actor_id }]),
  from_text: plainText(store, entry.from_text),
  to_text: plainText(store, entry.to_text),
});

/** A logger that records instead of printing. */
export function recordingLog() {
  const entries = [];
  const record =
    (level) =>
    (...args) =>
      entries.push({ level, args });
  return {
    entries,
    error: record("error"),
    warn: record("warn"),
    info: record("info"),
    log: record("log"),
  };
}

/**
 * A view of `store` that also knows the API token `record`
 * (`{ token, user_id, scopes, label }`), for scopes no seeded token has.
 */
export function storeWithToken(store, record) {
  const { view, add } = storeWithExtraTokens(store);
  add(record);
  return view;
}

/** First-name keys of the seeded users (SPEC-2 §2.1). */
export const SEED_USERS = Object.freeze([
  "alex",
  "sam",
  "noa",
  "priya",
  "jordan",
  "chris",
  "morgan",
]);

/**
 * The seed's effective access roles (SPEC-2 §1.2 and §2.1) for the active
 * users in SEED_USERS order (Morgan, deactivated, has none): "-" means no
 * access. Forms take the role of their board.
 */
const SEED_ROLE_TABLE = Object.freeze({
  workspace: {
    main: "owner editor editor editor viewer -",
    leadership: "owner - - - - -",
  },
  board: {
    roadmap: "owner editor editor editor viewer -",
    marketing: "- - - owner - editor",
    hiring: "owner - editor - - -",
    budget: "owner - - - - -",
  },
  doc: {
    vision: "owner editor editor editor viewer -",
    brief: "- editor - owner - viewer",
    offsite: "owner - - - - -",
  },
  note: {
    ideas: "owner - - - - -",
    oneOnOne: "owner viewer - - - -",
    crit: "- owner - - - -",
    checklist: "- editor - owner - -",
  },
});

/** The seeded role of `user` (a SEED_USERS key) on `kind`/`key`, or null. */
export function seedRole(kind, key, user) {
  if (user === "morgan") return null;
  const role = SEED_ROLE_TABLE[kind][key].split(" ")[SEED_USERS.indexOf(user)];
  return role === "-" ? null : role;
}

/** The resource keys of `kind` in the seed role table. */
export const seedKeys = (kind) => Object.keys(SEED_ROLE_TABLE[kind]);

const ID_GROUPS = Object.freeze({
  workspace: "workspaces",
  board: "boards",
  doc: "docs",
  note: "notes",
});

/** `{ [id]: role }` of the seeded `kind` resources `user` can reach. */
export function seedRoleMap(ids, kind, user) {
  const entries = seedKeys(kind).flatMap((key) => {
    const role = seedRole(kind, key, user);
    return role === null ? [] : [[ids[ID_GROUPS[kind]][key], role]];
  });
  return Object.fromEntries(entries);
}

const RANK = Object.freeze({ viewer: 1, editor: 2, owner: 3 });

/**
 * The error code SPEC-2 §1.2 requires for an action needing `minRole` from
 * a user holding `role`: NOT_FOUND without access, FORBIDDEN below
 * `minRole`, null (success) otherwise.
 */
export function expectedCode(role, minRole) {
  if (role === null) return "NOT_FOUND";
  return RANK[role] >= RANK[minRole] ? null : "FORBIDDEN";
}

const firstName = (record) => record.name.split(" ")[0].toLowerCase();
const byName = (records, names) =>
  Object.fromEntries(
    Object.entries(names).map(([key, name]) => [
      key,
      records.find((record) => (record.name ?? record.title) === name)?.id,
    ]),
  );

/**
 * Seeded record IDs by short key, looked up by name: `users` (first
 * names), `teams`, `workspaces`, `boards` (roadmap, marketing, hiring,
 * budget), `docs` (vision, brief, offsite), `notes` (ideas, oneOnOne,
 * crit, checklist) and `forms` (feature, campaign).
 */
export function seedIds(store) {
  return {
    users: Object.fromEntries(
      store.listUsers().map((user) => [firstName(user), user.id]),
    ),
    teams: Object.fromEntries(
      store.listTeams().map((team) => [team.name.toLowerCase(), team.id]),
    ),
    workspaces: byName(store.listWorkspaces(), {
      main: "Main space",
      leadership: "Leadership",
    }),
    boards: byName(store.listBoards({ limit: 1000 }), {
      roadmap: "Product roadmap",
      marketing: "Marketing launch",
      hiring: "Hiring plan",
      budget: "Budget 2027",
    }),
    docs: byName(store.listDocs(), {
      vision: "Product vision",
      brief: "Launch brief",
      offsite: "Leadership offsite",
    }),
    notes: byName(store.listNotes(), {
      ideas: "Ideas for Q1",
      oneOnOne: "1:1 with Sam",
      crit: "Design crit notes",
      checklist: "Launch checklist",
    }),
    forms: byName(store.listForms(), {
      feature: "Feature request",
      campaign: "Campaign intake",
    }),
  };
}

/**
 * A view of `store` whose `findApiToken` also knows the tokens added with
 * the returned `add(record)`.
 */
function storeWithExtraTokens(store) {
  const extra = new Map();
  const findApiToken = (token) => extra.get(token) ?? store.findApiToken(token);
  const view = Object.freeze({ ...store, findApiToken });
  return { view, add: (record) => extra.set(record.token, record) };
}

/**
 * Starts both servers on free ports over a fresh in-memory store (or
 * `options.store`). Other options are passed to `startServers`.
 *
 * Besides URLs, the store and the seeded tokens, the result can act as any
 * user: `sessionFor(userId)` → `{ Cookie, Origin }` headers of a new
 * browser session, `tokenFor(userId, scopes = ALL_SCOPES)` → a new API
 * token, and `as(userId)` → an `apiClient` over a new session. `ids`
 * holds the seeded IDs (`seedIds`).
 * @returns {Promise<{ hostUrl, appsUrl, hostOrigin, appsOrigin, store, auth,
 *   tokens: { readWrite, readOnly }, ids, sessionFor, tokenFor, as, log,
 *   close(): Promise<void> }>}
 */
export async function startTestServers(options = {}) {
  const log = options.log ?? recordingLog();
  const base = options.store ?? (await createStore({ file: null, log }));
  const { view: store, add } = storeWithExtraTokens(base);
  const servers = await startServers({
    hostPort: 0,
    appsPort: 0,
    ...options,
    store,
    log,
  });
  const tokens = store.listApiTokens();
  const token = (label) =>
    tokens.find((record) => record.label === label).token;
  const { hostOrigin } = servers;
  const sessionFor = (userId) => {
    const id = servers.auth.createBrowserSession(userId);
    return { Cookie: `mm_session=${id}`, Origin: hostOrigin };
  };
  const tokenFor = (userId, scopes = ALL_SCOPES) => {
    const record = { token: randomBytes(32).toString("base64url") };
    add({ ...record, user_id: userId, scopes: [...scopes], label: "test" });
    return record.token;
  };
  const as = (userId) => apiClient(hostOrigin, { headers: sessionFor(userId) });
  return {
    hostUrl: hostOrigin,
    appsUrl: servers.appsOrigin,
    hostOrigin,
    appsOrigin: servers.appsOrigin,
    store,
    auth: servers.auth,
    tokens: { readWrite: token("read-write"), readOnly: token("read-only") },
    ids: seedIds(store),
    sessionFor,
    tokenFor,
    as,
    log,
    close: () => servers.close(),
  };
}

async function readResponse(response) {
  const text = await response.text();
  const type = response.headers.get("content-type") ?? "";
  if (!type.startsWith("application/json")) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * POSTs a GraphQL request to `<hostUrl>/v2`. `token` becomes a Bearer
 * Authorization header and `apiVersion` the API-Version header.
 * @returns {Promise<{ status: number, headers: Headers, body: unknown }>}
 */
export async function gql(
  hostUrl,
  { query, variables, operationName, token, apiVersion, headers = {} } = {},
) {
  const sent = { "Content-Type": "application/json" };
  if (token !== undefined) sent.Authorization = `Bearer ${token}`;
  if (apiVersion !== undefined) sent["API-Version"] = apiVersion;
  const response = await fetch(new URL("/v2", hostUrl), {
    method: "POST",
    headers: { ...sent, ...headers },
    body: JSON.stringify({ query, variables, operationName }),
  });
  const body = await readResponse(response);
  return { status: response.status, headers: response.headers, body };
}

/**
 * A GraphQL client with fixed credentials (`headers` and/or `token`):
 * - `call(query, variables)` → `{ status, headers, body }`;
 * - `data(query, variables)` asserts a 200 without errors, returns `data`;
 * - `code(query, variables)` → the first error code, or null;
 * - `error(query, variables)` → the first error object, or null.
 */
export function apiClient(hostUrl, { headers = {}, token } = {}) {
  const call = (query, variables) =>
    gql(hostUrl, { query, variables, headers, token });
  const first = async (query, variables) =>
    (await call(query, variables)).body.errors?.[0] ?? null;
  return {
    headers,
    call,
    async data(query, variables) {
      const { status, body } = await call(query, variables);
      assert.equal(status, 200, JSON.stringify(body));
      assert.equal(body.errors, undefined, JSON.stringify(body.errors));
      return body.data;
    },
    error: first,
    code: async (query, variables) =>
      (await first(query, variables))?.extensions.code ?? null,
  };
}

/**
 * Opens the boards app (`GET /`) like a new browser and returns headers for
 * same-origin API calls: `{ Cookie, Origin }`.
 */
export async function browserSession(hostUrl) {
  const response = await fetch(new URL("/", hostUrl));
  await response.arrayBuffer();
  const cookie = response.headers.get("set-cookie") ?? "";
  const [pair] = cookie.split(";");
  return { Cookie: pair, Origin: new URL(hostUrl).origin };
}

/**
 * Sends one raw HTTP/1.1 request with node:http, so tests control the exact
 * target (no URL normalization) and headers such as Host.
 * @returns {Promise<{ status: number, headers: object, body: string }>}
 */
export function rawRequest(baseUrl, { method = "GET", path, headers, body }) {
  const url = new URL(baseUrl);
  // The servers listen on 127.0.0.1; "localhost" stays in the Host header.
  const hostname = url.hostname === "localhost" ? "127.0.0.1" : url.hostname;
  const sent = { Host: url.host, ...headers };
  return new Promise((resolve, reject) => {
    const options = { hostname, port: url.port, method, path, headers: sent };
    const req = httpRequest(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode, headers: res.headers, body: text });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  });
}

/**
 * Opens an SSE stream with fetch. `next(pattern)` reads until `pattern`
 * matches the unread text, consumes through the match and returns it;
 * `ends()` reads until the server ends the stream and returns the text
 * that was still unread. Both fail after `timeoutMs`.
 */
export async function openStream(url, headers = {}) {
  const controller = new AbortController();
  const response = await fetch(url, { headers, signal: controller.signal });
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let unread = "";
  let ended = false;
  // A read that lost a race against the timeout is kept for the next call.
  let pending = null;
  /** Reads one chunk into `unread` (or notes the end) before `deadline`. */
  const read = async (deadline, waitingFor) => {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`timed out waiting for ${waitingFor}`);
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(resolve, left, null);
    });
    pending ??= reader.read();
    const chunk = await Promise.race([pending, timeout]);
    clearTimeout(timer);
    if (chunk === null) return;
    pending = null;
    if (chunk.done) ended = true;
    else unread += decoder.decode(chunk.value, { stream: true });
  };
  const next = async (pattern, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const match = pattern.exec(unread);
      if (match) {
        unread = unread.slice(match.index + match[0].length);
        return match;
      }
      if (ended) throw new Error(`stream ended before ${pattern}`);
      await read(deadline, pattern);
    }
  };
  const ends = async (timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    while (!ended) await read(deadline, "the end of the stream");
    return unread;
  };
  return { response, next, ends, close: () => controller.abort() };
}

/** A minimal response double that records writes (and an ended `body`). */
export function fakeResponse() {
  const res = new EventEmitter();
  Object.assign(res, { writableLength: 0, writes: [], destroyed: false });
  res.writableEnded = false;
  res.writeHead = (status, headers) => Object.assign(res, { status, headers });
  res.flushHeaders = () => {};
  res.write = (text) => res.writes.push(text);
  res.end = (body) => {
    if (body !== undefined) res.body = body;
    res.writableEnded = true;
  };
  res.destroy = () => (res.destroyed = true);
  return res;
}
