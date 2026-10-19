#!/usr/bin/env node
/**
 * Browser test of the ClickUp-style List and task views (SPEC-5 §7). A
 * synthetic department meetings list
 * (`test/fixtures/import/clickup-meetings-data.js`) is scanned from the
 * fake ClickUp server and imported in code as Alex (`e2e-clickup-lib.mjs`);
 * then Chromium opens the board, which shows the List view by default, and
 * checks the status groups and their pills, nesting and expansion (mouse
 * and keyboard), status changes from the circle's compact status menu
 * (SPEC-6 §1.1: mouse, then keyboard: typing filters, arrows move, Escape
 * closes, Enter picks), search that keeps the ancestors of matches, the
 * "Show closed" toggle, the 360 px toolbar's "View options" menu and the
 * view tabs scrolling in their strip, and the task view: description,
 * custom fields, its status menu, subtasks, the activity stream with
 * author names (the ClickUp tag on authors without an account), posting a
 * comment and closing with focus back on the task's name. Text contrast
 * is checked in light and dark. Last, the Main table and the task view
 * opened from it edit the multi-line Minutes in a textarea that keeps its
 * line breaks (SPEC-5 §6), and closing goes back to the Main table
 * (`e2e-clickup-views.mjs`).
 *
 * Screenshots go to `e2e-output/clickup-<list|task>[-dark|-360].png`,
 * `clickup-status-menu.png`, `clickup-view-options-360.png` and
 * `clickup-task-subtasks.png`; at 360 px the page must not scroll
 * sideways.
 *
 * Usage: `node scripts/e2e-clickup.mjs`. The harness, environment
 * variables and skip rules are described in `e2e-lib.mjs`.
 */
import { MEETINGS } from "../test/fixtures/import/clickup-meetings-data.js";
import {
  checkContrast,
  expectedGroups,
  importMeetings,
  listGroup,
  listRow,
  rgbOf,
  statusMenuState,
  subtaskNames,
} from "./e2e-clickup-lib.mjs";
import { multiLineEdits, narrowToolbar } from "./e2e-clickup-views.mjs";
import { shots } from "./e2e-import-lib.mjs";
import {
  check,
  dataAs,
  runE2E,
  screenshot,
  seedIds,
  signedIn,
  waitUntil,
} from "./e2e-lib.mjs";

const BOARD = `query ($ids: [ID!]) {
  boards(ids: $ids, limit: 1) {
    views { type name }
    columns { id title type role }
    items_page(limit: 500) {
      items { id name parent_item_id updates_count }
    }
  }
}`;
const ITEM = `query ($ids: [ID!]!) {
  items(ids: $ids) { updates_count column_values { id text } }
}`;
/** The task with many comments and subtasks. */
const BUSY = MEETINGS.busy;
const TASK = "dialog.task-view[open]";
const MENU = ".status-menu-popover";
const COMMENT = "Thanks, see you on Sunday.\nI will bring the numbers.";

const textOf = async (locator) => ((await locator.textContent()) ?? "").trim();

/** Reads the board as Alex through the API. */
async function boardAsAlex(run) {
  const data = await dataAs(run, run.ids.users.alex, BOARD, {
    ids: [run.boardId],
  });
  return data.boards[0];
}

async function importStep(run) {
  const { data, report, boardId } = await importMeetings(run);
  Object.assign(run, { data, boardId });
  check(report.created.boards === 1, `${report.created.boards} boards`);
  const board = await boardAsAlex(run);
  const views = board.views.map((view) => view.type).join(",");
  check(views === "list,table,kanban", `ClickUp board views: ${views}`);
  const { items } = board.items_page;
  check(items.length === data.tasks.length, `${items.length} items`);
  const nested = items.filter((item) => item.parent_item_id !== null);
  const subtasks = data.tasks.filter((task) => task.parent !== null);
  check(nested.length === subtasks.length, `${nested.length} subitems`);
  const titles = board.columns.map((column) => column.title);
  check(!titles.includes("Parent item"), "real subitems, no Parent item");
  // Two columns are titled "Status": only ClickUp's own has the role.
  const statuses = board.columns.filter((column) => column.title === "Status");
  const roles = statuses.map((column) => column.role).join(",");
  check(roles === "status,", `roles of the Status columns: ${roles}`);
  run.statusColumn = statuses[0].id;
  const busy = items.find((item) => item.name === BUSY);
  check(busy.updates_count === MEETINGS.busyComments, "the busy task");
  run.itemIds = new Map(items.map((item) => [item.name, item.id]));
  run.minutesColumn = board.columns.find((c) => c.title === "Minutes").id;
}

async function listByDefault(run) {
  const hash = `#/boards/${run.boardId}`;
  const { page } = await signedIn(run, run.ids.users.alex, { hash });
  run.alex = page;
  await page.locator('.board-page[data-view="list"] .list-view').waitFor();
  check(page.url().endsWith(hash), `the board's link stays: ${page.url()}`);
  const tabs = await page.locator(".view-tab").allTextContents();
  const order = tabs.map((tab) => tab.trim()).join("|");
  check(order === "List|Main table|Kanban|Activity|Forms", `tabs: ${order}`);
  const active = await textOf(page.locator(".view-tab.active"));
  check(active === "List", `the active tab: ${active}`);
  const count = await textOf(page.locator("#toolbar-count"));
  check(count.includes(String(run.data.tasks.length)), `count: ${count}`);
}

/** Each group's pill, count and state as the page shows them. */
function shownGroups(page) {
  return page.locator("section.list-group").evaluateAll((sections) =>
    sections.map((section) => {
      const pill = section.querySelector(".list-group-pill");
      const style = getComputedStyle(pill);
      const count = section.querySelector(".list-group-count").textContent;
      return {
        label: pill.textContent.trim(),
        count: Number.parseInt(count, 10),
        background: style.backgroundColor,
        uppercase: style.textTransform === "uppercase",
        collapsed: section.classList.contains("collapsed"),
        expanded: section
          .querySelector(".list-group-toggle")
          .getAttribute("aria-expanded"),
      };
    }),
  );
}

async function groupsAndPills(run) {
  const page = run.alex;
  const shown = await shownGroups(page);
  const expected = expectedGroups(run.data);
  const labels = shown.map((group) => group.label).join("|");
  const want = expected.map((group) => group.label).join("|");
  check(labels === want, `groups: ${labels}, expected ${want}`);
  for (const [index, group] of expected.entries()) {
    const seen = shown[index];
    check(seen.count === group.count, `${group.label}: ${seen.count} tasks`);
    const color = rgbOf(group.color);
    check(seen.background === color, `${group.label}: ${seen.background}`);
    check(seen.uppercase, `${group.label}: the pill is uppercase`);
    // Closed work comes last, collapsed.
    check(seen.collapsed === group.done, `${group.label} collapsed`);
    check(seen.expanded === String(!group.done), `${group.label} toggle`);
  }
  const heads = await listGroup(page, "admin")
    .locator(".list-head")
    .allTextContents();
  for (const title of ["Assignees", "Due date", "Minutes", "Files", "#"]) {
    check(heads.includes(title), `the ${title} column shows: ${heads}`);
  }
  // Columns empty for every task are hidden; the description is a mark.
  for (const title of ["Tags", "Priority", "Time estimate (h)"]) {
    check(!heads.includes(title), `the empty ${title} column is hidden`);
  }
  check(!heads.includes("Description"), "the description is no cell");
  const arabic = listRow(page, MEETINGS.arabicTask).locator(".list-name");
  const dir = await arabic.evaluate((node) => [
    node.getAttribute("dir"),
    getComputedStyle(node).direction,
  ]);
  check(dir.join() === "auto,rtl", `an Arabic name reads ${dir}`);
  await checkColors(page, "light");
}

/** Text contrast of the list's pills, headers and counts in `scheme`. */
async function checkColors(page, scheme) {
  await checkContrast(page, ".list-group-pill", `a ${scheme} group pill`);
  await checkContrast(page, ".list-head", `a ${scheme} column header`);
  await checkContrast(page, ".list-group-count", `a ${scheme} task count`);
  await checkContrast(page, ".list-name", `a ${scheme} task name`);
}

/** The rows of `group` as `{ name, level }`, in order. */
function rowsOf(group) {
  return group.locator(".list-row").evaluateAll((rows) =>
    rows.map((row) => ({
      name: row.querySelector(".list-name")?.title,
      level: row.getAttribute("aria-level"),
    })),
  );
}

async function expandParent(run) {
  const page = run.alex;
  const group = listGroup(page, "facility");
  const row = listRow(group, MEETINGS.parent);
  const expanded = () => row.getAttribute("aria-expanded");
  check((await expanded()) === "false", "subtasks start collapsed");
  const names = subtaskNames(run.data, MEETINGS.parent);
  const chip = await textOf(row.locator(".list-subtasks"));
  check(chip === String(names.length), `the subtask chip reads ${chip}`);
  await row.locator(".list-expand").click();
  await waitUntil(async () => (await expanded()) === "true", "expanding");
  const rows = await rowsOf(group);
  const at = rows.findIndex((entry) => entry.name === MEETINGS.parent);
  const children = rows.slice(at + 1, at + 1 + names.length);
  const shown = children.map((entry) => entry.name).join("|");
  check(shown === names.join("|"), `subtasks under the parent: ${shown}`);
  check(
    children.every((entry) => entry.level === "2"),
    "subtasks are at level 2",
  );
  // A closed subtask stays under its parent, with a checked circle.
  const closed = listRow(group, MEETINGS.closedSubtask);
  check((await closed.locator(".list-status.done").count()) === 1, "checked");
  const elsewhere = listRow(listGroup(page, "Closed"), MEETINGS.closedSubtask);
  check((await elsewhere.count()) === 0, "not in the Closed group");
  // Left collapses and Right expands from the name.
  await row.locator(".list-name").focus();
  await page.keyboard.press("ArrowLeft");
  await waitUntil(async () => (await expanded()) === "false", "collapsing");
  check((await listRow(group, names[1]).count()) === 0, "subtasks hidden");
  await page.keyboard.press("ArrowRight");
  await waitUntil(async () => (await expanded()) === "true", "re-expanding");
  await shots(run, page, "list", { prefix: "clickup-" });
  await page.emulateMedia({ colorScheme: "dark" });
  await checkColors(page, "dark");
  await page.emulateMedia({ colorScheme: "light" });
}

/** Group counts by label. */
async function countsByLabel(page) {
  const groups = await shownGroups(page);
  return new Map(groups.map((group) => [group.label, group.count]));
}

/** The plain task's status as saved. */
async function plainStatus(run) {
  const { items } = await dataAs(run, run.ids.users.alex, ITEM, {
    ids: [run.itemIds.get(MEETINGS.plain)],
  });
  const value = items[0].column_values.find(
    (entry) => entry.id === run.statusColumn,
  );
  return value.text;
}

/**
 * The compact menu lists every label as written with a dot in its color,
 * checks the current one and ends with Clear; a click picks a label.
 */
async function statusMenu(run) {
  const page = run.alex;
  const before = await countsByLabel(page);
  const row = listRow(listGroup(page, "facility"), MEETINGS.plain);
  await row.locator("button.list-status").click();
  const menu = page.locator(MENU);
  await menu.waitFor();
  const circle = row.locator("button.list-status");
  check((await circle.getAttribute("aria-expanded")) === "true", "open");
  const shown = await statusMenuState(page);
  const statuses = run.data.lists[0].statuses;
  const labels = statuses
    .toSorted((a, b) => a.orderindex - b.orderindex)
    .map((status) => status.status);
  const rows = shown.labels.join("|");
  check(rows === [...labels, "Clear"].join("|"), `menu rows: ${rows}`);
  check(!shown.uppercase, "labels show in normal case");
  check(shown.checked.join() === "facility", `checked: ${shown.checked}`);
  check(shown.focused && shown.active === "facility", "opens on facility");
  for (const status of statuses) {
    const dot = shown.dots[status.status];
    check(
      dot === rgbOf(status.color.toLowerCase()),
      `${status.status}: ${dot}`,
    );
  }
  // The picture shows the menu once it has faded in.
  await menu.evaluate((node) =>
    Promise.all(node.getAnimations().map((motion) => motion.finished)),
  );
  await screenshot(run, page, "clickup-status-menu.png");
  await menu.getByRole("option", { name: "front desk", exact: true }).click();
  const moved = listRow(listGroup(page, "front desk"), MEETINGS.plain);
  await moved.waitFor();
  const after = await countsByLabel(page);
  check(after.get("facility") === before.get("facility") - 1, "facility");
  check(after.get("front desk") === before.get("front desk") + 1, "front");
  const saved = await plainStatus(run);
  check(saved === "front desk", `the saved status: ${saved}`);
  await statusMenuKeyboard(run, { moved, before });
}

/**
 * By keyboard: the menu opens on the current label with focus in its
 * search box; typing filters, arrows move (wrapping), Escape closes
 * without a change and Enter picks the active label.
 */
async function statusMenuKeyboard(run, { moved, before }) {
  const page = run.alex;
  const circle = moved.locator("button.list-status");
  await circle.focus();
  await page.keyboard.press("Enter");
  await page.locator(MENU).waitFor();
  const opened = await statusMenuState(page);
  check(opened.focused, "focus is in the menu's search box");
  check(opened.active === "front desk", `opens on ${opened.active}`);
  await page.keyboard.type("FAC");
  await waitUntil(
    async () =>
      (await statusMenuState(page)).labels.join("|") === "facility|Clear",
    "typing to filter the labels",
  );
  check((await statusMenuState(page)).active === "facility", "first match");
  await page.keyboard.press("ArrowDown");
  check((await statusMenuState(page)).active === "Clear", "ArrowDown");
  await page.keyboard.press("ArrowDown");
  check((await statusMenuState(page)).active === "facility", "it wraps");
  await page.keyboard.press("Escape");
  await page.locator(MENU).waitFor({ state: "detached" });
  // The list may be rebuilt as the menu closes; focus follows the circle.
  await waitUntil(
    () => circle.evaluate((node) => node === document.activeElement),
    "Escape to return focus to the status circle",
  );
  check((await plainStatus(run)) === "front desk", "Escape changed nothing");
  await page.keyboard.press("Enter");
  await page.locator(MENU).waitFor();
  await page.keyboard.type("fac");
  await page.keyboard.press("Enter");
  await listRow(listGroup(page, "facility"), MEETINGS.plain).waitFor();
  check((await plainStatus(run)) === "facility", "Enter picked facility");
  const after = await countsByLabel(page);
  check(after.get("facility") === before.get("facility"), "back in facility");
}

async function searchKeepsAncestors(run) {
  const page = run.alex;
  const search = page.locator(".search-input");
  await search.fill("PAPER stock");
  const rows = page.locator(".list-row");
  await waitUntil(async () => (await rows.count()) === 2, "the search");
  const shown = await rowsOf(page.locator(".list-view"));
  const names = shown.map((entry) => entry.name).join("|");
  check(names === `${MEETINGS.parent}|${MEETINGS.searchSubtask}`, names);
  const parent = listRow(page, MEETINGS.parent);
  check((await parent.getAttribute("aria-expanded")) === "true", "opened");
  const mark = await textOf(
    listRow(page, MEETINGS.searchSubtask).locator("mark"),
  );
  check(mark === "paper stock", `the highlighted part: ${mark}`);
  check((await page.locator("section.list-group").count()) === 1, "1 group");
  await search.fill("");
  const all = expectedGroups(run.data).length;
  await waitUntil(
    async () => (await page.locator("section.list-group").count()) === all,
    "every group after clearing the search",
  );
  // "Show closed" hides the closed group and brings it back.
  const toggle = page.locator(".list-tool", { hasText: "Show closed" });
  await toggle.click();
  await listGroup(page, "Closed").waitFor({ state: "detached" });
  check((await toggle.getAttribute("aria-pressed")) === "false", "pressed");
  await toggle.click();
  await listGroup(page, "Closed").waitFor();
}

/**
 * The task view's custom fields by label: each value's text, or its
 * editor's value (editors get inputs for numbers).
 */
function customFields(page) {
  return page.locator(`${TASK} .task-custom .task-field`).evaluateAll((rows) =>
    Object.fromEntries(
      rows.map((row) => {
        const value = row.querySelector(".task-field-value");
        const input = value.querySelector("input");
        return [
          row.querySelector(".task-field-label").textContent.trim(),
          (input ? input.value : value.innerText).trim(),
        ];
      }),
    ),
  );
}

async function checkTaskFields(run, page) {
  const title = page.locator(`${TASK} .task-title`);
  check((await title.inputValue()) === BUSY, "the task view's title");
  const description = page.locator(`${TASK} .task-description .task-text`);
  const text = await description.innerText();
  check(text.includes("Before the meeting:\n- "), `description: ${text}`);
  const wrap = await description.evaluate(
    (n) => getComputedStyle(n).whiteSpace,
  );
  check(wrap === "pre-wrap", `the description wraps as ${wrap}`);
  const fields = await customFields(page);
  const minutes = fields.Minutes ?? "";
  check(minutes.split("\n").length >= 3, `Minutes: ${minutes}`);
  check(fields.Files === "room-plan.png, agenda.pdf", `Files: ${fields.Files}`);
  check(fields.Status === "Working on it", `Status field: ${fields.Status}`);
  check(fields["#"] === "1", `# field: ${fields["#"]}`);
  check(!("Priority" in fields), "the empty Priority field is folded");
  const more = await textOf(page.locator(`${TASK} .task-empty-toggle`));
  check(more === "Show 1 empty field", `the empty fields toggle: ${more}`);
  const status = await textOf(
    page.locator(`${TASK} .task-fields .task-field-status`),
  );
  check(status.includes("admin"), `the status field: ${status}`);
  const names = subtaskNames(run.data, BUSY);
  const subtasks = page.locator(`${TASK} .task-subtask`);
  check((await subtasks.count()) === names.length, "the subtask rows");
  const done = await textOf(page.locator(`${TASK} .task-progress-count`));
  check(done === `2/${names.length}`, `subtasks done: ${done}`);
}

/** Author, tag and body of each comment of the open task view. */
function comments(page) {
  return page.locator(`${TASK} .task-comment`).evaluateAll((entries) =>
    entries.map((entry) => ({
      author: entry.querySelector(".task-comment-author").textContent,
      tag: entry.querySelector(".task-comment-tag")?.textContent ?? null,
      body: entry.querySelector(".task-comment-body").textContent,
    })),
  );
}

/** Whether the activity stream is scrolled to its end. */
const streamAtEnd = (page) =>
  page
    .locator("#task-stream")
    .evaluate((n) => n.scrollHeight - n.scrollTop - n.clientHeight < 2);

async function checkActivity(page) {
  const entries = await comments(page);
  check(entries.length === MEETINGS.busyComments, `${entries.length} shown`);
  const tagOf = (name) => entries.find((entry) => entry.author === name)?.tag;
  check(tagOf("Alex Rivera") === null, "a teammate has no source tag");
  for (const name of [MEETINGS.outsider, MEETINGS.arabicAuthor, "سارة يوسف"]) {
    check(tagOf(name) === "ClickUp", `${name}: tag ${tagOf(name)}`);
  }
  const created = await textOf(page.locator(`${TASK} .task-event`).first());
  check(created.startsWith("Alex Rivera created this task"), created);
  const link = page.locator(
    `${TASK} .task-comment-body a[href="https://notes.harbor.test/minutes/last-week"]`,
  );
  check(
    (await link.first().getAttribute("rel")) === "noopener noreferrer",
    "rel",
  );
  check(await streamAtEnd(page), "the stream opens at its end");
}

async function taskView(run) {
  const page = run.alex;
  const group = listGroup(page, "admin");
  await listRow(group, BUSY).locator(".list-name").click();
  await page.locator(TASK).waitFor();
  const itemId = run.itemIds.get(BUSY);
  check(page.url().endsWith(`/items/${itemId}`), `route ${page.url()}`);
  const shown = page.locator(`${TASK} .task-comment`);
  await waitUntil(
    async () => (await shown.count()) === MEETINGS.busyComments,
    "the task's comments",
  );
  const crumbs = await textOf(page.locator(`${TASK} .task-breadcrumb`));
  check(crumbs.includes(MEETINGS.board), `breadcrumb: ${crumbs}`);
  await checkTaskFields(run, page);
  await checkActivity(page);
  // The status pill opens the same compact menu; Escape closes only it.
  await page.locator(`${TASK} .task-status`).click();
  await page.locator(MENU).waitFor();
  const menu = await statusMenuState(page);
  check(menu.checked.join() === "admin", `task status menu: ${menu.checked}`);
  await page.keyboard.press("Escape");
  await page.locator(MENU).waitFor({ state: "detached" });
  check(await page.locator(TASK).isVisible(), "the task view stays open");
  await checkContrast(page, `${TASK} .task-comment-tag`, "the ClickUp tag");
  await checkContrast(page, `${TASK} .task-field-label`, "a field label");
  const cut = await page
    .locator(`${TASK} .task-field-label span`)
    .evaluateAll((spans) =>
      spans
        .filter((span) => span.scrollWidth > span.clientWidth)
        .map((span) => `${span.textContent} (${span.clientWidth}px)`),
    );
  check(cut.length === 0, `field labels are cut off: ${cut}`);
  // No hover effect where the click that opened the view left the mouse.
  await page.mouse.move(0, 0);
  await shots(run, page, "task", { prefix: "clickup-" });
  await page.locator("#task-main").evaluate((pane) => {
    pane.scrollTop = pane.scrollHeight;
  });
  await screenshot(run, page, "clickup-task-subtasks.png");
  await page.emulateMedia({ colorScheme: "dark" });
  await checkContrast(page, `${TASK} .task-comment-tag`, "a dark ClickUp tag");
  await checkContrast(page, `${TASK} .task-time`, "a dark comment time");
  await checkContrast(page, `${TASK} .task-field-label`, "a dark field label");
  await page.emulateMedia({ colorScheme: "light" });
}

async function postComment(run) {
  const page = run.alex;
  const box = page.locator(`${TASK} .task-composer textarea`);
  await box.fill(COMMENT);
  await page.locator(`${TASK} .task-composer button[type="submit"]`).click();
  const shown = page.locator(`${TASK} .task-comment`);
  const total = MEETINGS.busyComments + 1;
  await waitUntil(async () => (await shown.count()) === total, "the comment");
  const last = (await comments(page)).at(-1);
  check(last.author === "Alex Rivera" && last.tag === null, last.author);
  check(last.body === COMMENT, `the posted body: ${JSON.stringify(last.body)}`);
  check((await box.inputValue()) === "", "the composer is cleared");
  await waitUntil(() => streamAtEnd(page), "the stream to show the comment");
  const { items } = await dataAs(run, run.ids.users.alex, ITEM, {
    ids: [run.itemIds.get(BUSY)],
  });
  check(items[0].updates_count === total, `${items[0].updates_count} saved`);
}

async function closeTask(run) {
  const page = run.alex;
  await page.keyboard.press("Escape");
  await waitUntil(
    async () => (await page.locator(TASK).count()) === 0,
    "the task view to close",
  );
  check(!page.url().includes("/items/"), `back on the list: ${page.url()}`);
  const focused = await page.evaluate(() => {
    const active = document.activeElement;
    return active?.matches(".list-name") ? active.title : active?.className;
  });
  check(focused === BUSY, `focus returns to the task's name: ${focused}`);
}

runE2E({
  name: "e2e clickup",
  prefix: "clickup-",
  totalMs: 180_000,
  async setup(run) {
    run.ids = seedIds(run.store);
  },
  steps: [
    ["a ClickUp meetings list imports with real subtasks", importStep],
    ["the board opens in the List view", listByDefault],
    ["status groups with colored pills, hidden empty columns", groupsAndPills],
    ["a parent expands to its subtasks (mouse and keyboard)", expandParent],
    ["the compact status menu moves a task (mouse and keyboard)", statusMenu],
    [
      "search keeps ancestors; Show closed toggles the group",
      searchKeepsAncestors,
    ],
    ["at 360 px: View options, tabs scroll in their strip", narrowToolbar],
    ["the task view: description, fields, subtasks, activity", taskView],
    ["posting a comment in the task view", postComment],
    ["closing the task view returns focus to its name", closeTask],
    [
      "the table and the task view edit multi-line text in a textarea",
      multiLineEdits,
    ],
  ],
});
