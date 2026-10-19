/**
 * What SPEC-5 §2 adds to imports: real subitems (`key` / `parentKey`,
 * ids before parents, any group, the depth cap), column roles and status
 * label types through validation and the store, update author names, the
 * views a board starts with, and all of it surviving a save and a reload.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { run } from "../server/import/engine.js";
import { validateSnapshot } from "../server/import/snapshot.js";
import { createStore } from "../server/store.js";
import { MAX_SUBITEM_DEPTH } from "../server/store/subitems.js";
import { sampleSnapshot, seededStore } from "./import-engine-fixtures.js";

const BOARD = "workspaces[0].boards[0]";
const roadmapOf = (snapshot) => snapshot.workspaces[0].boards[0];
const checked = (snapshot) => {
  const result = validateSnapshot(snapshot);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  return result.snapshot;
};
const item = (source_id, group_source_id, parent_source_id = null) => ({
  source_id,
  name: `Task ${source_id}`,
  group_source_id,
  parent_source_id,
  values: {},
  created_at: null,
  creator_source_id: null,
  updates: [],
});

/** A ClickUp-like snapshot: roles, label types, nested subtasks. */
function clickupSnapshot() {
  const snapshot = sampleSnapshot();
  snapshot.source = "clickup";
  snapshot.source_label = "ClickUp workspace Acme";
  const board = roadmapOf(snapshot);
  const [status, owner, due, , notes] = board.columns;
  status.role = "status";
  status.labels = [
    { label: "Working on it", color: "#fdab3d", type: "custom" },
    { label: "Done", color: "#00c875", type: "closed" },
  ];
  owner.role = "assignees";
  due.role = "due_date";
  notes.role = "description";
  // The subtask comes first and sits in the other group.
  board.items = [
    { ...item("c", "g-later", "p"), values: { status: "Done" } },
    item("p", "g-now"),
  ];
  return snapshot;
}

async function importedBoard(snapshot) {
  const { store, ids } = await seededStore();
  const options = { store, importerId: ids.users.alex };
  const report = await run(snapshot, {}, options);
  const board = store.getBoard(report.links.find((l) => l.kind === "board").id);
  return { store, report, board };
}

test("ClickUp boards keep roles, label types, real subtasks and open in a List", async () => {
  const { store, board } = await importedBoard(clickupSnapshot());
  const columns = store.listColumns(board.id);
  assert.deepEqual(
    columns.map((c) => [c.title, c.role]),
    [
      ["Name", undefined],
      ["Status", "status"],
      ["Owner", "assignees"],
      ["Due", "due_date"],
      ["Estimate", undefined],
      ["Notes", "description"],
    ],
  );
  assert.deepEqual(columns[1].settings, {
    labels: { 0: "Working on it", 1: "Done" },
    labels_colors: { 0: "#fdab3d", 1: "#00c875" },
    labels_types: { 0: "custom", 1: "closed" },
  });
  assert.deepEqual(
    store.listViews(board.id).map((v) => [v.type, v.name]),
    [
      ["list", "List"],
      ["table", "Main table"],
      ["kanban", "Kanban"],
    ],
    "List first, so it is the default view",
  );
  const { items } = store.listItems({ boardId: board.id, limit: 10 });
  const byName = new Map(items.map((i) => [i.name, i]));
  const parent = byName.get("Task p");
  const child = byName.get("Task c");
  assert.equal(parent.parent_id, undefined);
  assert.equal(child.parent_id, parent.id, "a subtask in another group");
  assert.deepEqual(
    [parent.group_id, child.group_id],
    ["now", "later"],
    "subtasks keep their own group (their own status)",
  );
  assert.deepEqual(child.values, { status: { index: 1 } });
});

test("subitems deeper than the store allows join their deepest allowed ancestor", async () => {
  const snapshot = sampleSnapshot();
  const chain = Array.from({ length: MAX_SUBITEM_DEPTH + 3 }, (_, depth) =>
    item(`d${depth}`, "g-now", depth === 0 ? null : `d${depth - 1}`),
  );
  roadmapOf(snapshot).items = chain.toReversed();
  const valid = checked(snapshot);
  const flattened = valid.warnings.filter(
    (w) => w.code === "subitems_flattened",
  );
  assert.deepEqual(
    flattened.map((w) => w.path),
    [6, 7].map((depth) => {
      const index = chain.length - 1 - depth;
      return `${BOARD}.items[${index}].parent_source_id`;
    }),
  );
  assert.match(flattened[0].message, /"Task d6" was nested more than 5/);
  assert.match(flattened[0].message, /a subitem of "Task d4"/);
  const parents = Object.fromEntries(
    roadmapOf(valid).items.map((i) => [i.source_id, i.parent_source_id]),
  );
  assert.deepEqual(
    [parents.d5, parents.d6, parents.d7],
    ["d4", "d4", "d4"],
    "every item past depth 5 joins the ancestor at depth 4",
  );
  assert.equal(validateSnapshot(valid).snapshot, valid, "validated once");
  const { store, board } = await importedBoard(valid);
  const { items } = store.listItems({ boardId: board.id, limit: 20 });
  const depthOf = (record) => {
    let depth = 0;
    for (let at = record; at.parent_id; depth += 1)
      at = items.find((i) => i.id === at.parent_id);
    return depth;
  };
  assert.equal(Math.max(...items.map(depthOf)), MAX_SUBITEM_DEPTH);
  assert.deepEqual(
    items.map((i) => i.name.slice(-2)),
    ["d0", "d1", "d2", "d3", "d4", "d7", "d6", "d5"],
    "parents come before their subitems, which keep snapshot order",
  );
});

test("validation keeps valid roles and label types and drops the others", () => {
  const snapshot = clickupSnapshot();
  const board = roadmapOf(snapshot);
  board.columns[3].role = "tags"; // a numbers column
  board.columns.push(
    {
      source_id: "who2",
      title: "Reviewers",
      type: "people",
      original_type: "people",
      role: "assignees",
    },
    {
      source_id: "odd",
      title: "Odd",
      type: "text",
      original_type: "text",
      role: "mood",
    },
  );
  board.columns[0].labels.push({ label: "Later", color: "#c4c4c4", type: 3 });
  const valid = checked(snapshot);
  const columns = roadmapOf(valid).columns;
  assert.deepEqual(
    columns.map((c) => [c.source_id, c.role]),
    [
      ["status", "status"],
      ["owner", "assignees"],
      ["due", "due_date"],
      ["est", undefined],
      ["notes", "description"],
      ["who2", undefined],
      ["odd", undefined],
    ],
  );
  assert.deepEqual(columns[0].labels.at(-1), {
    label: "Later",
    color: "#c4c4c4",
  });
  assert.deepEqual(columns[0].labels[1].type, "closed");
  assert.deepEqual(
    valid.warnings
      .filter((w) => /role|label_type/.test(w.code))
      .map((w) => [w.code, w.path]),
    [
      ["invalid_label_type", `${BOARD}.columns[0].labels[2].type`],
      ["invalid_role", `${BOARD}.columns[6].role`],
      ["invalid_role", `${BOARD}.columns[3].role`],
      ["duplicate_role", `${BOARD}.columns[5].role`],
    ],
  );
  assert.equal(validateSnapshot(valid).snapshot, valid, "validated once");
});

test("a status column that becomes text loses its role", () => {
  const snapshot = clickupSnapshot();
  const [status] = roadmapOf(snapshot).columns;
  status.labels = Array.from({ length: 201 }, (_, n) => ({
    label: `L${n}`,
    color: "#c4c4c4",
  }));
  const column = roadmapOf(checked(snapshot)).columns[0];
  assert.deepEqual([column.type, column.role], ["text", undefined]);
});

/** A small valid `importBoard` spec with a subitem before its parent. */
function spec({ workspaceId, importerId }) {
  return {
    workspaceId,
    importerId,
    name: "Imported",
    description: null,
    boardKind: "private",
    meta: { source: "clickup", sourceId: "list-9", sourceUrl: null },
    label: "Import from ClickUp",
    summary: "Imported from ClickUp",
    members: [],
    groups: [
      { key: "open", title: "Open", color: "#579bfc" },
      { key: "closed", title: "Closed", color: "#00c875" },
    ],
    columns: [
      {
        key: "s",
        title: "Status",
        type: "status",
        role: "status",
        labels: [
          { label: "to do", color: "#c4c4c4", type: "open" },
          { label: "done", color: "#00c875", type: "done" },
        ],
      },
      { key: "d", title: "Description", type: "text", role: "description" },
    ],
    items: [
      {
        key: "child",
        parentKey: "top",
        groupKey: "closed",
        name: "Child",
        values: { s: "done" },
        creatorId: null,
        createdAt: null,
        updates: [
          {
            body: "Line one\nLine two",
            creatorId: null,
            createdAt: null,
            authorName: "Rania",
          },
        ],
      },
      {
        key: "top",
        groupKey: "open",
        name: "Top",
        values: { d: "First\nSecond" },
        creatorId: null,
        createdAt: null,
        updates: [],
      },
    ],
    views: [
      { type: "list", name: "List" },
      { type: "table", name: "Main table" },
    ],
  };
}

test("importBoard refuses bad parents, roles, label types, authors and views", async () => {
  const { store, ids, events } = await seededStore();
  const base = { workspaceId: ids.workspaces.main, importerId: ids.users.alex };
  const before = store.listBoards({ limit: 1000 }).length;
  const broken = [
    [(s) => (s.items[0].parentKey = "nope"), /unknown parent/],
    [(s) => (s.items[1].parentKey = "top"), /its own parent/],
    [(s) => (s.items[1].parentKey = "child"), /parent cycle/],
    [(s) => (s.items[1].key = "child"), /repeats an item key/],
    [
      (s) =>
        s.columns.push({
          key: "x",
          title: "Stage",
          type: "status",
          role: "status",
        }),
      /repeats the role status/,
    ],
    [(s) => (s.columns[1].role = "priority"), /needs a status column/],
    [(s) => (s.columns[1].role = "mood"), /Role must be one of/],
    [(s) => (s.columns[0].labels[0].type = "doing"), /Label type/],
    [(s) => (s.items[0].updates[0].creatorId = ids.users.sam), /author/],
    [(s) => (s.items[0].updates[0].authorName = " "), /Author name/],
    [(s) => s.views.push({ type: "list" }), /listed twice/],
    [(s) => (s.views = [{ type: "app" }]), /View type/],
    [(s) => (s.views = []), /needs a List view/],
    [(s) => (s.views = [{ type: "table" }]), /needs a List view/],
  ];
  for (const [breakIt, message] of broken) {
    const input = spec(base);
    breakIt(input);
    const result = store.importBoard(input);
    assert.equal(result.ok, false, String(breakIt));
    assert.match(result.message, message, String(breakIt));
  }
  const deep = spec(base);
  deep.items = Array.from({ length: MAX_SUBITEM_DEPTH + 2 }, (_, n) => ({
    key: `k${n}`,
    parentKey: n === 0 ? null : `k${n - 1}`,
    groupKey: "open",
    name: `Level ${n}`,
    values: {},
    updates: [],
  }));
  assert.match(store.importBoard(deep).message, /nested 6 levels deep/);
  assert.equal(store.listBoards({ limit: 1000 }).length, before);
  assert.deepEqual(events, [], "no change was committed");
});

test("subitems, roles, label types, authors and views survive a reload", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "mini-monday-import-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "data.json");
  const store = await createStore({ file });
  const workspaceId = store.listWorkspaces()[0].id;
  const importerId = store.listUsers()[0].id;
  const { board } = store.importBoard(spec({ workspaceId, importerId }));
  await store.flush();
  const reloaded = await createStore({ file });
  const { items } = reloaded.listItems({ boardId: board.id, limit: 10 });
  const [child, top] = items.toSorted((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(
    [child.name, child.parent_id, child.group_id],
    ["Child", top.id, "closed"],
  );
  assert.equal(Number(child.id) < Number(top.id), true, "ids in spec order");
  assert.equal(top.values.text, "First\nSecond", "multi-line text as written");
  const [update] = reloaded.listUpdates(child.id);
  assert.deepEqual(
    [update.body, update.creator_id, update.author_name],
    ["Line one\nLine two", null, "Rania"],
  );
  const columns = reloaded.listColumns(board.id);
  assert.deepEqual(
    columns.map((c) => c.role),
    [undefined, "status", "description"],
  );
  assert.deepEqual(columns[1].settings.labels_types, { 0: "open", 1: "done" });
  assert.deepEqual(
    reloaded.listViews(board.id).map((v) => v.type),
    ["list", "table"],
  );
});
