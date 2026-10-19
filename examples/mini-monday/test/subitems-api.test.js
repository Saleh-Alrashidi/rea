/**
 * The SPEC-5 §1.6 GraphQL additions over HTTP: subitem fields and counts
 * on Item, `create_subitem` (editor on the parent's board, the store path
 * of create_item), `Column.role`, `Update.author_name` and
 * `create_board_view`. None of them is version-gated.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createStore } from "../server/store.js";
import { openStream, startTestServers } from "./helpers.js";

const quietLog = { error() {}, warn() {}, info() {}, log() {} };

const CREATE = `mutation S($p: ID!, $n: String!, $v: String) {
  create_subitem(parent_item_id: $p, item_name: $n, column_values: $v) {
    id name parent_item_id group { id } parent_item { id name }
    column_values(ids: ["status"]) { text } } }`;
const TREE = `query T($ids: [ID!]!) { items(ids: $ids) {
  id parent_item_id subitems_count updates_count
  subitems { id name parent_item_id group { id } }
  first: subitems(limit: 1) { id } } }`;
const VIEW = `mutation V($b: ID!, $t: BoardViewType!, $n: String) {
  create_board_view(board_id: $b, type: $t, name: $n) { id name type } }`;

async function setup(t, options) {
  const servers = await startTestServers(options);
  t.after(() => servers.close());
  const { users, boards } = servers.ids;
  return { ...servers, users, roadmap: boards.roadmap };
}

test("create_subitem and the subitem fields of Item", async (t) => {
  const { as, users, roadmap, store } = await setup(t);
  const sam = as(users.sam);
  const [parent] = store.listItems({ boardId: roadmap }).items;
  const made = await sam.data(CREATE, {
    p: parent.id,
    n: "  Write copy ",
    v: JSON.stringify({ status: "Done" }),
  });
  const child = made.create_subitem;
  assert.deepEqual(child, {
    id: child.id,
    name: "Write copy",
    parent_item_id: parent.id,
    group: { id: parent.group_id },
    parent_item: { id: parent.id, name: parent.name },
    column_values: [{ text: "Done" }],
  });
  const second = await sam.data(CREATE, { p: parent.id, n: "Review" });
  const grand = await sam.data(CREATE, { p: child.id, n: "Proofread" });
  store.createUpdate({ itemId: child.id, body: "One", creatorId: users.sam });
  store.createUpdate({ itemId: child.id, body: "Two", creatorId: users.sam });
  const ids = [parent.id, child.id, grand.create_subitem.id];
  const { items } = await sam.data(TREE, { ids });
  const [top, middle, leaf] = items;
  assert.equal(top.parent_item_id, null);
  assert.equal(top.subitems_count, 2);
  assert.deepEqual(
    top.subitems.map((s) => [s.name, s.parent_item_id]),
    [
      ["Write copy", parent.id],
      ["Review", parent.id],
    ],
    "direct children only, in board order",
  );
  assert.deepEqual(top.first, [{ id: child.id }]);
  assert.equal(second.create_subitem.parent_item_id, parent.id);
  assert.deepEqual(
    [middle.subitems_count, middle.updates_count, leaf.subitems_count],
    [1, 2, 0],
  );
  assert.equal(top.updates_count, store.listUpdates(parent.id).length);
  // The same counts in one request that also writes (fresh indexes).
  const write = `mutation W($p: ID!) { create_subitem(parent_item_id: $p,
    item_name: "Third") { parent_item { subitems_count } } }`;
  const after = await sam.data(write, { p: parent.id });
  assert.equal(after.create_subitem.parent_item.subitems_count, 3);
});

test("create_subitem needs editor access and a parent with room", async (t) => {
  const { as, users, roadmap, store, ids } = await setup(t);
  const [parent] = store.listItems({ boardId: roadmap }).items;
  const before = store.countItems(roadmap);
  const vars = { p: parent.id, n: "Nope" };
  assert.equal(await as(users.jordan).code(CREATE, vars), "FORBIDDEN");
  assert.equal(await as(users.chris).code(CREATE, vars), "NOT_FOUND");
  const alex = as(users.alex);
  assert.equal(await alex.code(CREATE, { ...vars, p: "999999" }), "NOT_FOUND");
  const bad = JSON.stringify({ nope: "x" });
  assert.equal(await alex.code(CREATE, { ...vars, v: bad }), "BAD_USER_INPUT");
  assert.equal(store.countItems(roadmap), before, "nothing was written");
  let at = parent.id;
  for (let level = 1; level <= 5; level += 1) {
    at = (await alex.data(CREATE, { p: at, n: `L${level}` })).create_subitem.id;
  }
  const deep = await alex.error(CREATE, { p: at, n: "L6" });
  assert.equal(deep.extensions.code, "BAD_USER_INPUT");
  assert.equal(deep.message, "Subitems nest at most 5 levels deep");
  // Subitems of a board the caller cannot open stay hidden.
  const marketing = store.listItems({ boardId: ids.boards.marketing }).items[0];
  const hidden = { p: marketing.id, n: "x" };
  assert.equal(await alex.code(CREATE, hidden), "NOT_FOUND");
});

test("Column.role and Update.author_name come from the data file", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "mini-monday-roles-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "data.json");
  const seeded = await createStore({ file, log: quietLog });
  await seeded.flush();
  const doc = JSON.parse(await readFile(file, "utf8"));
  const board = doc.boards.find((b) => b.name === "Product roadmap").id;
  const status = doc.columns.find(
    (c) => c.board_id === board && c.id === "status",
  );
  status.role = "status";
  const update = doc.updates.find((u) => u.item_id === "7");
  update.author_name = "Dana Hill";
  await writeFile(file, JSON.stringify(doc));
  const store = await createStore({ file, log: quietLog });
  const { as, users } = await setup(t, { store });
  const data = await as(users.sam).data(
    `query R($b: ID!, $i: [ID!]!) {
      boards(ids: [$b]) { columns(ids: ["status", "date"]) { id role } }
      items(ids: $i) { updates(limit: 100) { id author_name } } }`,
    { b: board, i: ["7"] },
  );
  assert.deepEqual(data.boards[0].columns, [
    { id: "status", role: "status" },
    { id: "date", role: null },
  ]);
  const authors = data.items[0].updates.map((u) => [u.id, u.author_name]);
  assert.ok(
    authors.some(([id, name]) => id === update.id && name === "Dana Hill"),
  );
  assert.ok(authors.some(([, name]) => name === null));
});

/** A file store whose board "Views" (Sam's) has only its List view. */
async function listOnlyStore(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "mini-monday-views-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "data.json");
  const seeded = await createStore({ file, log: quietLog });
  const board = seeded.createBoard({ name: "Views", creatorId: "2" });
  await seeded.flush();
  const doc = JSON.parse(await readFile(file, "utf8"));
  doc.views = doc.views.filter(
    (view) => view.board_id !== board.id || view.type === "list",
  );
  await writeFile(file, JSON.stringify(doc));
  return { store: await createStore({ file, log: quietLog }), board };
}

test("create_board_view adds each list, table or kanban view once", async (t) => {
  const { store, board } = await listOnlyStore(t);
  const { as, users, roadmap } = await setup(t, { store });
  const sam = as(users.sam);
  const types = store.listViews(roadmap).map((view) => view.type);
  assert.deepEqual(types, ["list", "table", "kanban", "app"], "tab order");
  const again = await sam.error(VIEW, { b: roadmap, t: "list", n: "Mine" });
  assert.equal(again.extensions.code, "BAD_USER_INPUT");
  assert.equal(again.message, "The board already has a List view");
  const table = await sam.error(VIEW, { b: roadmap, t: "table" });
  assert.equal(table.message, "The board already has a Main table view");
  assert.equal(
    await sam.code(VIEW, { b: roadmap, t: "app" }),
    "BAD_USER_INPUT",
  );
  assert.equal(
    await sam.code(VIEW, { b: roadmap, t: "gantt" }),
    "BAD_USER_INPUT",
  );
  assert.equal(
    await as(users.jordan).code(VIEW, { b: roadmap, t: "list" }),
    "FORBIDDEN",
  );
  assert.equal(
    await as(users.chris).code(VIEW, { b: roadmap, t: "list" }),
    "NOT_FOUND",
  );
  // A missing view is added with its default name, or a given name
  // (trimmed); a blank one is refused. Views come back in tab order.
  const created = await sam.data(VIEW, { b: board.id, t: "kanban" });
  assert.deepEqual(created.create_board_view, {
    id: created.create_board_view.id,
    name: "Kanban",
    type: "kanban",
  });
  const blank = await sam.error(VIEW, { b: board.id, t: "table", n: " " });
  assert.equal(blank.extensions.code, "BAD_USER_INPUT");
  const named = await sam.data(VIEW, { b: board.id, t: "table", n: " Tasks " });
  assert.equal(named.create_board_view.name, "Tasks");
  const { boards } = await sam.data(
    "query B($b: ID!) { boards(ids: [$b]) { views { name type } } }",
    { b: board.id },
  );
  assert.deepEqual(boards[0].views, [
    { name: "List", type: "list" },
    { name: "Tasks", type: "table" },
    { name: "Kanban", type: "kanban" },
  ]);
});

test("delete_group streams item_deleted for subitems in other groups", async (t) => {
  const { as, users, roadmap, store, hostUrl, sessionFor } = await setup(t);
  const sam = as(users.sam);
  const parent = store.listItems({ boardId: roadmap, groupId: "next_up" })
    .items[0];
  const child = (await sam.data(CREATE, { p: parent.id, n: "Child" }))
    .create_subitem;
  store.moveItem(child.id, { groupId: "done" });
  const url = new URL(`/v2/events?board_id=${roadmap}`, hostUrl);
  const stream = await openStream(url, sessionFor(users.sam));
  t.after(() => stream.close());
  await stream.next(/^: connected\n\n/);
  const remove = `mutation G($b: ID!, $g: String!) {
    delete_group(board_id: $b, group_id: $g) { id } }`;
  await sam.data(remove, { b: roadmap, g: "next_up" });
  const seen = [];
  for (let n = 0; n < 2; n += 1) {
    const [, data] = await stream.next(/event: change\ndata: (.*)\n\n/);
    seen.push(JSON.parse(data));
  }
  assert.deepEqual(
    seen.map((event) => [event.type, event.item_id ?? null, event.group_id]),
    [
      ["group_deleted", null, "next_up"],
      ["item_deleted", child.id, "done"],
    ],
  );
  const { boards } = await sam.data(
    "query L($b: ID!) { boards(ids: [$b]) { activity_logs(limit: 1) { kind subitems_deleted } } }",
    { b: roadmap },
  );
  assert.deepEqual(boards[0].activity_logs, [
    { kind: "group_deleted", subitems_deleted: 1 },
  ]);
});

test("delete_item streams one item_deleted per removed item", async (t) => {
  const { as, users, roadmap, store, hostUrl, sessionFor } = await setup(t);
  const sam = as(users.sam);
  const [parent] = store.listItems({ boardId: roadmap }).items;
  const child = (await sam.data(CREATE, { p: parent.id, n: "Child" }))
    .create_subitem;
  const grand = (await sam.data(CREATE, { p: child.id, n: "Grandchild" }))
    .create_subitem;
  const url = new URL(`/v2/events?board_id=${roadmap}`, hostUrl);
  const stream = await openStream(url, sessionFor(users.sam));
  t.after(() => stream.close());
  await stream.next(/^: connected\n\n/);
  const remove = `mutation D($i: ID!) { delete_item(item_id: $i) { state } }`;
  await sam.data(remove, { i: parent.id });
  const seen = [];
  for (let n = 0; n < 3; n += 1) {
    const [, data] = await stream.next(/event: change\ndata: (.*)\n\n/);
    seen.push(JSON.parse(data));
  }
  assert.deepEqual(
    seen.map((event) => [event.type, event.item_id]),
    [
      ["item_deleted", parent.id],
      ["item_deleted", child.id],
      ["item_deleted", grand.id],
    ],
  );
  const { boards } = await sam.data(
    "query L($b: ID!) { boards(ids: [$b]) { activity_logs(limit: 1) { kind item_id subitems_deleted } } }",
    { b: roadmap },
  );
  assert.deepEqual(boards[0].activity_logs, [
    { kind: "item_deleted", item_id: parent.id, subitems_deleted: 2 },
  ]);
});
