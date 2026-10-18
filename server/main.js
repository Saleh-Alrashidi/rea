/**
 * Entry point: reads the MM_* environment variables, opens the store,
 * starts both servers and prints their URLs and the seeded API tokens. On
 * SIGINT/SIGTERM it closes the servers, flushes the store and exits 0.
 *
 * Run with `node server/main.js` (or `npm start`).
 */
import { realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startServers } from "./http.js";
import { createStore } from "./store.js";

const EXAMPLE_DIR = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_DATA_FILE = path.join(EXAMPLE_DIR, ".data", "mini-monday.json");
const PORT_PATTERN = /^\d{1,5}$/;

/** Empty or unset variables count as unset. */
const setting = (env, name) => (env[name] ? env[name] : undefined);

function readPort(env, name, fallback) {
  const raw = setting(env, name);
  if (raw === undefined) return fallback;
  const port = PORT_PATTERN.test(raw) ? Number(raw) : Number.NaN;
  if (!(port >= 0 && port <= 65_535)) {
    throw new TypeError(`${name} must be a port number from 0 to 65535`);
  }
  return port;
}

/**
 * Reads the configuration from `env` (see SPEC.md "Configuration").
 * `MM_DATA_FILE=:memory:` disables persistence.
 */
export function readConfig(env = process.env) {
  const dataFile = setting(env, "MM_DATA_FILE") ?? DEFAULT_DATA_FILE;
  return {
    hostPort: readPort(env, "MM_HOST_PORT", 4100),
    appsPort: readPort(env, "MM_APPS_PORT", 4101),
    bind: setting(env, "MM_BIND") ?? "127.0.0.1",
    file: dataFile === ":memory:" ? null : dataFile,
    hostOrigin: setting(env, "MM_HOST_ORIGIN"),
    appsOrigin: setting(env, "MM_APPS_ORIGIN"),
  };
}

/** The startup banner: URLs and the seeded tokens by label. */
export function banner({ hostOrigin, appsOrigin, tokens }) {
  const token = (label) =>
    tokens.find((record) => record.label === label)?.token ?? "(none)";
  return [
    "mini-monday is running",
    `  Boards app   ${hostOrigin}`,
    `  Apps origin  ${appsOrigin}`,
    `  GraphQL API  ${hostOrigin}/v2`,
    `  Token (read-write)  ${token("read-write")}`,
    `  Token (read-only)   ${token("read-only")}`,
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
  stdout.write(banner({ ...servers, tokens }));
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
      console.error(`mini-monday: ${error?.message ?? error}`);
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
