/**
 * The two HTTP servers (see SPEC.md "server/http.js"):
 *
 * - host: the boards app (`web/`), the GraphQL API at `/v2`, the SSE change
 *   stream and app session tokens;
 * - apps: iframe apps (`apps/`), the SDK and the example app's backend.
 *   It sets no cookies and serves no API.
 *
 * Both servers only answer requests whose Host header names their public
 * origin, `localhost` or an IP literal: names that DNS rebinding cannot
 * point at them.
 */
import { readFile, realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAuth, verifyJwt } from "./auth.js";
import { createEventHub } from "./events.js";
import { GraphQLError } from "./graphql/errors.js";
import { execute } from "./graphql/execute.js";
import { parse } from "./graphql/parse.js";
import { printSchema } from "./graphql/schema.js";
import { createSchema } from "./schema.js";
import { resolveApiVersion } from "./versions.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SDK_FILE = path.join(ROOT, "sdk", "mini-monday-sdk.js");
const MAX_BODY_BYTES = 1024 * 1024;
const CLOSE_GRACE_MS = 1000;
const SESSION_COOKIE = "mm_session";
const SESSION_PATTERN = /(?:^|;)\s*mm_session=([^;]*)/;
const DEMO_USER_ID = "1";
const STATUS_SUMMARY_PATH = "/apps/status-summary/";
const ID_PATTERN = /^[1-9]\d{0,15}$/;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};
const ERROR_CODES = {
  400: "BAD_REQUEST",
  401: "UNAUTHENTICATED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  405: "METHOD_NOT_ALLOWED",
  413: "PAYLOAD_TOO_LARGE",
  415: "UNSUPPORTED_MEDIA_TYPE",
  500: "INTERNAL_SERVER_ERROR",
  503: "SERVICE_UNAVAILABLE",
};

const isPlainObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A failure answered with `{ errors: [{ message, extensions: { code } }] }`. */
class HttpError extends Error {
  constructor(status, message, { code, headers = {} } = {}) {
    super(message);
    this.status = status;
    this.code = code ?? ERROR_CODES[status];
    this.headers = headers;
  }
}

/** Throws an HttpError; usable as an expression (`x ?? fail(…)`). */
const fail = (status, message, options) => {
  throw new HttpError(status, message, options);
};
/** Throws a TypeError for an invalid `startServers` option. */
const invalidOption = (message) => {
  throw new TypeError(`startServers: ${message}`);
};

// --------------------------------------------------------------- responses

function sendBody(res, { status = 200, type, body, headers = {} }) {
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function sendJson(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  const type = CONTENT_TYPES[".json"];
  const noStore = { "Cache-Control": "no-store", ...headers };
  sendBody(res, { status, type, body, headers: noStore });
}

function sendError(req, res, error, log) {
  let failure = error;
  if (!(error instanceof HttpError)) {
    log.error?.("mini-monday: request failed", error);
    failure = new HttpError(500, "Internal server error");
  }
  if (res.headersSent) return void res.destroy();
  // An unread request body is not drained; the connection closes instead.
  if (!req.complete) res.setHeader("Connection", "close");
  const { message, code } = failure;
  const errors = [{ message, extensions: { code } }];
  sendJson(res, failure.status, { errors }, failure.headers);
}

// ---------------------------------------------------------------- requests

/** Splits the request target into its raw path and query parameters. */
function splitTarget(target) {
  if (typeof target !== "string" || !target.startsWith("/"))
    fail(400, "Invalid request target");
  const [pathname, query = ""] = target.split(/\?(.*)/s);
  return { pathname, search: new URLSearchParams(query) };
}

/** True when `host` is `origin`'s host, `localhost` or an IP literal. */
function isAllowedHost(host, origin) {
  if (typeof host !== "string") return false;
  if (host.toLowerCase() === new URL(origin).host) return true;
  const url = `http://${host}`;
  const hostname = URL.canParse(url) ? new URL(url).hostname : "";
  const literal = hostname.replace(/^\[(.*)\]$/, "$1");
  return hostname === "localhost" || isIP(literal) !== 0;
}

function requireJsonType(req) {
  const [type, ...params] = String(req.headers["content-type"] ?? "")
    .split(";")
    .map((part) => part.trim().toLowerCase().replaceAll('"', ""));
  const charset = params.find((param) => param.startsWith("charset="));
  if (type !== "application/json" || (charset && charset !== "charset=utf-8"))
    fail(415, "Content-Type must be application/json");
}

async function readBody(req) {
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
async function readJsonObject(req) {
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

/** The first `mm_session` cookie value, or null. */
function readSessionCookie(req) {
  const header = req.headers.cookie;
  const match =
    typeof header === "string" ? SESSION_PATTERN.exec(header) : null;
  return match ? match[1].trim() : null;
}

// ------------------------------------------------------------- principals

function tokenPrincipal(req, cfg) {
  const principal = cfg.auth.authenticateApiToken(req.headers.authorization);
  return principal ?? fail(401, "Invalid API token");
}

/**
 * The browser-session principal. The cookie counts only when `Origin` is the
 * host origin, or (`sameOriginFetch`) `Sec-Fetch-Site` is `same-origin`.
 */
function sessionPrincipal(req, cfg, { sameOriginFetch = false } = {}) {
  const sessionId = readSessionCookie(req);
  if (sessionId === null) fail(401, "Authentication required");
  const sameOrigin =
    req.headers.origin === cfg.hostOrigin ||
    (sameOriginFetch && req.headers["sec-fetch-site"] === "same-origin");
  if (!sameOrigin) fail(403, "Cross-origin request refused");
  const principal = cfg.auth.getBrowserSession(sessionId);
  return principal ?? fail(401, "The browser session has expired");
}

/** API token, browser session, or the app principal of `X-App-Install`. */
function apiPrincipal(req, cfg) {
  const install = req.headers["x-app-install"];
  if (req.headers.authorization !== undefined) {
    if (install !== undefined)
      fail(400, "X-App-Install needs a browser session");
    return tokenPrincipal(req, cfg);
  }
  const principal = sessionPrincipal(req, cfg);
  if (install === undefined) return principal;
  const installId = typeof install === "string" ? install.trim() : "";
  const app = ID_PATTERN.test(installId)
    ? cfg.auth.appPrincipal(principal, installId)
    : null;
  if (!app) fail(403, "Unknown app install");
  return app;
}

// ------------------------------------------------------------- host routes

function readGraphqlRequest(body) {
  const { query, variables = null, operationName = null } = body;
  if (typeof query !== "string" || query.trim() === "")
    fail(400, "query must be a non-empty string");
  if (variables !== null && !isPlainObject(variables))
    fail(400, "variables must be a JSON object");
  if (operationName !== null && typeof operationName !== "string")
    fail(400, "operationName must be a string");
  return { query, variables: variables ?? {}, operationName };
}

/** Parses and executes one operation; parse errors become `{ errors }`. */
async function runGraphql(cfg, { request, principal, apiVersion }) {
  let document;
  try {
    document = parse(request.query);
  } catch (error) {
    if (error instanceof GraphQLError) return { errors: [error] };
    throw error;
  }
  const { store, hostOrigin, appsOrigin, log } = cfg;
  const requireScope = (scope) => {
    if (!principal.scopes.has(scope)) {
      throw new GraphQLError(`Missing scope ${scope}`, { code: "FORBIDDEN" });
    }
  };
  const context = { store, principal, apiVersion, hostOrigin, appsOrigin };
  Object.assign(context, { log, requireScope });
  const { variables, operationName } = request;
  const run = { schema: cfg.schema, document, variables, operationName };
  return execute({ ...run, context, apiVersion });
}

function apiVersionOf(value) {
  const version = resolveApiVersion(value);
  if (version.ok) return version.value;
  const { message, code } = version.error;
  throw new HttpError(400, message, { code });
}

async function postGraphql(req, res, cfg) {
  const apiVersion = apiVersionOf(req.headers["api-version"]);
  res.setHeader("API-Version", apiVersion);
  requireJsonType(req);
  const principal = apiPrincipal(req, cfg);
  const request = readGraphqlRequest(await readJsonObject(req));
  const result = await runGraphql(cfg, { request, principal, apiVersion });
  sendJson(res, Object.hasOwn(result, "data") ? 200 : 400, result);
}

function getSchema(_req, res, cfg, { search }) {
  const apiVersion = apiVersionOf(search.get("version"));
  if ((search.get("format") ?? "sdl") !== "sdl")
    fail(400, 'format must be "sdl"');
  let sdl = cfg.sdl.get(apiVersion);
  if (sdl === undefined) {
    sdl = printSchema(cfg.schema, { apiVersion });
    cfg.sdl.set(apiVersion, sdl);
  }
  const headers = { "API-Version": apiVersion, "Cache-Control": "no-cache" };
  sendBody(res, { type: "text/plain; charset=utf-8", body: sdl, headers });
}

function getEvents(req, res, cfg, { search }) {
  const principal =
    req.headers.authorization === undefined
      ? sessionPrincipal(req, cfg, { sameOriginFetch: true })
      : tokenPrincipal(req, cfg);
  if (!principal.scopes.has("boards:read"))
    fail(403, "Missing scope boards:read");
  const boardId = search.get("board_id") ?? "";
  if (!ID_PATTERN.test(boardId)) fail(400, "board_id must be a board ID");
  if (!cfg.store.getBoard(boardId)) fail(404, "Unknown board");
  cfg.events.handle(req, res, { boardId });
}

async function postSessionToken(req, res, cfg) {
  requireJsonType(req);
  const principal = sessionPrincipal(req, cfg);
  const { install_id: raw } = await readJsonObject(req);
  const installId = Number.isSafeInteger(raw) ? String(raw) : raw;
  if (typeof installId !== "string" || !ID_PATTERN.test(installId))
    fail(400, "install_id must be an install ID");
  const { userId } = principal;
  const issued = cfg.auth.issueSessionToken({ userId, installId });
  if (!issued) fail(404, "Unknown app install");
  sendJson(res, 200, issued);
}

async function getIndex(req, res, cfg) {
  const headers = { "Cache-Control": "no-store" };
  const sessionId = readSessionCookie(req);
  if (sessionId === null || !cfg.auth.getBrowserSession(sessionId)) {
    // Demo auto-login: every new browser is signed in as user 1.
    const id = cfg.auth.createBrowserSession(DEMO_USER_ID);
    const secure = cfg.hostOrigin.startsWith("https:") ? "; Secure" : "";
    const cookie = `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Strict`;
    headers["Set-Cookie"] = `${cookie}; Path=/${secure}`;
  }
  const file = path.join(cfg.webRoot, "index.html");
  await sendFile(res, cfg, { file, type: CONTENT_TYPES[".html"], headers });
}

// ------------------------------------------------------------- apps routes

function getAppsConfig(_req, res, cfg) {
  const body = `export const HOST_ORIGIN = ${JSON.stringify(cfg.hostOrigin)};\n`;
  const headers = { "Cache-Control": "no-store" };
  sendBody(res, { type: CONTENT_TYPES[".js"], body, headers });
}

function getSdk(_req, res, cfg) {
  const type = CONTENT_TYPES[".js"];
  return sendFile(res, cfg, { file: SDK_FILE, type, csp: cfg.appsCsp });
}

/** The Status summary app's backend: verifies a session token it was given. */
async function postVerify(req, res, cfg) {
  requireJsonType(req);
  const { sessionToken } = await readJsonObject(req);
  if (typeof sessionToken !== "string")
    fail(400, "sessionToken must be a string");
  const app = cfg.store
    .listApps()
    .find((candidate) => candidate.path.startsWith(STATUS_SUMMARY_PATH));
  if (!app) fail(404, "The Status summary app is not set up");
  const audience = app.client_id;
  const result = verifyJwt(sessionToken, app.client_secret, { audience });
  const payload = result.ok ? result.payload : null;
  const valid = isPlainObject(payload?.dat) && payload.iss === "mini-monday";
  if (!valid) {
    const reason = result.ok ? "malformed" : result.reason;
    return sendJson(res, 401, { ok: false, reason });
  }
  const { user_id, board_id, install_id } = payload.dat;
  const claims = { user_id, board_id, install_id, exp: payload.exp };
  sendJson(res, 200, { ok: true, claims });
}

// ------------------------------------------------------------------ static

/**
 * Maps a raw URL path to a file under `root`, or null. The path is decoded
 * once; `..`/`.` segments, dotfiles, empty segments, NUL and backslashes are
 * refused, only known extensions are served, and the real path (symlinks
 * resolved) must stay inside the real `root`.
 */
async function resolveStatic(root, rawPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    throw new HttpError(400, "Malformed percent-encoding in the path");
  }
  const segments = decoded.split("/").slice(1);
  const safe = (segment) =>
    segment !== "" &&
    !segment.startsWith(".") &&
    !segment.includes("\\") &&
    !segment.includes("\0");
  const extension = path.extname(decoded).toLowerCase();
  if (!segments.every(safe) || !Object.hasOwn(CONTENT_TYPES, extension)) {
    return null;
  }
  try {
    const real = await realpath(path.resolve(root, ...segments));
    const info = await stat(real);
    const inside = real.startsWith(`${root}${path.sep}`);
    return inside && info.isFile()
      ? { file: real, type: CONTENT_TYPES[extension] }
      : null;
  } catch {
    return null;
  }
}

async function sendFile(res, cfg, { file, type, headers = {}, csp }) {
  const body = await readFile(file);
  const policy = { "Content-Security-Policy": csp ?? cfg.hostCsp };
  const cache = { "Cache-Control": "no-cache" };
  sendBody(res, { type, body, headers: { ...cache, ...policy, ...headers } });
}

/** Static fallback: 404 for unknown files, 405 for non-GET methods. */
function staticRoute({ root, prefix = "", minSegments = 1, csp }) {
  return async (req, res, cfg, { pathname }) => {
    const rest = pathname.slice(prefix.length);
    const deep = rest.split("/").length - 1 >= minSegments;
    const found =
      pathname.startsWith(`${prefix}/`) && deep
        ? await resolveStatic(cfg[root], rest)
        : null;
    if (!found) fail(404, "Not found");
    if (req.method !== "GET" && req.method !== "HEAD") {
      const headers = { Allow: "GET, HEAD" };
      throw new HttpError(405, "Method not allowed", { headers });
    }
    await sendFile(res, cfg, { ...found, csp: cfg[csp] });
  };
}

const READ = (handler) => ({ GET: handler, HEAD: handler });
const HOST_ROUTES = new Map([
  ["/", READ(getIndex)],
  ["/v2", { POST: postGraphql }],
  ["/v2/get_schema", { GET: getSchema }],
  ["/v2/events", { GET: getEvents }],
  ["/apps/session-token", { POST: postSessionToken }],
]);
const APPS_ROUTES = new Map([
  ["/sdk/mini-monday-sdk.js", READ(getSdk)],
  ["/apps/config.js", READ(getAppsConfig)],
  [`${STATUS_SUMMARY_PATH}api/verify`, { POST: postVerify }],
]);
const HOST_STATIC = staticRoute({ root: "webRoot", csp: "hostCsp" });
const APPS_STATIC = staticRoute({
  root: "appsRoot",
  prefix: "/apps",
  minSegments: 2,
  csp: "appsCsp",
});

// ------------------------------------------------------------------ servers

function createHandler(cfg, { routes, fallback, originKey, headers }) {
  const dispatch = async (req, res) => {
    for (const [name, value] of headers) res.setHeader(name, value);
    if (!cfg.ready) fail(503, "Server is starting");
    if (!isAllowedHost(req.headers.host, cfg[originKey]))
      fail(400, "Unexpected Host header");
    const target = splitTarget(req.url);
    const route = routes.get(target.pathname);
    if (!route) return fallback(req, res, cfg, target);
    const handler = Object.hasOwn(route, req.method) ? route[req.method] : null;
    if (handler) return handler(req, res, cfg, target);
    const allow = { Allow: Object.keys(route).join(", ") };
    throw new HttpError(405, "Method not allowed", { headers: allow });
  };
  return (req, res) => {
    dispatch(req, res).catch((error) => sendError(req, res, error, cfg.log));
  };
}

function readPort(value, label) {
  const valid = Number.isInteger(value) && value >= 0 && value <= 65_535;
  return valid ? value : invalidOption(`${label} must be from 0 to 65535`);
}

function readOrigin(value, label) {
  if (value === undefined || value === null) return null;
  const url = URL.canParse(value) ? new URL(value) : null;
  const web = url?.protocol === "http:" || url?.protocol === "https:";
  if (web && url.origin === value) return value;
  return invalidOption(`${label} must be an origin like http://localhost:4100`);
}

function listen(server, { port, bind }) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, bind, () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

/** Closes idle connections now and busy ones after CLOSE_GRACE_MS. */
function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => {
    const force = () => server.closeAllConnections();
    const timer = setTimeout(force, CLOSE_GRACE_MS);
    server.close(() => resolve(clearTimeout(timer)));
    server.closeIdleConnections();
  });
}

function policies({ hostOrigin, appsOrigin }) {
  const base = "default-src 'self'; script-src 'self'; style-src 'self'";
  const end = "base-uri 'none'; object-src 'none'";
  const hostCsp =
    `${base}; img-src 'self' data:; connect-src 'self'; ` +
    `frame-src ${appsOrigin}; frame-ancestors 'none'; base-uri 'none'; ` +
    "form-action 'self'; object-src 'none'";
  const appsCsp =
    `${base}; connect-src 'self'; img-src 'self' data:; ` +
    `frame-ancestors ${hostOrigin}; ${end}`;
  return { hostCsp, appsCsp };
}

const COMMON_HEADERS = [
  ["X-Content-Type-Options", "nosniff"],
  ["Referrer-Policy", "no-referrer"],
];
const SERVERS = [
  {
    routes: HOST_ROUTES,
    fallback: HOST_STATIC,
    originKey: "hostOrigin",
    headers: [...COMMON_HEADERS, ["Cross-Origin-Opener-Policy", "same-origin"]],
    defaultOrigin: (port) => `http://localhost:${port}`,
  },
  {
    routes: APPS_ROUTES,
    fallback: APPS_STATIC,
    originKey: "appsOrigin",
    headers: COMMON_HEADERS,
    defaultOrigin: (port) => `http://127.0.0.1:${port}`,
  },
];

/**
 * Starts the host and apps servers. Port 0 picks a free port; an origin
 * that is not given is derived from the actual port. `close()` ends SSE
 * streams and closes both servers.
 * @returns {Promise<{ hostOrigin, appsOrigin, hostServer, appsServer, auth,
 *   close(): Promise<void> }>}
 */
export async function startServers({
  store,
  hostPort = 4100,
  appsPort = 4101,
  bind = "127.0.0.1",
  hostOrigin,
  appsOrigin,
  log = console,
} = {}) {
  if (typeof store?.getBoard !== "function")
    invalidOption("A store is required");
  const ports = [
    readPort(hostPort, "hostPort"),
    readPort(appsPort, "appsPort"),
  ];
  const origins = [
    readOrigin(hostOrigin, "hostOrigin"),
    readOrigin(appsOrigin, "appsOrigin"),
  ];
  const [webRoot, appsRoot] = await Promise.all(
    ["web", "apps"].map((name) => realpath(path.join(ROOT, name))),
  );
  const auth = createAuth({ store });
  const events = createEventHub({ store });
  const cfg = { ready: false, store, auth, events, log, webRoot, appsRoot };
  Object.assign(cfg, { schema: createSchema(), sdl: new Map() });
  const servers = SERVERS.map((kind) => createServer(createHandler(cfg, kind)));
  const close = async () => {
    events.close();
    await Promise.all(servers.map(closeServer));
  };
  try {
    for (const [index, kind] of SERVERS.entries()) {
      const port = await listen(servers[index], { port: ports[index], bind });
      cfg[kind.originKey] = origins[index] ?? kind.defaultOrigin(port);
    }
    if (cfg.hostOrigin === cfg.appsOrigin) invalidOption("Origins must differ");
  } catch (error) {
    await close();
    throw error;
  }
  Object.assign(cfg, policies(cfg), { ready: true });
  let closing = null;
  const [hostServer, appsServer] = servers;
  return {
    hostOrigin: cfg.hostOrigin,
    appsOrigin: cfg.appsOrigin,
    hostServer,
    appsServer,
    auth,
    close: () => (closing ??= close()),
  };
}
