/**
 * Inbox, activity and discovery over GraphQL (SPEC-2 §2, §3):
 * notifications (kinds, unread filter, limits, marking read, never to the
 * actor), board activity logs from API mutations, `search` (matching,
 * order, limits, URLs) and `my_work` order.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { startTestServers } from "./helpers.js";

async function setup(t) {
  const servers = await startTestServers();
  t.after(() => servers.close());
  const { ids } = servers;
  const users = Object.fromEntries(
    ["alex", "sam", "noa", "priya", "jordan", "chris"].map((key) => [
      key,
      servers.as(ids.users[key]),
    ]),
  );
  return { ...servers, users };
}

const INBOX = `query I($u: Boolean, $l: Int) { notifications(unread_only: $u, limit: $l) {
  id kind text url read actor { id } created_at } unread_notifications_count }`;
const MARK = `mutation M($ids: [ID!], $all: Boolean) { mark_notifications_read(ids: $ids, all: $all) }`;

test("notifications: seeded inbox, unread filter, limits and marking read", async (t) => {
  const { users, ids } = await setup(t);
  const alex = await users.alex.data(INBOX);
  assert.equal(alex.unread_notifications_count, 2);
  assert.deepEqual(
    alex.notifications.map((n) => [n.kind, n.actor.id, n.read]),
    [
      ["assign", ids.users.noa, false],
      ["update", ids.users.sam, false],
    ],
    "newest first",
  );
  assert.match(
    alex.notifications[0].url,
    new RegExp(`^#/boards/${ids.boards.roadmap}/items/\\d+$`),
  );
  const [first, second] = alex.notifications;
  assert.equal(
    (await users.alex.data(INBOX, { l: 1 })).notifications.length,
    1,
  );
  assert.equal(await users.alex.code(INBOX, { l: 0 }), "BAD_USER_INPUT");
  // Other users' notification IDs are ignored.
  const sam = await users.sam.data(INBOX);
  assert.equal(
    (await users.sam.data(MARK, { ids: [first.id] })).mark_notifications_read,
    0,
  );
  assert.equal(
    (await users.alex.data(MARK, { ids: [first.id, first.id] }))
      .mark_notifications_read,
    1,
  );
  const unread = await users.alex.data(INBOX, { u: true });
  assert.deepEqual(
    unread.notifications.map((n) => n.id),
    [second.id],
  );
  assert.equal(unread.unread_notifications_count, 1);
  assert.equal(
    (await users.alex.data(MARK, { all: true })).mark_notifications_read,
    1,
  );
  assert.equal(
    (await users.alex.data(MARK, { all: true })).mark_notifications_read,
    0,
  );
  assert.equal(
    (await users.alex.data(INBOX)).notifications.length,
    2,
    "read ones stay listed",
  );
  assert.equal(
    (await users.sam.data(INBOX)).unread_notifications_count,
    sam.unread_notifications_count,
  );
});

test("assignments and updates notify the people involved, never the actor", async (t) => {
  const { users, ids, store } = await setup(t);
  const [item] = store.listItems({ boardId: ids.boards.roadmap }).items;
  const assign = `mutation A($b: ID!, $i: ID!, $v: String) {
    change_simple_column_value(board_id: $b, item_id: $i, column_id: "person", value: $v) { id } }`;
  const vars = {
    b: ids.boards.roadmap,
    i: item.id,
    v: `${ids.users.alex},${ids.users.noa}`,
  };
  const before = (await users.alex.data(INBOX)).unread_notifications_count;
  await users.alex.data(assign, vars);
  const noa = (await users.noa.data(INBOX)).notifications[0];
  assert.deepEqual([noa.kind, noa.actor.id], ["assign", ids.users.alex]);
  assert.equal(noa.text, `Alex Rivera assigned you to “${item.name}”`);
  assert.equal(
    (await users.alex.data(INBOX)).unread_notifications_count,
    before,
  );
  const update = `mutation U($i: ID!) { create_update(item_id: $i, body: "Status?") { id } }`;
  await users.sam.data(update, { i: item.id });
  const kinds = async (client) =>
    (await client.data(INBOX)).notifications.map((n) => n.kind);
  assert.deepEqual((await kinds(users.noa)).slice(0, 2), ["update", "assign"]);
  assert.equal((await kinds(users.alex))[0], "update");
  // People without board access cannot be assigned, so they are never
  // notified (Chris is a guest; the roadmap is a Main board).
  const guest = { ...vars, v: ids.users.chris };
  const refused = await users.alex.error(assign, guest);
  assert.equal(refused.extensions.code, "BAD_USER_INPUT");
  assert.equal(refused.message, "Chris Taylor cannot access this board");
  assert.deepEqual(await kinds(users.chris), []);
});

test("activity_logs record API changes with names and from/to texts", async (t) => {
  const { users, ids, store } = await setup(t);
  const board = ids.boards.roadmap;
  const [item] = store.listItems({ boardId: board }).items;
  const sam = users.sam;
  await sam.data(
    `mutation R($b: ID!, $i: ID!) { change_simple_column_value(board_id: $b, item_id: $i,
    column_id: "status", value: "Done") { id } }`,
    { b: board, i: item.id },
  );
  await sam.data(
    `mutation M($i: ID!) { move_item_to_group(item_id: $i, group_id: "done") { id } }`,
    { i: item.id },
  );
  await sam.data(
    `mutation N($b: ID!, $i: ID!) { change_simple_column_value(board_id: $b, item_id: $i,
    column_id: "name", value: "Onboarding v2") { id } }`,
    { b: board, i: item.id },
  );
  await sam.data(
    `mutation G($b: ID!) { create_group(board_id: $b, group_name: "Ideas") { id } }`,
    { b: board },
  );
  const log = await sam.data(
    `query L($b: ID!) { boards(ids: [$b]) { activity_logs(limit: 4) {
    kind actor { id } actor_label item_id item_name column_id from_text to_text created_at } } }`,
    { b: board },
  );
  const entries = log.boards[0].activity_logs.map(
    ({ created_at, actor, ...rest }) => {
      assert.match(created_at, /^\d{4}-/);
      assert.equal(actor.id, ids.users.sam);
      return rest;
    },
  );
  const named = { actor_label: "Sam Lee", item_id: item.id };
  assert.deepEqual(entries, [
    {
      kind: "group_created",
      actor_label: "Sam Lee",
      item_id: null,
      item_name: null,
      column_id: null,
      from_text: null,
      to_text: "Ideas",
    },
    {
      kind: "item_renamed",
      ...named,
      item_name: "Onboarding v2",
      column_id: null,
      from_text: "Design onboarding flow",
      to_text: "Onboarding v2",
    },
    {
      kind: "item_moved",
      ...named,
      item_name: "Design onboarding flow",
      column_id: null,
      from_text: "This sprint",
      to_text: "Done",
    },
    {
      kind: "column_value_changed",
      ...named,
      item_name: "Design onboarding flow",
      column_id: "status",
      from_text: "Working on it",
      to_text: "Done",
    },
  ]);
  const limit = `query L($b: ID!, $l: Int) { boards(ids: [$b]) { activity_logs(limit: $l) { id } } }`;
  assert.equal(await sam.code(limit, { b: board, l: 0 }), "BAD_USER_INPUT");
  assert.equal(
    (await sam.data(limit, { b: board, l: 2 })).boards[0].activity_logs.length,
    2,
  );
});

test("search matches titles case-insensitively, ordered by kind then title", async (t) => {
  const { users, ids } = await setup(t);
  const search = `query S($q: String!, $l: Int) { search(query: $q, limit: $l) { kind id title subtitle url } }`;
  const found = (await users.alex.data(search, { q: "LAUNCH" })).search;
  assert.deepEqual(found, []);
  const priya = (await users.priya.data(search, { q: "launch" })).search;
  assert.deepEqual(
    priya.map((r) => `${r.kind}:${r.title}`),
    [
      "board:Marketing launch",
      "doc:Launch brief",
      "item:Write launch blog post",
      "note:Launch checklist",
    ],
  );
  assert.deepEqual(priya[0], {
    kind: "board",
    id: ids.boards.marketing,
    title: "Marketing launch",
    subtitle: "Shareable board",
    url: `#/boards/${ids.boards.marketing}`,
  });
  assert.equal(priya[1].url, `#/docs/${ids.docs.brief}`);
  assert.equal(priya[3].url, `#/notes/${ids.notes.checklist}`);
  // "ri" also matches Sam's own content; Marketing launch items stay out.
  const people = (await users.sam.data(search, { q: "ri" })).search;
  assert.deepEqual(
    people.map((r) => `${r.kind}:${r.title}`),
    [
      "doc:Launch brief",
      "item:Board sharing",
      "note:Design crit notes",
      "user:Alex Rivera",
      "user:Chris Taylor",
      "user:Priya Nair",
    ],
  );
  const teams = (await users.sam.data(search, { q: "product" })).search;
  assert.deepEqual(
    teams.map((r) => [r.kind, r.url]),
    [
      ["board", `#/boards/${ids.boards.roadmap}`],
      ["doc", `#/docs/${ids.docs.vision}`],
      ["team", `#/teams/${ids.teams.product}`],
    ],
  );
  assert.equal(
    (await users.alex.data(search, { q: "e", l: 3 })).search.length,
    3,
  );
  assert.deepEqual((await users.alex.data(search, { q: "   " })).search, []);
  for (const vars of [
    { q: "e", l: 0 },
    { q: "e", l: 51 },
    { q: "x".repeat(256) },
  ]) {
    assert.equal(
      await users.alex.code(search, vars),
      "BAD_USER_INPUT",
      JSON.stringify(vars),
    );
  }
});

test("my_work orders assigned items by due date, undated last", async (t) => {
  const { users, ids } = await setup(t);
  const query = `query W($l: Int) { my_work(limit: $l) { name board { id }
    column_values(ids: ["date"]) { text } } }`;
  const work = (await users.noa.data(query)).my_work;
  assert.deepEqual(
    work.map((item) => [item.name, item.column_values[0]?.text ?? null]),
    [
      ["Item card comments", "2026-10-05"],
      ["Fix login timeout bug", "2026-10-16"],
      ["Senior backend engineer", "2026-11-15"],
      ["Dark mode polish", null],
    ],
  );
  assert.equal(work[2].board.id, ids.boards.hiring);
  assert.equal((await users.noa.data(query, { l: 1 })).my_work.length, 1);
  assert.equal(await users.noa.code(query, { l: 0 }), "BAD_USER_INPUT");
  assert.deepEqual((await users.jordan.data(query)).my_work, []);
});
