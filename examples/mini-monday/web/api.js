/**
 * Host-app HTTP client: GraphQL over `POST /v2`, app session tokens and the
 * board change stream. Every request is same-origin and authenticated by the
 * HttpOnly session cookie; nothing here stores credentials.
 */

const API_PATH = "/v2";
const EVENTS_PATH = "/v2/events";
const SESSION_TOKEN_PATH = "/apps/session-token";
/** The version this UI was written against (`server/versions.js` current). */
const DEFAULT_API_VERSION = "2026-01";
const ID_PATTERN = /^\d{1,20}$/;
const VERSION_PATTERN = /^\d{4}-\d{2}$/;
const STATUS_CODES = new Map([
  [400, "BAD_REQUEST"],
  [401, "UNAUTHENTICATED"],
  [403, "FORBIDDEN"],
  [404, "NOT_FOUND"],
  [413, "PAYLOAD_TOO_LARGE"],
  [415, "UNSUPPORTED_MEDIA_TYPE"],
]);

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

/** Builds the Error thrown for a non-2xx response (or a non-JSON body). */
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
  const first = errors[0];
  const message =
    typeof first?.message === "string" ? first.message : "Request failed";
  const error = new Error(message);
  error.status = response.status;
  error.errors = errors;
  error.code = first?.extensions?.code;
  return error;
}

async function postJson(path, { body, headers = {} }) {
  const response = await globalThis.fetch(path, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const parsed = await readJson(response);
  if (!response.ok || !isPlainObject(parsed)) {
    throw httpError(response, parsed);
  }
  return parsed;
}

/**
 * Runs a GraphQL operation as the signed-in user, or as the app principal of
 * `installId` (sent as `X-App-Install`). Returns the parsed `{ data, errors? }`
 * body; throws an Error with `.errors` and `.status` when the HTTP status is
 * not 2xx. `operationName` is an optional extension of the spec signature.
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
  return postJson(API_PATH, { body, headers });
}

/**
 * Asks the host server for a signed session token for an app install.
 * @param {string} installId
 * @returns {Promise<{ token: string, expires_at: string }>}
 */
export async function requestSessionToken(installId) {
  const body = { install_id: readId(installId, "installId") };
  const result = await postJson(SESSION_TOKEN_PATH, { body });
  if (
    typeof result.token !== "string" ||
    typeof result.expires_at !== "string"
  ) {
    throw new Error("Malformed session token response");
  }
  return { token: result.token, expires_at: result.expires_at };
}

/**
 * Subscribes to a board's server-sent change events. `onEvent` receives each
 * parsed change object; malformed events are ignored. Returns `close()`.
 *
 * @param {string} boardId
 * @param {(change: object) => void} onEvent
 * @returns {() => void}
 */
export function subscribeBoardEvents(boardId, onEvent) {
  const id = readId(boardId, "boardId");
  const source = new globalThis.EventSource(
    `${EVENTS_PATH}?board_id=${encodeURIComponent(id)}`,
  );
  source.addEventListener("change", (event) => {
    let change;
    try {
      change = JSON.parse(event.data);
    } catch {
      return;
    }
    if (isPlainObject(change) && typeof change.type === "string") {
      onEvent(change);
    }
  });
  return () => source.close();
}
