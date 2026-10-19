/**
 * Text values with line breaks (SPEC-5 §3.4, §6) in the Main table, the
 * item card, the List view and the shared editors, on the task view's
 * fake DOM, whose text inputs drop line breaks as browsers do: a real
 * edit of a multi-line value goes through a textarea and saves its line
 * breaks; one-line values keep the inline input.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createItemCard } from "../web/ui/board/item-card.js";
import { listCell } from "../web/ui/board/list-cells.js";
import { renderTable } from "../web/ui/board/table-view.js";
import { closePopover, isPopoverOpen } from "../web/ui/components/popover.js";
import {
  firstLine,
  textCommit,
  textEditor,
} from "../web/ui/components/text-editor.js";
import { FakeElement, findAll, fire, hasClass } from "./fake-dom.js";
import { installTaskDom, meetingsBoard, task } from "./web-task-fixtures.js";

const MINUTES = "Line one\nLine two\nLine three";

const byKey = (root, key) =>
  findAll(root, (node) => node.dataset.focusKey === key)[0] ?? null;

/** The textarea of the open text popover. */
function popoverEditor() {
  const doc = globalThis.document;
  const [popover] = findAll(doc.body, (node) => hasClass(node, "text-popover"));
  assert.ok(popover, "a text popover opened");
  const [editor] = findAll(popover, (node) => node.localName === "textarea");
  assert.ok(editor, "with a textarea");
  assert.equal(isPopoverOpen(), true);
  assert.equal(doc.activeElement, editor, "the textarea has focus");
  return editor;
}

/** Records action calls; `setValues()` lists `[columnId, value]`. */
function recorder() {
  const calls = [];
  const actions = new Proxy(
    {},
    {
      get:
        (_target, name) =>
        (...args) => {
          calls.push([name, ...args]);
          return Promise.resolve(true);
        },
    },
  );
  const setValues = () =>
    calls
      .filter(([name]) => name === "setValue")
      .map(([, , column, value]) => [column.id, value]);
  return { calls, actions, setValues };
}

const agenda = () =>
  meetingsBoard([task("1", "Agenda", { minuts: MINUTES, files: "plan.pdf" })]);

test("the Main table edits a multi-line text cell in a textarea", (t) => {
  const doc = installTaskDom(t);
  const board = agenda();
  const { actions, setValues } = recorder();
  const container = new FakeElement("div");
  doc.body.append(container);
  renderTable(container, {
    board,
    items: board.items,
    search: "",
    users: new Map(),
    collapsed: new Set(),
    actions,
    caps: { edit: true, viewOnly: false, reasons: {} },
    openItem() {},
    toggleGroup() {},
  });
  const inputs = findAll(container, (node) => node.localName === "input");
  const labels = inputs.map((input) => input.getAttribute("aria-label"));
  assert.ok(!labels.includes("Minuts for Agenda"), "no input flattens it");
  // A one-line value keeps its inline input.
  assert.equal(byKey(container, "cell:1:files").localName, "input");
  const cell = byKey(container, "cell:1:minuts");
  assert.equal(cell.localName, "button");
  assert.equal(cell.textContent, "Line one…");
  assert.equal(cell.getAttribute("title"), MINUTES);

  fire(cell, "click");
  const editor = popoverEditor();
  assert.equal(editor.value, MINUTES);
  editor.value = `${MINUTES}!`;
  fire(editor, "keydown", { key: "Enter", ctrlKey: true });
  assert.equal(isPopoverOpen(), false);
  assert.deepEqual(setValues(), [["minuts", `${MINUTES}!`]]);
});

/** The item card of the agenda, attached; `field` is its Minuts editor. */
function openCard(t) {
  const doc = installTaskDom(t);
  const board = agenda();
  const { actions, setValues } = recorder();
  const card = createItemCard({ onClose() {} });
  card.render({
    status: "ready",
    item: board.items[0],
    detail: { id: "1", createdAt: null, creator: null, updates: [] },
    board,
    users: new Map(),
    actions,
    caps: { edit: true, viewOnly: false },
    draft: "",
    onDraft() {},
  });
  doc.body.append(card.element);
  const field = byKey(card.element, "card-cell:minuts");
  return { doc, field, setValues };
}

test("the item card edits a multi-line value: Escape cancels, leaving saves", (t) => {
  const { doc, field, setValues } = openCard(t);
  assert.equal(field.localName, "button");
  fire(field, "click");
  let editor = popoverEditor();
  editor.value = "Changed\ntext";
  // The popover takes Escape before the textarea (capture phase).
  const escape = doc.keydown({ key: "Escape" });
  assert.equal(escape.defaultPrevented, true, "the card stays open");
  assert.equal(isPopoverOpen(), false);
  assert.equal(doc.activeElement, field, "focus returns to the field");
  assert.deepEqual(setValues(), []);

  fire(field, "click");
  editor = popoverEditor();
  assert.equal(editor.value, MINUTES, "the edit was not kept");
  editor.value = `${MINUTES}\nLine four`;
  editor.blur();
  assert.deepEqual(setValues(), [], "nothing saves until the popover closes");
  // A click outside closes the popover.
  closePopover();
  assert.deepEqual(setValues(), [["minuts", `${MINUTES}\nLine four`]]);
});

test("the text popover saves only a change, after focus comes back too", (t) => {
  const { field, setValues } = openCard(t);
  fire(field, "click");
  popoverEditor();
  closePopover();
  assert.deepEqual(setValues(), []);
  fire(field, "click");
  const editor = popoverEditor();
  editor.value = " \n ";
  // A click on the popover's hint moves focus off the textarea and back.
  editor.blur();
  editor.focus();
  fire(editor, "keydown", { key: "Enter", metaKey: true });
  assert.equal(isPopoverOpen(), false);
  // Clearing stores no value.
  assert.deepEqual(setValues(), [["minuts", null]]);
});

test("the List view edits only one-line text inline; multi-line opens the task", (t) => {
  installTaskDom(t);
  const board = agenda();
  const { actions } = recorder();
  const opened = [];
  const ctx = {
    board,
    users: new Map(),
    actions,
    caps: { edit: true },
    keyPrefix: "row-1",
    openItem: (id) => opened.push(id),
  };
  const column = (id) => board.columns.find((entry) => entry.id === id);
  const cellOf = (id) =>
    listCell(ctx, {
      item: board.items[0],
      cell: { column: column(id), kind: "text" },
      done: false,
    });
  assert.equal(cellOf("files").localName, "input");
  const minutes = cellOf("minuts");
  assert.equal(minutes.localName, "button");
  assert.equal(minutes.textContent, "Line one…");
  fire(minutes, "click");
  assert.deepEqual(opened, ["1"]);
});

test("a one-line field with a line break still edits in a textarea", (t) => {
  installTaskDom(t);
  const ends = [];
  const editor = textEditor({
    value: "weekly,\npsych",
    label: "Tags",
    multiline: false,
    onEnd: (end) => ends.push(end),
  });
  assert.equal(editor.localName, "textarea");
  // Enter adds a line in a textarea; Ctrl+Enter saves.
  fire(editor, "keydown", { key: "Enter" });
  assert.deepEqual(ends, []);
  editor.value = "weekly,\npsych, urgent";
  fire(editor, "keydown", { key: "Enter", ctrlKey: true });
  assert.deepEqual(ends, [
    {
      save: true,
      leaving: false,
      text: { changed: true, value: "weekly,\npsych, urgent" },
    },
  ]);
  const line = textEditor({
    value: "weekly",
    label: "Tags",
    onEnd() {},
  });
  assert.equal(line.localName, "input");
});

test("text cells show their first line", () => {
  assert.deepEqual(firstLine("One\ntwo"), {
    text: "One",
    more: true,
    multiline: true,
  });
  assert.deepEqual(firstLine("One\r\n\r\n"), {
    text: "One",
    more: false,
    multiline: true,
  });
  assert.deepEqual(firstLine(null), {
    text: "",
    more: false,
    multiline: false,
  });
});

test("an edited text saves only when it changed", () => {
  assert.deepEqual(textCommit("a\nb", "a\nb"), {
    changed: false,
    value: "a\nb",
  });
  assert.deepEqual(textCommit("a", "a\n\nb"), {
    changed: true,
    value: "a\n\nb",
  });
  // Clearing (or only blanks) stores no value.
  assert.deepEqual(textCommit("a", "  \n"), { changed: true, value: null });
});
