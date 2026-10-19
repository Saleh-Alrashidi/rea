/**
 * Mentions over GraphQL (SPEC-6 §2.2): `Update.body_parts` and `body` as
 * each reader may see them (current names of what they may see, the
 * snapshot otherwise, "Private task" for tasks on boards they cannot
 * open), and mention, reply and like notifications in the inbox with its
 * `kinds` filter (the Inbox's Mentions filter), never reaching users
 * without access.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { startTestServers } from "./helpers.js";

async function setup(t) {
  const servers = await startTestServers();
  t.after(() => servers.close());
  const { users, boards } = servers.ids;
  const client = (key) => servers.as(users[key]);
  const first = (board) =>
    servers.store.listItems({ boardId: boards[board] }).items[0];
  return { ...servers, users, client, first };
}

const CREATE = `mutation C($i: ID!, $b: String!, $p: ID) {
  create_update(item_id: $i, body: $b, parent_id: $p) { id } }`;
const READ = `query R($i: [ID!]!) { items(ids: $i) { updates(limit: 1) { body
  body_parts { type text url item_id name board_id
    user { id name initials color } team { id name } } } } }`;
const INBOX = `query I($k: [NotificationKind!]) {
  notifications(kinds: $k, limit: 100) { kind text url } }`;
const token = (kind, id, name) => `@[${name}](${kind}:${id})`;

test("body_parts give text, links and mentions with the names each reader may see", async (t) => {
  const { client, users, ids, first } = await setup(t);
  const design = first("roadmap");
  const launch = first("marketing");
  const body = [
    `Hi ${token("user", users.sam, "S.")}`,
    token("team", ids.teams.product, "Prod"),
    `see ${token("item", launch.id, "Launch post")}`,
    `and ${token("item", design.id, "Design")}`,
    "at https://example.test/spec.",
  ].join(" ");
  await client("priya").data(CREATE, { i: design.id, b: body });
  const read = async (key) =>
    (await client(key).data(READ, { i: [design.id] })).items[0].updates[0];
  const part = (type, fields) => ({
    type,
    text: null,
    url: null,
    item_id: null,
    name: null,
    board_id: null,
    user: null,
    team: null,
    ...fields,
  });
  const text = (value) => part("text", { text: value });
  const sam = await read("sam");
  const samUser = sam.body_parts[1].user;
  assert.deepEqual(sam.body_parts, [
    text("Hi "),
    part("user", { text: "Sam Lee", user: samUser }),
    text(" "),
    part("team", {
      text: "Product",
      team: { id: ids.teams.product, name: "Product" },
    }),
    text(" see "),
    // Sam cannot open the Marketing board: no name, no board.
    part("item", { item_id: launch.id }),
    text(" and "),
    part("item", {
      text: design.name,
      item_id: design.id,
      name: design.name,
      board_id: ids.boards.roadmap,
    }),
    text(" at "),
    part("link", {
      text: "https://example.test/spec",
      url: "https://example.test/spec",
    }),
    text("."),
  ]);
  assert.deepEqual(samUser, {
    id: users.sam,
    name: "Sam Lee",
    initials: "SL",
    color: samUser.color,
  });
  assert.match(
    sam.body,
    new RegExp(`@\\[Private task\\]\\(item:${launch.id}\\)`),
  );
  assert.doesNotMatch(sam.body, /Launch post/, "no task name in the body");
  const priya = await read("priya");
  assert.deepEqual(priya.body_parts[5], {
    ...part("item", { item_id: launch.id }),
    text: launch.name,
    name: launch.name,
    board_id: ids.boards.marketing,
  });
  assert.equal(priya.body, body, "the author reads what she wrote");
});

test("a guest reads snapshots for people and teams outside their directory", async (t) => {
  const { client, users, ids, first } = await setup(t);
  const launch = first("marketing");
  const body = [
    token("user", users.noa, "Noa C."),
    token("team", ids.teams.product, "Product team"),
    token("user", users.priya, "P."),
  ].join(" ");
  await client("priya").data(CREATE, { i: launch.id, b: body });
  const [update] = (await client("chris").data(READ, { i: [launch.id] }))
    .items[0].updates;
  const mentions = update.body_parts
    .filter((p) => p.type !== "text")
    .map((p) => [p.type, p.text, p.user?.name ?? p.team?.name ?? null]);
  assert.deepEqual(mentions, [
    ["user", "Noa C.", null],
    ["team", "Product team", null],
    ["user", "Priya Nair", "Priya Nair"],
  ]);
});

test("mention, reply and like notifications reach the inbox and its kinds filter", async (t) => {
  const { client, users, first, store } = await setup(t);
  const design = first("roadmap");
  const sam = client("sam");
  const body = `${token("user", users.noa, "Noa")} ${token("user", users.chris, "Chris")}`;
  const { id } = (await sam.data(CREATE, { i: design.id, b: body }))
    .create_update;
  const inbox = async (key, k) =>
    (await client(key).data(INBOX, { k })).notifications;
  const [mention] = await inbox("noa", ["mention"]);
  assert.deepEqual(mention, {
    kind: "mention",
    text: `Sam Lee mentioned you in “${design.name}”`,
    url: `#/boards/${design.board_id}/items/${design.id}/updates/${id}`,
  });
  assert.ok((await inbox("noa")).some((n) => n.kind === "mention"));
  assert.deepEqual(await inbox("noa", []), []);
  assert.ok((await inbox("noa", ["assign"])).every((n) => n.kind === "assign"));
  assert.notEqual(await client("noa").code(INBOX, { k: ["bogus"] }), null);
  // Chris cannot open the board: no notification, no event, no trace.
  assert.ok(
    store
      .listNotifications(users.chris, { limit: 500 })
      .every((n) => n.kind !== "mention"),
  );
  await client("noa").data(CREATE, { i: design.id, b: "On it", p: id });
  await client("noa").data(
    `mutation L($u: ID!) { like_update(update_id: $u) { id } }`,
    { u: id },
  );
  assert.deepEqual(
    (await inbox("sam", ["reply", "like"])).map((n) => [n.kind, n.text]),
    [
      ["like", `Noa Cohen liked your update on “${design.name}”`],
      ["reply", `Noa Cohen replied to your update on “${design.name}”`],
    ],
    "newest first",
  );
});
