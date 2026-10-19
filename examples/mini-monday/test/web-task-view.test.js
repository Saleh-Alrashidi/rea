import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "../server/graphql/parse.js";
import { loadBoard, loadItem } from "../web/ui/board/board-data.js";
import { createTaskView } from "../web/ui/board/task-view.js";
import { findAll, fire, hasClass } from "./fake-dom.js";
import { installTaskDom, meetingsBoard, task } from "./web-task-fixtures.js";

const byClass = (root, name) => findAll(root, (node) => hasClass(node, name));
const oneOf = (root, name) => {
  const [found] = byClass(root, name);
  assert.ok(found, `.${name}`);
  return found;
};
const byKey = (root, key) =>
  findAll(root, (node) => node.dataset.focusKey === key)[0] ?? null;
const textsOf = (root, name) =>
  byClass(root, name).map((node) => node.textContent);

const ITEMS = [
  task("1", "Agenda", {
    status: 0,
    people: ["2"],
    description: "Room 4\n\nBring notes",
    minuts: "Line one\nLine two",
    tags: "weekly, psych",
    count: "3",
  }),
  task("2", "Book room", { status: 2 }, { parentId: "1", groupId: "closed" }),
  task("3", "Send invite", { status: 1, due: "2020-01-02" }, { parentId: "1" }),
];

const DETAIL = {
  id: "1",
  createdAt: "2026-10-01T09:00:00.000Z",
  creator: { id: "2", name: "Sam Lee", initials: "SL" },
  parent: null,
  subitemsCount: 2,
  updatesCount: 2,
  updates: [
    {
      id: "21",
      body: "Minutes: https://example.com/notes.\nتم",
      author_name: "Fox Mulder",
      creator: null,
      created_at: "2026-10-03T09:00:00.000Z",
    },
    {
      id: "20",
      body: "First",
      creator: { id: "2", name: "Sam Lee", initials: "SL" },
      created_at: "2026-10-02T09:00:00.000Z",
    },
  ],
};

/** Records action calls; `setValue` and friends resolve like the real ones. */
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
  return { calls, actions };
}

/** Renders a task view of `itemId`; `repaint()` re-renders it. */
function renderTask(t, { edit = true, itemId = "1", detail = DETAIL } = {}) {
  installTaskDom(t);
  const board = meetingsBoard(ITEMS.map((item) => ({ ...item })));
  const { calls, actions } = recorder();
  const view = createTaskView({ onClose: () => calls.push(["close"]) });
  const item = board.items.find((entry) => entry.id === itemId);
  const props = {
    status: "ready",
    item,
    itemId,
    detail: detail && { ...detail, id: itemId },
    board,
    users: new Map([["2", { id: "2", name: "Sam Lee", color: "#d6409f" }]]),
    actions,
    caps: { edit, viewOnly: !edit },
    draft: "",
    onDraft: (text) => calls.push(["draft", text]),
    repaint: () => view.render(props),
  };
  view.render(props);
  return { view, root: view.element, calls, board, props };
}

test("the task view lays out the top bar, title, fields and activity", (t) => {
  const { root, calls, board } = renderTask(t);
  assert.equal(root.getAttribute("aria-label"), "Task Agenda");
  assert.deepEqual(
    findAll(
      oneOf(root, "task-breadcrumb"),
      (node) => node.tagName === "LI",
    ).map((node) => node.textContent),
    ["Clinic", "Weekly Meetings"],
  );
  assert.equal(byClass(root, "task-parent").length, 0);
  assert.equal(oneOf(root, "task-id").textContent, "#1");
  assert.equal(oneOf(root, "task-title").value, "Agenda");

  // The fields grid: one row per role row, labelled.
  assert.deepEqual(
    byClass(oneOf(root, "task-fields"), "task-field-label").map(
      (node) => node.textContent,
    ),
    ["Status", "Assignees", "Dates", "Priority", "Time estimate", "Tags"],
  );
  assert.equal(oneOf(root, "task-status").textContent, "facility");
  assert.deepEqual(textsOf(root, "task-tag"), ["weekly", "psych"]);
  const complete = oneOf(root, "task-complete");
  assert.equal(
    complete.getAttribute("aria-label"),
    "Complete: set Status to Closed",
  );
  fire(complete, "click");
  const status = board.columns.find((column) => column.id === "status");
  assert.deepEqual(calls.at(-1), ["setValue", board.items[0], status, 2]);

  // The description keeps its line breaks, in its own direction.
  const description = oneOf(oneOf(root, "task-description"), "task-text");
  assert.equal(description.textContent, "Room 4\n\nBring notes");
  assert.equal(description.getAttribute("dir"), "auto");

  // Subtasks: progress, rows in board order, links to their task views.
  assert.equal(oneOf(root, "task-progress-count").textContent, "1/2");
  assert.deepEqual(
    byClass(root, "task-subtask-name").map((node) => [
      node.textContent,
      node.getAttribute("href"),
    ]),
    [
      ["Book room", "#/boards/1/items/2"],
      ["Send invite", "#/boards/1/items/3"],
    ],
  );
  assert.ok(hasClass(oneOf(root, "task-subtask-due"), "overdue"));
  const add = oneOf(root, "task-subtask-input");
  add.value = "  Order snacks ";
  fire(oneOf(root, "task-subtask-add"), "submit");
  assert.deepEqual(calls.at(-1), [
    "createSubitem",
    { parentId: "1", name: "Order snacks" },
  ]);
});

test("the activity runs oldest first with source authors and safe links", (t) => {
  const { root, calls } = renderTask(t);
  const stream = oneOf(root, "task-stream");
  assert.equal(stream.getAttribute("tabindex"), "0");
  const [created] = byClass(stream, "task-event");
  assert.match(created.textContent, /^Sam Lee created this task · /);
  assert.deepEqual(textsOf(stream, "task-comment-author"), [
    "Sam Lee",
    "Fox Mulder",
  ]);
  assert.deepEqual(textsOf(stream, "task-comment-tag"), ["ClickUp"]);
  assert.equal(oneOf(root, "task-activity-count").textContent, "2 comments");
  const body = byClass(stream, "task-comment-body")[1];
  assert.equal(body.getAttribute("dir"), "auto");
  assert.equal(body.textContent, "Minutes: https://example.com/notes.\nتم");
  const [link] = findAll(body, (node) => node.tagName === "A");
  assert.equal(link.getAttribute("href"), "https://example.com/notes");
  assert.equal(link.getAttribute("rel"), "noopener noreferrer");
  assert.equal(link.getAttribute("target"), "_blank");
  // A full date in the title of every relative time.
  for (const time of byClass(stream, "task-time")) {
    assert.ok(time.getAttribute("title"), time.textContent);
  }

  const input = oneOf(root, "composer-input");
  assert.equal(input.getAttribute("placeholder"), "Write a comment…");
  input.value = "  Agreed  ";
  fire(oneOf(root, "composer"), "submit");
  assert.deepEqual(calls.at(-2), ["draft", ""]);
  assert.equal(calls.at(-1)[0], "addUpdate");
  assert.equal(calls.at(-1)[2], "Agreed");
});

test("text fields save on blur only when the text changed", (t) => {
  const { root, calls, view } = renderTask(t);
  const doc = globalThis.document;
  fire(byKey(root, "task-edit-btn:description"), "click");
  let editor = byKey(view.element, "task-edit:description");
  assert.equal(editor.tagName, "TEXTAREA");
  assert.equal(editor.value, "Room 4\n\nBring notes");
  assert.equal(doc.activeElement, editor);
  // Leaving it unchanged saves nothing and shows the text again.
  editor.blur();
  doc.clicks();
  assert.equal(
    calls.filter(([name]) => name === "setValue").length,
    0,
    "no save",
  );
  assert.equal(byKey(view.element, "task-edit:description"), null);

  fire(byKey(view.element, "task-edit-btn:description"), "click");
  editor = byKey(view.element, "task-edit:description");
  editor.value = "Room 5\n\nBring notes";
  editor.blur();
  doc.clicks();
  const [name, , column, value] = calls.at(-1);
  assert.deepEqual(
    [name, column.id, value],
    ["setValue", "description", "Room 5\n\nBring notes"],
  );
});

test("Ctrl+Enter saves a text field, Escape cancels without closing", (t) => {
  const { root, calls, view } = renderTask(t);
  fire(byKey(root, "task-edit-btn:field:minuts"), "click");
  let editor = byKey(view.element, "task-edit:field:minuts");
  editor.value = "Line one\nLine two\nLine three";
  const escape = fire(editor, "keydown", { key: "Escape" });
  assert.equal(escape.defaultPrevented, true);
  assert.equal(calls.filter(([n]) => n === "setValue").length, 0);
  assert.equal(
    calls.some(([n]) => n === "close"),
    false,
  );
  // Focus returns to the field.
  assert.equal(
    globalThis.document.activeElement,
    byKey(view.element, "task-edit-btn:field:minuts"),
  );

  fire(byKey(view.element, "task-edit-btn:field:minuts"), "click");
  editor = byKey(view.element, "task-edit:field:minuts");
  editor.value = "Line one\nLine 2";
  fire(editor, "keydown", { key: "Enter", ctrlKey: true });
  assert.equal(calls.at(-1)[0], "setValue");
  assert.equal(calls.at(-1)[3], "Line one\nLine 2");
});

test("empty custom fields hide behind a toggle", (t) => {
  const { root, view } = renderTask(t);
  const labels = () =>
    byClass(oneOf(view.element, "task-custom-fields"), "task-field-label").map(
      (node) => node.textContent,
    );
  assert.deepEqual(labels(), ["Minuts", "#"]);
  const toggle = oneOf(root, "task-empty-toggle");
  assert.equal(toggle.textContent, "Show 3 empty fields");
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  fire(toggle, "click");
  assert.deepEqual(labels(), ["Minuts", "Files", "Status", "#", "Priority"]);
  const again = oneOf(view.element, "task-empty-toggle");
  assert.equal(again.getAttribute("aria-expanded"), "true");
  assert.equal(again.textContent, "Hide empty fields");
  // Multi-line text shows with its line breaks.
  assert.equal(
    oneOf(oneOf(view.element, "task-custom"), "task-text").textContent,
    "Line one\nLine two",
  );
});

test("a subtask links to its parent; view-only users get no editors", (t) => {
  const { root } = renderTask(t, {
    edit: false,
    itemId: "3",
    detail: {
      ...DETAIL,
      parent: { id: "1", name: "Agenda" },
      subitemsCount: 0,
      updatesCount: 0,
      updates: [],
    },
  });
  const parent = oneOf(root, "task-parent");
  assert.equal(parent.getAttribute("href"), "#/boards/1/items/1");
  assert.equal(parent.textContent, "Subtask ofAgenda");
  assert.equal(oneOf(root, "task-title-text").textContent, "Send invite");
  assert.equal(byClass(root, "view-only-badge").length, 1);
  for (const name of [
    "task-title",
    "task-complete",
    "task-edit",
    "task-subtask-add",
    "composer",
  ]) {
    assert.equal(byClass(root, name).length, 0, name);
  }
  assert.equal(oneOf(root, "task-status").tagName, "SPAN");
  assert.match(oneOf(root, "task-readonly-note").textContent, /view-only/);
  // No subtasks and no way to add one: no section.
  assert.equal(byClass(root, "task-subtasks").length, 0);
});

test("loading and missing tasks show the shared messages", (t) => {
  installTaskDom(t);
  const view = createTaskView({ onClose() {} });
  view.render({ status: "loading", itemId: "9" });
  assert.equal(byClass(view.element, "skeleton-list").length, 1);
  view.render({ status: "missing", itemId: "9" });
  assert.equal(
    oneOf(view.element, "empty-title").textContent,
    "This task isn’t available",
  );
  assert.equal(byKey(view.element, "task-close").tagName, "BUTTON");
});

// ------------------------------------------------------ against the server

function jsonResponse(status, body) {
  const text = JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

/** Routes the UI's requests through the real schema and store as user 1. */
async function realServer(t) {
  const { createSchema } = await import("../server/schema.js");
  const { execute } = await import("../server/graphql/execute.js");
  const { createStore } = await import("../server/store.js");
  const store = await createStore({ file: null });
  const schema = createSchema();
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const result = await execute({
      schema,
      document: parse(body.query),
      variables: body.variables ?? {},
      apiVersion: "2026-01",
      context: {
        store,
        principal: {
          kind: "session",
          userId: "1",
          scopes: new Set(["boards:read", "boards:write"]),
        },
        hostOrigin: "http://localhost:4100",
        apiVersion: "2026-01",
        log: { error() {} },
        requireScope() {},
      },
    });
    return jsonResponse("data" in result ? 200 : 400, result);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return store;
}

/** Imports a board of `columns` text columns whose task has `updates`. */
function importWide(store, { columns, updates }) {
  const workspaceId = store.listWorkspaces()[0].id;
  const extra = Array.from({ length: columns }, (_, index) => ({
    key: `c${index}`,
    title: `Field ${index}`,
    type: "text",
  }));
  const at = (index) =>
    new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString();
  const { board } = store.importBoard({
    workspaceId,
    importerId: "1",
    name: "Wide",
    description: null,
    boardKind: "public",
    meta: { source: "clickup", sourceId: "list-1", sourceUrl: null },
    label: "Import from ClickUp",
    summary: null,
    members: [],
    groups: [{ key: "open", title: "Open", color: "#579bfc" }],
    columns: extra,
    items: [
      { key: "p", groupKey: "open", name: "Parent", values: {}, updates: [] },
      {
        key: "t",
        parentKey: "p",
        groupKey: "open",
        name: "Task",
        values: {},
        updates: Array.from({ length: updates }, (_, index) => ({
          body: `Comment ${index}`,
          creatorId: null,
          createdAt: at(index),
          authorName: "Fox Mulder",
        })),
      },
    ],
  });
  return board.id;
}

test("loadItem() fits 500 comments in the field budget, fewer on wide boards", async (t) => {
  const store = await realServer(t);
  for (const [columns, loaded] of [
    [12, 500],
    [400, 409],
  ]) {
    const boardId = importWide(store, { columns, updates: 505 });
    const board = await loadBoard(boardId);
    const child = board.items.find((item) => item.name === "Task");
    const detail = await loadItem(child.id, board.columns);
    assert.equal(detail.updates.length, loaded, `${columns} columns`);
    assert.equal(detail.updatesCount, 505);
    assert.equal(detail.updates[0].body, "Comment 504");
    assert.equal(detail.updates[0].author_name, "Fox Mulder");
    assert.equal(detail.updates[0].creator, null);
    assert.deepEqual(detail.parent, {
      id: board.items.find((item) => item.name === "Parent").id,
      name: "Parent",
    });
    assert.equal(detail.parentId, detail.parent.id);
    assert.equal(detail.subitemsCount, 0);
  }
});
