/**
 * Host-app HTTP client: GraphQL over `POST /v2`, app session tokens, the
 * server-sent event streams, the demo sign-in routes and other JSON routes
 * (`requestJson`, e.g. the importer's). Every request is
 * same-origin and authenticated by the HttpOnly session cookie; nothing here
 * stores credentials.
 *
 * This module is the one place that turns HTTP and GraphQL failures into
 * thrown errors (`ApiError`), so pages read `error.code` instead of parsing
 * response bodies. On a private site (SPEC-3 §2) a request the site gate
 * refuses (`SITE_LOCKED`: the site session ended) also opens the sign-in
 * page, which brings the browser back to the same page afterwards.
 */

const API_PATH = "/v2";
const EVENTS_PATH = "/v2/events";
const SESSION_TOKEN_PATH = "/apps/session-token";
const DEMO_USERS_PATH = "/auth/demo-users";
const DEMO_LOGIN_PATH = "/auth/demo-login";
const LOGOUT_PATH = "/auth/logout";
const SIGNIN_PATH = "/signin";
/** The version this UI was written against (`server/versions.js` current). */
const DEFAULT_API_VERSION = "2026-01";
const ID_PATTERN = /^\d{1,20}$/;
const VERSION_PATTERN = /^\d{4}-\d{2}$/;
const STATUS_CODES = new Map([
  [400, "BAD_REQUEST"],
  [401, "UNAUTHENTICATED"],
  [403, "FORBIDDEN"],
  [404, "NOT_FOUND"],
  [405, "METHOD_NOT_ALLOWED"],
  [413, "PAYLOAD_TOO_LARGE"],
  [415, "UNSUPPORTED_MEDIA_TYPE"],
  [429, "RATE_LIMITED"],
]);

/**
 * A failed request. `code` is the first error's `extensions.code`
 * (`NOT_FOUND`, `FORBIDDEN`, `VERSION_CONFLICT`, …), `errors` the full
 * GraphQL error list, `status` the HTTP status (when the request itself
 * failed), `version` the current version on `VERSION_CONFLICT` and
 * `details` the list a route attached as `extensions.errors` (an invalid
 * import plan's `{ path, message }` entries).
 */
export class ApiError extends Error {
  constructor(errors, { status } = {}) {
    const first = errors[0];
    super(
      typeof first?.message === "string" && first.message
        ? first.message
        : "Request failed",
    );
    this.name = "ApiError";
    this.errors = errors;
    this.code = first?.extensions?.code;
    this.status = status;
    const version = first?.extensions?.version;
    if (Number.isSafeInteger(version)) this.version = version;
    const details = first?.extensions?.errors;
    if (Array.isArray(details)) this.details = details;
  }
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readId(value, name) {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !ID_PATTERN.test(text)) {
    throw new TypeError(`${name} must be a numeric ID`);
  }
  return text;
}

async function readJson(response) {
  let text;
  try {
    text = await response.text();
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Builds the error thrown for a non-2xx response (or a non-JSON body). */
function httpError(response, body) {
  const errors =
    Array.isArray(body?.errors) && body.errors.length > 0
      ? body.errors
      : [
          {
            message: `Request failed (HTTP ${response.status})`,
            extensions: {
              code: STATUS_CODES.get(response.status) ?? "INTERNAL",
            },
          },
        ];
  return new ApiError(errors, { status: response.status });
}

/**
 * Opens the sign-in page with this page as `next` (its hash rides along:
 * the sign-in page adds it back).
 */
function openSignin() {
  const { pathname, search, hash } = globalThis.location;
  const next = encodeURIComponent(`${pathname}${search}`);
  globalThis.location.assign(`${SIGNIN_PATH}?next=${next}${hash}`);
}

/** `httpError`, after opening the sign-in page when the site gate refused. */
function failed(response, body) {
  const error = httpError(response, body);
  if (error.code === "SITE_LOCKED") openSignin();
  return error;
}

/** `body` is sent as JSON; `raw` (a Blob or File) as is. */
async function send(path, { method = "POST", body, raw, headers = {} }) {
  const init = {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers: { Accept: "application/json", ...headers },
  };
  if (raw !== undefined) {
    init.body = raw;
  } else if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return globalThis.fetch(path, init);
}

/**
 * Calls a host REST route (POST unless `method` says otherwise) and
 * returns the JSON object it answers. `body` is sent as JSON, `raw` (a
 * Blob or File) as is with the caller's `headers`. Failures throw
 * `ApiError`s like every request here, including the site gate's.
 *
 * @param {string} path
 * @param {{ method?: string, body?: unknown, raw?: Blob,
 *   headers?: Record<string, string> }} [options]
 * @returns {Promise<object>}
 */
export async function requestJson(path, options = {}) {
  const response = await send(path, options);
  const parsed = await readJson(response);
  if (!response.ok || !isPlainObject(parsed)) {
    throw failed(response, parsed);
  }
  return parsed;
}

/** POSTs `body` to a route that answers 204 No Content. */
async function postNoContent(path, body) {
  const response = await send(path, { body });
  if (!response.ok) throw failed(response, await readJson(response));
  // Finish the exchange before resolving: callers often reload the page
  // next (switching user, signing out), which would abort it otherwise.
  await response.arrayBuffer();
}

/**
 * Runs a GraphQL operation as the signed-in user, or as the app principal of
 * `installId` (sent as `X-App-Install`). Returns the parsed `{ data, errors? }`
 * body; throws an `ApiError` with `.errors` and `.status` when the HTTP
 * status is not 2xx. `operationName` is an optional extension of the part-1
 * signature.
 *
 * @param {string} query
 * @param {object} [variables]
 * @param {{ installId?: string, apiVersion?: string, operationName?: string }} [options]
 * @returns {Promise<{ data?: object | null, errors?: object[] }>}
 */
export async function graphql(query, variables = {}, options = {}) {
  const {
    installId,
    apiVersion = DEFAULT_API_VERSION,
    operationName = null,
  } = options;
  if (typeof query !== "string" || query.trim() === "") {
    throw new TypeError("query must be a non-empty string");
  }
  if (typeof apiVersion !== "string" || !VERSION_PATTERN.test(apiVersion)) {
    throw new TypeError("apiVersion must look like YYYY-MM");
  }
  const headers = { "API-Version": apiVersion };
  if (installId !== undefined && installId !== null) {
    headers["X-App-Install"] = readId(installId, "installId");
  }
  const body = { query, variables: isPlainObject(variables) ? variables : {} };
  if (typeof operationName === "string" && operationName !== "") {
    body.operationName = operationName;
  }
  return requestJson(API_PATH, { body, headers });
}

/**
 * Runs `query` as the signed-in user and returns its `data`. Any GraphQL
 * error (even next to partial data) becomes a thrown `ApiError`, so callers
 * never render half a response as if it were complete.
 *
 * @param {string} query
 * @param {object} [variables]
 * @returns {Promise<object>}
 */
export async function request(query, variables = {}) {
  const response = await graphql(query, variables);
  if (Array.isArray(response.errors) && response.errors.length > 0) {
    throw new ApiError(response.errors);
  }
  if (!isPlainObject(response.data)) {
    throw new ApiError([{ message: "The server returned no data" }]);
  }
  return response.data;
}

/**
 * Asks the host server for a signed session token for an app install.
 * @param {string} installId
 * @returns {Promise<{ token: string, expires_at: string }>}
 */
export async function requestSessionToken(installId) {
  const body = { install_id: readId(installId, "installId") };
  const result = await requestJson(SESSION_TOKEN_PATH, { body });
  if (
    typeof result.token !== "string" ||
    typeof result.expires_at !== "string"
  ) {
    throw new Error("Malformed session token response");
  }
  return { token: result.token, expires_at: result.expires_at };
}

/**
 * Opens an EventSource on `url` and forwards the parsed objects of each
 * event name in `listeners` (`{ [eventName]: onEvent }`) to its listener.
 * The server refuses a stream (429 when the user holds too many) or ends
 * one for good by refusing its reconnection (a board the user lost access
 * to answers 404): EventSource then reports an error in the CLOSED state,
 * which `onEnd()` announces once. Network drops keep the CONNECTING state
 * and retry on their own.
 */
function subscribe(url, listeners, onEnd = null) {
  const source = new globalThis.EventSource(url);
  let ended = false;
  source.addEventListener("error", () => {
    if (ended || source.readyState !== globalThis.EventSource.CLOSED) return;
    ended = true;
    onEnd?.();
  });
  for (const [eventName, onEvent] of Object.entries(listeners)) {
    source.addEventListener(eventName, (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      if (isPlainObject(payload) && typeof payload.type === "string") {
        onEvent(payload);
      }
    });
  }
  return () => source.close();
}

/**
 * Subscribes to a board's server-sent change events. `onEvent` receives each
 * parsed change object; malformed events are ignored. `onEnd()` runs once
 * the server has ended the stream for good (lost access, deleted board).
 * Returns `close()`.
 *
 * @param {string} boardId
 * @param {(change: object) => void} onEvent
 * @param {() => void} [onEnd]
 * @returns {() => void}
 */
export function subscribeBoardEvents(boardId, onEvent, onEnd) {
  const id = readId(boardId, "boardId");
  const url = `${EVENTS_PATH}?board_id=${encodeURIComponent(id)}`;
  return subscribe(url, { change: onEvent }, onEnd);
}

/**
 * Subscribes to the signed-in user's stream (`GET /v2/events?stream=me`):
 * `notification(event)` receives its `event: notification` messages and
 * `sidebar(change)` its `event: sidebar` ones (SPEC-6 §3.3: a folder,
 * List, doc or Space the user can see moved or changed; IDs only).
 * Events without a string `type` are ignored. `onEnd()` runs once the
 * server has refused or ended the stream for good (too many open
 * streams, the session ended). Returns `close()`.
 *
 * @param {{ notification?(event: object): void,
 *   sidebar?(change: object): void }} listeners
 * @param {() => void} [onEnd]
 * @returns {() => void}
 */
export function subscribeMyEvents(listeners, onEnd) {
  return subscribe(`${EVENTS_PATH}?stream=me`, listeners, onEnd);
}

/**
 * Lists the users of the demo user switcher, or returns null when demo
 * sign-in is turned off (the route answers 404).
 *
 * @returns {Promise<{ id: string, name: string, role: string, title: string | null,
 *   color: string, status: string }[] | null>}
 */
export async function listDemoUsers() {
  const response = await send(DEMO_USERS_PATH, { method: "GET" });
  if (response.status === 404) return null;
  const body = await readJson(response);
  if (!response.ok || !Array.isArray(body?.users)) {
    throw failed(response, body);
  }
  return body.users.filter(
    (user) => isPlainObject(user) && ID_PATTERN.test(String(user.id)),
  );
}

/**
 * Switches the session to another demo user (the server rotates the session
 * cookie). Reload the page afterwards: every cached record belongs to the
 * previous user.
 * @param {string} userId
 */
export async function demoLogin(userId) {
  await postNoContent(DEMO_LOGIN_PATH, { user_id: readId(userId, "userId") });
}

/**
 * Ends the browser session (the server clears the cookie). A session the
 * site gate already ended (`SITE_LOCKED`) counts as signed out.
 */
export async function logout() {
  const response = await send(LOGOUT_PATH, { body: {} });
  if (response.ok) return void (await response.arrayBuffer());
  const error = httpError(response, await readJson(response));
  if (error.code !== "SITE_LOCKED") throw error;
}
