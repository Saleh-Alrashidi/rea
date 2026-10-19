#!/usr/bin/env node
/**
 * Browser test of the importer (SPEC-4 §7): starts the fake monday.com
 * GraphQL server and the fake ClickUp REST server
 * (`test/fixtures/import/`), points Worklane at them with
 * `MM_IMPORT_MONDAY_URL` / `MM_IMPORT_CLICKUP_URL` (the test override of
 * the fixed upstream hosts) and drives the wizard in Chromium as the
 * admin: the Admin page's Import tab, a member without the importer, a
 * monday scan with live progress that is cancelled, a monday scan to the
 * review (tree, people, warnings) with one person invited, the import
 * with its progress and done step (counts, links, the warnings as a .txt
 * download), the imported board with its badge, items, statuses, people
 * and updates (every imported board opens in the List view; the checks
 * read its Main table and open items in the task view, SPEC-6 §1.1), then
 * a ClickUp import (running its scan again is refused with 409, SPEC-5
 * §2.5), a CSV file and a monday Excel export built by
 * `test/fixtures/import/make-xlsx.js` (its subitems are real subitems).
 *
 * Every wizard step is photographed light, dark and 360 px wide
 * (`e2e-output/import-<n>-<step>[-dark|-360].png`). The source tokens
 * must never reach the page's storage, its DOM, a job or a download.
 *
 * The ClickUp scan skips docs and lowers the update limit to 40 (comments
 * of the first tasks only), so it stays under ClickUp's 90 requests a
 * minute and needs no throttle wait (a full scan of the fixture takes
 * about three minutes).
 *
 * Usage: `node scripts/e2e-import.mjs`. The harness, environment
 * variables and skip rules are described in `e2e-lib.mjs`.
 */
import process from "node:process";
import { startClickUpServer } from "../test/fixtures/import/clickup-server.js";
import { sampleMondayExport } from "../test/fixtures/import/make-xlsx.js";
import { startMondayServer } from "../test/fixtures/import/monday-server.js";
import {
  JOB_WAIT_MS,
  checkItem,
  checkSidebarFits,
  chooseSource,
  jobOf,
  openImportedBoard,
  scanFile,
  scanWithToken,
  shots,
  startImport,
  stepTitle,
  toMainTable,
  waitStep,
} from "./e2e-import-lib.mjs";
import {
  check,
  dataAs,
  openHash,
  runE2E,
  screenshot,
  seedIds,
  serveLocal,
  signedIn,
  waitUntil,
} from "./e2e-lib.mjs";

const upstreams = {};
const IMPORTED = `{
  boards(limit: 500) { id name import { source source_id } }
  users { name email role }
  notifications(limit: 50) { kind text }
}`;
const PARENTS = `query ($ids: [ID!]) {
  boards(ids: $ids, limit: 1) {
    items_page(limit: 100) { items { name parent_item { name } } }
  }
}`;
const CSV_TEXT = [
  "Name,Status,Owner,Due,Estimate,Group",
  "Write the spec,Done,fox@acme.test,2026-10-01,3,Now",
  "Build it,Working on it,,2026-10-12,8,Now",
  "Ship it,,fox@acme.test,,=1+1,Later",
].join("\n");

/** Local mode plus the two fake upstreams, which `close()` stops. */
async function serveWithUpstreams(log) {
  upstreams.monday = await startMondayServer();
  upstreams.clickup = await startClickUpServer();
  process.env.MM_IMPORT_MONDAY_URL = upstreams.monday.endpoint;
  process.env.MM_IMPORT_CLICKUP_URL = upstreams.clickup.endpoint;
  const served = await serveLocal(log);
  const close = async () => {
    await upstreams.monday.close();
    await upstreams.clickup.close();
  };
  return { ...served, close };
}

/** Nothing the page keeps or shows may contain a source token. */
async function checkNoTokens(run, page) {
  const tokens = [upstreams.monday.token, upstreams.clickup.token];
  const kept = await page.evaluate(() =>
    JSON.stringify({ ...localStorage, ...sessionStorage }),
  );
  const html = await page.content();
  const jobs = await Promise.all(run.jobIds.map((id) => jobOf(page, id)));
  const text = `${kept}\n${html}\n${JSON.stringify(jobs)}`;
  for (const token of tokens) {
    check(!text.includes(token), "a source token reached the page or a job");
  }
}

async function adminSourceStep(run) {
  const { page } = await signedIn(run, run.ids.users.alex, { hash: "#/admin" });
  run.alex = page;
  await page.locator(".tabs .tab", { hasText: "Import" }).click();
  await waitStep(page, "Choose what to import");
  check(page.url().endsWith("#/import"), `Import tab → ${page.url()}`);
  check((await page.locator(".import-source").count()) === 4, "four sources");
  await chooseSource(page, "ClickUp");
  const clickupHint = await page.locator(".import-where").textContent();
  check(clickupHint.includes("Settings → Apps"), `ClickUp: ${clickupHint}`);
  await chooseSource(page, "monday.com");
  const mondayHint = await page.locator(".import-where").textContent();
  check(mondayHint.includes("My access tokens"), `monday: ${mondayHint}`);
  const token = page.locator(".import-token");
  check((await token.getAttribute("type")) === "password", "password field");
  check((await token.getAttribute("autocomplete")) === "off", "autocomplete");
  await shots(run, page, "1-source");
}

async function memberHasNoImporter(run) {
  const { page } = await signedIn(run, run.ids.users.sam, { hash: "#/import" });
  const heading = await page.locator("#page h1").allTextContents();
  check(heading.join("|").includes("Only admins can import"), `${heading}`);
  run.expectHttp(403, "/import/scan");
  const status = await page.evaluate(async (token) => {
    const response = await fetch("/import/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "monday", token }),
    });
    return response.status;
  }, upstreams.monday.token);
  check(status === 403, `a member's scan answered ${status}`);
  await openHash(page, run, "#/home");
  await page.locator(".sidebar-add").click();
  const entries = await page.locator('[role="menuitem"]').allTextContents();
  check(!entries.join("|").includes("Import"), `member menu: ${entries}`);
  await page.keyboard.press("Escape");
  run.page = run.alex;
}

async function mondayScanCancelled(run) {
  const page = run.alex;
  // The third board's items answer slowly: the scan is caught midway.
  const slow = { operation: "WorklaneItems", match: { board: "104" } };
  upstreams.monday.fail({ ...slow, kind: "slow", ms: 15_000 });
  run.jobIds.push(await scanWithToken(page, upstreams.monday.token));
  await waitStep(page, "Scanning monday.com");
  const count = page.locator(".import-progress-count");
  await waitUntil(
    async () => (await count.textContent()) === "2 of 29 boards",
    "the scan's live progress",
  );
  const bar = page.locator('[role="progressbar"]');
  check((await bar.getAttribute("aria-valuenow")) === "7", "the bar's value");
  await shots(run, page, "2-scanning");
  await page.locator(".import-cancel").click();
  await waitStep(page, "Choose what to import");
  const notice = await page.locator(".import-banner").textContent();
  check(notice.includes("cancelled"), `after Cancel: ${notice}`);
  const job = await jobOf(page, run.jobIds.at(-1));
  check(job.state === "cancelled", `the cancelled scan is ${job.state}`);
  await checkNoTokens(run, page);
}

async function mondayReview(run) {
  const page = run.alex;
  await chooseSource(page, "monday.com");
  run.jobIds.push(await scanWithToken(page, upstreams.monday.token));
  await waitStep(page, "Review what to import");
  const names = await page.locator(".import-entry-name").allTextContents();
  check(names.includes("Roadmap") && names.includes("Hiring"), `${names}`);
  const action = page.getByLabel("Action for Fox Mulder", { exact: true });
  check((await action.inputValue()) === "skip", "no Worklane user matches");
  await action.selectOption("invite:member");
  const summary = await page.locator(".import-summary").textContent();
  check(/People: .*\b1 invited\b/.test(summary), `summary: ${summary}`);
  const group = page.locator(".import-warning-group", {
    has: page.locator(".import-warning-code", { hasText: "column_as_text" }),
  });
  await group.locator(".import-warning-summary").click();
  const path = await group
    .locator(".import-warning-path")
    .first()
    .textContent();
  check(/columns\[\d+\]/.test(path), `a warning's path: ${path}`);
  await screenshot(run, page, "import-3-review-warnings.png");
  await shots(run, page, "3-review");
}

/** Holds reads of import jobs until `release()`; live events still flow. */
async function holdJobReads(page) {
  let release;
  const released = new Promise((resolve) => (release = resolve));
  const held = [];
  const handler = (route) => {
    const sent = (async () => {
      if (route.request().method() === "GET") await released;
      await route.continue();
    })();
    held.push(sent);
    return sent;
  };
  await page.route("**/import/jobs/*", handler);
  return async () => {
    release();
    await Promise.all(held);
    await page.unroute("**/import/jobs/*", handler);
  };
}

async function mondayImport(run) {
  const page = run.alex;
  // The import takes a fraction of a second; holding the job's reads
  // keeps the Importing step on screen for its screenshots.
  const release = await holdJobReads(page);
  run.jobIds.push(await startImport(page));
  await waitStep(page, "Importing into Worklane");
  await waitUntil(
    async () =>
      (await page.locator(".import-progress-count").textContent()).endsWith(
        " of 31 boards and docs",
      ),
    "the import's live progress",
  );
  await shots(run, page, "4-importing");
  await release();
  await waitStep(page, "Import finished");
  check((await page.locator(".import-tile").count()) === 8, "count tiles");
  const links = await page.locator("a.import-link").allTextContents();
  check(links.includes("Roadmap"), `done links: ${links.slice(0, 5)}`);
  const download = page.waitForEvent("download");
  await page.locator("button", { hasText: "Download warnings" }).click();
  const file = await download;
  check(file.suggestedFilename().endsWith(".txt"), "a .txt download");
  let text = "";
  for await (const chunk of await file.createReadStream()) text += chunk;
  check(text.includes("column_as_text"), "the warnings file lists codes");
  check(!text.includes(upstreams.monday.token), "no token in the download");
  await shots(run, page, "5-done");
  const data = await dataAs(run, run.ids.users.alex, IMPORTED);
  const fox = data.users.find((user) => user.email === "fox@acme.test");
  check(fox?.role === "member", `the invited user: ${JSON.stringify(fox)}`);
  const finished = data.notifications.filter(
    (entry) => entry.kind === "import_finished",
  );
  check(finished.length === 1, `${finished.length} import notifications`);
  await checkNoTokens(run, page);
}

async function mondayBoard(run) {
  const page = run.alex;
  await openImportedBoard(page, {
    title: "Roadmap",
    badge: "Imported from monday.com",
    href: "https://acme.monday.com/boards/101",
  });
  await toMainTable(page);
  await screenshot(run, page, "import-board-monday.png");
  await checkItem(page, {
    name: "Launch MVP",
    status: "Done",
    person: "Fox Mulder",
    update: "Planning started",
    onTask: () => screenshot(run, page, "import-item-monday.png"),
  });
  await checkSidebarFits(page);
  // The activity names the import as the way the admin acted.
  await page.locator(".view-tab", { hasText: /^Activity$/ }).click();
  const imported = page.locator('.activity-entry[data-kind="board_imported"]');
  const line = await imported.locator(".activity-text").textContent();
  check(
    line.includes("Alex Rivera (Import from monday.com) imported this board"),
    `activity: ${line}`,
  );
  const detail = await imported.locator(".activity-detail").textContent();
  check(detail.includes("account Acme Corp: 455 items"), `detail: ${detail}`);
  await screenshot(run, page, "import-activity-monday.png");
  // Back to the wizard: the done step is kept until "Import more".
  await openHash(page, run, "#/import");
  check((await stepTitle(page)) === "Import finished", "the done step stays");
}

/** The source step of `#/import`, after "Import more" if it shows a result. */
async function freshSource(run) {
  const page = run.alex;
  await openHash(page, run, "#/import");
  if ((await stepTitle(page)) === "Import finished") {
    // The done step offers it under its summary and at the end.
    await page.locator("button", { hasText: "Import more" }).first().click();
  }
  await waitStep(page, "Choose what to import");
}

async function clickupImport(run) {
  const page = run.alex;
  await freshSource(run);
  await chooseSource(page, "ClickUp");
  const docs = page
    .locator(".import-check")
    .filter({ has: page.getByText("Docs", { exact: true }) });
  await docs.locator("input").uncheck();
  await page.locator(".import-limits summary").click();
  await page.locator("#import-limit-updates").fill("40");
  const before = upstreams.clickup.requests.length;
  const scanId = await scanWithToken(page, upstreams.clickup.token);
  run.jobIds.push(scanId);
  await waitStep(page, "Review what to import");
  const requests = upstreams.clickup.requests.length - before;
  check(requests < 90, `the ClickUp scan sent ${requests} requests`);
  const fox = page.getByLabel("Action for Fox Mulder", { exact: true });
  const action = await fox.inputValue();
  check(action.startsWith("match:"), `Fox is matched by email: ${action}`);
  const importId = await startImport(page);
  run.jobIds.push(importId);
  await waitStep(page, "Import finished");
  await importedOnce(run, { scanId, importId });
  await openImportedBoard(page, {
    title: "Engineering / Sprint 12",
    badge: "Imported from ClickUp",
    href: "https://app.clickup.com/9001/v/li/901101",
  });
  // The checks below read the Main table.
  await toMainTable(page);
  await checkItem(page, {
    name: "Plan the sprint",
    status: "in progress",
    person: "Fox Mulder",
    update: "Planning started",
  });
  await screenshot(run, page, "import-board-clickup.png");
  await checkNoTokens(run, page);
}

/**
 * A scan is imported once (SPEC-5 §2.5): running it again is 409 and
 * names the import that ran.
 */
async function importedOnce(run, { scanId, importId }) {
  run.expectHttp(409, "/import/run");
  const again = await run.alex.evaluate(async (scanJobId) => {
    const response = await fetch("/import/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scan_job_id: scanJobId, plan: {} }),
    });
    return { status: response.status, body: await response.json() };
  }, scanId);
  const details = again.body.errors?.[0]?.extensions ?? {};
  check(again.status === 409, `a second run answered ${again.status}`);
  check(details.code === "ALREADY_IMPORTED", `code ${details.code}`);
  const named = String(details.import_job_id);
  check(named === String(importId), `the import named: ${named}`);
}

/** Imports `file` from the source step of a fresh `#/import`. */
async function importFile(run, { source, file }) {
  const page = run.alex;
  await freshSource(run);
  await chooseSource(page, source);
  run.jobIds.push(await scanFile(page, file));
  await waitStep(page, "Review what to import");
  run.jobIds.push(await startImport(page));
  await waitStep(page, "Import finished");
}

async function csvImport(run) {
  const page = run.alex;
  const file = {
    name: "Sprint plan.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(CSV_TEXT),
  };
  await importFile(run, { source: "CSV file", file });
  await openImportedBoard(page, {
    title: "Sprint plan",
    badge: "Imported from a CSV file",
  });
  await toMainTable(page);
  await checkItem(page, {
    name: "Write the spec",
    status: "Done",
    person: "Fox Mulder",
  });
  await screenshot(run, page, "import-board-csv.png");
}

async function xlsxImport(run) {
  const page = run.alex;
  const file = {
    name: "Product roadmap.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: sampleMondayExport(),
  };
  await importFile(run, { source: "monday Excel export", file });
  await openImportedBoard(page, {
    title: "Product roadmap",
    badge: "Imported from an Excel file",
  });
  await toMainTable(page);
  await checkItem(page, {
    name: "Launch site",
    status: "Done",
    person: "Sam Lee",
  });
  // Subitems are real subitems of their parent, with no "Parent item"
  // column (SPEC-5 §2.1); the Main table lists them as rows.
  await itemNamed(page, "Copy");
  const heads = await page.locator('th[scope="col"]').allTextContents();
  check(!heads.join("|").includes("Parent item"), `columns: ${heads}`);
  await screenshot(run, page, "import-board-xlsx.png");
  const data = await dataAs(run, run.ids.users.alex, IMPORTED);
  const board = data.boards.find((entry) => entry.import?.source === "xlsx");
  const { boards } = await dataAs(run, run.ids.users.alex, PARENTS, {
    ids: [board.id],
  });
  const { items } = boards[0].items_page;
  const parentOf = (name) =>
    items.find((item) => item.name === name)?.parent_item?.name ?? null;
  check(parentOf("Copy") === "Launch site", `Copy: ${parentOf("Copy")}`);
  check(parentOf("Launch site") === null, "Launch site is top-level");
  const sources = data.boards.map((board) => board.import?.source);
  for (const source of ["monday", "clickup", "csv", "xlsx"]) {
    check(sources.includes(source), `a board imported from ${source}`);
  }
  await checkNoTokens(run, page);
}

const itemNamed = (page, name) =>
  page
    .locator(`button.open-item[aria-label="Open ${name}"]`)
    .waitFor({ timeout: JOB_WAIT_MS });

runE2E({
  name: "e2e import",
  prefix: "import-",
  totalMs: 240_000,
  serve: serveWithUpstreams,
  async setup(run) {
    run.ids = seedIds(run.store);
    run.jobIds = [];
  },
  steps: [
    ["the Admin page's Import tab opens the source step", adminSourceStep],
    ["a member has no importer", memberHasNoImporter],
    [
      "a monday scan shows live progress and can be cancelled",
      mondayScanCancelled,
    ],
    ["the monday review: tree, people and warnings; one invite", mondayReview],
    [
      "the monday import: progress, done step and downloaded warnings",
      mondayImport,
    ],
    [
      "the imported monday board: badge, items, statuses, people, updates",
      mondayBoard,
    ],
    ["a ClickUp import, matched by email, with comments", clickupImport],
    ["a CSV file becomes a board", csvImport],
    ["a monday Excel export becomes a board with subitems", xlsxImport],
  ],
});
