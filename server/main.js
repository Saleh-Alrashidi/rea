/**
 * Entry point: reads the MM_* environment variables, opens the store,
 * starts the servers and prints their URLs and the seeded API tokens. On
 * SIGINT/SIGTERM it closes the servers, flushes the store and exits 0.
 *
 * Two modes (SPEC-3 §1): local (no `PORT`: two loopback listeners, demo
 * sign-in) and hosted (`PORT` set: one listener behind a proxy, the site
 * gate). The whole configuration is checked before anything starts; every
 * problem is printed on its own line and the process exits with code 1.
 *
 * Run with `node server/main.js` (or `npm start`).
 */
import { realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sameHostname, startServers } from "./http.js";
import { sitePasswordProblem } from "./routes/gate.js";
import { createStore } from "./store.js";

const EXAMPLE_DIR = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_DATA_FILE = path.join(EXAMPLE_DIR, ".data", "mini-monday.json");
const PORT_PATTERN = /^\d{1,5}$/;
const LOOPBACK_IPV4 = /^127(?:\.\d{1,3}){3}$/;
/** Variables that mean something only in hosted mode. */
const HOSTED_ONLY = ["MM_SITE_PASSWORD", "MM_PUBLIC_DEMO"];
const ORIGIN_EXAMPLE = "https://worklane.cranl.net";

/** The configuration problems found by `readConfig`, one per line. */
export class ConfigError extends TypeError {
  constructor(problems) {
    super(problems.join("\n"));
    this.name = "ConfigError";
    this.problems = problems;
  }
}

/** Empty or unset variables count as unset. */
const setting = (env, name) => (env[name] ? env[name] : undefined);

/**
 * `env` with the variables that select or configure hosted mode (`PORT`
 * and the hosted-only ones) cleared, for harnesses that always run local
 * mode whatever environment they inherit.
 */
export function localModeEnv(env) {
  const cleared = ["PORT", ...HOSTED_ONLY].map((name) => [name, ""]);
  return { ...env, ...Object.fromEntries(cleared) };
}

function readPort(env, name, { fallback, problems }) {
  const raw = setting(env, name);
  if (raw === undefined) return fallback;
  const port = PORT_PATTERN.test(raw) ? Number(raw) : Number.NaN;
  if (port >= 0 && port <= 65_535) return port;
  problems.push(`${name} must be a port number from 0 to 65535`);
  return fallback;
}

/** `0` → false, `1` → true, unset → undefined; anything else is a problem. */
function readFlag(env, name, problems) {
  const raw = setting(env, name);
  if (raw === undefined || raw === "0" || raw === "1")
    return raw === undefined ? undefined : raw === "1";
  problems.push(`${name} must be 0 or 1`);
  return undefined;
}

const isLoopback = (hostname) =>
  hostname === "localhost" ||
  hostname === "[::1]" ||
  LOOPBACK_IPV4.test(hostname);

/** A public origin (`https:`, or `http:` on a loopback host), or null. */
function readPublicOrigin(env, name, problems) {
  const raw = setting(env, name);
  if (raw === undefined) return null;
  const url = URL.canParse(raw) ? new URL(raw) : null;
  const web = url?.protocol === "https:" || url?.protocol === "http:";
  if (!web || url.origin !== raw) {
    problems.push(
      `${name} must be an origin (scheme, host and optional port; no ` +
        `path or trailing slash), like ${ORIGIN_EXAMPLE}`,
    );
    return null;
  }
  if (url.protocol === "http:" && !isLoopback(url.hostname)) {
    problems.push(`${name} must use https: (http: is only for loopback hosts)`);
    return null;
  }
  return raw;
}

/** The site password, or null for a public demo (`MM_PUBLIC_DEMO=1`). */
function readSitePassword(env, problems) {
  const password = setting(env, "MM_SITE_PASSWORD");
  const publicDemo = readFlag(env, "MM_PUBLIC_DEMO", problems) === true;
  if (password === undefined) {
    if (!publicDemo)
      problems.push(
        "MM_SITE_PASSWORD is required in hosted mode (MM_PUBLIC_DEMO=1 " +
          "runs a public demo without one, on purpose)",
      );
    return null;
  }
  if (publicDemo)
    problems.push("Set MM_SITE_PASSWORD or MM_PUBLIC_DEMO=1, not both");
  const problem = sitePasswordProblem(password);
  if (problem !== null) problems.push(`MM_SITE_PASSWORD ${problem}`);
  return password;
}

function localConfig(env, problems) {
  for (const name of HOSTED_ONLY) {
    if (setting(env, name) !== undefined)
      problems.push(`${name} applies only in hosted mode (set PORT)`);
  }
  return {
    mode: "local",
    hostPort: readPort(env, "MM_HOST_PORT", { fallback: 4100, problems }),
    appsPort: readPort(env, "MM_APPS_PORT", { fallback: 4101, problems }),
    bind: setting(env, "MM_BIND") ?? "127.0.0.1",
    hostOrigin: setting(env, "MM_HOST_ORIGIN"),
    appsOrigin: setting(env, "MM_APPS_ORIGIN"),
  };
}

function hostedConfig(env, problems) {
  const hostOrigin = readPublicOrigin(env, "MM_HOST_ORIGIN", problems);
  if (setting(env, "MM_HOST_ORIGIN") === undefined)
    problems.push(
      `MM_HOST_ORIGIN is required in hosted mode: the site's public ` +
        `origin, like ${ORIGIN_EXAMPLE}`,
    );
  const appsOrigin = readPublicOrigin(env, "MM_APPS_ORIGIN", problems);
  if (hostOrigin && appsOrigin && sameHostname(hostOrigin, appsOrigin))
    problems.push("MM_APPS_ORIGIN must be on another host than MM_HOST_ORIGIN");
  return {
    mode: "hosted",
    port: readPort(env, "PORT", { fallback: 0, problems }),
    bind: setting(env, "MM_BIND") ?? "0.0.0.0",
    hostOrigin,
    appsOrigin,
    sitePassword: readSitePassword(env, problems),
  };
}

/**
 * Reads the configuration from `env` (see SPEC.md "Configuration" and
 * SPEC-3 §1): `mode` "hosted" when `PORT` is set, else "local".
 * `MM_DATA_FILE=:memory:` disables persistence; `MM_DEMO_LOGIN=0` turns
 * demo sign-in off (SPEC-2 §4), which is on otherwise; `MM_TRUST_PROXY`
 * defaults to 1 in hosted mode and 0 locally. Throws a ConfigError
 * listing every problem.
 */
export function readConfig(env = process.env) {
  const problems = [];
  const hosted = setting(env, "PORT") !== undefined;
  const dataFile = setting(env, "MM_DATA_FILE") ?? DEFAULT_DATA_FILE;
  const config = {
    ...(hosted ? hostedConfig(env, problems) : localConfig(env, problems)),
    demoLogin: setting(env, "MM_DEMO_LOGIN") !== "0",
    file: dataFile === ":memory:" ? null : dataFile,
    trustProxy: readFlag(env, "MM_TRUST_PROXY", problems) ?? hosted,
  };
  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}

const tokenOf = (tokens, label) =>
  tokens.find((record) => record.label === label)?.token ?? "(none)";

const tokenLines = (tokens) => [
  `  Token (read-write)  ${tokenOf(tokens, "read-write")}`,
  `  Token (read-only)   ${tokenOf(tokens, "read-only")}`,
];

/** The startup banner: URLs and the seeded tokens by label. */
export function banner({ hostOrigin, appsOrigin, tokens }) {
  return [
    "mini-monday is running",
    `  Boards app   ${hostOrigin}`,
    `  Apps origin  ${appsOrigin}`,
    `  GraphQL API  ${hostOrigin}/v2`,
    ...tokenLines(tokens),
    "",
  ].join("\n");
}

/** Where rate limits take client IPs from (SPEC-3 §1 `MM_TRUST_PROXY`). */
const clientIps = (trustProxy) =>
  trustProxy
    ? "last X-Forwarded-For hop (MM_TRUST_PROXY=1: let only the proxy reach PORT)"
    : "the connection's address (MM_TRUST_PROXY=0)";

/**
 * The hosted startup banner (SPEC-3 §5): public URL, gate, where client
 * IPs come from, apps, data file and tokens; a loud warning when the gate
 * is off. Never the site password.
 */
export function hostedBanner(options) {
  const { hostOrigin, appsOrigin, gate, file, trustProxy, tokens } = options;
  const warning = gate
    ? []
    : [
        "!!! WARNING: MM_PUBLIC_DEMO=1: the site gate is OFF. Anyone who",
        `!!! can reach ${hostOrigin} can use this Worklane.`,
      ];
  const apps = appsOrigin
    ? `on at ${appsOrigin}`
    : "off (set MM_APPS_ORIGIN to a second domain)";
  return [
    ...warning,
    "mini-monday is running (hosted)",
    `  Public URL   ${hostOrigin}`,
    `  Site gate    ${gate ? "on (site password required)" : "OFF"}`,
    `  Client IPs   ${clientIps(trustProxy)}`,
    `  Apps         ${apps}`,
    `  Data file    ${file ?? ":memory: (not saved)"}`,
    `  GraphQL API  ${hostOrigin}/v2`,
    ...tokenLines(tokens),
    "",
  ].join("\n");
}

/**
 * Starts mini-monday. Resolves with `stop()`, which closes the servers and
 * flushes the store; signal handlers call it and then exit.
 */
export async function main({
  env = process.env,
  stdout = process.stdout,
  log = console,
} = {}) {
  const { file, ...options } = readConfig(env);
  const store = await createStore({ file, log });
  const servers = await startServers({ store, ...options, log });
  const tokens = store.listApiTokens();
  const text =
    options.mode === "hosted"
      ? hostedBanner({
          ...servers,
          gate: options.sitePassword !== null,
          file,
          trustProxy: options.trustProxy,
          tokens,
        })
      : banner({ ...servers, tokens });
  stdout.write(text);
  let stopping = null;
  const stop = () =>
    (stopping ??= (async () => {
      await servers.close();
      await store.flush();
    })());
  return { servers, store, stop };
}

function runFromCommandLine() {
  const onSignal = (stop) => () =>
    stop().then(
      () => process.exit(0),
      (error) => {
        console.error("mini-monday: shutdown failed:", error);
        process.exit(1);
      },
    );
  main().then(
    ({ stop }) => {
      process.once("SIGINT", onSignal(stop));
      process.once("SIGTERM", onSignal(stop));
    },
    (error) => {
      const problems =
        error instanceof ConfigError
          ? error.problems
          : [error?.message ?? error];
      for (const problem of problems) console.error(`mini-monday: ${problem}`);
      process.exitCode = 1;
    },
  );
}

function isEntryPoint() {
  try {
    const entry = process.argv[1];
    return (
      Boolean(entry) &&
      pathToFileURL(realpathSync(entry)).href === import.meta.url
    );
  } catch {
    return false;
  }
}

if (isEntryPoint()) runFromCommandLine();
