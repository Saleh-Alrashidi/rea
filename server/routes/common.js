/**
 * Shared HTTP plumbing of the route modules (`server/routes/*.js`): the
 * error type and its JSON body, response writers, request parsing (target,
 * JSON bodies of at most 1 MiB), the session cookie and the principals
 * that authenticate a request.
 *
 * Route handlers have the signature `(req, res, cfg, target)` where `cfg`
 * is the server state built by `startServers` (`store`, `auth`, `events`,
 * `hostOrigin`, `appsOrigin`, `log`, `demoLogin`, …) and `target` is
 * `{ pathname, search, params? }`.
 */

const MAX_BODY_BYTES = 1024 * 1024;
const SESSION_COOKIE = "mm_session";
const SESSION_PATTERN = /(?:^|;)\s*mm_session=([^;]*)/;
export const ID_PATTERN = /^[1-9]\d{0,15}$/;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
export const CONTENT_TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
});
const ERROR_CODES = Object.freeze({
  400: "BAD_REQUEST",
  401: "UNAUTHENTICATED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  405: "METHOD_NOT_ALLOWED",
  413: "PAYLOAD_TOO_LARGE",
  415: "UNSUPPORTED_MEDIA_TYPE",
  429: "RATE_LIMITED",
  500: "INTERNAL_SERVER_ERROR",
  503: "SERVICE_UNAVAILABLE",
});

export const isPlainObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A failure answered with `{ errors: [{ message, extensions }] }`;
 * `extensions` holds `code` plus any `details`.
 */
export class HttpError extends Error {
  constructor(status, message, { code, headers = {}, details = {} } = {}) {
    super(message);
    this.status = status;
    this.code = code ?? ERROR_CODES[status];
    this.headers = headers;
    this.details = details;
  }
}

/** Throws an HttpError; usable as an expression (`x ?? fail(…)`). */
export const fail = (status, message, options) => {
  throw new HttpError(status, message, options);
};

// --------------------------------------------------------------- responses

export function sendBody(res, { status = 200, type, body, headers = {} }) {
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

export function sendJson(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  const type = CONTENT_TYPES[".json"];
  const noStore = { "Cache-Control": "no-store", ...headers };
  sendBody(res, { status, type, body, headers: noStore });
}

export function sendNoContent(res, headers = {}) {
  res.writeHead(204, { "Cache-Control": "no-store", ...headers });
  res.end();
}

export function sendError(req, res, error, log) {
  let failure = error;
  if (!(error instanceof HttpError)) {
    log.error?.("mini-monday: request failed", error);
    failure = new HttpError(500, "Internal server error");
  }
  if (res.headersSent) return void res.destroy();
  // An unread request body is not drained; the connection closes instead.
  if (!req.complete) res.setHeader("Connection", "close");
  const { message, code, details } = failure;
  const errors = [{ message, extensions: { ...details, code } }];
  sendJson(res, failure.status, { errors }, failure.headers);
}

// ---------------------------------------------------------------- requests

/** Splits the request target into its raw path and query parameters. */
export function splitTarget(target) {
  if (typeof target !== "string" || !target.startsWith("/"))
    fail(400, "Invalid request target");
  const [pathname, query = ""] = target.split(/\?(.*)/s);
  return { pathname, search: new URLSearchParams(query) };
}

export function requireJsonType(req) {
  const [type, ...params] = String(req.headers["content-type"] ?? "")
    .split(";")
    .map((part) => part.trim().toLowerCase().replaceAll('"', ""));
  const charset = params.find((param) => param.startsWith("charset="));
  if (type !== "application/json" || (charset && charset !== "charset=utf-8"))
    fail(415, "Content-Type must be application/json");
}

function readBody(req) {
  const tooLarge = () =>
    new HttpError(413, "Request bodies are limited to 1 MiB");
  if (Number(req.headers["content-length"]) > MAX_BODY_BYTES) throw tooLarge();
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const onData = (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) return void chunks.push(chunk);
      req.off("data", onData);
      reject(tooLarge());
    };
    req.on("data", onData);
    req.once("end", () => resolve(Buffer.concat(chunks)));
    req.once("error", reject);
    req.once("close", () => reject(new HttpError(400, "Request aborted")));
  });
}

/** Reads a JSON object body (at most 1 MiB of UTF-8). */
export async function readJsonObject(req) {
  const bytes = await readBody(req);
  let value;
  try {
    value = JSON.parse(UTF8.decode(bytes));
  } catch {
    throw new HttpError(400, "The request body must be UTF-8 JSON");
  }
  if (!isPlainObject(value))
    fail(400, "The request body must be a JSON object");
  return value;
}

/** Reads an ID given as a numeric string or a safe integer, else null. */
export function readIdValue(raw) {
  const id = Number.isSafeInteger(raw) ? String(raw) : raw;
  return typeof id === "string" && ID_PATTERN.test(id) ? id : null;
}

// ------------------------------------------------------------- sessions

/** The first `mm_session` cookie value, or null. */
export function readSessionCookie(req) {
  const header = req.headers.cookie;
  const match =
    typeof header === "string" ? SESSION_PATTERN.exec(header) : null;
  return match ? match[1].trim() : null;
}

const secureFlag = (cfg) =>
  cfg.hostOrigin.startsWith("https:") ? "; Secure" : "";

/** `Set-Cookie` value for a new session. */
export const sessionCookie = (cfg, sessionId) =>
  `${SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Strict; Path=/${secureFlag(cfg)}`;

/** `Set-Cookie` value that clears the session cookie. */
export const clearedSessionCookie = (cfg) =>
  `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureFlag(cfg)}`;

/**
 * True when the request comes from the host app: `Origin` is the host
 * origin, or (`sameOriginFetch`, for GETs) `Sec-Fetch-Site` is
 * `same-origin`.
 */
export function fromHostApp(req, cfg, { sameOriginFetch = false } = {}) {
  return (
    req.headers.origin === cfg.hostOrigin ||
    (sameOriginFetch && req.headers["sec-fetch-site"] === "same-origin")
  );
}

// ------------------------------------------------------------- principals

export function tokenPrincipal(req, cfg) {
  const principal = cfg.auth.authenticateApiToken(req.headers.authorization);
  return principal ?? fail(401, "Invalid API token");
}

/**
 * The browser-session principal. The cookie counts only from the host app
 * (see `fromHostApp`).
 */
export function sessionPrincipal(req, cfg, options = {}) {
  const sessionId = readSessionCookie(req);
  if (sessionId === null) fail(401, "Authentication required");
  if (!fromHostApp(req, cfg, options))
    fail(403, "Cross-origin request refused");
  const principal = cfg.auth.getBrowserSession(sessionId);
  return principal ?? fail(401, "The browser session has expired");
}

/** An API token principal when `Authorization` is sent, else the session. */
export function requestPrincipal(req, cfg, options = {}) {
  return req.headers.authorization === undefined
    ? sessionPrincipal(req, cfg, options)
    : tokenPrincipal(req, cfg);
}
