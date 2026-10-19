#!/usr/bin/env node
/**
 * Browser test of moving tasks (SPEC-6 §1.2, §1.4, §1.5) with real mouse
 * drags in Chromium (`page.mouse`, in steps) on the seeded Product
 * roadmap and on the imported ClickUp meetings list:
 *
 * - reordering within a status group (the API's positions follow), the
 *   drop line, ghost and announcement, then Undo from the toast and
 *   Ctrl+Z;
 * - a drop into another status group changes the status; the middle
 *   band nests (the task keeps its status), a top-level drop un-nests;
 * - a drop into the task's own subtree paints red with the not-allowed
 *   cursor and changes nothing; pressing on a name does not drag;
 * - Alt+arrows and the row's "…" menu move the focused row;
 * - a Shift / Ctrl selection drags together, with a count badge and the
 *   bulk bar (Move to… another board is enabled; e2e-sidebar.mjs uses it);
 * - a viewer gets no handles and cannot drag;
 * - Kanban: a card reorders within its lane and moves to another lane;
 * - ClickUp: a drop on a group header, holding over a collapsed parent
 *   expands it, a subtask lands between two others, auto-scroll.
 *
 * Screenshots of a drag in progress (drop line showing) go to
 * `e2e-output/dnd-drag.png`, `dnd-drag-dark.png` and `dnd-drag-360.png`,
 * plus `dnd-selection.png` and `dnd-kanban.png`; at 360 px the page must
 * not scroll sideways.
 *
 * Usage: `node scripts/e2e-dnd.mjs`. The harness, environment variables
 * and skip rules are described in `e2e-lib.mjs`.
 */
import { clickupBoard, kanbanMoves } from "./e2e-dnd-boards.mjs";
import {
  N,
  WORKING,
  ahead,
  bandOf,
  dragRow,
  dropPaint,
  itemsByName,
  listGroup,
  listRow,
  rowNames,
  waitForItems,
} from "./e2e-dnd-lib.mjs";
import {
  DESKTOP,
  MOBILE,
  check,
  dataAs,
  runE2E,
  screenshot,
  seedIds,
  sidewaysOverflow,
  signedIn,
  waitUntil,
} from "./e2e-lib.mjs";

const MOVE = `mutation ($i: ID!, $p: ID) {
  move_item(item_id: $i, parent_item_id: $p) { id }
}`;
/** `--color-danger` of the light theme, as computed styles report it. */
const DANGER = "rgb(198, 42, 60)";

const working = (run) => listGroup(run.alex, WORKING);
const opacity = (locator) =>
  locator.evaluate((node) => getComputedStyle(node).opacity);
const announced = (page) => page.locator("#announcer").textContent();

/** Waits for `group`'s rows to read `names` (indented by level). */
function rowsRead(group, names, label) {
  return waitUntil(
    async () => (await rowNames(group)).join("|") === names.join("|"),
    label,
  );
}

async function openList(run) {
  run.boardId = run.ids.roadmap;
  const hash = `#/boards/${run.boardId}`;
  const { page } = await signedIn(run, run.ids.users.alex, { hash });
  run.alex = page;
  await page.locator(".list-view.can-move .list-row").first().waitFor();
  await rowsRead(working(run), [N.design, N.dark], "the Working on it rows");
  const handle = listRow(page, N.dark).locator(".list-drag-handle");
  check((await opacity(handle)) === "0", "the handle hides until hover");
  await listRow(page, N.dark).hover();
  await waitUntil(async () => (await opacity(handle)) === "1", "on hover");
}

async function reorderInGroup(run) {
  const page = run.alex;
  const group = working(run);
  const during = async () => {
    const paint = await dropPaint(page);
    check(paint.ghost === N.dark && paint.count === null, "the ghost");
    const marks = paint.marks.map((m) => `${m.name}:${m.classes}`).join();
    check(marks === `${N.design}:drop-before`, `the drop mark: ${marks}`);
    check(
      paint.line?.height === "2px",
      `the line ${JSON.stringify(paint.line)}`,
    );
    check(!paint.notAllowed && paint.line.color !== DANGER, "allowed");
  };
  const from = listRow(group, N.dark);
  await dragRow(page, from, listRow(group, N.design), { during });
  await waitForItems(
    run,
    run.boardId,
    (items) => ahead(items, N.dark, N.design),
    "Dark mode polish before Design onboarding flow in the API",
  );
  await rowsRead(group, [N.dark, N.design], "the new order on screen");
  const toast = page.locator(".toast", { hasText: `Moved “${N.dark}”` });
  await toast.locator(".toast-action", { hasText: "Undo" }).waitFor();
  await waitUntil(
    async () => (await announced(page)).startsWith(`Moved “${N.dark}” before`),
    "the move announced",
  );
}

async function undoMoves(run) {
  const page = run.alex;
  const group = working(run);
  await page
    .locator(".toast", { hasText: `Moved “${N.dark}”` })
    .locator(".toast-action")
    .click();
  const restored = (items) => ahead(items, N.design, N.dark);
  await waitForItems(run, run.boardId, restored, "the toast's Undo");
  await rowsRead(group, [N.design, N.dark], "the order back on screen");
  await dragRow(page, listRow(group, N.dark), listRow(group, N.design));
  const moved = (items) => ahead(items, N.dark, N.design);
  await waitForItems(run, run.boardId, moved, "moved again");
  await page.locator(".toast", { hasText: `Moved “${N.dark}”` }).waitFor();
  await page.keyboard.press("Control+z");
  await waitForItems(run, run.boardId, restored, "Ctrl+Z");
  await page
    .locator(".toast", { hasText: `Moved “${N.dark}”` })
    .waitFor({ state: "detached" });
}

async function toAnotherGroup(run) {
  const page = run.alex;
  const blank = listGroup(page, "No status");
  const to = listRow(working(run), N.design);
  await dragRow(page, listRow(blank, N.kanban), to, { zone: "after" });
  await waitForItems(
    run,
    run.boardId,
    (items) =>
      items.get(N.kanban).texts.status === WORKING &&
      ahead(items, N.design, N.kanban) &&
      ahead(items, N.kanban, N.dark),
    "Working on it, between Design and Dark mode",
  );
  await rowsRead(working(run), [N.design, N.kanban, N.dark], "on screen");
}

async function nestAndUnnest(run) {
  const page = run.alex;
  const group = working(run);
  const blank = listGroup(page, "No status");
  const during = async () => {
    const [mark] = (await dropPaint(page)).marks;
    check(mark?.classes.join() === "drop-inside", `inside: ${mark?.classes}`);
  };
  const to = listRow(group, N.design);
  await dragRow(page, listRow(blank, N.api), to, { zone: "inside", during });
  await waitForItems(
    run,
    run.boardId,
    (items) => items.get(N.api).parentId === items.get(N.design).id,
    "API rate limits a subtask of Design onboarding flow",
  );
  // Shown under its parent (expanded for it), with its own status.
  const nested = [N.design, `  ${N.api}`, N.kanban, N.dark];
  await rowsRead(group, nested, "the subtask under its parent");
  const items = await itemsByName(run, run.boardId);
  check(items.get(N.api).texts.status !== WORKING, "the subtask's status");
  await dragRow(page, listRow(group, N.api), listRow(group, N.dark));
  await waitForItems(
    run,
    run.boardId,
    (all) =>
      all.get(N.api).parentId === null &&
      all.get(N.api).texts.status === WORKING &&
      ahead(all, N.kanban, N.api) &&
      ahead(all, N.api, N.dark),
    "API rate limits top-level again, in Working on it",
  );
  await rowsRead(group, [N.design, N.kanban, N.api, N.dark], "un-nested");
}

/** Records the `move_item` requests the page sends; returns the list. */
function moveRequests(page) {
  const sent = [];
  page.on("request", (request) => {
    if (request.postData()?.includes("move_item")) sent.push(request);
  });
  return sent;
}

async function ownSubtree(run) {
  const page = run.alex;
  const group = working(run);
  const items = await itemsByName(run, run.boardId);
  const variables = { i: items.get(N.fix).id, p: items.get(N.design).id };
  await dataAs(run, run.ids.users.alex, MOVE, variables);
  await waitUntil(
    async () => (await rowNames(group)).includes(`  ${N.fix}`),
    "the live refresh shows Fix login under Design",
  );
  const sent = moveRequests(page);
  const during = async () => {
    const inside = await dropPaint(page);
    check(inside.notAllowed, "the not-allowed cursor inside the subtree");
    check(inside.marks[0]?.classes.includes("drop-invalid"), "a red outline");
    const point = await bandOf(listRow(group, N.fix), "before");
    await page.mouse.move(point.x, point.y, { steps: 3 });
    const line = await dropPaint(page);
    check(line.notAllowed && line.line?.color === DANGER, "a red line");
  };
  const from = listRow(group, N.design);
  await dragRow(page, from, listRow(group, N.fix), { zone: "inside", during });
  // Pressing on a task's name (a button) never starts a drag.
  const name = await listRow(group, N.dark).locator(".list-name").boundingBox();
  await page.mouse.move(name.x + 10, name.y + name.height / 2);
  await page.mouse.down();
  await page.mouse.move(name.x + 10, name.y - 60, { steps: 6 });
  check((await page.locator(".list-drag-ghost").count()) === 0, "no drag");
  await page.mouse.up();
  await page.waitForTimeout(400);
  check(sent.length === 0, `${sent.length} move_item requests`);
  const after = await itemsByName(run, run.boardId);
  check(after.get(N.design).parentId === null, "Design stays top-level");
  check(!(await page.locator("dialog.task-view[open]").count()), "no task");
}

/** The focused element's task name, if it is a row's name. */
const focusedName = (page) =>
  page.evaluate(
    () =>
      document.activeElement?.closest(".list-row")?.querySelector(".list-name")
        ?.title ?? null,
  );

async function keyboardMoves(run) {
  const page = run.alex;
  const id = run.boardId;
  await listRow(working(run), N.dark).locator(".list-name").focus();
  await page.keyboard.press("Alt+ArrowUp");
  await waitForItems(run, id, (all) => ahead(all, N.dark, N.api), "Alt+Up");
  await waitUntil(async () => (await focusedName(page)) === N.dark, "focus");
  await waitUntil(
    async () => (await announced(page)).startsWith(`Moved “${N.dark}” before`),
    "the keyboard move announced",
  );
  await page.keyboard.press("Alt+ArrowRight");
  await waitForItems(
    run,
    id,
    (all) => all.get(N.dark).parentId === all.get(N.kanban).id,
    "Alt+Right: a subtask of the previous sibling",
  );
  await waitUntil(async () => (await focusedName(page)) === N.dark, "focus");
  await page.keyboard.press("Alt+ArrowLeft");
  await waitForItems(
    run,
    id,
    (all) => all.get(N.dark).parentId === null && ahead(all, N.kanban, N.dark),
    "Alt+Left: out of its parent, right after it",
  );
  await rowsRead(
    working(run),
    [N.design, `  ${N.fix}`, N.kanban, N.dark, N.api],
    "keyboard",
  );
  await rowMenu(run);
}

async function rowMenu(run) {
  const page = run.alex;
  const row = listRow(working(run), N.dark);
  await row.hover();
  await row.locator(".list-row-menu").click();
  const menu = page.locator(".popover-menu");
  const labels = (await menu.locator(".menu-label").allTextContents()).join(
    "|",
  );
  const want = "Move up|Move down|Make subtask of…|Move out of parent|Move to…";
  check(labels === want, `the row menu: ${labels}`);
  // Move to… another board (SPEC-6 §3.2; e2e-sidebar.mjs moves one).
  const other = menu.locator(".menu-item", { hasText: "Move to…" });
  check((await other.getAttribute("aria-disabled")) === null, "Move to…");
  const out = menu.locator(".menu-item", { hasText: "Move out of parent" });
  check((await out.getAttribute("aria-disabled")) === "true", "top level");
  await menu.locator(".menu-item", { hasText: "Move down" }).click();
  await waitForItems(
    run,
    run.boardId,
    (all) => ahead(all, N.api, N.dark),
    "the menu's Move down",
  );
  await makeSubtaskOf(run);
}

/** "Make subtask of…" asks for the parent; Undo puts the task back. */
async function makeSubtaskOf(run) {
  const page = run.alex;
  const row = listRow(working(run), N.api);
  await row.hover();
  await row.locator(".list-row-menu").click();
  await page
    .locator(".popover-menu .menu-item", { hasText: "Make subtask of…" })
    .click();
  const dialog = page.locator("dialog[open]");
  const items = await itemsByName(run, run.boardId);
  await dialog.locator("select").selectOption(items.get(N.design).id);
  await dialog.locator("button[type=submit]").click();
  const id = run.boardId;
  const design = items.get(N.design).id;
  const nested = (all) => all.get(N.api).parentId === design;
  await waitForItems(run, id, nested, "a subtask of the picked task");
  await page
    .locator(".toast", { hasText: `Moved “${N.api}”` })
    .locator(".toast-action")
    .click();
  await waitForItems(
    run,
    id,
    (all) =>
      all.get(N.api).parentId === null &&
      ahead(all, N.kanban, N.api) &&
      ahead(all, N.api, N.dark),
    "Undo: back to the top level, in its place",
  );
}

async function selectionDrag(run) {
  const page = run.alex;
  const group = working(run);
  const box = (name) => listRow(page, name).locator(".list-select");
  await listRow(group, N.kanban).hover();
  await box(N.kanban).click();
  await listRow(group, N.dark).hover();
  await box(N.dark).click({ modifiers: ["Shift"] });
  const count = page.locator(".list-bulk-count");
  await waitUntil(
    async () => (await count.textContent()) === "3 selected",
    "Shift range",
  );
  await listRow(group, N.api)
    .locator(".list-name")
    .click({ modifiers: ["Control"] });
  await waitUntil(
    async () => (await count.textContent()) === "2 selected",
    "Ctrl toggles",
  );
  const done = listGroup(page, "Done");
  await done.locator(".list-group-toggle").click();
  await listRow(done, N.ci)
    .locator(".list-name")
    .click({ modifiers: ["Control"] });
  await waitUntil(
    async () => (await count.textContent()) === "3 selected",
    "three",
  );
  const other = page.locator(".list-bulk-move");
  check((await other.getAttribute("aria-disabled")) === null, "Move to…");
  await screenshot(run, page, "dnd-selection.png");
  const during = async () => {
    const paint = await dropPaint(page);
    check(paint.count === "3", `the count badge reads ${paint.count}`);
    check(paint.marks[0]?.classes.includes("drop-end"), "the end of Done");
  };
  const header = done.locator(".list-group-header");
  await dragRow(page, listRow(group, N.kanban), header, {
    zone: "inside",
    during,
  });
  await waitForItems(
    run,
    run.boardId,
    (all) =>
      [N.kanban, N.dark, N.ci].every(
        (name) => all.get(name).texts.status === "Done",
      ) &&
      ahead(all, N.comments, N.kanban) &&
      ahead(all, N.kanban, N.dark) &&
      ahead(all, N.dark, N.ci),
    "the selection at the end of Done, in display order",
  );
  await page.locator(".toast", { hasText: "Moved 3 tasks" }).waitFor();
  await bulkBar(run);
}

/** The bulk bar sets a status for the selection, clears it and deletes. */
async function bulkBar(run) {
  const page = run.alex;
  const moved = [N.kanban, N.dark, N.ci];
  await page.locator(".list-bulk-status").click();
  await page
    .locator(".status-menu-popover [role=option]", { hasText: "Stuck" })
    .click();
  await waitForItems(
    run,
    run.boardId,
    (all) => moved.every((name) => all.get(name).texts.status === "Stuck"),
    "Set status on the whole selection",
  );
  await page.locator(".list-bulk-clear").click();
  await page.locator(".list-bulk").waitFor({ state: "detached" });
  const sharing = listRow(listGroup(page, "Done"), N.sharing);
  await sharing.hover();
  await sharing.locator(".list-select").click();
  await page.locator(".list-bulk-delete").click();
  const dialog = page.locator("dialog[open]");
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await waitForItems(
    run,
    run.boardId,
    (all) => !all.has(N.sharing),
    "the selection deleted",
  );
  await page.locator(".list-bulk").waitFor({ state: "detached" });
}

/** Holds a drag over Design's top band for the screenshots. */
async function holdDrag(page, run, name) {
  const group = working(run);
  await dragRow(page, listRow(group, N.api), listRow(group, N.design), {
    release: false,
  });
  const paint = await dropPaint(page);
  check(paint.line?.height === "2px", `a drop line at ${name}`);
  await screenshot(run, page, name);
}

async function dragScreenshots(run) {
  const page = run.alex;
  const before = JSON.stringify([...(await itemsByName(run, run.boardId))]);
  await holdDrag(page, run, "dnd-drag.png");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.mouse.move(300, 300);
  await page.waitForTimeout(100);
  const point = await bandOf(listRow(working(run), N.design), "before");
  await page.mouse.move(point.x, point.y, { steps: 3 });
  await screenshot(run, page, "dnd-drag-dark.png");
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize(MOBILE);
  await page.waitForTimeout(300);
  await holdDrag(page, run, "dnd-drag-360.png");
  const overflow = await sidewaysOverflow(page);
  check(overflow <= 0, `at 360 px the page scrolls sideways by ${overflow}`);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  check((await page.locator(".list-drag-ghost").count()) === 0, "cancelled");
  await page.setViewportSize(DESKTOP);
  await page.waitForTimeout(300);
  const after = JSON.stringify([...(await itemsByName(run, run.boardId))]);
  check(after === before, "Escape moved nothing");
}

async function viewerCannotDrag(run) {
  const hash = `#/boards/${run.boardId}`;
  const { context, page } = await signedIn(run, run.ids.users.jordan, { hash });
  await page.locator(".list-row").first().waitFor();
  for (const selector of [
    ".list-drag-handle",
    ".list-select",
    ".list-row-menu",
  ]) {
    check((await page.locator(selector).count()) === 0, `no ${selector}`);
  }
  const box = await page.locator(".list-row").first().boundingBox();
  await page.mouse.move(box.x + 3, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 3, box.y + 80, { steps: 6 });
  check((await page.locator(".list-drag-ghost").count()) === 0, "no drag");
  await page.mouse.up();
  await context.close();
  run.page = run.alex;
}

runE2E({
  name: "e2e dnd",
  prefix: "dnd-",
  totalMs: 240_000,
  setup(run) {
    run.ids = seedIds(run.store);
  },
  steps: [
    ["Alex opens the roadmap's List with drag handles", openList],
    ["a drag reorders a group; the API's positions follow", reorderInGroup],
    ["the toast's Undo and Ctrl+Z put a move back", undoMoves],
    ["a drop in another status group changes the status", toAnotherGroup],
    ["the middle band nests, a top-level drop un-nests", nestAndUnnest],
    ["a drop into its own subtree is refused in red", ownSubtree],
    ["Alt+arrows and the row menu move the focused row", keyboardMoves],
    ["a Shift/Ctrl selection drags together with a count", selectionDrag],
    ["a drag in progress: light, dark and 360 px", dragScreenshots],
    ["a viewer has no handles and cannot drag", viewerCannotDrag],
    ["Kanban: reorder in a lane, move to another lane", kanbanMoves],
    ["ClickUp: header drop, hover-expand, auto-scroll", clickupBoard],
  ],
});
