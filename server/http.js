/**
 * The two HTTP servers (see SPEC.md "server/http.js" and SPEC-2 §4):
 *
 * - host: the boards app (`web/`), the GraphQL API at `/v2`, the SSE
 *   streams, app session tokens, public forms (`/f/<token>`) and the
 *   sign-in routes (`/auth/*`);
 * - apps: iframe apps (`apps/`), the SDK and the example app's backend.
 *   It sets no cookies and serves no API.
 *
 * Route handlers live in `server/routes/`. Both servers only answer
 * requests whose Host header names their public origin, `localhost` or an
 * IP literal: names that DNS rebinding cannot point at them.
 */
import { realpath } from "node:fs/promises";
import { createServer } from "node:http";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAuth } from "./auth.js";
import { createEventHub } from "./events.js";
import {
  STATUS_SUMMARY_PATH,
  getAppsConfig,
  getSdk,
  postSessionToken,
  postVerify,
} from "./routes/apps.js";
import {
  getDemoUsers,
  getIndex,
  postDemoLogin,
  postLogout,
} from "./routes/auth.js";
import { HttpError, fail, sendError, splitTarget } from "./routes/common.js";
import { createRateLimiter, formRoute, matchFormPath } from "./routes/forms.js";
import { getEvents, getSchema, postGraphql } from "./routes/graphql.js";
import { staticRoute } from "./routes/static.js";
import { createSchema } from "./schema.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLOSE_GRACE_MS = 1000;

/** Throws a TypeError for an invalid `startServers` option. */
const invalidOption = (message) => {
  throw new TypeError(`startServers: ${message}`);
};

/** True when `host` is `origin`'s host, `localhost` or an IP literal. */
function isAllowedHost(host, origin) {
  if (typeof host !== "string") return false;
  if (host.toLowerCase() === new URL(origin).host) return true;
  const url = `http://${host}`;
  const hostname = URL.canParse(url) ? new URL(url).hostname : "";
  const literal = hostname.replace(/^\[(.*)\]$/, "$1");
  return hostname === "localhost" || isIP(literal) !== 0;
}

const READ = (handler) => ({ GET: handler, HEAD: handler });
const HOST_ROUTES = new Map([
  ["/", READ(getIndex)],
  ["/v2", { POST: postGraphql }],
  ["/v2/get_schema", { GET: getSchema }],
  ["/v2/events", { GET: getEvents }],
  ["/apps/session-token", { POST: postSessionToken }],
  ["/auth/demo-users", { GET: getDemoUsers }],
  ["/auth/demo-login", { POST: postDemoLogin }],
  ["/auth/logout", { POST: postLogout }],
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

/** Host fallback: public form pages, then static files. */
function hostFallback(req, res, cfg, target) {
  const form = matchFormPath(target.pathname);
  if (form) return formRoute(req, res, cfg, form);
  return HOST_STATIC(req, res, cfg, target);
}

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
    fallback: hostFallback,
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
 * that is not given is derived from the actual port. `demoLogin` (default
 * true) turns on demo sign-in (`server/routes/auth.js`). `close()` ends
 * SSE streams and closes both servers.
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
  demoLogin = true,
} = {}) {
  if (typeof store?.getBoard !== "function")
    invalidOption("A store is required");
  if (typeof demoLogin !== "boolean") invalidOption("demoLogin is a boolean");
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
  Object.assign(cfg, { schema: createSchema(), sdl: new Map(), demoLogin });
  cfg.formLimiter = createRateLimiter();
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
