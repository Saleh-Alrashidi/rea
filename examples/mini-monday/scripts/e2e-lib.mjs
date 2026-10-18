/**
 * Shared harness of the browser tests (`e2e-smoke.mjs`, `e2e-roles.mjs`,
 * `e2e-hosted.mjs`, `e2e-import.mjs`).
 *
 * `runE2E({ name, steps })` starts the host and apps servers over an
 * in-memory store, launches headless Chromium and runs the steps in order,
 * stopping at the first failure. Every browser context made through
 * `run.newContext()` is watched: console errors, page errors, CSP
 * violations (in every frame), failed requests, HTTP responses >= 400 and
 * server-logged warnings and errors fail the run, unless a step announced
 * the response it provokes with `run.expectHttp(status, path)`. A stream
 * the page closes itself (`EventSource.close()` when leaving a board) is
 * reported by Chromium as an aborted request and is not a problem.
 *
 * Skip rules (SPEC.md "Layout": the browser tests are optional): when
 * neither `playwright` nor `playwright-core` can be imported, or no
 * Chromium is installed, the run prints why and exits 0. MM_E2E_CHROMIUM
 * names a browser executable; MM_HOST_PORT / MM_APPS_PORT (default 0, a
 * free port) and MM_BIND choose where the servers listen (a script can
 * start other servers with `serve`, as `e2e-hosted.mjs` and
 * `e2e-import.mjs` do). Screenshots
 * go to `e2e-output/`.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { startServers } from "../server/http.js";
import { localModeEnv, readConfig } from "../server/main.js";
import { createStore } from "../server/store.js";
import { launchBrowser, loadPlaywright } from "./e2e-browser.mjs";

export const WAIT_MS = 10_000;
export const DESKTOP = { width: 1280, height: 860 };
export const MOBILE = { width: 360, height: 740 };
export const OUTPUT_DIR = fileURLToPath(
  new URL("../e2e-output/", import.meta.url),
);

// ----------------------------------------------------------------- checks

export function fail(message) {
  throw new Error(message);
}

export function check(condition, message) {
  if (!condition) fail(message);
}

/** Polls `probe` until it returns a truthy value; returns that value. */
export async function waitUntil(probe, label, timeout = WAIT_MS) {
  const deadline = Date.now() + timeout;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      last = `: ${error.message.split("\n")[0]}`;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fail(`timed out waiting for ${label}${last}`);
}

// --------------------------------------------------------------- problems

/**
 * Marks an announced response (`run.expectHttp`) matching `status` and
 * `url` as seen; true when the response was expected.
 */
function takeExpected(run, status, url) {
  const { pathname } = new URL(url);
  const entry = run.expected.find(
    (candidate) =>
      candidate.status === status &&
      pathname === candidate.path &&
      (candidate.repeat || !candidate.seen),
  );
  if (!entry) return false;
  entry.seen = true;
  run.seenExpected.add(`${status} ${url}`);
  return true;
}

/** A stream the page closed itself, e.g. a board's events on leaving it. */
const closedStream = (request) =>
  request.resourceType() === "eventsource" &&
  request.failure()?.errorText === "net::ERR_ABORTED";

/** Chromium logs every >= 400 response once more as a console error. */
function expectedConsole(run, message) {
  if (!message.text().startsWith("Failed to load resource")) return false;
  const url = message.location()?.url ?? "";
  for (const seen of run.seenExpected) {
    if (seen.endsWith(` ${url}`)) return true;
  }
  return false;
}

/** Records every browser problem the run must not have. */
async function watchProblems(run, context, label) {
  const { problems } = run;
  const add = (text) => problems.push(`[${label}] ${text}`);
  await context.exposeBinding("__mmCspViolation", (source, detail) =>
    add(`CSP violation in ${source.frame.url()}: ${detail}`),
  );
  // Runs in every frame, the cross-site app iframe included.
  await context.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) =>
      globalThis.__mmCspViolation?.(
        `${event.violatedDirective} blocked ${event.blockedURI}`,
      ),
    );
  });
  context.on("console", (message) => {
    if (message.type() !== "error" || expectedConsole(run, message)) return;
    add(`console: ${message.text()} (${message.location()?.url ?? ""})`);
  });
  context.on("weberror", (error) => add(`page: ${error.error()}`));
  context.on("requestfailed", (request) => {
    if (closedStream(request)) return;
    add(`request failed: ${request.url()} ${request.failure()?.errorText}`);
  });
  context.on("response", (response) => {
    const status = response.status();
    if (status >= 400 && !takeExpected(run, status, response.url())) {
      add(`HTTP ${status}: ${response.url()}`);
    }
    if (response.request().resourceType() !== "document") return;
    const kind = response.url().startsWith(run.appsOrigin) ? "app" : "host";
    run.documentCsp.set(kind, response.headers()["content-security-policy"]);
  });
}

/** A server log that turns warnings and errors into problems. */
function problemLog(problems) {
  const record = (level) => (message, error) =>
    problems.push(`server ${level}: ${message} ${error?.stack ?? ""}`);
  return { error: record("error"), warn: record("warn"), info() {}, log() {} };
}

// -------------------------------------------------------------------- api

/**
 * Runs GraphQL through the public endpoint as `userId`, with a fresh
 * browser session (cookie plus the host Origin, as the web app sends
 * them). Returns `{ data, errors }`; `fail`s on a non-JSON or 5xx answer.
 */
async function apiAs(run, { userId, query, variables = {} }) {
  const session = run.servers.auth.createBrowserSession(String(userId));
  const response = await fetch(`${run.hostOrigin}/v2`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `mm_session=${session}`,
      Origin: run.hostOrigin,
    },
    body: JSON.stringify({ query, variables }),
  });
  check(response.status < 500, `API answered ${response.status}`);
  return response.json();
}

/** The data of `run.apiAs`, failing on GraphQL errors. */
export async function dataAs(run, userId, query, variables) {
  const body = await run.apiAs(userId, query, variables);
  if (body.errors) fail(`API errors: ${JSON.stringify(body.errors)}`);
  return body.data;
}

/** The first error code of `run.apiAs` (null when it succeeded). */
export async function errorCodeAs(run, userId, query, variables) {
  const body = await run.apiAs(userId, query, variables);
  return body.errors?.[0]?.extensions?.code ?? null;
}

// ------------------------------------------------------------------- seed

/**
 * IDs of seeded records by name (SPEC-2 §2.1), looked up once before any
 * step renames them: `users` by lower-case first name, plus the boards,
 * workspace, item, install, doc, note, form and team the tests visit.
 */
export function seedIds(store) {
  const named = (list, key, value) =>
    list.find((record) => record[key] === value).id;
  const boards = store.listBoards({ limit: 500 });
  const roadmap = named(boards, "name", "Product roadmap");
  const users = {};
  for (const user of store.listUsers()) {
    users[user.name.split(" ")[0].toLowerCase()] = user.id;
  }
  return {
    users,
    roadmap,
    marketing: named(boards, "name", "Marketing launch"),
    workspace: named(store.listWorkspaces(), "name", "Main workspace"),
    install: store.listInstalls({ boardId: roadmap })[0].id,
    item: store.listItems({ boardId: roadmap, limit: 1 }).items[0].id,
    vision: named(store.listDocs({}), "title", "Product vision"),
    ideas: named(store.listNotes({}), "title", "Ideas for Q1"),
    featureForm: named(store.listForms({}), "title", "Feature request"),
    productTeam: named(store.listTeams(), "name", "Product"),
  };
}

// ------------------------------------------------------------------ pages

/**
 * Waits until `#page` shows no loading skeletons (the page's data arrived),
 * then a short quiet period for follow-up renders.
 */
export async function pageReady(page) {
  const skeletons = page.locator(
    "#page .skeleton, #page .skeleton-block, #page .skeleton-list",
  );
  await waitUntil(
    async () => (await skeletons.count()) === 0,
    "the page to finish loading",
  );
  await page.waitForTimeout(150);
}

/** Navigates the app to `hash` ("#/home") and waits for the page. */
export async function openHash(page, run, hash) {
  const url = `${run.hostOrigin}/${hash}`;
  // The same URL again fires no hashchange, so reload to open it afresh.
  if (page.url() === url) await page.reload();
  else await page.goto(url);
  // Attached, not visible: under 900 px the sidebar is a closed drawer.
  await page
    .locator("#sidebar .nav-link")
    .first()
    .waitFor({ state: "attached" });
  await pageReady(page);
}

/**
 * A watched browser signed in as `userId` (see `newContext`), showing
 * `hash`. Returns `{ context, page }`; the page is also `run.page`, so a
 * failure screenshot shows it.
 */
export async function signedIn(run, userId, options = {}) {
  const context = await run.newContext({ userId, ...options });
  const page = await context.newPage();
  run.page = page;
  await openHash(page, run, options.hash ?? "#/home");
  return { context, page };
}

/** How far the page scrolls sideways (0 when it fits the viewport). */
export const sidewaysOverflow = (page) =>
  page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );

// -------------------------------------------------------------------- run

/** Saves a screenshot of `page` as `e2e-output/<name>`. */
export async function screenshot(run, page, name) {
  const file = path.join(run.outputDir, name);
  await page.screenshot({ path: file, fullPage: false });
  run.screenshots.push(file);
  return file;
}

/**
 * A watched browser context. `userId` signs it in with a fresh browser
 * session for that user (what the demo switcher does); without it the
 * context is anonymous and `GET /` signs it in as user 1 in demo mode.
 */
async function newContext(run, options = {}) {
  const { userId, label = userId ? `user ${userId}` : "browser" } = options;
  const context = await run.browser.newContext({
    viewport: options.viewport ?? DESKTOP,
    colorScheme: options.colorScheme ?? "light",
  });
  context.setDefaultTimeout(WAIT_MS);
  await watchProblems(run, context, label);
  if (userId) {
    const value = run.servers.auth.createBrowserSession(String(userId));
    await context.addCookies([
      {
        name: "mm_session",
        value,
        url: run.hostOrigin,
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);
  }
  run.contexts.push(context);
  return context;
}

/**
 * Runs the steps in order and stops at the first failure. MM_E2E_STEPS
 * ("2,5") runs only those step numbers, a development aid: later steps may
 * depend on earlier ones.
 */
async function runSteps(run, steps, prefix) {
  const only = process.env.MM_E2E_STEPS?.split(",").map(Number);
  console.log(`1..${steps.length}`);
  for (const [index, [name, step]] of steps.entries()) {
    if (only && !only.includes(index + 1)) {
      console.log(`ok ${index + 1} - ${name} # SKIP not selected`);
      continue;
    }
    const started = Date.now();
    run.expected = [];
    try {
      await step(run);
      const missing = run.expected
        .filter((entry) => !entry.seen)
        .map((entry) => `${entry.status} ${entry.path}`);
      check(missing.length === 0, `expected responses not seen: ${missing}`);
      console.log(`ok ${index + 1} - ${name} (${Date.now() - started} ms)`);
    } catch (error) {
      console.log(`not ok ${index + 1} - ${name}\n  ${error.message}`);
      const file = path.join(OUTPUT_DIR, `${prefix}failure-${index + 1}.png`);
      await run.page?.screenshot({ path: file }).catch(() => {});
      console.log(`  screenshot: ${file}`);
      return false;
    }
  }
  return true;
}

function createRun({ browser, servers, store, problems }) {
  const tokens = store.listApiTokens();
  const run = {
    browser,
    servers,
    store,
    problems,
    hostOrigin: servers.hostOrigin,
    appsOrigin: servers.appsOrigin,
    token: tokens.find((record) => record.label === "read-write").token,
    outputDir: OUTPUT_DIR,
    documentCsp: new Map(),
    screenshots: [],
    contexts: [],
    expected: [],
    seenExpected: new Set(),
    page: null,
  };
  run.newContext = (options) => newContext(run, options);
  /**
   * Announces a response >= 400 that the current step provokes: once, or
   * any number of times (at least once) with `{ repeat: true }`.
   */
  run.expectHttp = (status, urlPath, { repeat = false } = {}) =>
    run.expected.push({ status, path: urlPath, repeat, seen: false });
  /** Tolerates a response >= 400 that timing may or may not produce. */
  run.allowHttp = (status, urlPath) =>
    run.expected.push({ status, path: urlPath, repeat: true, seen: true });
  run.apiAs = (userId, query, variables) =>
    apiAs(run, { userId, query, variables });
  return run;
}

async function drive(context, { name, steps, prefix, setup }) {
  const run = createRun(context);
  await setup?.(run);
  const passed = await runSteps(run, steps, prefix);
  for (const browserContext of run.contexts) {
    await browserContext.close().catch(() => {});
  }
  for (const problem of context.problems) console.log(`problem: ${problem}`);
  for (const file of run.screenshots) console.log(`screenshot: ${file}`);
  const ok = passed && context.problems.length === 0;
  console.log(ok ? `${name}: passed` : `${name}: FAILED`);
  return ok;
}

/**
 * Where the default `serve` listens: local mode (whatever `PORT` or
 * hosted-only variable `env` inherits), on free ports unless
 * MM_HOST_PORT / MM_APPS_PORT say otherwise.
 */
export function localServeConfig(env = process.env) {
  const { hostPort, appsPort, bind } = readConfig({
    ...localModeEnv(env),
    MM_HOST_PORT: env.MM_HOST_PORT || "0",
    MM_APPS_PORT: env.MM_APPS_PORT || "0",
  });
  return { hostPort, appsPort, bind };
}

/** The default `serve`: local mode over an in-memory store. */
export async function serveLocal(log) {
  const { hostPort, appsPort, bind } = localServeConfig();
  const store = await createStore({ file: null, log });
  const servers = await startServers({ store, hostPort, appsPort, bind, log });
  return { store, servers };
}

async function start({ serve = serveLocal, ...options }) {
  const playwright = await loadPlaywright();
  if (!playwright) {
    console.log("playwright not available; skipping");
    return 0;
  }
  const problems = [];
  const log = problemLog(problems);
  await mkdir(OUTPUT_DIR, { recursive: true });
  const served = await serve(log);
  const { store, servers } = served;
  let browser = null;
  try {
    browser = await launchBrowser(playwright.chromium);
    if (!browser) {
      console.log("playwright Chromium not installed; skipping");
      return 0;
    }
    const context = { browser, servers, store, problems };
    return (await drive(context, options)) ? 0 : 1;
  } finally {
    await browser?.close();
    await servers.close();
    await served.close?.();
  }
}

/**
 * Runs `steps` (`[name, async step(run)]`, in order) and sets the exit
 * code. `prefix` names failure screenshots (`<prefix>failure-<n>.png`);
 * `setup(run)` runs once before the first step; `serve(log)` starts the
 * servers (`{ store, servers }`, `servers` as `startServers` returns
 * them, and optionally `close()` for whatever else it started, called
 * after the servers close), local mode over an in-memory store by default
 * (`serveLocal`).
 *
 * A step receives `run`: `{ browser, servers, store, hostOrigin,
 * appsOrigin, token, outputDir, documentCsp, screenshots, newContext(
 * { userId, label, viewport, colorScheme }), expectHttp(status, path,
 * { repeat }), allowHttp(status, path), apiAs(userId, query, variables),
 * page }` and may add fields for later steps. Set `run.page` to the page a
 * failure screenshot should show.
 */
export function runE2E({ totalMs = 180_000, ...options }) {
  const { name } = options;
  const watchdog = setTimeout(() => {
    console.error(`${name}: no result after ${totalMs / 1000} s`);
    process.exit(1);
  }, totalMs);
  watchdog.unref();
  start({ prefix: "", ...options }).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`${name}: error:`, error);
      process.exitCode = 1;
    },
  );
}
