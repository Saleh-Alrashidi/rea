/**
 * The user flow of the browser smoke test (`e2e-smoke.mjs` runs it). Each
 * step drives the real UI and confirms the result through the public
 * GraphQL API with the seeded read-write token.
 *
 * A step receives `run`: `{ page, hostOrigin, appsOrigin, store, token,
 * outputDir, documentCsp: Map<"host"|"app", string>, screenshots: string[] }`
 * (see `runE2E` in `e2e-lib.mjs`) and may add fields for later steps
 * (boardId, itemId, installId, frame…).
 */
import path from "node:path";
import { DESKTOP, WAIT_MS, check, fail, waitUntil } from "./e2e-lib.mjs";

const ITEM_NAME = "Smoke test item";
const RENAMED = "Smoke test item (renamed)";
const UPDATE_BODY = "Posted by the smoke test <img src=x onerror=alert(1)>";
const NOTE_TEXT = "Launch checklist from the smoke test";

const BOARD_QUERY = `query SmokeBoard($id: ID!) {
  boards(ids: [$id]) {
    id name
    groups { id title }
    columns { id title type }
    items_page(limit: 500) {
      items { id name group { id } column_values { id type text } }
    }
  }
}`;
const ITEM_QUERY = `query SmokeItem($id: ID!) {
  items(ids: [$id]) {
    id name group { id }
    column_values { id type text }
    updates { body }
  }
}`;

// ------------------------------------------------------------------ helpers

/** POSTs GraphQL with the seeded read-write token; returns `data`. */
async function api(run, query, variables) {
  const response = await fetch(`${run.hostOrigin}/v2`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${run.token}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json();
  if (!response.ok || body.errors) {
    fail(`API ${response.status}: ${JSON.stringify(body.errors ?? body)}`);
  }
  return body.data;
}

const boardFromApi = async (run) =>
  (await api(run, BOARD_QUERY, { id: run.boardId })).boards[0];

const itemFromApi = async (run, id) =>
  (await api(run, ITEM_QUERY, { id })).items[0] ?? null;

/** Column value text of `item` for the first column of `type`. */
function textOf(item, type) {
  return item.column_values.find((value) => value.type === type)?.text ?? "";
}

/** Item counts per status text ("" counts as "No status"). */
function statusCounts(items) {
  const counts = new Map();
  for (const item of items) {
    const label = textOf(item, "status") || "No status";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return counts;
}

async function screenshot(run, name) {
  const file = path.join(run.outputDir, name);
  await run.page.screenshot({ path: file });
  run.screenshots.push(file);
}

const row = (run, id) => run.page.locator(`tr.item-row[data-item-id="${id}"]`);

const tab = (run, name) =>
  run.page.locator(".view-tab", { hasText: new RegExp(`^${name}$`) });

const lane = (run, title) =>
  run.page
    .locator(".lane")
    .filter({ has: run.page.locator(".lane-title", { hasText: title }) });

/** Left edge and width of the sidebar, in viewport pixels. */
const sidebarBox = (run) => run.page.locator("#sidebar").boundingBox();

/**
 * Waits until the board view has not been rebuilt for `quietMs`. Change
 * events refresh the view 250 ms after they arrive (`ui/board/board-sync.js`);
 * a rebuild in the middle of Playwright's `dragTo` leaves Chromium's
 * intercepted drag unfinished, and every later drag on the page is lost.
 */
function viewSettled(run, quietMs = 600) {
  return run.page.evaluate(
    ({ quiet, limit }) =>
      new Promise((resolve, reject) => {
        const observer = new MutationObserver(() => restart());
        const finish = (error) => {
          observer.disconnect();
          clearTimeout(timer);
          clearTimeout(deadline);
          if (error) reject(error);
          else resolve();
        };
        let timer = setTimeout(finish, quiet);
        const restart = () => {
          clearTimeout(timer);
          timer = setTimeout(finish, quiet);
        };
        const deadline = setTimeout(
          () => finish(new Error("the board view kept changing")),
          limit,
        );
        const view = document.getElementById("board-view");
        observer.observe(view, { childList: true, subtree: true });
      }),
    { quiet: quietMs, limit: WAIT_MS },
  );
}

// -------------------------------------------------------------------- steps

async function boardLoads(run) {
  const { page } = run;
  const response = await page.goto(`${run.hostOrigin}/`);
  const csp = response.headers()["content-security-policy"] ?? "";
  check(csp.includes("frame-ancestors 'none'"), `host CSP: ${csp}`);
  check(csp.includes(`frame-src ${run.appsOrigin}`), `frame-src: ${csp}`);
  const cookie = (await page.context().cookies()).find(
    (entry) => entry.name === "mm_session",
  );
  check(cookie?.httpOnly && cookie.sameSite === "Strict", "session cookie");
  // The default route is Home (SPEC-2 §5.1); open the board from the sidebar.
  await waitUntil(() => page.url().endsWith("#/home"), "redirect to Home");
  await page.locator(".nav-link", { hasText: "Product roadmap" }).click();
  const match = await waitUntil(
    () => /#\/boards\/(\d+)$/.exec(page.url()),
    "the Product roadmap route",
  );
  run.boardId = match[1];
  const board = await boardFromApi(run);
  run.groupId = board.groups[0].id;
  await waitUntil(
    async () => (await page.inputValue(".board-name")) === board.name,
    `board name ${board.name}`,
  );
  const items = board.items_page.items.length;
  await waitUntil(
    async () =>
      (await page.locator("section.group").count()) === board.groups.length &&
      (await page.locator("tr.item-row").count()) === items,
    `${board.groups.length} groups and ${items} rows`,
  );
  const titles = await page
    .locator(".group-title")
    .evaluateAll((inputs) => inputs.map((input) => input.value));
  check(
    titles.join("|") === board.groups.map((group) => group.title).join("|"),
    `group titles ${titles}`,
  );
  await screenshot(run, "table.png");
}

async function statusPicker(run) {
  const { page } = run;
  const first = page.locator("tr.item-row").first();
  const id = await first.getAttribute("data-item-id");
  const before = textOf(await itemFromApi(run, id), "status");
  const target = before === "Stuck" ? "Done" : "Stuck";
  await row(run, id).locator(".status-pill").first().click();
  await page
    .locator(".popover .status-choice", { hasText: new RegExp(`^${target}$`) })
    .click();
  await waitUntil(
    async () => textOf(await itemFromApi(run, id), "status") === target,
    `API status ${target}`,
  );
  const pill = row(run, id).locator(".status-pill").first();
  await waitUntil(
    async () => (await pill.textContent()) === target,
    `pill text ${target}`,
  );
}

async function addAndRenameItem(run) {
  const { page } = run;
  const input = page.locator(".add-item-input").first();
  await input.fill(ITEM_NAME);
  await input.press("Enter");
  run.itemId = await waitUntil(
    () =>
      page.evaluate((name) => {
        const inputs = document.querySelectorAll("tr.item-row .name-input");
        const match = [...inputs].find((entry) => entry.value === name);
        return match?.closest("tr").dataset.itemId ?? null;
      }, ITEM_NAME),
    "the new row",
  );
  const created = await itemFromApi(run, run.itemId);
  check(created?.name === ITEM_NAME, "API item name");
  check(created.group.id === run.groupId, "item is in the first group");
  const name = row(run, run.itemId).locator(".name-input");
  await name.fill(RENAMED);
  await name.press("Enter");
  await waitUntil(
    async () => (await itemFromApi(run, run.itemId)).name === RENAMED,
    "API rename",
  );
}

async function dateAndNumber(run) {
  const target = row(run, run.itemId);
  const valueOf = async (type) =>
    textOf(await itemFromApi(run, run.itemId), type);
  await target.locator("input.cell-date").fill("2026-12-24");
  await waitUntil(
    async () => (await valueOf("date")) === "2026-12-24",
    "API date",
  );
  const number = target.locator("input.cell-number");
  await number.fill("7.5");
  await number.press("Enter");
  await waitUntil(async () => (await valueOf("numbers")) === "7.5", "number");
}

async function addGroupAndColumn(run) {
  const { page } = run;
  const groups = (await boardFromApi(run)).groups.length;
  await page.locator("button.add-group").click();
  await waitUntil(
    async () => (await boardFromApi(run)).groups.length === groups + 1,
    "API group count",
  );
  await waitUntil(
    async () => (await page.locator("section.group").count()) === groups + 1,
    "group block",
  );
  await page.locator("button.add-column").first().click();
  await page.fill("dialog.modal input[name=title]", "Priority");
  await page.selectOption("dialog.modal select[name=type]", "text");
  await page.click("dialog.modal button[type=submit]");
  await waitUntil(
    async () =>
      (await boardFromApi(run)).columns.some(
        (column) => column.title === "Priority" && column.type === "text",
      ),
    "API column",
  );
  const headers = page.locator("th", { hasText: "Priority" });
  await waitUntil(
    async () => (await headers.count()) === groups + 1,
    "a Priority header in every group",
  );
}

async function kanbanDrag(run) {
  const { page } = run;
  await tab(run, "Kanban").click();
  await waitUntil(() => page.url().endsWith("/views/kanban"), "kanban route");
  const done = lane(run, /^Done$/);
  await done.waitFor();
  await viewSettled(run);
  const id = await page
    .locator(".lane")
    .filter({ hasNot: page.locator(".lane-title", { hasText: /^Done$/ }) })
    .locator(".kanban-card")
    .first()
    .getAttribute("data-item-id");
  check(textOf(await itemFromApi(run, id), "status") !== "Done", "not Done");
  const card = page.locator(`.kanban-card[data-item-id="${id}"]`);
  await card.dragTo(done.locator(".lane-cards"));
  await waitUntil(
    async () => textOf(await itemFromApi(run, id), "status") === "Done",
    "API status Done after the drop",
  );
  await done.locator(`.kanban-card[data-item-id="${id}"]`).waitFor();
  run.cardItemId = id;
  await screenshot(run, "kanban.png");
}

async function itemCardUpdate(run) {
  const { page } = run;
  const id = run.cardItemId;
  const title = `.kanban-card[data-item-id="${id}"] .kanban-card-title`;
  await page.locator(title).click();
  await page.locator("dialog.item-card[open] .card-title").waitFor();
  check(page.url().endsWith(`/items/${id}`), `card route ${page.url()}`);
  const { name } = await itemFromApi(run, id);
  check((await page.inputValue(".card-title")) === name, "card title");
  await page.fill(".composer-input", UPDATE_BODY);
  await page.click(".composer button[type=submit]");
  await waitUntil(
    async () => (await itemFromApi(run, id)).updates[0]?.body === UPDATE_BODY,
    "API update",
  );
  const newest = page.locator(".update-body").first();
  await waitUntil(
    async () => (await newest.textContent()) === UPDATE_BODY,
    "update shown as text",
  );
  check((await page.locator(".update-list img").count()) === 0, "no markup");
  await screenshot(run, "item-card.png");
  await page.keyboard.press("Escape");
  await page.locator("dialog.item-card").waitFor({ state: "detached" });
  check(page.url().endsWith("/views/kanban"), `back to kanban ${page.url()}`);
}

async function appViewCounts(run) {
  const { page } = run;
  await tab(run, "Status summary").click();
  const iframe = page.locator("iframe.app-frame");
  const sandbox = await iframe.getAttribute("sandbox");
  check(sandbox === "allow-scripts allow-same-origin allow-forms", sandbox);
  check((await iframe.getAttribute("referrerpolicy")) === "no-referrer", "rp");
  run.installId = /views\/app-(\d+)$/.exec(page.url())?.[1];
  check(run.installId, `app route ${page.url()}`);
  const board = await boardFromApi(run);
  const items = board.items_page.items;
  const frame = page.frameLocator("iframe.app-frame");
  run.frame = frame;
  await frame.locator("#board-name", { hasText: board.name }).waitFor();
  const total = `${items.length} items`;
  await frame.locator("#item-total", { hasText: total }).waitFor();
  const expected = [...statusCounts(items)].sort().join("|");
  const bars = frame.locator("#bars .bar");
  await waitUntil(async () => {
    const shown = await bars.evaluateAll((buttons) =>
      buttons.map((button) => [
        button.querySelector(".bar-label").textContent,
        Number(button.querySelector(".bar-count").textContent),
      ]),
    );
    return (
      shown
        .filter(([, count]) => count > 0)
        .sort()
        .join("|") === expected
    );
  }, `bars ${expected}`);
  const appCsp = run.documentCsp.get("app") ?? "";
  const ancestors = `frame-ancestors ${run.hostOrigin}`;
  check(appCsp.includes(ancestors), `app CSP: ${appCsp}`);
  await screenshot(run, "app-view.png");
}

async function appPlatform(run) {
  const { page, frame } = run;
  await frame.locator("#send-notice").click();
  await page
    .locator(".toast", { hasText: "Status summary:" })
    .filter({ hasText: "Product roadmap has" })
    .waitFor();
  await frame.locator("#note").fill(NOTE_TEXT);
  await frame.locator("#save-note").click();
  await frame.locator("#note-version", { hasText: /^Version 1$/ }).waitFor();
  // Only app principals can read app storage, so check the store itself.
  const stored = run.store.getAppStorage(`install:${run.installId}`, "note");
  check(stored?.value === NOTE_TEXT && stored.version === 1, "stored note");
  await frame.locator("#verify-token").click();
  await frame
    .locator("#platform-status", { hasText: "Token verified for this view." })
    .waitFor();
  const claims = await frame
    .locator("#claims dd")
    .evaluateAll((cells) => cells.map((cell) => cell.textContent));
  const [user, board, install] = claims;
  check(
    user === "1" && board === run.boardId && install === run.installId,
    `claims ${claims}`,
  );
}

async function darkMode(run) {
  const { page, frame } = run;
  await page.emulateMedia({ colorScheme: "dark" });
  // The host forwards the theme to the app through a context event.
  await frame.locator("html[data-theme=dark]").waitFor({ state: "attached" });
  await tab(run, "Main table").click();
  await page.locator("tr.item-row").first().waitFor();
  const luminance = await page.evaluate(() => {
    const color = getComputedStyle(document.body).backgroundColor;
    const [r, g, b] = color.match(/\d+/g).map(Number);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  });
  check(luminance < 0.3, `dark background luminance ${luminance}`);
  await screenshot(run, "table-dark.png");
  await page.emulateMedia({ colorScheme: "light" });
}

async function mobileLayout(run) {
  const { page } = run;
  await page.setViewportSize({ width: 360, height: 740 });
  // The drawer slides out of view when the layout switches.
  await waitUntil(async () => {
    const box = await sidebarBox(run);
    return box && box.x + box.width <= 0;
  }, "the sidebar to leave the screen");
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  check(overflow <= 0, `page scrolls sideways by ${overflow}px`);
  await screenshot(run, "mobile-360.png");
  await page.locator(".sidebar-toggle").click();
  await waitUntil(
    async () => (await sidebarBox(run))?.x === 0,
    "the drawer to open",
  );
  await page.keyboard.press("Escape");
  await page.locator("#app.sidebar-open").waitFor({ state: "detached" });
  await page.setViewportSize(DESKTOP);
}

/** `[name, step(run)]` in order; later steps rely on earlier ones. */
export const STEPS = [
  ["board loads with groups and items", boardLoads],
  ["status changes through the picker", statusPicker],
  ["add and rename an item", addAndRenameItem],
  ["set a date and a number", dateAndNumber],
  ["add a group and a column", addGroupAndColumn],
  ["kanban drag changes the status", kanbanDrag],
  ["item card posts an update", itemCardUpdate],
  ["Status summary app shows the counts", appViewCounts],
  ["app notice, note storage and session token", appPlatform],
  ["dark mode", darkMode],
  ["360px mobile layout", mobileLayout],
];
