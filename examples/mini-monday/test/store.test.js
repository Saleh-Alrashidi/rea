import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "../server/store.js";

// Store API tests: mutators, change events, ordering, app storage, tokens
// and listeners. Seed, ID generation and persistence are covered by
// store-state.test.js.
const START = Date.UTC(2026, 9, 18, 9, 0, 0);
const clock = () => {
  let tick = 0;
  return () => new Date(START + 1000 * tick++);
};
const quietLog = () => {
  const errors = [];
  return { errors, error: (...args) => errors.push(args) };
};
const memoryStore = (options = {}) => createStore({ now: clock(), ...options });
const record = (store) => {
  const events = [];
  const off = store.on((event) => events.push(event));
  return { events, off };
};
const roadmapOf = (store) =>
  store.listBoards().find((b) => b.name === "Product roadmap");

test("createBoard adds the default columns, group and views", async () => {
  const store = await memoryStore();
  const { events } = record(store);
  const board = store.createBoard({
    name: "Ops",
    description: "Runbook",
    creatorId: "2",
  });
  assert.deepEqual(board, {
    id: board.id,
    name: "Ops",
    description: "Runbook",
    state: "active",
    creator_id: "2",
  });
  assert.deepEqual(events, [{ type: "board_created", board_id: board.id }]);
  assert.deepEqual(
    store.listColumns(board.id).map((c) => [c.id, c.type]),
    [
      ["name", "name"],
      ["status", "status"],
      ["person", "people"],
      ["date", "date"],
    ],
  );
  assert.deepEqual(
    store.listGroups(board.id).map((g) => [g.id, g.title, g.color]),
    [["topics", "Topics", "#579bfc"]],
  );
  assert.deepEqual(
    store.listViews(board.id).map((v) => v.type),
    ["table", "kanban"],
  );
  assert.equal(store.createBoard({ name: "Ghost", creatorId: "99" }), null);
  assert.equal(store.createBoard({ name: "Anon" }).creator_id, null);
  assert.throws(() => store.createBoard({ name: "" }), TypeError);
  assert.throws(
    () => store.createBoard({ name: "x", description: 5 }),
    TypeError,
  );
  assert.equal(events.length, 2);
});

test("updateBoard and deleteBoard emit events and cascade", async () => {
  const store = await memoryStore();
  const roadmap = roadmapOf(store);
  const install = store.listInstalls({ boardId: roadmap.id })[0];
  store.setAppStorage(`install:${install.id}`, "note", "hi");
  store.setAppStorage(`app:${install.app_id}`, "shared", "kept");
  const { events } = record(store);
  const renamed = store.updateBoard(roadmap.id, { name: "Roadmap" });
  assert.equal(renamed.name, "Roadmap");
  assert.equal(renamed.description, roadmap.description);
  assert.equal(
    store.updateBoard(roadmap.id, { description: null }).description,
    null,
  );
  assert.equal(store.updateBoard("999", { name: "x" }), null);
  const deleted = store.deleteBoard(roadmap.id);
  assert.equal(deleted.state, "deleted");
  assert.equal(store.getBoard(roadmap.id), null);
  assert.deepEqual(store.listGroups(roadmap.id), []);
  assert.deepEqual(store.listColumns(roadmap.id), []);
  assert.deepEqual(store.listViews(roadmap.id), []);
  assert.equal(store.countItems(roadmap.id), 0);
  assert.equal(store.getItem("7"), null);
  assert.deepEqual(store.listUpdates("7"), []);
  assert.equal(store.getInstall(install.id), null);
  assert.equal(store.getAppStorage(`install:${install.id}`, "note"), null);
  assert.equal(
    store.getAppStorage(`app:${install.app_id}`, "shared").value,
    "kept",
  );
  assert.equal(store.deleteBoard(roadmap.id), null);
  assert.deepEqual(
    events.map((e) => [e.type, e.board_id]),
    [
      ["board_updated", roadmap.id],
      ["board_updated", roadmap.id],
      ["board_deleted", roadmap.id],
    ],
  );
});

test("deleteGroup removes the group and its items", async () => {
  const store = await memoryStore();
  const roadmap = roadmapOf(store);
  const doomed = store.listItems({
    boardId: roadmap.id,
    groupId: "next_up",
  }).items;
  assert.equal(doomed.length, 3);
  const { events } = record(store);
  assert.equal(store.deleteGroup(roadmap.id, "next_up").id, "next_up");
  assert.deepEqual(events, [
    { type: "group_deleted", board_id: roadmap.id, group_id: "next_up" },
  ]);
  assert.equal(store.countItems(roadmap.id), 5);
  for (const item of doomed) assert.equal(store.getItem(item.id), null);
  assert.equal(store.getGroup(roadmap.id, "next_up"), null);
  assert.equal(store.deleteGroup(roadmap.id, "next_up"), null);
  assert.equal(store.deleteGroup("999", "done"), null);
  assert.equal(events.length, 1);
});

test("createItem validates stored values and appends to the group", async () => {
  const store = await memoryStore();
  const roadmap = roadmapOf(store);
  const { events } = record(store);
  const values = {
    status: { index: 2 },
    person: ["2", "3"],
    estimate: 1,
    notes: null,
  };
  const item = store.createItem({
    boardId: roadmap.id,
    name: "New",
    values,
    creatorId: "3",
  });
  assert.equal(item.group_id, "this_sprint", "defaults to the first group");
  assert.equal(item.position, 3);
  assert.deepEqual(item.values, {
    status: { index: 2 },
    person: ["2", "3"],
    estimate: 1,
  });
  assert.equal(item.created_at, item.updated_at);
  assert.equal(item.state, "active");
  values.person.push("1");
  assert.deepEqual(
    store.getItem(item.id).values.person,
    ["2", "3"],
    "values are copied",
  );
  const done = store.createItem({
    boardId: roadmap.id,
    groupId: "done",
    name: "Late",
  });
  assert.equal(done.position, 2);
  assert.deepEqual(events, [
    {
      type: "item_created",
      board_id: roadmap.id,
      item_id: item.id,
      group_id: "this_sprint",
    },
    {
      type: "item_created",
      board_id: roadmap.id,
      item_id: done.id,
      group_id: "done",
    },
  ]);
  assert.equal(store.createItem({ boardId: "999", name: "x" }), null);
  assert.equal(
    store.createItem({ boardId: roadmap.id, groupId: "nope", name: "x" }),
    null,
  );
  assert.equal(
    store.createItem({ boardId: roadmap.id, name: "x", creatorId: "99" }),
    null,
  );
  const bad = [
    { missing: "x" },
    { name: "x" },
    { status: { index: 9 } },
    { person: ["99"] },
    { estimate: "5" },
    { date: "2026-02-30" },
  ];
  for (const badValues of bad) {
    assert.throws(
      () =>
        store.createItem({ boardId: roadmap.id, name: "x", values: badValues }),
      TypeError,
    );
  }
  assert.throws(
    () => store.createItem({ boardId: roadmap.id, name: " " }),
    TypeError,
  );
  assert.equal(events.length, 2);
});

test("item mutators emit one event each and ignore unknown IDs", async () => {
  const store = await memoryStore();
  const roadmap = roadmapOf(store);
  const item = store.listItems({ boardId: roadmap.id }).items[0];
  const { events } = record(store);
  const renamed = store.renameItem(item.id, "Renamed");
  assert.equal(renamed.name, "Renamed");
  assert.ok(renamed.updated_at > item.updated_at);
  const set = store.setColumnValue(item.id, "estimate", 13);
  assert.equal(set.values.estimate, 13);
  const cleared = store.setColumnValue(item.id, "status", null);
  assert.equal("status" in cleared.values, false);
  const moved = store.moveItem(item.id, "done");
  assert.deepEqual([moved.group_id, moved.position], ["done", 2]);
  assert.equal(
    store.moveItem(item.id, "done").position,
    2,
    "same group keeps position",
  );
  const deleted = store.deleteItem(item.id);
  assert.equal(deleted.state, "deleted");
  assert.equal(store.getItem(item.id), null);
  assert.deepEqual(store.listUpdates(item.id), [], "updates go with the item");
  const base = { board_id: roadmap.id, item_id: item.id };
  assert.deepEqual(events, [
    { type: "item_renamed", ...base, group_id: "this_sprint" },
    {
      type: "column_value_changed",
      ...base,
      group_id: "this_sprint",
      column_id: "estimate",
    },
    {
      type: "column_value_changed",
      ...base,
      group_id: "this_sprint",
      column_id: "status",
    },
    { type: "item_moved", ...base, group_id: "done" },
    { type: "item_moved", ...base, group_id: "done" },
    { type: "item_deleted", ...base, group_id: "done" },
  ]);
  const other = store.listItems({ boardId: roadmap.id }).items[0];
  assert.equal(store.renameItem("999", "x"), null);
  assert.equal(store.setColumnValue("999", "status", { index: 1 }), null);
  assert.equal(store.setColumnValue(other.id, "missing", "x"), null);
  assert.equal(store.moveItem(other.id, "missing"), null);
  assert.equal(store.moveItem("999", "done"), null);
  assert.equal(store.deleteItem(item.id), null);
  assert.throws(() => store.setColumnValue(other.id, "name", " "), TypeError);
  assert.throws(
    () => store.setColumnValue(other.id, "person", ["42"]),
    TypeError,
  );
  assert.throws(() => store.setColumnValue(other.id, "notes", ""), TypeError);
  assert.throws(() => store.renameItem(other.id, ""), TypeError);
  assert.equal(events.length, 6);
});

test("setColumnValue on the name column renames the item", async () => {
  const store = await memoryStore();
  const item = store.getItem("7");
  const { events } = record(store);
  const renamed = store.setColumnValue(item.id, "name", "Via column");
  assert.equal(renamed.name, "Via column");
  assert.deepEqual(renamed.values, item.values);
  assert.deepEqual(
    events.map((e) => e.type),
    ["item_renamed"],
  );
  assert.throws(() => store.setColumnValue(item.id, "name", null), TypeError);
});

test("items are ordered by group position, then item position, and paged", async () => {
  const store = await memoryStore();
  const roadmap = roadmapOf(store);
  const names = () =>
    store
      .listItems({ boardId: roadmap.id, limit: 100 })
      .items.map((i) => i.name);
  const before = names();
  assert.equal(before.length, 8);
  assert.deepEqual(before.slice(0, 3), [
    "Design onboarding flow",
    "Set up CI pipeline",
    "Fix login timeout bug",
  ]);
  store.moveItem(
    store.listItems({ boardId: roadmap.id }).items[0].id,
    "next_up",
  );
  const after = names();
  assert.equal(after[0], "Set up CI pipeline");
  assert.equal(
    after[5],
    "Design onboarding flow",
    "moved to the end of next_up",
  );
  const page = store.listItems({ boardId: roadmap.id, offset: 2, limit: 3 });
  assert.equal(page.total, 8);
  assert.deepEqual(
    page.items.map((i) => i.name),
    after.slice(2, 5),
  );
  const done = store.listItems({ boardId: roadmap.id, groupId: "done" });
  assert.deepEqual([done.total, done.items.length], [2, 2]);
  assert.deepEqual(store.listItems({ boardId: "999" }), {
    items: [],
    total: 0,
  });
  assert.equal(
    store.listItems({ boardId: roadmap.id, offset: 50 }).items.length,
    0,
  );
  assert.throws(
    () => store.listItems({ boardId: roadmap.id, offset: -1 }),
    TypeError,
  );
  assert.throws(
    () => store.listItems({ boardId: roadmap.id, limit: 1.5 }),
    TypeError,
  );
});

test("listBoards filters by IDs and pages", async () => {
  const store = await memoryStore();
  for (const name of ["A", "B", "C"]) store.createBoard({ name });
  const all = store.listBoards();
  assert.equal(all.length, 5);
  assert.deepEqual(store.listBoards({ limit: 2, page: 2 }), all.slice(2, 4));
  assert.deepEqual(store.listBoards({ ids: [all[3].id, all[0].id, "999"] }), [
    all[0],
    all[3],
  ]);
  assert.deepEqual(store.listBoards({ ids: [] }), []);
  assert.throws(() => store.listBoards({ limit: 0 }), TypeError);
});

test("updates are listed newest first", async () => {
  const store = await memoryStore();
  const roadmap = roadmapOf(store);
  const item = store.listItems({ boardId: roadmap.id }).items[0];
  assert.deepEqual(
    store.listUpdates(item.id).map((u) => u.creator_id),
    ["1", "2"],
  );
  const { events } = record(store);
  const update = store.createUpdate({
    itemId: item.id,
    body: "Shipped!",
    creatorId: "3",
  });
  assert.deepEqual(Object.keys(update), [
    "id",
    "item_id",
    "body",
    "creator_id",
    "created_at",
  ]);
  assert.deepEqual(
    store.listUpdates(item.id).map((u) => u.body)[0],
    "Shipped!",
  );
  assert.deepEqual(store.listUpdates(item.id, { limit: 1 }), [update]);
  assert.deepEqual(events, [
    { type: "update_created", board_id: roadmap.id, item_id: item.id },
  ]);
  assert.equal(store.createUpdate({ itemId: "999", body: "x" }), null);
  assert.equal(
    store.createUpdate({ itemId: item.id, body: "x", creatorId: "99" }),
    null,
  );
  assert.throws(
    () => store.createUpdate({ itemId: item.id, body: "" }),
    TypeError,
  );
  assert.equal(events.length, 1);
});

test("app storage versions writes and reports conflicts", async () => {
  const store = await memoryStore();
  const { events } = record(store);
  const scope = "install:24";
  assert.equal(store.getAppStorage(scope, "note"), null);
  assert.deepEqual(store.setAppStorage(scope, "note", "a"), {
    success: true,
    version: 1,
  });
  assert.deepEqual(store.setAppStorage(scope, "note", "b", 1), {
    success: true,
    version: 2,
  });
  assert.deepEqual(store.setAppStorage(scope, "note", "c", 1), {
    success: false,
    version: 2,
    reason: "version_conflict",
  });
  assert.deepEqual(store.getAppStorage(scope, "note"), {
    value: "b",
    version: 2,
  });
  assert.deepEqual(store.setAppStorage(scope, "new", "x", 0), {
    success: false,
    version: null,
    reason: "version_conflict",
  });
  assert.deepEqual(store.deleteAppStorage(scope, "note"), {
    success: true,
    version: null,
  });
  assert.equal(store.getAppStorage(scope, "note"), null);
  assert.deepEqual(store.setAppStorage(scope, "note", "d", 2), {
    success: false,
    version: null,
    reason: "version_conflict",
  });
  assert.deepEqual(
    store.setAppStorage(scope, "note", "e"),
    { success: true, version: 3 },
    "versions are never reused",
  );
  assert.deepEqual(store.deleteAppStorage(scope, "absent"), {
    success: true,
    version: null,
  });
  assert.equal(
    store.getAppStorage("app:23", "note"),
    null,
    "segments are separate",
  );
  store.setAppStorage("app:23", "note", "global");
  assert.equal(store.getAppStorage(scope, "note").value, "e");
  assert.equal(store.getAppStorage(scope, "a/../b"), null, "keys are opaque");
  for (const bad of ["install:", "board:4", "install:4/x", "", 24]) {
    assert.throws(() => store.getAppStorage(bad, "k"), TypeError);
  }
  assert.throws(() => store.setAppStorage(scope, "k", 5), TypeError);
  assert.throws(() => store.setAppStorage(scope, "k", "v", "1"), TypeError);
  assert.throws(() => store.setAppStorage(scope, 5, "v"), TypeError);
  assert.deepEqual(events, [], "storage writes are not board changes");
});

test("findApiToken matches whole tokens only", async () => {
  const store = await memoryStore();
  const [readWrite] = store.listApiTokens();
  assert.deepEqual(store.findApiToken(readWrite.token), readWrite);
  for (const bad of [
    readWrite.token.slice(0, -1),
    `${readWrite.token}A`,
    "",
    undefined,
    42,
  ]) {
    assert.equal(store.findApiToken(bad), null);
  }
});

test("listeners unsubscribe and a throwing listener does not stop others", async () => {
  const log = quietLog();
  const store = await memoryStore({ log });
  const seen = [];
  store.on(() => {
    throw new Error("boom");
  });
  const off = store.on((event) => seen.push(event.type));
  store.createBoard({ name: "One" });
  off();
  off();
  store.createBoard({ name: "Two" });
  assert.deepEqual(seen, ["board_created"]);
  assert.equal(log.errors.length, 2);
  assert.match(String(log.errors[0][0]), /listener failed/);
  assert.throws(() => store.on("nope"), TypeError);
});
