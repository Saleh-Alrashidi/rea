/**
 * Real subitems in the store (SPEC-5 §1.1): `parent_id` on item records,
 * the parent invariants on write and on load (server/store/subitems.js),
 * the cascade through `removeItems` with its activity entry and events,
 * update authors and column roles in the data file (since /4).
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createStore } from "../server/store.js";
import { MAX_SUBITEM_DEPTH } from "../server/store/subitems.js";

const quietLog = { error() {}, warn() {}, info() {}, log() {} };

async function setup() {
  const store = await createStore({ log: quietLog });
  const board = store.listBoards().find((b) => b.name === "Product roadmap");
  const other = store.listBoards().find((b) => b.name === "Hiring plan");
  const events = [];
  store.on((event) => events.push(event));
  const add = (name, fields = {}) =>
    store.createItem({ boardId: board.id, name, creatorId: "1", ...fields });
  return { store, board, other, events, add };
}

/** A chain of `n` items, each a subitem of the one before. */
function chain(add, n, fields = {}) {
  const items = [add("Level 0", fields)];
  for (let level = 1; level < n; level += 1) {
    items.push(add(`Level ${level}`, { parentId: items.at(-1).id }));
  }
  return items;
}

test("parent_id is absent at the top level and set on subitems", async () => {
  const { store, board, add } = await setup();
  const parent = add("Parent", { groupId: "next_up" });
  assert.equal("parent_id" in parent, false, "absent, never null");
  const child = add("Child", { parentId: parent.id });
  assert.equal(child.parent_id, parent.id);
  assert.equal(child.group_id, "next_up", "the parent's group by default");
  const elsewhere = add("Elsewhere", { parentId: parent.id, groupId: "done" });
  assert.equal(elsewhere.group_id, "done", "a subitem may sit in any group");
  // Moving a parent never moves its children.
  store.moveItem(parent.id, { groupId: "this_sprint" });
  assert.equal(store.getItem(child.id).group_id, "next_up");
  // Order stays group → position → id; nesting is by parent_id only.
  const { items } = store.listItems({ boardId: board.id, limit: 100 });
  const order = items.map((item) => item.id);
  assert.ok(order.indexOf(parent.id) < order.indexOf(elsewhere.id));
  assert.ok(order.indexOf(child.id) < order.indexOf(elsewhere.id));
});

test("bad parents are refused with not_found or invalid_parent", async () => {
  const { store, board, other, events, add } = await setup();
  const before = store.countItems(board.id);
  const foreign = store.listItems({ boardId: other.id }).items[0];
  for (const parentId of ["999999", foreign.id, 7]) {
    const result = add("Orphan", { parentId });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "not_found", String(parentId));
    assert.match(result.message, /Parent item .* is not on this board/);
  }
  const levels = chain(add, MAX_SUBITEM_DEPTH + 1);
  assert.equal(levels.at(-1).parent_id, levels.at(-2).id, "depth 5 is fine");
  const tooDeep = add("Level 6", { parentId: levels.at(-1).id });
  assert.deepEqual(
    [tooDeep.reason, tooDeep.message],
    ["invalid_parent", "Subitems nest at most 5 levels deep"],
  );
  assert.equal(store.countItems(board.id), before + MAX_SUBITEM_DEPTH + 1);
  assert.equal(events.length, MAX_SUBITEM_DEPTH + 1, "refusals emit nothing");
  // An unknown board or group is still null, parent or not.
  assert.equal(add("X", { boardId: "999999", parentId: levels[0].id }), null);
  assert.equal(add("X", { parentId: levels[0].id, groupId: "nope" }), null);
});

test("deleting an item deletes its subitems across groups, once each", async () => {
  const { store, board, events, add } = await setup();
  const [top, middle, leaf] = chain(add, 3);
  const aside = add("Aside", { parentId: top.id, groupId: "done" });
  const sibling = add("Sibling");
  store.createUpdate({ itemId: leaf.id, body: "On the leaf", creatorId: "1" });
  store.createUpdate({ itemId: aside.id, body: "Aside", creatorId: "1" });
  events.length = 0;
  const deleted = store.deleteItem(top.id, { actorId: "1" });
  assert.equal(deleted.state, "deleted");
  for (const item of [top, middle, leaf, aside]) {
    assert.equal(store.getItem(item.id), null, item.name);
    assert.deepEqual(store.listUpdates(item.id), []);
  }
  assert.ok(store.getItem(sibling.id), "unrelated items stay");
  const removed = events.filter((e) => e.type === "item_deleted");
  assert.equal(events.length, removed.length, "only item_deleted events");
  assert.deepEqual(
    removed.map((e) => e.item_id),
    [top.id, middle.id, leaf.id, aside.id],
    "the deleted item first, then each subitem",
  );
  assert.equal(removed[3].group_id, "done");
  const [entry, ...older] = store.listActivity(board.id);
  assert.equal(entry.kind, "item_deleted");
  assert.equal(entry.item_id, top.id);
  assert.equal(entry.subitems_deleted, 3);
  assert.notEqual(older[0].kind, "item_deleted", "one entry per call");
  // Without subitems the entry has no count.
  store.deleteItem(sibling.id);
  assert.equal("subitems_deleted" in store.listActivity(board.id)[0], false);
});

test("deleting a group or a board takes subitems in other groups along", async () => {
  const { store, board, events, add } = await setup();
  const parent = add("Parent", { groupId: "next_up" });
  const child = add("Child", { parentId: parent.id, groupId: "done" });
  const grandchild = add("Grandchild", { parentId: child.id });
  const inside = add("Inside", { parentId: parent.id });
  const kept = add("Kept", { groupId: "done" });
  events.length = 0;
  store.deleteGroup(board.id, "next_up", { actorId: "1" });
  assert.equal(store.getItem(child.id), null);
  assert.equal(store.getItem(grandchild.id), null);
  assert.equal(store.getItem(inside.id), null);
  assert.ok(store.getItem(kept.id));
  // Clients drop the group, then each subitem it took from another group.
  assert.deepEqual(
    events.map((e) => [e.type, e.item_id ?? null, e.group_id]),
    [
      ["group_deleted", null, "next_up"],
      ["item_deleted", child.id, "done"],
      ["item_deleted", grandchild.id, "done"],
    ],
  );
  const [entry] = store.listActivity(board.id);
  assert.deepEqual(
    [entry.kind, entry.from_text, entry.subitems_deleted],
    ["group_deleted", "Next up", 2],
  );
  // A group whose items have no subitems elsewhere logs no count.
  events.length = 0;
  store.deleteGroup(board.id, "done");
  assert.deepEqual(
    events.map((e) => e.type),
    ["group_deleted"],
  );
  assert.equal("subitems_deleted" in store.listActivity(board.id)[0], false);
  const again = add("Again");
  const below = add("Below", { parentId: again.id });
  store.deleteBoard(board.id);
  assert.equal(store.getItem(below.id), null);
});

async function fileStore(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "mini-monday-subitems-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "data.json");
  const store = await createStore({ file, log: quietLog });
  const board = store.listBoards().find((b) => b.name === "Product roadmap");
  return { file, store, board };
}

test("subitems, update authors and roles persist in the data file", async (t) => {
  const { file, store, board } = await fileStore(t);
  const parent = store.createItem({ boardId: board.id, name: "Parent" });
  const child = store.createItem({
    boardId: board.id,
    name: "Child",
    parentId: parent.id,
  });
  await store.flush();
  const doc = JSON.parse(await readFile(file, "utf8"));
  assert.equal(doc.format, "mini-monday-store/6");
  const saved = (id) => doc.items.find((item) => item.id === id);
  assert.equal(saved(child.id).parent_id, parent.id);
  assert.equal("parent_id" in saved(parent.id), false);
  // Fields the importer writes: update authors and column roles.
  const update = doc.updates.find((u) => u.item_id === "7");
  update.author_name = "Dana (ClickUp)";
  const status = doc.columns.find(
    (c) => c.board_id === board.id && c.id === "status",
  );
  status.role = "status";
  await writeFile(file, JSON.stringify(doc));
  const reloaded = await createStore({ file, log: quietLog });
  assert.deepEqual(reloaded.getItem(child.id), child);
  const updates = reloaded.listUpdates("7", { limit: 100 });
  const authored = updates.find((u) => u.id === update.id);
  assert.equal(authored.author_name, "Dana (ClickUp)");
  assert.ok(
    updates.some((u) => !("author_name" in u)),
    "absent stays absent",
  );
  assert.equal(reloaded.getColumn(board.id, "status").role, "status");
  assert.equal("role" in reloaded.getColumn(board.id, "date"), false);
});

test("files with broken parents or roles are refused precisely", async (t) => {
  const { file, store, board } = await fileStore(t);
  const top = store.createItem({ boardId: board.id, name: "Top" });
  const child = store.createItem({
    boardId: board.id,
    name: "Child",
    parentId: top.id,
  });
  await store.flush();
  const good = JSON.parse(await readFile(file, "utf8"));
  const item = (doc, id) => doc.items.find((record) => record.id === id);
  const foreign = (doc) => doc.items.find((i) => i.board_id !== board.id);
  const column = (doc, id) =>
    doc.columns.find((c) => c.board_id === board.id && c.id === id);
  const cases = [
    [(doc) => (item(doc, child.id).parent_id = "999"), "a missing parent 999"],
    [(doc) => (item(doc, child.id).parent_id = child.id), "its own parent"],
    [
      (doc) => (item(doc, child.id).parent_id = foreign(doc).id),
      "a parent on another board",
    ],
    [(doc) => (item(doc, top.id).parent_id = child.id), "in a parent cycle"],
    [
      (doc) => (item(doc, child.id).parent_id = null),
      "items\\[\\d+\\] is malformed",
    ],
    [
      (doc) => (column(doc, "status").role = "owner"),
      "columns\\[\\d+\\] is malformed",
    ],
    [
      (doc) => (column(doc, "date").role = "status"),
      `column date of board ${board.id} has role status, which needs a status column`,
    ],
    [
      (doc) => {
        column(doc, "status").role = "status";
        doc.columns.push({ ...column(doc, "status"), id: "status_9" });
      },
      `column status_9 of board ${board.id} repeats the role status`,
    ],
    [(doc) => (doc.views[0].type = "gantt"), "views\\[0\\] is malformed"],
  ];
  for (const [mutate, message] of cases) {
    const doc = structuredClone(good);
    mutate(doc);
    const text = JSON.stringify(doc);
    await writeFile(file, text);
    await assert.rejects(
      createStore({ file, log: quietLog }),
      new RegExp(`Invalid mini-monday data file .*: .*${message}`),
    );
    assert.equal(await readFile(file, "utf8"), text, "left untouched");
  }
});

test("a chain deeper than the limit is refused on load", async (t) => {
  const { file, store, board } = await fileStore(t);
  const add = (name, fields) =>
    store.createItem({ boardId: board.id, name, ...fields });
  const levels = chain(add, MAX_SUBITEM_DEPTH + 1);
  const extra = add("Extra");
  await store.flush();
  const doc = JSON.parse(await readFile(file, "utf8"));
  doc.items.find((i) => i.id === extra.id).parent_id = levels.at(-1).id;
  await writeFile(file, JSON.stringify(doc));
  await assert.rejects(
    createStore({ file, log: quietLog }),
    new RegExp(`item ${extra.id} is nested 6 levels deep \\(at most 5\\)`),
  );
});
