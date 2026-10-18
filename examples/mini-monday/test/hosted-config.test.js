/**
 * Configuration of the two modes (SPEC-3 §1, §5): `readConfig` picks
 * hosted mode when PORT is set, checks every hosted variable and reports
 * each problem; the hosted banner; and `server/main.js` exiting 1 with
 * one line per problem, or starting hosted mode on PORT without ever
 * printing the site password.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ConfigError, hostedBanner, main, readConfig } from "../server/main.js";
import { PASSWORD } from "./hosted-helpers.js";

const MAIN = fileURLToPath(new URL("../server/main.js", import.meta.url));
const ORIGIN = "https://worklane.cranl.net";
const HOSTED = {
  PORT: "8080",
  MM_HOST_ORIGIN: ORIGIN,
  MM_SITE_PASSWORD: PASSWORD,
};

/** The problems `readConfig(env)` reports (none → []). */
function problemsOf(env) {
  try {
    readConfig(env);
    return [];
  } catch (error) {
    assert.ok(error instanceof ConfigError, error);
    return error.problems;
  }
}

test("local mode (no PORT) reads as before, plus MM_TRUST_PROXY", () => {
  const config = readConfig({});
  assert.equal(config.mode, "local");
  assert.deepEqual(
    [config.hostPort, config.appsPort, config.bind, config.demoLogin],
    [4100, 4101, "127.0.0.1", true],
  );
  assert.equal(config.hostOrigin, undefined);
  assert.equal(config.trustProxy, false);
  assert.match(config.file, /\.data[/\\]mini-monday\.json$/);
  assert.equal(readConfig({ MM_TRUST_PROXY: "1" }).trustProxy, true);
  assert.equal(readConfig({ PORT: "" }).mode, "local", "empty counts as unset");
  assert.deepEqual(problemsOf({ MM_HOST_PORT: "http" }), [
    "MM_HOST_PORT must be a port number from 0 to 65535",
  ]);
  // A password is never ignored silently: it needs hosted mode.
  assert.deepEqual(
    problemsOf({ MM_SITE_PASSWORD: PASSWORD, MM_PUBLIC_DEMO: "1" }),
    [
      "MM_SITE_PASSWORD applies only in hosted mode (set PORT)",
      "MM_PUBLIC_DEMO applies only in hosted mode (set PORT)",
    ],
  );
});

test("hosted mode (PORT set): one listener, the gate and proxy-aware IPs", () => {
  assert.deepEqual(readConfig({ ...HOSTED, MM_DATA_FILE: ":memory:" }), {
    mode: "hosted",
    port: 8080,
    bind: "0.0.0.0",
    hostOrigin: ORIGIN,
    appsOrigin: null,
    sitePassword: PASSWORD,
    demoLogin: true,
    file: null,
    trustProxy: true,
  });
  const custom = readConfig({
    ...HOSTED,
    MM_BIND: "127.0.0.1",
    MM_TRUST_PROXY: "0",
    MM_APPS_ORIGIN: "https://apps.worklane.example",
    MM_DEMO_LOGIN: "0",
  });
  assert.deepEqual(
    [custom.bind, custom.trustProxy, custom.appsOrigin, custom.demoLogin],
    ["127.0.0.1", false, "https://apps.worklane.example", false],
  );
  const demo = readConfig({
    PORT: "1",
    MM_HOST_ORIGIN: ORIGIN,
    MM_PUBLIC_DEMO: "1",
  });
  assert.equal(demo.sitePassword, null, "a public demo on purpose");
  for (const origin of [
    "http://localhost:8080",
    "http://127.0.0.1:4100",
    "http://127.9.9.9",
    "http://[::1]:8080",
    "https://worklane.example:8443",
  ]) {
    assert.deepEqual(
      problemsOf({ ...HOSTED, MM_HOST_ORIGIN: origin }),
      [],
      origin,
    );
  }
  const emoji = "🔒".repeat(12);
  assert.deepEqual(problemsOf({ ...HOSTED, MM_SITE_PASSWORD: emoji }), []);
});

test("hosted mode reports every problem, one per line", () => {
  assert.deepEqual(problemsOf({ PORT: "8080" }), [
    "MM_HOST_ORIGIN is required in hosted mode: the site's public origin, like https://worklane.cranl.net",
    "MM_SITE_PASSWORD is required in hosted mode (MM_PUBLIC_DEMO=1 runs a public demo without one, on purpose)",
  ]);
  const many = problemsOf({
    PORT: "http",
    MM_HOST_ORIGIN: "http://worklane.example",
    MM_APPS_ORIGIN: "apps.worklane.example",
    MM_SITE_PASSWORD: "elevenchars",
    MM_TRUST_PROXY: "yes",
    MM_PUBLIC_DEMO: "true",
  });
  assert.equal(many.length, 6, many.join("\n"));
  for (const name of [
    "PORT",
    "MM_HOST_ORIGIN must use https:",
    "MM_APPS_ORIGIN must be an origin",
    "MM_SITE_PASSWORD must be at least 12 characters",
    "MM_TRUST_PROXY must be 0 or 1",
    "MM_PUBLIC_DEMO must be 0 or 1",
  ]) {
    assert.ok(
      many.some((problem) => problem.startsWith(name)),
      name,
    );
  }
  for (const origin of [
    `${ORIGIN}/`,
    `${ORIGIN}/app`,
    `${ORIGIN}?x=1`,
    "worklane.cranl.net",
    "ftp://worklane.cranl.net",
    "https://Worklane.cranl.net",
  ]) {
    const [problem] = problemsOf({ ...HOSTED, MM_HOST_ORIGIN: origin });
    assert.match(problem, /^MM_HOST_ORIGIN must be an origin/, origin);
  }
  assert.deepEqual(
    problemsOf({ ...HOSTED, MM_APPS_ORIGIN: `${ORIGIN}:8443` }),
    ["MM_APPS_ORIGIN must be on another host than MM_HOST_ORIGIN"],
  );
  assert.deepEqual(problemsOf({ ...HOSTED, MM_PUBLIC_DEMO: "1" }), [
    "Set MM_SITE_PASSWORD or MM_PUBLIC_DEMO=1, not both",
  ]);
  assert.deepEqual(problemsOf({ ...HOSTED, PORT: "65536" }), [
    "PORT must be a port number from 0 to 65535",
  ]);
});

test("the hosted banner: URL, gate, apps, data file, tokens; a warning without a gate", () => {
  const tokens = [
    { label: "read-write", token: "rw-token" },
    { label: "read-only", token: "ro-token" },
  ];
  const on = hostedBanner({
    hostOrigin: ORIGIN,
    appsOrigin: null,
    gate: true,
    file: "/data/worklane.json",
    tokens,
  });
  assert.equal(
    on,
    [
      "mini-monday is running (hosted)",
      `  Public URL   ${ORIGIN}`,
      "  Site gate    on (site password required)",
      "  Apps         off (set MM_APPS_ORIGIN to a second domain)",
      "  Data file    /data/worklane.json",
      `  GraphQL API  ${ORIGIN}/v2`,
      "  Token (read-write)  rw-token",
      "  Token (read-only)   ro-token",
      "",
    ].join("\n"),
  );
  const off = hostedBanner({
    hostOrigin: ORIGIN,
    appsOrigin: "https://apps.worklane.example",
    gate: false,
    file: null,
    tokens,
  });
  assert.match(off, /^!!! WARNING: MM_PUBLIC_DEMO=1: the site gate is OFF/);
  assert.match(off, /Site gate {4}OFF\n/);
  assert.match(off, /Apps {9}on at https:\/\/apps\.worklane\.example\n/);
  assert.match(off, /Data file {4}:memory: \(not saved\)\n/);
});

test("main() in hosted mode starts one listener and never prints the password", async (t) => {
  let output = "";
  const stdout = { write: (text) => void (output += text) };
  const env = {
    PORT: "0",
    MM_BIND: "127.0.0.1",
    MM_HOST_ORIGIN: "http://localhost:4100",
    MM_SITE_PASSWORD: PASSWORD,
    MM_DATA_FILE: ":memory:",
  };
  const { servers, stop } = await main({ env, stdout, log: { error() {} } });
  t.after(stop);
  assert.equal(servers.appsServer, null);
  assert.match(output, /^mini-monday is running \(hosted\)\n/);
  assert.ok(!output.includes(PASSWORD));
  const { port } = servers.hostServer.address();
  const health = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(await health.text(), "ok");
  await assert.rejects(main({ env: { PORT: "8080" }, stdout }), ConfigError);
});

/** A port nothing listens on right now. */
const freePort = () =>
  new Promise((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

/** Runs server/main.js with exactly `env` (plus PATH); collects output. */
function run(env) {
  const child = spawn(process.execPath, [MAIN], {
    env: { PATH: process.env.PATH, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => (output.stdout += chunk));
  child.stderr.on("data", (chunk) => (output.stderr += chunk));
  const exited = new Promise((resolve) => child.once("exit", resolve));
  return { child, output, exited };
}

test("server/main.js exits 1 with one line per problem, never half-started", async () => {
  const bad = run({ PORT: "8080", MM_SITE_PASSWORD: "short" });
  assert.equal(await bad.exited, 1);
  assert.equal(bad.output.stdout, "");
  const lines = bad.output.stderr.trimEnd().split("\n");
  assert.deepEqual(lines, [
    "mini-monday: MM_HOST_ORIGIN is required in hosted mode: the site's public origin, like https://worklane.cranl.net",
    "mini-monday: MM_SITE_PASSWORD must be at least 12 characters long",
  ]);
});

test("server/main.js serves hosted mode on PORT and stops on SIGTERM", async (t) => {
  const port = await freePort();
  const started = run({
    PORT: String(port),
    MM_BIND: "127.0.0.1",
    MM_HOST_ORIGIN: `http://localhost:${port}`,
    MM_SITE_PASSWORD: PASSWORD,
    MM_DATA_FILE: ":memory:",
  });
  t.after(() => started.child.kill("SIGKILL"));
  await new Promise((resolve, reject) => {
    started.child.stdout.on("data", () => {
      if (started.output.stdout.includes("Token (read-only)")) resolve();
    });
    started.child.once("exit", () => reject(new Error(started.output.stderr)));
  });
  assert.match(
    started.output.stdout,
    new RegExp(`Public URL {3}http://localhost:${port}\n`),
  );
  const health = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(await health.text(), "ok");
  const locked = await fetch(`http://127.0.0.1:${port}/`, {
    redirect: "manual",
  });
  assert.equal(locked.status, 401, "fetch is not a page load");
  started.child.kill("SIGTERM");
  assert.equal(await started.exited, 0);
  const all = started.output.stdout + started.output.stderr;
  assert.ok(!all.includes(PASSWORD), "the password is never printed");
});
