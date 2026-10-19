/**
 * `move_item` and `Item.position` over HTTP (SPEC-6 §1.2, §1.3): the
 * neighbor forms, parent, group and grouping values in one change, the
 * streamed events, editor access and the refusals (NOT_FOUND for
 * neighbors and parents that are not on the board, BAD_USER_INPUT for
 * invalid ones), and `move_item_to_group` through the same store move.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { POSITION_SPACING } from "../server/store/positions.js";
import { openStream, startTestServers } from "./helpers.js";

const S = POSITION_SPACING;
const MOVE = `mutation M($i: ID!, $b: ID, $a: ID, $p: ID, $d: Boolean,
  $g: String, $v: String) {
  move_item(item_id: $i, before_item_id: $b, after_item_id: $a,
    parent_item_id: $p, detach_parent: $d, group_id: $g, column_values: $v) {
    id position parent_item_id group { id }
    column_values(ids: ["status"]) { text } } }`;
const TO_GROUP = `mutation G($i: ID!, $g: String!) {
  move_item_to_group(item_id: $i, group_id: $g) { id position group { id } } }`;
const ITEMS = `query I($b: ID!) { boards(ids: [$b]) {
  items_page(limit: 100) { items { id name position } } } }`;

async function setup(t) {
  const servers = await startTestServers();
  t.after(() => servers.close());
  const { users, boards } = servers.ids;
  const { store } = servers;
  const named = (name) =>
    store
      .listItems({ boardId: boards.roadmap, limit: 100 })
      .items.find((item) => item.name === name);
  return { ...servers, users, boards, named };
}

test("move_item takes one or two neighbors and reports positions", async (t) => {
  const { as, users, boards, named } = await setup(t);
  const sam = as(users.sam);
  const id = (name) => named(name).id;
  const both = await sam.data(MOVE, {
    i: id("API rate limits"),
    a: id("Design onboarding flow"),
    b: id("Set up CI pipeline"),
  });
  assert.deepEqual(both.move_item, {
    id: id("API rate limits"),
    position: 1.5 * S,
    parent_item_id: null,
    group: { id: "next_up" },
    column_values: [{ text: null }],
  });
  const after = await sam.data(MOVE, {
    i: id("Fix login timeout bug"),
    a: id("Design onboarding flow"),
  });
  assert.equal(after.move_item.position, 1.25 * S, "right after Design");
  const before = await sam.data(MOVE, {
    i: id("Dark mode polish"),
    b: id("Set up CI pipeline"),
  });
  assert.equal(before.move_item.position, 1.75 * S, "right before Set up CI");
  // Clients sort by grouping, then position: the server's own order.
  const { boards: data } = await sam.data(ITEMS, { b: boards.roadmap });
  const page = data[0].items_page.items;
  assert.deepEqual(
    page.slice(0, 5).map((item) => [item.name, item.position]),
    [
      ["Design onboarding flow", S],
      ["Fix login timeout bug", 1.25 * S],
      ["Set up CI pipeline", 2 * S],
      ["API rate limits", 1.5 * S],
      ["Dark mode polish", 1.75 * S],
    ],
  );
});

test("move_item sets parent, group and values in one change", async (t) => {
  const { as, users, boards, named, hostUrl, sessionFor } = await setup(t);
  const sam = as(users.sam);
  const item = named("Kanban drag and drop");
  const design = named("Design onboarding flow");
  const url = new URL(`/v2/events?board_id=${boards.roadmap}`, hostUrl);
  const stream = await openStream(url, sessionFor(users.sam));
  t.after(() => stream.close());
  await stream.next(/^: connected\n\n/);
  const moved = await sam.data(MOVE, {
    i: item.id,
    a: design.id,
    p: design.id,
    g: "done",
    v: JSON.stringify({ status: "Done" }),
  });
  assert.deepEqual(moved.move_item, {
    id: item.id,
    position: 1.5 * S,
    parent_item_id: design.id,
    group: { id: "done" },
    column_values: [{ text: "Done" }],
  });
  const seen = [];
  for (let n = 0; n < 2; n += 1) {
    const [, data] = await stream.next(/event: change\ndata: (.*)\n\n/);
    seen.push(JSON.parse(data));
  }
  const base = { board_id: boards.roadmap, item_id: item.id, group_id: "done" };
  assert.deepEqual(seen, [
    {
      type: "item_moved",
      ...base,
      position: 1.5 * S,
      parent_item_id: design.id,
    },
    { type: "column_value_changed", ...base, column_id: "status" },
  ]);
  const top = await sam.data(MOVE, { i: item.id, d: true });
  assert.equal(top.move_item.parent_item_id, null);
  assert.equal(top.move_item.position, 1.5 * S, "no neighbors: kept");
});

test("move_item needs editor access and refuses bad moves whole", async (t) => {
  const { as, users, boards, named, store } = await setup(t);
  const item = named("Kanban drag and drop");
  const first = named("Design onboarding flow").id;
  const second = named("Set up CI pipeline").id;
  const sub = store.createItem({
    boardId: boards.roadmap,
    name: "Sub",
    parentId: item.id,
  });
  const before = JSON.stringify(
    store.listItems({ boardId: boards.roadmap, limit: 100 }),
  );
  const vars = { i: item.id, a: first };
  assert.equal(await as(users.jordan).code(MOVE, vars), "FORBIDDEN");
  assert.equal(await as(users.chris).code(MOVE, vars), "NOT_FOUND");
  // Alex can open the hiring board, but its items are no neighbors or
  // parents here.
  const alex = as(users.alex);
  const hiring = store.listItems({ boardId: boards.hiring }).items[0].id;
  const notFound = [
    { ...vars, a: hiring },
    { ...vars, a: null, b: hiring },
    { i: item.id, p: hiring },
    { ...vars, a: "999999" },
    { ...vars, g: "nope" },
  ];
  for (const variables of notFound) {
    assert.equal(await alex.code(MOVE, variables), "NOT_FOUND");
  }
  const invalid = [
    [{ ...vars, a: sub.id }, /itself or its subitems/],
    [{ i: item.id, a: second, b: first }, /must come before/],
    [{ i: item.id, p: sub.id }, /subitem of itself or its subitems/],
    [{ i: item.id, p: first, d: true }, /not both/],
    [{ ...vars, v: JSON.stringify({ nope: 1 }) }, /Unknown column/],
    [{ ...vars, v: "{" }, /valid JSON/],
  ];
  for (const [variables, message] of invalid) {
    const error = await alex.error(MOVE, variables);
    assert.equal(error.extensions.code, "BAD_USER_INPUT");
    assert.match(error.message, message);
  }
  assert.equal(
    JSON.stringify(store.listItems({ boardId: boards.roadmap, limit: 100 })),
    before,
    "nothing changed",
  );
});

test("move_item_to_group goes to the end of the group through the same move", async (t) => {
  const { as, users, boards, named, store, hostUrl, sessionFor } =
    await setup(t);
  const sam = as(users.sam);
  const item = named("Design onboarding flow");
  const url = new URL(`/v2/events?board_id=${boards.roadmap}`, hostUrl);
  const stream = await openStream(url, sessionFor(users.sam));
  t.after(() => stream.close());
  await stream.next(/^: connected\n\n/);
  const moved = await sam.data(TO_GROUP, { i: item.id, g: "next_up" });
  assert.deepEqual(moved.move_item_to_group, {
    id: item.id,
    position: 9 * S,
    group: { id: "next_up" },
  });
  const [, data] = await stream.next(/event: change\ndata: (.*)\n\n/);
  assert.deepEqual(JSON.parse(data), {
    type: "item_moved",
    board_id: boards.roadmap,
    item_id: item.id,
    group_id: "next_up",
    position: 9 * S,
    parent_item_id: null,
  });
  const names = store
    .listItems({ boardId: boards.roadmap, groupId: "next_up" })
    .items.map((each) => each.name);
  assert.equal(names.at(-1), "Design onboarding flow");
  const again = await sam.data(TO_GROUP, { i: item.id, g: "next_up" });
  assert.equal(again.move_item_to_group.position, 9 * S, "same group: kept");
  assert.equal(
    await as(users.jordan).code(TO_GROUP, { i: item.id, g: "done" }),
    "FORBIDDEN",
  );
});
