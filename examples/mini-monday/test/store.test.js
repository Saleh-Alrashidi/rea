import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "../server/store.js";
import { plainEntry } from "./helpers.js";

// Store API tests for the part-1 board model: mutators, change events,
// activity entries, ordering, app storage, tokens and listeners. Seed, ID
// generation and persistence are covered by store-state.test.js; SPEC-2
// people, sharing and content by the other store-*.test.js files, and
// updates by store-updates.test.js.
const START = Date.UTC(2026, 9, 18, 9, 0, 0);
const clock = () => {
  let tick = 0;
  return () => new Date(START + 1000 * tick++);
};
const memoryStore = (options = {}) => createStore({ now: clock(), ...options });
const record = (store) => {
  const events = [];
  const off = store.on((event) => events.push(event));
  return { events, off };
};
const roadmapOf = (store) =>
  store.listBoards().find((b) => b.name === "Product roadmap");
const boardEvents = (events) =>
  events.filter((event) => event.type !== "notification_created");
const activityOf = (store, boardId, count) =>
  store
    .listActivity(boardId, { limit: count })
    .reverse()
    .map((a) => [a.kind, a.actor_id, a.item_name, a.from_text, a.to_text]);

test("createBoard adds the default columns, group and views", async () => {
  const store = await memoryStore();
  const { events } = record(store);
  const board = store.createBoard({
    name: "Ops",
    description: "Runbook",
    creatorId: "2",
  });
  // SPEC-2: boards live in a workspace (default: the first one), have a
  // kind (default "public") and members; the creator is the first owner.
  // SPEC-6 §3.1: a new board goes last at the workspace's root (the seed
  // has two boards there).
  const [main] = store.listWorkspaces();
  assert.deepEqual(board, {
    id: board.id,
    name: "Ops",
    description: "Runbook",
    state: "active",
    creator_id: "2",
    workspace_id: main.id,
    board_kind: "public",
    members: [{ kind: "user", id: "2", role: "owner" }],
    position: 3 * 1024,
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
    ["list", "table", "kanban"],
  );
  assert.equal(store.createBoard({ name: "Ghost", creatorId: "99" }), null);
  const anon = store.createBoard({ name: "Anon", workspaceId: null });
  assert.equal(anon.workspace_id, main.id, "null means the default workspace");
  assert.deepEqual([anon.creator_id, anon.members], [null, []]);
  assert.equal(
    store.createBoard({ name: "Lost", workspaceId: "999" }),
    null,
    "unknown workspace",
  );
  const leadership = store.listWorkspaces()[1];
  const placed = store.createBoard({
    name: "Private plan",
    creatorId: "1",
    workspaceId: leadership.id,
    boardKind: "private",
  });
  assert.deepEqual(
    [placed.workspace_id, placed.board_kind],
    [leadership.id, "private"],
  );
  const secret = store.createBoard({ name: "x", boardKind: "secret" });
  assert.equal(secret.reason, "invalid", "an unknown kind is bad input");
  const unset = store.createBoard({ name: "x", boardKind: null });
  assert.match(unset.message, /board_kind must be one of/);
  assert.throws(() => store.createBoard({ name: "" }), TypeError);
  assert.throws(
    () => store.createBoard({ name: "x", description: 5 }),
    TypeError,
  );
  assert.equal(events.length, 3);
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
  assert.deepEqual(store.listForms({ boardId: roadmap.id }), [], "forms go");
  assert.deepEqual(store.listActivity(roadmap.id), [], "activity goes");
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
  const form = store.listForms({ boardId: roadmap.id })[0];
  assert.equal(form.target_group_id, "next_up");
  const { events } = record(store);
  const deleted = store.deleteGroup(roadmap.id, "next_up", { actorId: "2" });
  assert.equal(deleted.id, "next_up");
  assert.deepEqual(events, [
    { type: "group_deleted", board_id: roadmap.id, group_id: "next_up" },
  ]);
  assert.equal(
    store.getForm(form.id).target_group_id,
    null,
    "forms aimed at the group fall back to the first group",
  );
  assert.deepEqual(activityOf(store, roadmap.id, 1), [
    ["group_deleted", "2", null, "Next up", null],
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
  // SPEC-6 §1.2: one order per board; the seeded 8 items sit at 1024 …
  // 8192, so a new item goes after all of them.
  assert.equal(item.position, 9 * 1024);
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
  assert.equal(done.position, 10 * 1024);
  const inGroup = (groupId) =>
    store.listItems({ boardId: roadmap.id, groupId }).items.map((i) => i.id);
  assert.equal(inGroup("this_sprint").at(-1), item.id, "the group's end");
  assert.equal(inGroup("done").at(-1), done.id);
  assert.deepEqual(boardEvents(events), [
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
  // SPEC-2: the assigned user 2 is notified right after the item event;
  // user 3 created the item and is never notified about their own action.
  assert.deepEqual(
    events
      .filter((e) => e.type === "notification_created")
      .map((e) => e.user_ids),
    [["2"]],
  );
  assert.equal(events[1].type, "notification_created");
  assert.deepEqual(activityOf(store, roadmap.id, 2), [
    ["item_created", "3", "New", null, "This sprint"],
    ["item_created", null, "Late", null, "Done"],
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
  assert.equal(events.length, 3);
});

test("item mutators emit one event each and ignore unknown IDs", async () => {
  const store = await memoryStore();
  const roadmap = roadmapOf(store);
  const item = store.listItems({ boardId: roadmap.id }).items[0];
  const { events } = record(store);
  const actor = { actorId: "2" };
  const renamed = store.renameItem(item.id, "Renamed", actor);
  assert.equal(renamed.name, "Renamed");
  assert.ok(renamed.updated_at > item.updated_at);
  const set = store.setColumnValue(item.id, "estimate", 13, actor);
  assert.equal(set.values.estimate, 13);
  const cleared = store.setColumnValue(item.id, "status", null, actor);
  assert.equal("status" in cleared.values, false);
  // move_item_to_group's move: the end of the new group, after every
  // item of the board (the seeded 8 sit at 1024 … 8192).
  const toDone = { groupId: "done", toGroupEnd: true };
  const moved = store.moveItem(item.id, toDone, actor);
  assert.deepEqual([moved.group_id, moved.position], ["done", 9 * 1024]);
  assert.equal(
    store.moveItem(item.id, toDone).position,
    9 * 1024,
    "same group keeps position",
  );
  const deleted = store.deleteItem(item.id, actor);
  assert.equal(deleted.state, "deleted");
  assert.equal(store.getItem(item.id), null);
  assert.deepEqual(store.listUpdates(item.id), [], "updates go with the item");
  // SPEC-2 activity: from/to texts come from formatColumnValue; a move
  // within the same group is not a change and is not logged.
  assert.deepEqual(activityOf(store, roadmap.id, 5), [
    ["item_renamed", "2", "Renamed", "Design onboarding flow", "Renamed"],
    ["column_value_changed", "2", "Renamed", "5", "13"],
    ["column_value_changed", "2", "Renamed", "Working on it", null],
    ["item_moved", "2", "Renamed", "This sprint", "Done"],
    ["item_deleted", "2", "Renamed", null, null],
  ]);
  const [latest] = store.listActivity(roadmap.id);
  assert.equal(plainEntry(store, latest).actor_label, "Sam Lee");
  assert.equal(store.listActivity(roadmap.id)[1].column_id, null);
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
    ...Array.from({ length: 2 }, () => ({
      type: "item_moved",
      ...base,
      group_id: "done",
      position: 9 * 1024,
      parent_item_id: null,
    })),
    { type: "item_deleted", ...base, group_id: "done" },
  ]);
  const other = store.listItems({ boardId: roadmap.id }).items[0];
  assert.equal(store.renameItem("999", "x"), null);
  assert.equal(store.setColumnValue("999", "status", { index: 1 }), null);
  assert.equal(store.setColumnValue(other.id, "missing", "x"), null);
  assert.equal(
    store.moveItem(other.id, { groupId: "missing" }).reason,
    "not_found",
  );
  assert.equal(store.moveItem("999", toDone), null);
  assert.equal(store.deleteItem(item.id), null);
  assert.throws(() => store.setColumnValue(other.id, "name", " "), TypeError);
  assert.throws(
    () => store.setColumnValue(other.id, "person", ["42"]),
    TypeError,
  );
  assert.throws(() => store.setColumnValue(other.id, "notes", ""), TypeError);
  assert.throws(() => store.renameItem(other.id, ""), TypeError);
  assert.equal(events.length, 6);
  const logged = store.listActivity(roadmap.id).length;
  store.setColumnValue(other.id, "estimate", other.values.estimate ?? null);
  assert.equal(
    store.listActivity(roadmap.id).length,
    logged,
    "unchanged values are not logged",
  );
});

test("groups and columns log their changes", async () => {
  const store = await memoryStore();
  const roadmap = roadmapOf(store);
  const actor = { actorId: "3" };
  store.createGroup(roadmap.id, { title: "Backlog" }, actor);
  store.updateGroup(roadmap.id, "backlog", { color: "#a25ddc" }, actor);
  store.updateGroup(roadmap.id, "backlog", { title: "Icebox" }, actor);
  const column = store.createColumn(
    roadmap.id,
    { title: "Risk", type: "text" },
    actor,
  );
  const entries = store.listActivity(roadmap.id, { limit: 3 }).reverse();
  assert.deepEqual(
    entries.map((a) => [a.kind, a.column_id, a.from_text, a.to_text]),
    [
      ["group_created", null, null, "Backlog"],
      ["group_renamed", null, "Backlog", "Icebox"],
      ["column_created", column.id, null, "Risk"],
    ],
    "a color change is not a rename",
  );
  assert.ok(
    entries.every((a) => a.actor_id === "3" && a.board_id === roadmap.id),
  );
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
  store.moveItem(store.listItems({ boardId: roadmap.id }).items[0].id, {
    groupId: "next_up",
    toGroupEnd: true,
  });
  const after = names();
  assert.equal(after[0], "Set up CI pipeline");
  assert.equal(
    after[5],
    "Design onboarding flow",
    "moved to the end of next_up",
  );
  // Without toGroupEnd the item keeps its place in the board's order.
  const fix = store.listItems({ boardId: roadmap.id }).items[1];
  store.moveItem(fix.id, { groupId: "next_up" });
  assert.deepEqual(
    names().slice(0, 3),
    ["Set up CI pipeline", "Fix login timeout bug", "Kanban drag and drop"],
    "first in next_up: its position is the lowest there",
  );
  store.moveItem(fix.id, { groupId: "this_sprint" });
  assert.deepEqual(names(), after, "and back to the same place");
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
  assert.equal(all.length, 7, "four seeded boards (SPEC-2) plus three");
  assert.deepEqual(store.listBoards({ limit: 2, page: 2 }), all.slice(2, 4));
  assert.deepEqual(store.listBoards({ ids: [all[3].id, all[0].id, "999"] }), [
    all[0],
    all[3],
  ]);
  assert.deepEqual(store.listBoards({ ids: [] }), []);
  assert.throws(() => store.listBoards({ limit: 0 }), TypeError);
});
