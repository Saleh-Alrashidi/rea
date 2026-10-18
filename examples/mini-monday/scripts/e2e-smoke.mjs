#!/usr/bin/env node
/**
 * Browser smoke test: starts the host and apps servers over an in-memory
 * store, drives the boards app and the Status summary app in headless
 * Chromium (steps in `e2e-steps.mjs`), checks each change through the public
 * GraphQL API, and fails on console errors, page errors, CSP violations,
 * failed or rejected requests and server-logged errors. Screenshots go to
 * `e2e-output/`.
 *
 * Usage: `node scripts/e2e-smoke.mjs` (or `npm run e2e`). Ports come from
 * MM_HOST_PORT / MM_APPS_PORT (default 0, a free port) and MM_BIND.
 * MM_E2E_CHROMIUM names a browser executable. When neither `playwright` nor
 * `playwright-core` can be imported, or no Chromium is installed, the test
 * prints why and exits 0 (it is optional, see SPEC.md "Layout").
 */
import { access, mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { startServers } from "../server/http.js";
import { readConfig } from "../server/main.js";
import { createStore } from "../server/store.js";
import { DESKTOP, STEPS, WAIT_MS } from "./e2e-steps.mjs";

const OUTPUT_DIR = fileURLToPath(new URL("../e2e-output/", import.meta.url));
const TOTAL_MS = 180_000;
const CHROME_PATHS = {
  linux: [
    ["chrome-linux", "chrome"],
    ["chrome-linux64", "chrome"],
  ],
  darwin: [["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"]],
  win32: [["chrome-win", "chrome.exe"]],
};

async function loadPlaywright() {
  for (const name of ["playwright", "playwright-core"]) {
    try {
      const module = await import(name);
      return module.chromium ? module : module.default;
    } catch (error) {
      if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
    }
  }
  return null;
}

/** A Chromium from the Playwright browser cache, newest revision first. */
async function installedChromium() {
  const root =
    process.env.PLAYWRIGHT_BROWSERS_PATH ||
    path.join(homedir(), ".cache", "ms-playwright");
  const names = (await readdir(root).catch(() => []))
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
  for (const name of names) {
    for (const parts of CHROME_PATHS[process.platform] ?? []) {
      const file = path.join(root, name, ...parts);
      if (
        await access(file).then(
          () => true,
          () => false,
        )
      )
        return file;
    }
  }
  return null;
}

/** Launches headless Chromium, or returns null when none is installed. */
async function launchBrowser(chromium) {
  // Chromium refuses its sandbox when run as root (as in containers).
  const args = process.getuid?.() === 0 ? ["--no-sandbox"] : [];
  const executablePath = process.env.MM_E2E_CHROMIUM || undefined;
  try {
    return await chromium.launch({ headless: true, args, executablePath });
  } catch (error) {
    if (executablePath || !/Executable doesn't exist/.test(error.message)) {
      throw error;
    }
  }
  // The installed Playwright may expect a browser revision that is missing.
  const fallback = await installedChromium();
  if (!fallback) return null;
  return chromium.launch({ headless: true, args, executablePath: fallback });
}

/** Records every browser problem the run must not have. */
async function watchProblems(run, context) {
  const { problems } = run;
  await context.exposeBinding("__mmCspViolation", (source, detail) =>
    problems.push(`CSP violation in ${source.frame.url()}: ${detail}`),
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
    if (message.type() === "error") problems.push(`console: ${message.text()}`);
  });
  context.on("weberror", (error) => problems.push(`page: ${error.error()}`));
  context.on("requestfailed", (request) =>
    problems.push(`request failed: ${request.url()}`),
  );
  context.on("response", (response) => {
    if (response.status() >= 400) {
      problems.push(`HTTP ${response.status()}: ${response.url()}`);
    }
    if (response.request().resourceType() !== "document") return;
    const kind = response.url().startsWith(run.appsOrigin) ? "app" : "host";
    run.documentCsp.set(kind, response.headers()["content-security-policy"]);
  });
}

/** Runs the steps in order and stops at the first failure. */
async function runSteps(run) {
  for (const [index, [name, step]] of STEPS.entries()) {
    const started = Date.now();
    try {
      await step(run);
      console.log(`ok ${index + 1} - ${name} (${Date.now() - started} ms)`);
    } catch (error) {
      console.log(`not ok ${index + 1} - ${name}\n  ${error.message}`);
      const file = path.join(OUTPUT_DIR, `failure-${index + 1}.png`);
      await run.page.screenshot({ path: file }).catch(() => {});
      console.log(`  screenshot: ${file}`);
      return false;
    }
  }
  return true;
}

async function drive({ browser, servers, store, problems }) {
  const context = await browser.newContext({ viewport: DESKTOP });
  context.setDefaultTimeout(WAIT_MS);
  const tokens = store.listApiTokens();
  const run = {
    hostOrigin: servers.hostOrigin,
    appsOrigin: servers.appsOrigin,
    store,
    problems,
    token: tokens.find((record) => record.label === "read-write").token,
    outputDir: OUTPUT_DIR,
    documentCsp: new Map(),
    screenshots: [],
  };
  await watchProblems(run, context);
  run.page = await context.newPage();
  console.log(`1..${STEPS.length}`);
  const passed = await runSteps(run);
  await context.close();
  for (const problem of problems) console.log(`problem: ${problem}`);
  for (const file of run.screenshots) console.log(`screenshot: ${file}`);
  return passed && problems.length === 0;
}

/** A server log that turns warnings and errors into problems. */
function problemLog(problems) {
  const record = (level) => (message, error) =>
    problems.push(`server ${level}: ${message} ${error?.stack ?? ""}`);
  return { error: record("error"), warn: record("warn"), info() {}, log() {} };
}

async function main() {
  const playwright = await loadPlaywright();
  if (!playwright) {
    console.log("playwright not available; skipping");
    return 0;
  }
  const env = process.env;
  const { hostPort, appsPort, bind } = readConfig({
    ...env,
    MM_HOST_PORT: env.MM_HOST_PORT || "0",
    MM_APPS_PORT: env.MM_APPS_PORT || "0",
  });
  const problems = [];
  const log = problemLog(problems);
  await mkdir(OUTPUT_DIR, { recursive: true });
  const store = await createStore({ file: null, log });
  const servers = await startServers({ store, hostPort, appsPort, bind, log });
  let browser = null;
  try {
    browser = await launchBrowser(playwright.chromium);
    if (!browser) {
      console.log("playwright Chromium not installed; skipping");
      return 0;
    }
    const passed = await drive({ browser, servers, store, problems });
    console.log(passed ? "e2e smoke: passed" : "e2e smoke: FAILED");
    return passed ? 0 : 1;
  } finally {
    await browser?.close();
    await servers.close();
  }
}

const watchdog = setTimeout(() => {
  console.error(`e2e smoke: no result after ${TOTAL_MS / 1000} s`);
  process.exit(1);
}, TOTAL_MS);
watchdog.unref();

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error("e2e smoke: error:", error);
    process.exitCode = 1;
  },
);
