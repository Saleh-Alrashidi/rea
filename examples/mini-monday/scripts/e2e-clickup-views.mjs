/**
 * Steps of `e2e-clickup.mjs` beyond the List view at desktop width:
 *
 * - At 360 px (SPEC-6 §1.1) the List toolbar's Group, Subtasks, Columns
 *   and Show closed fold into one "View options" menu ("Columns…" opens
 *   the Columns menu from it), the view tabs scroll inside their strip
 *   and the page never scrolls sideways.
 * - The Main table edits the busy task's multi-line Minutes in a textarea
 *   popover that keeps its line breaks (SPEC-5 §6); its "Open" shows the
 *   task view, whose Minutes edit in place (Escape cancels and keeps the
 *   view, a click outside saves), and closing goes back to the table.
 */
import { MEETINGS } from "../test/fixtures/import/clickup-meetings-data.js";
import { listRow } from "./e2e-clickup-lib.mjs";
import {
  DESKTOP,
  MOBILE,
  check,
  dataAs,
  screenshot,
  sidewaysOverflow,
  waitUntil,
} from "./e2e-lib.mjs";

const ITEM = `query ($ids: [ID!]!) {
  items(ids: $ids) { column_values { id text } }
}`;
/** The task with many comments and subtasks. */
const BUSY = MEETINGS.busy;
const TASK = "dialog.task-view[open]";

/** Picks `name` (a role and an accessible name) in the "View options" menu. */
async function viewOption(page, { role, name }) {
  await page.locator(".list-view-options").click();
  const menu = page.locator(".popover-menu");
  await menu.getByRole(role, { name, exact: true }).click();
}

/** Whether the parent task's row shows its subtasks. */
const parentExpanded = async (page) =>
  (await listRow(page, MEETINGS.parent).getAttribute("aria-expanded")) ===
  "true";

export async function narrowToolbar(run) {
  const page = run.alex;
  await page.setViewportSize(MOBILE);
  await page.locator(".list-view-options").waitFor();
  const wide = await page
    .locator(".list-tool-wide")
    .evaluateAll((tools) => tools.filter((n) => n.offsetParent).length);
  check(wide === 0, `${wide} wide toolbar tools show at 360 px`);
  const strip = await page.locator(".view-tabs").evaluate((node) => ({
    scrolls: node.scrollWidth > node.clientWidth,
    right: node.getBoundingClientRect().right,
  }));
  check(strip.scrolls, "the view tabs scroll inside their strip");
  check(strip.right <= MOBILE.width, `the tab strip ends at ${strip.right}`);
  const overflow = await sidewaysOverflow(page);
  check(overflow <= 0, `the page scrolls sideways by ${overflow}px`);
  await viewOption(page, { role: "menuitemradio", name: "Expanded" });
  await waitUntil(() => parentExpanded(page), "subtasks expanded");
  await viewOption(page, { role: "menuitem", name: "Columns…" });
  const columns = page.locator(".popover-menu", { hasText: "Minutes" });
  await columns.locator(".menu-heading", { hasText: "Columns" }).waitFor();
  // The picture shows the menu once it has faded in.
  await columns.evaluate((node) =>
    Promise.all(node.getAnimations().map((motion) => motion.finished)),
  );
  await screenshot(run, page, "clickup-view-options-360.png");
  await page.keyboard.press("Escape");
  await columns.waitFor({ state: "detached" });
  await viewOption(page, { role: "menuitemradio", name: "Collapsed" });
  await waitUntil(async () => !(await parentExpanded(page)), "collapsed");
  await page.setViewportSize(DESKTOP);
}

/** The busy task's Minutes as saved. */
async function savedMinutes(run) {
  const { items } = await dataAs(run, run.ids.users.alex, ITEM, {
    ids: [run.itemIds.get(BUSY)],
  });
  return items[0].column_values.find((v) => v.id === run.minutesColumn).text;
}

/** Appends `text` in the open text popover's textarea. */
async function typeAtEnd(page, text) {
  const editor = page.locator(".text-popover textarea");
  await editor.waitFor();
  await editor.press("Control+End");
  await page.keyboard.type(text);
  return editor;
}

export async function multiLineEdits(run) {
  const page = run.alex;
  await page.locator(".view-tab", { hasText: "Main table" }).click();
  await page.locator(".table-view").waitFor();
  const label = `Minutes for ${BUSY}`;
  const flat = await page.locator(`input[aria-label="${label}"]`).count();
  check(flat === 0, "no input holds the multi-line Minutes");
  let saved = await savedMinutes(run);
  check(saved.includes("\n"), `multi-line Minutes: ${JSON.stringify(saved)}`);
  const cell = page.locator(
    `.table-view button.text-lines[aria-label^="${label}:"]`,
  );
  await cell.click();
  const area = page.locator(".text-popover textarea");
  check((await area.inputValue()) === saved, "the textarea shows every line");
  await screenshot(run, page, "clickup-table-text.png");
  const editor = await typeAtEnd(page, "\nChecked in the table");
  await editor.press("Control+Enter");
  await editor.waitFor({ state: "detached" });
  saved = `${saved}\nChecked in the table`;
  await waitUntil(async () => (await savedMinutes(run)) === saved, "the edit");
  await taskViewFromTable(run, { label, saved });
}

/** Appends `text` at the end of the task view's open text editor. */
async function typeInTask(page, label, text) {
  const editor = page.locator(`${TASK} textarea[aria-label="${label}"]`);
  await editor.waitFor();
  await editor.press("Control+End");
  await page.keyboard.type(text);
  return editor;
}

/**
 * The Main table's "Open" shows the task view (SPEC-6 §1.1), whose
 * Minutes edit in place: Escape cancels and keeps the view, a click
 * outside saves; closing goes back to the table.
 */
async function taskViewFromTable(run, { label, saved: before }) {
  const page = run.alex;
  await page.locator(`button.open-item[aria-label="Open ${BUSY}"]`).click();
  const task = page.locator(TASK);
  await task.locator(".task-title").waitFor();
  const edit = task.getByRole("button", { name: "Edit Minutes", exact: true });
  await edit.click();
  const editor = await typeInTask(page, label, " (draft)");
  await page.keyboard.press("Escape");
  await editor.waitFor({ state: "detached" });
  check(await task.isVisible(), "Escape in the editor keeps the view open");
  check((await savedMinutes(run)) === before, "Escape saved nothing");
  await edit.click();
  await typeInTask(page, label, "\nReviewed in the task view");
  await task.locator("#task-custom-heading").click();
  const saved = `${before}\nReviewed in the task view`;
  await waitUntil(async () => (await savedMinutes(run)) === saved, "the task");
  await page.keyboard.press("Escape");
  await task.waitFor({ state: "detached" });
  check(
    page.url().endsWith("/views/table"),
    `back on the table: ${page.url()}`,
  );
}
