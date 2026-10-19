/**
 * `store.moveItem` (SPEC-6 §1.3, server/store/moves.js): neighbors in the
 * board's manual order (one or both), parents under the SPEC-5 §1.1
 * invariants, groups and values in one commit; refusals change nothing;
 * one `item_moved` event plus the value events, and activity entries like
 * single changes.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createStore } from "../server/store.js";
import { POSITION_SPACING } from "../server/store/positions.js";
import { plainText, seedIds } from "./helpers.js";

const quietLog = { error() {}, warn() {}, info() {}, log() {} };
const S = POSITION_SPACING;

/** The roadmap's items by name, and its items in manual order. */
function roadmapOf(store, boards) {
  const items = () =>
    store.listItems({ boardId: boards.roadmap, limit: 100 }).items;
  const named = (name) => items().find((item) => item.name === name);
  const manual = () =>
    items()
      .toSorted((a, b) => a.position - b.position || a.id - b.id)
      .map((item) => item.name);
  return { items, named, manual };
}

async function setup(options = {}) {
  const store = await createStore({ log: quietLog, ...options });
  const ids = seedIds(store);
  const events = [];
  store.on((event) => events.push(event));
  return { store, ids, events, ...roadmapOf(store, ids.boards) };
}

/** Everything a refused move must leave as it was. */
const snapshot = (store, boardId) =>
  JSON.stringify([
    store.listItems({ boardId, limit: 100 }),
    store.listActivity(boardId, { limit: 500 }),
  ]);

test("neighbors put the item at their midpoint, one or both given", async () => {
  const { store, named, manual } = await setup();
  const id = (name) => named(name).id;
  // Seeded: 1024 … 8192 in board order.
  const both = store.moveItem(id("API rate limits"), {
    afterId: id("Design onboarding flow"),
    beforeId: id("Set up CI pipeline"),
  });
  assert.deepEqual([both.position, both.group_id], [1.5 * S, "next_up"]);
  // after_item_id alone: between it and the item that follows it.
  const after = store.moveItem(id("Fix login timeout bug"), {
    afterId: id("Design onboarding flow"),
  });
  assert.equal(after.position, 1.25 * S, "between Design and API");
  // before_item_id alone: between the item that precedes it and it.
  const before = store.moveItem(id("Dark mode polish"), {
    beforeId: id("Set up CI pipeline"),
  });
  assert.equal(before.position, 1.75 * S, "between API and Set up CI");
  assert.deepEqual(manual().slice(0, 5), [
    "Design onboarding flow",
    "Fix login timeout bug",
    "API rate limits",
    "Dark mode polish",
    "Set up CI pipeline",
  ]);
  // Each grouping sorts by its group first, then by position.
  const group = (groupId) =>
    store
      .listItems({ boardId: both.board_id, groupId })
      .items.map((item) => item.name);
  assert.deepEqual(group("next_up"), [
    "API rate limits",
    "Dark mode polish",
    "Kanban drag and drop",
  ]);
  // Without neighbors the item keeps its position.
  const kept = store.moveItem(id("Board sharing"), {});
  assert.equal(kept.position, 7 * S);
});

test("a missing side renumbers the board inside the same commit", async () => {
  const { store, named, manual, events } = await setup();
  const id = (name) => named(name).id;
  const others = () => manual().filter((name) => name !== "Board sharing");
  const order = others();
  const stamps = new Map(
    store
      .listItems({ boardId: named("Board sharing").board_id, limit: 100 })
      .items.map((item) => [item.id, item.updated_at]),
  );
  events.length = 0;
  const first = store.moveItem(id("Board sharing"), {
    beforeId: id("Design onboarding flow"),
  });
  assert.equal(first.position, S / 2, "before the first item");
  assert.deepEqual(others(), order, "everyone else keeps their order");
  const rest = order.map((name) => named(name).position);
  assert.deepEqual(
    rest,
    order.map((_, index) => (index + 1) * S),
  );
  for (const name of order) {
    const item = named(name);
    assert.equal(item.updated_at, stamps.get(item.id), "not an item change");
  }
  assert.deepEqual(
    events.map((event) => event.type),
    ["item_moved"],
    "one event",
  );
  const last = store.moveItem(id("Design onboarding flow"), {
    afterId: id("Item card comments"),
  });
  assert.equal(last.position, 7 * S + S / 2, "after the last of 8 items");
  assert.equal(manual().at(-1), "Design onboarding flow");
});

test("gaps below 1e-6 renumber; repeated halving never ties", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "mini-monday-moves-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "data.json");
  const seeded = await createStore({ file, log: quietLog });
  await seeded.flush();
  const doc = JSON.parse(await readFile(file, "utf8"));
  const second = doc.items.find((item) => item.name === "Set up CI pipeline");
  second.position = S + 5e-7;
  await writeFile(file, JSON.stringify(doc));
  const { store, named, manual } = await setup({ file });
  const id = (name) => named(name).id;
  const moved = store.moveItem(id("Item card comments"), {
    afterId: id("Design onboarding flow"),
    beforeId: id("Set up CI pipeline"),
  });
  assert.equal(moved.position, 1.5 * S, "between renumbered 1024 and 2048");
  assert.deepEqual(
    [
      named("Design onboarding flow").position,
      named("Set up CI pipeline").position,
    ],
    [S, 2 * S],
  );
  // Halving the gap after Design over and over: each move goes between
  // Design and the item moved before it.
  const movers = ["Board sharing", "Item card comments"];
  for (let n = 0; n < 40; n += 1) {
    store.moveItem(id(movers[n % 2]), {
      afterId: id("Design onboarding flow"),
    });
  }
  const order = manual();
  assert.deepEqual(order.slice(0, 4), [
    "Design onboarding flow",
    "Item card comments",
    "Board sharing",
    "Set up CI pipeline",
  ]);
  const positions = order.map((name) => named(name).position);
  for (let n = 1; n < positions.length; n += 1) {
    assert.ok(positions[n] - positions[n - 1] >= 1e-6, "no ties, no slivers");
  }
  assert.notEqual(named("Set up CI pipeline").position, 2 * S, "renumbered");
});

test("parents: a subitem, detached again; bad parents are refused", async () => {
  const { store, ids, named, events } = await setup();
  const id = (name) => named(name).id;
  const fix = store.moveItem(id("Fix login timeout bug"), {
    parentId: id("Design onboarding flow"),
  });
  assert.equal(fix.parent_id, id("Design onboarding flow"));
  assert.deepEqual([fix.group_id, fix.position], ["this_sprint", 3 * S]);
  const top = store.moveItem(fix.id, { detachParent: true });
  assert.equal("parent_id" in top, false, "absent, never null");
  // A chain L0 … L4 (L4 at depth 4) and an item with one subitem.
  let at = null;
  const chain = [];
  for (let level = 0; level < 5; level += 1) {
    const parentId = at?.id ?? null;
    at = store.createItem({
      boardId: fix.board_id,
      name: `L${level}`,
      parentId,
    });
    chain.push(at);
  }
  const child = store.createItem({
    boardId: fix.board_id,
    name: "Fix child",
    parentId: fix.id,
  });
  const before = snapshot(store, fix.board_id);
  const count = events.length;
  const foreign = store.listItems({ boardId: ids.boards.hiring }).items[0];
  const refusals = [
    [{ parentId: fix.id }, "invalid_parent", /itself or its subitems/],
    [{ parentId: child.id }, "invalid_parent", /itself or its subitems/],
    [{ parentId: chain[4].id }, "invalid_parent", /at most 5 levels/],
    [{ parentId: "999999" }, "not_found", /"999999" is not on this board/],
    [{ parentId: foreign.id }, "not_found", /not on this board/],
  ];
  for (const [move, reason, message] of refusals) {
    const result = store.moveItem(fix.id, move);
    assert.equal(result.reason, reason, JSON.stringify(move));
    assert.match(result.message, message);
  }
  assert.equal(snapshot(store, fix.board_id), before, "nothing changed");
  assert.equal(events.length, count, "nothing emitted");
  // A leaf may go under L4 (depth 5); its subtree must fit too.
  const leaf = store.moveItem(child.id, { parentId: chain[4].id });
  assert.equal(leaf.parent_id, chain[4].id);
  // The moved item's subitems keep their parent, group and position.
  const moved = store.moveItem(chain[1].id, {
    detachParent: true,
    groupId: "done",
    afterId: id("Item card comments"),
  });
  const kept = store.getItem(chain[2].id);
  assert.deepEqual(
    [kept.parent_id, kept.group_id, kept.position],
    [moved.id, chain[2].group_id, chain[2].position],
  );
});

test("bad neighbors, groups and values are refused and change nothing", async () => {
  const { store, ids, named, events } = await setup();
  const id = (name) => named(name).id;
  const item = named("Kanban drag and drop");
  const child = store.createItem({
    boardId: item.board_id,
    name: "Sub",
    parentId: item.id,
  });
  const foreign = store.listItems({ boardId: ids.boards.hiring }).items[0];
  const before = snapshot(store, item.board_id);
  const count = events.length;
  const first = id("Design onboarding flow");
  const second = id("Set up CI pipeline");
  const refusals = [
    [{ afterId: "999999" }, "not_found"],
    [{ beforeId: foreign.id }, "not_found"],
    [{ afterId: item.id }, "invalid_neighbor"],
    [{ beforeId: child.id }, "invalid_neighbor"],
    [{ afterId: second, beforeId: first }, "invalid_neighbor"],
    [{ afterId: first, beforeId: first }, "invalid_neighbor"],
    [{ groupId: "nope" }, "not_found"],
    [{ values: { nope: "x" } }, "not_found"],
    [{ parentId: first, detachParent: true }, "invalid"],
    // A valid neighbor does not make up for a bad parent.
    [{ afterId: first, parentId: item.id }, "invalid_parent"],
  ];
  for (const [move, reason] of refusals) {
    assert.equal(
      store.moveItem(item.id, move).reason,
      reason,
      JSON.stringify(move),
    );
  }
  const message = store.moveItem(item.id, { afterId: second, beforeId: first });
  assert.equal(
    message.message,
    "after_item_id must come before before_item_id",
  );
  assert.throws(
    () => store.moveItem(item.id, { afterId: first, values: { status: 5 } }),
    TypeError,
  );
  assert.throws(
    () => store.moveItem(item.id, { afterId: first, toGroupEnd: true }),
    TypeError,
  );
  assert.throws(() => store.moveItem(item.id, "done"), TypeError);
  assert.throws(() => store.moveItem(item.id, { detachParent: 1 }), TypeError);
  assert.throws(() => store.moveItem(item.id, { afterId: 7 }), TypeError);
  assert.equal(store.moveItem("999999", {}), null);
  assert.equal(snapshot(store, item.board_id), before, "nothing changed");
  assert.equal(events.length, count, "nothing emitted");
});

test("one item_moved event, value events and activity like single changes", async () => {
  const { store, ids, named, events } = await setup();
  const { users } = ids;
  const item = named("Kanban drag and drop");
  const design = named("Design onboarding flow");
  const sub = store.createItem({
    boardId: item.board_id,
    name: "Kanban sub",
    parentId: item.id,
  });
  events.length = 0;
  const moved = store.moveItem(
    item.id,
    {
      afterId: design.id,
      parentId: design.id,
      groupId: "done",
      values: {
        status: { index: 1 },
        person: [...item.values.person, users.noa],
        date: item.values.date,
      },
    },
    { actorId: users.sam },
  );
  const base = { board_id: item.board_id, item_id: item.id, group_id: "done" };
  assert.deepEqual(events, [
    {
      type: "item_moved",
      ...base,
      position: moved.position,
      parent_item_id: design.id,
    },
    { type: "column_value_changed", ...base, column_id: "status" },
    { type: "column_value_changed", ...base, column_id: "person" },
    // The unchanged date emits nothing.
    {
      type: "notification_created",
      user_ids: [users.noa],
      resource_kind: "notification",
      resource_id: events[3].resource_id,
    },
  ]);
  assert.ok(moved.updated_at >= item.updated_at);
  const entries = store
    .listActivity(item.board_id, { limit: 4 })
    .toReversed()
    .map((entry) => [
      entry.kind,
      entry.actor_id,
      entry.column_id,
      plainText(store, entry.from_text),
      plainText(store, entry.to_text),
    ]);
  assert.deepEqual(entries, [
    ["item_moved", users.sam, null, "Next up", "Done"],
    [
      "item_moved",
      users.sam,
      null,
      "Top level",
      "Subitem of “Design onboarding flow”",
    ],
    ["column_value_changed", users.sam, "status", null, "Done"],
    [
      "column_value_changed",
      users.sam,
      "person",
      "Alex Rivera, Sam Lee",
      "Alex Rivera, Sam Lee, Noa Cohen",
    ],
  ]);
  // The subitem stays where it was, under the moved item.
  assert.deepEqual(store.getItem(sub.id), sub);
  // A new place in the order alone: one event, no activity entry.
  const logged = store.listActivity(item.board_id).length;
  events.length = 0;
  store.moveItem(item.id, { beforeId: design.id }, { actorId: users.sam });
  assert.deepEqual(
    events.map((event) => event.type),
    ["item_moved"],
  );
  assert.equal(store.listActivity(item.board_id).length, logged);
  // A name in the values renames, as setColumnValues does.
  events.length = 0;
  store.moveItem(item.id, { values: { name: "Kanban DnD" } });
  assert.deepEqual(
    events.map((event) => event.type),
    ["item_moved", "item_renamed"],
  );
});
