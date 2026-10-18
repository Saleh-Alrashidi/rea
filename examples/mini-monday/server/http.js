/**
 * The HTTP handlers and their listeners (see SPEC.md "server/http.js",
 * SPEC-2 §4 and SPEC-3 §3–4):
 *
 * - host: the boards app (`web/`), the GraphQL API at `/v2`, the SSE
 *   streams, app session tokens, public forms (`/f/<token>`), the
 *   importer (`/import/*`, SPEC-4 §5) and the sign-in routes (`/auth/*`);
 *   with a site password, the site gate (`routes/gate.js`) runs before
 *   every host route and `/signin` exists;
 * - apps: iframe apps (`apps/`), the SDK and the example app's backend.
 *   It sets no cookies and serves no API.
 *
 * Local mode (default) gives each handler its own listener, and both only
 * answer requests whose Host header names their public origin,
 * `localhost` or an IP literal: names that DNS rebinding cannot point at
 * them. Hosted mode has one listener behind the platform's proxy: a Host
 * naming the apps origin's host goes to the apps handler, every other
 * Host to the host handler (proxies may rewrite it), while CSP, cookies
 * and Origin checks keep using the configured origins. Hosted responses
 * carry `X-Robots-Tag` (and HSTS for an `https:` host origin), and the
 * host also serves `/healthz` and `/robots.txt`. Without an apps origin
 * (`appsOrigin` null) the app platform is off: no app views, session
 * tokens or app principals, and no `frame-src` in the host CSP.
 *
 * Route handlers live in `server/routes/`.
 */
import { realpath } from "node:fs/promises";
import { createServer } from "node:http";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAuth } from "./auth.js";
import { createEventHub } from "./events.js";
import { createImportJobs } from "./import/jobs.js";
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
import { createFormLimiter, formRoute, matchFormPath } from "./routes/forms.js";
import {
  SITE_SESSION_IDLE_MS,
  createGate,
  getSignin,
  guard,
  postSignin,
} from "./routes/gate.js";
import { getEvents, getSchema, postGraphql } from "./routes/graphql.js";
import {
  getImportJobs,
  importJobRoute,
  matchImportJobPath,
  postImportRun,
  postImportScan,
} from "./routes/import.js";
import { getHealthz, getRobots } from "./routes/platform.js";
import { staticRoute } from "./routes/static.js";
import { createSchema } from "./schema.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLOSE_GRACE_MS = 1000;

/** Throws a TypeError for an invalid `startServers` option. */
const invalidOption = (message) => {
  throw new TypeError(`startServers: ${message}`);
};

/** The host name a Host header names (lower case), or "". */
function hostnameOf(host) {
  const url = `http://${host}`;
  return typeof host === "string" && URL.canParse(url)
    ? new URL(url).hostname
    : "";
}

/** True when two origins name the same host (ports aside, like cookies). */
export const sameHostname = (a, b) =>
  new URL(a).hostname === new URL(b).hostname;

/** True when `host` is `origin`'s host, `localhost` or an IP literal. */
function isAllowedHost(host, origin) {
  if (typeof host !== "string") return false;
  if (host.toLowerCase() === new URL(origin).host) return true;
  const hostname = hostnameOf(host);
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
  ["/import/scan", { POST: postImportScan }],
  ["/import/run", { POST: postImportRun }],
  ["/import/jobs", { GET: getImportJobs }],
]);
/** Hosted mode only (SPEC-3 §2, §4). */
const HOSTED_ROUTES = [
  ["/healthz", READ(getHealthz)],
  ["/robots.txt", READ(getRobots)],
];
/** With a site password only. */
const GATE_ROUTES = [["/signin", { ...READ(getSignin), POST: postSignin }]];
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

/** Host fallback: public form pages, import jobs, then static files. */
function hostFallback(req, res, cfg, target) {
  const form = matchFormPath(target.pathname);
  if (form) return formRoute(req, res, cfg, form);
  const job = matchImportJobPath(target.pathname);
  if (job) return importJobRoute(req, res, cfg, job);
  return HOST_STATIC(req, res, cfg, target);
}

// ------------------------------------------------------------------ servers

function createHandler(cfg, kind) {
  const { fallback, originKey, headers, gated } = kind;
  const routes = kind.routes(cfg);
  const dispatch = async (req, res) => {
    for (const [name, value] of headers) res.setHeader(name, value);
    for (const [name, value] of cfg.headers) res.setHeader(name, value);
    if (!cfg.ready) fail(503, "Server is starting");
    if (!cfg.hosted && !isAllowedHost(req.headers.host, cfg[originKey]))
      fail(400, "Unexpected Host header");
    const target = splitTarget(req.url);
    if (gated && !guard(req, res, cfg, target)) return;
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
  const frames = appsOrigin === null ? "" : `frame-src ${appsOrigin}; `;
  const hostCsp =
    `${base}; img-src 'self' data:; connect-src 'self'; ` +
    `${frames}frame-ancestors 'none'; base-uri 'none'; ` +
    "form-action 'self'; object-src 'none'";
  const appsCsp =
    appsOrigin === null
      ? null
      : `${base}; connect-src 'self'; img-src 'self' data:; ` +
        `frame-ancestors ${hostOrigin}; ${end}`;
  return { hostCsp, appsCsp };
}

/** Headers of every response that depend on the configuration. */
function configuredHeaders({ hosted, hostOrigin }) {
  if (!hosted) return [];
  const headers = [["X-Robots-Tag", "noindex, nofollow"]];
  if (hostOrigin.startsWith("https:"))
    headers.push(["Strict-Transport-Security", "max-age=31536000"]);
  return headers;
}

const COMMON_HEADERS = [
  ["X-Content-Type-Options", "nosniff"],
  ["Referrer-Policy", "no-referrer"],
];
const HOST_KIND = {
  routes: (cfg) =>
    new Map([
      ...HOST_ROUTES,
      ...(cfg.hosted ? HOSTED_ROUTES : []),
      ...(cfg.gate ? GATE_ROUTES : []),
    ]),
  fallback: hostFallback,
  originKey: "hostOrigin",
  headers: [...COMMON_HEADERS, ["Cross-Origin-Opener-Policy", "same-origin"]],
  gated: true,
  defaultOrigin: (port) => `http://localhost:${port}`,
};
const APPS_KIND = {
  routes: () => APPS_ROUTES,
  fallback: APPS_STATIC,
  originKey: "appsOrigin",
  headers: COMMON_HEADERS,
  gated: false,
  defaultOrigin: (port) => `http://127.0.0.1:${port}`,
};
const LOCAL_KINDS = [HOST_KIND, APPS_KIND];

/** Hosted mode's one listener: picks the handler by the Host header. */
function routeByHost(cfg, { host, apps }) {
  const appsHost =
    cfg.appsOrigin === null ? null : new URL(cfg.appsOrigin).hostname;
  return (req, res) =>
    appsHost !== null && hostnameOf(req.headers.host) === appsHost
      ? apps(req, res)
      : host(req, res);
}

/**
 * The checked listener layout: local → two ports and optional origins
 * (derived from the ports later); hosted → one port and the given
 * origins (`hostOrigin` required, `appsOrigin` optional on another host).
 */
function readLayout(options) {
  const { mode = "local" } = options;
  const origins = [
    readOrigin(options.hostOrigin, "hostOrigin"),
    readOrigin(options.appsOrigin, "appsOrigin"),
  ];
  if (mode === "local") {
    const { hostPort = 4100, appsPort = 4101 } = options;
    const ports = [
      readPort(hostPort, "hostPort"),
      readPort(appsPort, "appsPort"),
    ];
    return { hosted: false, ports, origins };
  }
  if (mode !== "hosted") invalidOption('mode must be "local" or "hosted"');
  const [hostOrigin, appsOrigin] = origins;
  if (hostOrigin === null) invalidOption("hosted mode needs a hostOrigin");
  if (appsOrigin !== null && sameHostname(hostOrigin, appsOrigin))
    invalidOption("hostOrigin and appsOrigin need different hosts");
  return { hosted: true, ports: [readPort(options.port, "port")], origins };
}

/** The shared server state route handlers receive as `cfg`. */
async function createState(options, layout) {
  const { store, log, demoLogin, trustProxy, now, importConnectors } = options;
  const [webRoot, appsRoot] = await Promise.all(
    ["web", "apps"].map((name) => realpath(path.join(ROOT, name))),
  );
  const gate =
    options.sitePassword === null
      ? null
      : createGate({ password: options.sitePassword, now });
  const sessionIdleMs = gate ? SITE_SESSION_IDLE_MS : undefined;
  const auth = createAuth({ store, now, sessionIdleMs });
  const { sessionActive } = auth;
  const events = createEventHub({ store, sessionActive });
  const cfg = { ready: false, store, auth, events, log, webRoot, appsRoot };
  Object.assign(cfg, { schema: createSchema(), sdl: new Map(), demoLogin });
  Object.assign(cfg, { hosted: layout.hosted, gate, trustProxy, headers: [] });
  cfg.formLimiter = createFormLimiter({ now });
  // Import progress reaches the importer's `stream=me` as `event: import`.
  const publish = (userId, payload) =>
    events.publish(userId, "import", payload);
  const connectors = importConnectors;
  cfg.imports = createImportJobs({ store, publish, connectors, log, now });
  return cfg;
}

/**
 * Starts the listeners of `layout` (added to `servers` as they are made,
 * so a failed start can close them) and sets the origins local mode
 * derives from its ports.
 */
async function listenAll(cfg, layout, { bind, servers }) {
  const { ports, origins } = layout;
  if (layout.hosted) {
    [cfg.hostOrigin, cfg.appsOrigin] = origins;
    const handlers = {
      host: createHandler(cfg, HOST_KIND),
      apps: createHandler(cfg, APPS_KIND),
    };
    const server = createServer(routeByHost(cfg, handlers));
    servers.push(server);
    await listen(server, { port: ports[0], bind });
    return;
  }
  servers.push(
    ...LOCAL_KINDS.map((kind) => createServer(createHandler(cfg, kind))),
  );
  for (const [index, kind] of LOCAL_KINDS.entries()) {
    const port = await listen(servers[index], { port: ports[index], bind });
    cfg[kind.originKey] = origins[index] ?? kind.defaultOrigin(port);
  }
  if (cfg.hostOrigin === cfg.appsOrigin) invalidOption("Origins must differ");
}

/**
 * Starts the servers. `mode` "local" (default) listens on `hostPort` and
 * `appsPort` (0 picks a free port; an origin that is not given is derived
 * from the actual port); "hosted" listens on `port` alone and needs
 * `hostOrigin` (`appsOrigin` null turns the app platform off).
 * `demoLogin` (default true) turns on demo sign-in
 * (`server/routes/auth.js`); `sitePassword` turns on the site gate;
 * `trustProxy` takes client IPs from `X-Forwarded-For`
 * (`routes/rate-limit.js`); `now` is the clock of sessions, rate limits
 * and import jobs; `importConnectors` (`{ monday, clickup, files }`, each
 * with `scan`) replaces the importer's connectors (tests). `close()` ends
 * SSE streams and import jobs, stops the services' store listeners and
 * closes the servers.
 * @returns {Promise<{ hostOrigin, appsOrigin, hostServer, appsServer, auth,
 *   close(): Promise<void> }>} (`appsServer` is null in hosted mode, where
 *   `hostServer` is the one listener)
 */
export async function startServers({
  store,
  bind = "127.0.0.1",
  log = console,
  demoLogin = true,
  sitePassword = null,
  trustProxy = false,
  now = () => Date.now(),
  importConnectors = null,
  ...layoutOptions
} = {}) {
  if (typeof store?.getBoard !== "function")
    invalidOption("A store is required");
  if (typeof demoLogin !== "boolean") invalidOption("demoLogin is a boolean");
  if (typeof trustProxy !== "boolean") invalidOption("trustProxy is a boolean");
  if (importConnectors !== null && typeof importConnectors !== "object")
    invalidOption("importConnectors is an object of connector modules");
  const layout = readLayout(layoutOptions);
  const options = { store, log, demoLogin, sitePassword, trustProxy, now };
  options.importConnectors = importConnectors;
  const cfg = await createState(options, layout);
  const servers = [];
  const stopSessions = cfg.auth.onSessionEnded((id) =>
    cfg.events.endSession(id),
  );
  const close = async () => {
    stopSessions();
    cfg.imports.close();
    cfg.events.close();
    cfg.auth.close();
    await Promise.all(servers.map(closeServer));
  };
  try {
    await listenAll(cfg, layout, { bind, servers });
  } catch (error) {
    await close();
    throw error;
  }
  Object.assign(cfg, policies(cfg), { headers: configuredHeaders(cfg) });
  cfg.ready = true;
  let closing = null;
  const [hostServer, appsServer = null] = servers;
  return {
    hostOrigin: cfg.hostOrigin,
    appsOrigin: cfg.appsOrigin,
    hostServer,
    appsServer,
    auth: cfg.auth,
    close: () => (closing ??= close()),
  };
}
