/**
 * The compact status menu (SPEC-6 §1.1) on the task view's fake DOM: its
 * rows, the keyboard (arrows, Enter, typing, Escape), mouse picks, and
 * which surfaces open it (List rows, the task view, kanban and My work
 * pills) while the Main table keeps its full-bleed label picker.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { statusPill } from "../web/ui/board/cells.js";
import { statusCircle } from "../web/ui/board/list-row.js";
import { openStatusMenu, statusMenuRows } from "../web/ui/board/status-menu.js";
import { createTaskView } from "../web/ui/board/task-view.js";
import { closePopover, isPopoverOpen } from "../web/ui/components/popover.js";
import { FakeElement, findAll, fire, hasClass } from "./fake-dom.js";
import { installTaskDom, meetingsBoard, task } from "./web-task-fixtures.js";

const statusColumn = (board = meetingsBoard([])) =>
  board.columns.find((column) => column.id === "status");
const byClass = (root, name) => findAll(root, (node) => hasClass(node, name));
const byRole = (root, role) =>
  findAll(root, (node) => node.getAttribute("role") === role);

/** Opens the menu of the Status column at `value`; returns its parts. */
function openMenu(t, { value }) {
  const doc = installTaskDom(t);
  const anchor = new FakeElement("button");
  doc.body.append(anchor);
  const changes = [];
  openStatusMenu({
    anchor,
    column: statusColumn(),
    value,
    onChange: (next) => changes.push(next),
  });
  const [popover] = byClass(doc.body, "status-menu-popover");
  assert.ok(popover, "the compact menu opened");
  const [input] = byRole(popover, "combobox");
  const options = () => byRole(popover, "option");
  const labels = () =>
    options().map((node) => byClass(node, "status-menu-label")[0].textContent);
  const active = () => {
    const id = input.getAttribute("aria-activedescendant");
    const node = options().find((option) => option.id === id);
    assert.equal(node?.getAttribute("aria-selected"), "true");
    return byClass(node, "status-menu-label")[0].textContent;
  };
  const key = (name) => fire(input, "keydown", { key: name });
  const type = (text) => {
    input.value = text;
    fire(input, "input");
  };
  return { doc, anchor, input, options, labels, active, key, type, changes };
}

test("menu rows: labels as written, in label order, filtered; Clear last", () => {
  const column = statusColumn();
  const rows = statusMenuRows(column, { value: 1 });
  assert.deepEqual(
    rows.map((row) => [row.label, row.index, row.current, row.color]),
    [
      ["facility", 0, false, "#ff7800"],
      ["psych dept", 1, true, "#1090e0"],
      ["Closed", 2, false, "#008844"],
      ["Clear", null, false, null],
    ],
  );
  // Any part of a label, in any case; Clear always stays.
  const dept = statusMenuRows(column, { value: 1, term: " DEPT " });
  assert.deepEqual(
    dept.map((row) => row.label),
    ["psych dept", "Clear"],
  );
  const none = statusMenuRows(column, { value: null, term: "zzz" });
  assert.deepEqual(
    none.map((row) => row.label),
    ["Clear"],
  );
});

test("the menu opens in its search box on the current label, checked", (t) => {
  const { doc, input, options, labels, active, anchor } = openMenu(t, {
    value: 1,
  });
  assert.equal(doc.activeElement, input, "focus is in the search box");
  assert.equal(input.getAttribute("aria-expanded"), "true");
  const [list] = byRole(doc.body, "listbox");
  assert.equal(input.getAttribute("aria-controls"), list.id);
  assert.equal(list.getAttribute("aria-label"), "Status");
  assert.deepEqual(labels(), ["facility", "psych dept", "Closed", "Clear"]);
  assert.equal(active(), "psych dept");
  assert.deepEqual(
    options().map((node) => node.getAttribute("aria-checked")),
    ["false", "true", "false", null],
  );
  // One check mark, on the current label; a dot in each label's color.
  const [current] = options().filter((node) => hasClass(node, "current"));
  assert.equal(byClass(current, "status-menu-check").length, 1);
  assert.equal(byClass(doc.body, "status-menu-check").length, 1);
  assert.equal(options()[0].style["--dot-color"], "#ff7800");
  assert.equal(anchor.getAttribute("aria-expanded"), "true");
});

test("arrows move and wrap; Enter picks; the current label changes nothing", (t) => {
  const menu = openMenu(t, { value: 1 });
  menu.key("ArrowDown");
  assert.equal(menu.active(), "Closed");
  menu.key("ArrowDown");
  assert.equal(menu.active(), "Clear");
  menu.key("ArrowDown");
  assert.equal(menu.active(), "facility", "down from Clear wraps");
  menu.key("ArrowUp");
  assert.equal(menu.active(), "Clear", "up from the first wraps");
  menu.key("ArrowUp");
  menu.key("ArrowUp");
  assert.equal(menu.active(), "psych dept");
  const enter = menu.key("Enter");
  assert.equal(enter.defaultPrevented, true);
  assert.equal(isPopoverOpen(), false);
  assert.deepEqual(menu.changes, [], "picking the current label");
  assert.equal(menu.doc.activeElement, menu.anchor, "focus goes back");
});

test("typing filters the labels; the first match is active; Enter picks it", (t) => {
  const menu = openMenu(t, { value: 1 });
  menu.type("clo");
  assert.deepEqual(menu.labels(), ["Closed", "Clear"]);
  assert.equal(menu.active(), "Closed");
  menu.type("nothing like it");
  assert.deepEqual(menu.labels(), ["Clear"]);
  assert.equal(menu.active(), "Clear");
  const [empty] = byClass(menu.doc.body, "status-menu-empty");
  assert.equal(empty.hidden, false, "it says nothing matches");
  menu.type("");
  assert.equal(menu.active(), "psych dept", "a cleared search: the current");
  assert.equal(empty.hidden, true);
  menu.type("FAC");
  menu.key("Enter");
  assert.deepEqual(menu.changes, [0]);
  assert.equal(isPopoverOpen(), false);
});

test("Escape closes without a change; the mouse picks a row or Clear", (t) => {
  const menu = openMenu(t, { value: 1 });
  menu.key("ArrowDown");
  const escape = menu.doc.keydown({ key: "Escape" });
  assert.equal(escape.defaultPrevented, true, "a surrounding dialog stays");
  assert.equal(isPopoverOpen(), false);
  assert.deepEqual(menu.changes, []);

  const again = openMenu(t, { value: 1 });
  const [clear] = byClass(again.doc.body, "status-menu-clear");
  fire(again.options()[0], "pointermove");
  assert.equal(again.active(), "facility", "the pointer moves the active row");
  const press = fire(clear, "mousedown");
  assert.equal(press.defaultPrevented, true, "focus stays in the search box");
  fire(clear, "click");
  assert.deepEqual(again.changes, [null]);

  // Clear on a task without a status changes nothing.
  const unset = openMenu(t, { value: null });
  assert.equal(unset.active(), "facility", "no current label: the first");
  fire(byClass(unset.doc.body, "status-menu-clear")[0], "click");
  assert.deepEqual(unset.changes, []);
});

test("List rows, the task view, kanban and My work pills open the compact menu", (t) => {
  const doc = installTaskDom(t);
  const board = meetingsBoard([task("1", "Agenda", { status: 0 })]);
  const status = statusColumn(board);
  const [item] = board.items;
  const opened = (trigger) => {
    doc.body.append(trigger);
    fire(trigger, "click");
    const compact = byClass(doc.body, "status-menu-popover").length;
    const picker = byClass(doc.body, "status-picker").length;
    closePopover();
    return { compact, picker, popup: trigger.getAttribute("aria-haspopup") };
  };
  const ctx = { roles: { status }, caps: { edit: true }, actions: {} };
  assert.deepEqual(opened(statusCircle(ctx, { item, key: "g:1" })), {
    compact: 1,
    picker: 0,
    popup: "dialog",
  });
  const pill = (compact) =>
    statusPill({
      column: status,
      value: 0,
      label: "Status for Agenda",
      onChange() {},
      compact,
    });
  // Kanban cards and My work pass `compact`; the Main table does not.
  assert.deepEqual(opened(pill(true)), {
    compact: 1,
    picker: 0,
    popup: "dialog",
  });
  assert.deepEqual(opened(pill(false)), {
    compact: 0,
    picker: 1,
    popup: "menu",
  });

  const view = createTaskView({ onClose() {} });
  view.render({
    status: "ready",
    item,
    itemId: "1",
    detail: null,
    board,
    users: new Map(),
    actions: {},
    caps: { edit: true, viewOnly: false },
    draft: "",
    onDraft() {},
    repaint() {},
  });
  const [taskStatus] = findAll(
    view.element,
    (node) => node.dataset.focusKey === "task-status",
  );
  assert.deepEqual(opened(taskStatus), {
    compact: 1,
    picker: 0,
    popup: "dialog",
  });
});
