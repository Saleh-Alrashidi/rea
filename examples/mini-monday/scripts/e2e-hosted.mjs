#!/usr/bin/env node
/**
 * Browser test of a private hosted deployment (SPEC-3): starts
 * `server/main.js`'s `main()` in hosted mode (`PORT`, an
 * `MM_HOST_ORIGIN`, a site password, no apps origin, an in-memory store)
 * and drives Chromium through the site gate: a deep link redirects to
 * `/signin`, a wrong password shows the error, the right one lands on the
 * requested page, a board works (without app tabs), demo user switching
 * stays signed in, a public form works signed out, and signing out
 * returns to `/signin` for good. Changes are confirmed through the API
 * with the seeded token, which the gate lets through on its own.
 *
 * Usage: `node scripts/e2e-hosted.mjs`. The harness and skip rules are
 * described in `e2e-lib.mjs`; `PORT` (default: a free port) and `MM_BIND`
 * (default 127.0.0.1) choose where the server listens.
 */
import { createServer } from "node:net";
import process from "node:process";
import { main } from "../server/main.js";
import {
  MOBILE,
  check,
  fail,
  openHash,
  pageReady,
  runE2E,
  screenshot,
  seedIds,
  sidewaysOverflow,
  waitUntil,
} from "./e2e-lib.mjs";

const PASSWORD = "e2e hosted site password";
const ITEM_NAME = "Planned behind the gate";
const REQUEST_TITLE = "Answered without signing in";
const ITEM_NAMES = `query Names($id: ID!) {
  boards(ids: [$id]) { views { type } items_page(limit: 500) { items { name } } }
}`;

/** A port nothing listens on right now. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Hosted mode through the real entry point's configuration. */
async function serveHosted(log) {
  const port = process.env.PORT || String(await freePort());
  const env = {
    PORT: port,
    MM_BIND: process.env.MM_BIND || "127.0.0.1",
    MM_HOST_ORIGIN: `http://localhost:${port}`,
    MM_SITE_PASSWORD: PASSWORD,
    MM_DATA_FILE: ":memory:",
  };
  let banner = "";
  const stdout = { write: (text) => void (banner += text) };
  const { servers, store } = await main({ env, stdout, log });
  check(banner.includes("Site gate    on"), `banner: ${banner}`);
  check(!banner.includes(PASSWORD), "the banner never shows the password");
  return { servers, store };
}

/** GraphQL with the seeded read-write token (no site session). */
async function tokenApi(run, query, variables) {
  const response = await fetch(`${run.hostOrigin}/v2`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${run.token}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json();
  if (!response.ok || body.errors) fail(`API ${JSON.stringify(body)}`);
  return body.data;
}

const boardNames = async (run, id) => {
  const [board] = (await tokenApi(run, ITEM_NAMES, { id })).boards;
  return board.items_page.items.map((item) => item.name);
};

const at = (page) => new URL(page.url());

async function submitPassword(page, password) {
  await page.locator("#signin-password").fill(password);
  await page.locator("#signin-password").press("Enter");
}

// -------------------------------------------------------------------- steps

async function redirectToSignin(run) {
  const context = await run.newContext({ label: "browser" });
  run.page = await context.newPage();
  const { page } = run;
  await page.goto(`${run.hostOrigin}/#/my-work`);
  await page.locator("#signin-form").waitFor();
  const url = at(page);
  check(url.pathname === "/signin", `path ${url.pathname}`);
  check(url.search === "?next=%2F", `search ${url.search}`);
  check(url.hash === "#/my-work", `the hash rides along: ${url.hash}`);
  check((await page.title()) === "Sign in · Worklane", "title");
  check(
    (await page.locator(".brand-word").textContent()) === "Worklane",
    "wordmark",
  );
  const label = page.locator("label[for=signin-password]");
  check((await label.textContent()).trim() === "Site password", "label");
  const csp = run.documentCsp.get("host") ?? "";
  check(csp.includes("script-src 'self'"), `CSP ${csp}`);
  check(!csp.includes("frame-src"), "no frame-src without an apps origin");
  await screenshot(run, page, "hosted-signin.png");
}

async function wrongPassword(run) {
  const { page } = run;
  run.expectHttp(401, "/signin");
  const started = Date.now();
  await submitPassword(page, "not the site password");
  const error = page.locator("#signin-error");
  await error.waitFor({ state: "visible" });
  check(Date.now() - started >= 250, "a wrong password waits ~300 ms");
  check(/isn’t right/.test(await error.textContent()), "error text");
  const input = page.locator("#signin-password");
  check((await input.getAttribute("aria-invalid")) === "true", "invalid");
  check(
    await input.evaluate((element) => element === document.activeElement),
    "focus returns to the password",
  );
  await screenshot(run, page, "hosted-signin-error.png");
  // Dark theme at phone width: the card fits.
  const dark = await run.newContext({
    label: "dark",
    colorScheme: "dark",
    viewport: MOBILE,
  });
  const small = await dark.newPage();
  await small.goto(`${run.hostOrigin}/signin`);
  await small.locator("#signin-form").waitFor();
  check((await sidewaysOverflow(small)) <= 0, "no sideways scroll at 360 px");
  await screenshot(run, small, "hosted-signin-dark-360.png");
  await dark.close();
}

async function signInLands(run) {
  const { page } = run;
  await submitPassword(page, PASSWORD);
  await waitUntil(
    () => page.url() === `${run.hostOrigin}/#/my-work`,
    "the requested page",
  );
  await page.locator("#sidebar .nav-link").first().waitFor();
  await pageReady(page);
  const title = await page.locator("#page h1").first().textContent();
  check(title.includes("My work"), `page title ${title}`);
}

async function useBoard(run) {
  const { page } = run;
  run.seed = seedIds(run.store);
  await openHash(page, run, `#/boards/${run.seed.roadmap}`);
  const tabs = await page.locator(".view-tab").allTextContents();
  check(tabs.includes("Main table"), `tabs ${tabs}`);
  check(!tabs.some((text) => /status summary/i.test(text)), "no app tab");
  check((await page.locator("iframe").count()) === 0, "no app frame");
  const input = page.locator(".add-item-input").first();
  await input.fill(ITEM_NAME);
  await input.press("Enter");
  await waitUntil(
    async () => (await boardNames(run, run.seed.roadmap)).includes(ITEM_NAME),
    "the new item through the API",
  );
  const { boards } = await tokenApi(run, ITEM_NAMES, { id: run.seed.roadmap });
  const types = boards[0].views.map((view) => view.type);
  check(!types.includes("app"), `API views ${types}`);
  await screenshot(run, page, "hosted-board.png");
}

async function demoSwitchStaysSignedIn(run) {
  const { page } = run;
  await page.locator(".user-menu-button").click();
  await page.locator(".menu-item", { hasText: "Sam Lee" }).click();
  await waitUntil(
    async () =>
      (await page.locator(".user-menu-button").getAttribute("title")) ===
      "Sam Lee",
    "the switch to Sam",
  );
  check(at(page).pathname === "/", "still past the gate after switching");
}

async function publicFormSignedOut(run) {
  const form = run.store.getForm(run.seed.featureForm);
  const visitor = await run.newContext({ label: "visitor" });
  const pub = await visitor.newPage();
  await pub.goto(`${run.hostOrigin}/f/${form.token}`);
  await pub.locator(".fr-form").waitFor();
  await pub
    .locator(".fr-question input[type=text]")
    .first()
    .fill(REQUEST_TITLE);
  await pub.locator(".fr-submit").click();
  await pub.locator(".fr-success").waitFor();
  await screenshot(run, pub, "hosted-public-form.png");
  const names = await boardNames(run, form.board_id);
  check(names.includes(REQUEST_TITLE), "the response created an item");
  // The same signed-out browser still meets the gate everywhere else.
  await pub.goto(`${run.hostOrigin}/`);
  await pub.locator("#signin-form").waitFor();
  await visitor.close();
}

async function logoutReturnsToSignin(run) {
  const { page } = run;
  // The notification stream ends with the session; a reconnect is refused.
  run.allowHttp(401, "/v2/events");
  await page.locator(".user-menu-button").click();
  await page.locator(".menu-item", { hasText: "Sign out" }).click();
  await page.locator("#signin-form").waitFor();
  check(at(page).pathname === "/signin", `after sign-out ${page.url()}`);
  // No auto-login: the app stays behind the gate.
  await page.goto(`${run.hostOrigin}/#/home`);
  await page.locator("#signin-form").waitFor();
  check(at(page).pathname === "/signin", "no auto-login");
  run.expectHttp(401, "/v2");
  const status = await page.evaluate(async () => {
    const response = await fetch("/v2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "{ me { id } }" }),
    });
    const body = await response.json();
    return `${response.status} ${body.errors[0].extensions.code}`;
  });
  check(status === "401 SITE_LOCKED", `API after sign-out: ${status}`);
  await screenshot(run, page, "hosted-signed-out.png");
}

runE2E({
  name: "e2e hosted",
  prefix: "hosted-",
  serve: serveHosted,
  steps: [
    ["a deep link redirects to /signin", redirectToSignin],
    ["a wrong password shows the error", wrongPassword],
    ["signing in lands on the requested page", signInLands],
    ["a board works, without app tabs", useBoard],
    ["demo user switching stays signed in", demoSwitchStaysSignedIn],
    ["a public form works signed out", publicFormSignedOut],
    ["signing out returns to /signin", logoutReturnsToSignin],
  ],
});
