/**
 * Updates over GraphQL, monday-style (SPEC-6 §2.1): replies, pins, likes,
 * edits and deletes with their fields and refusals, the board stream's
 * update events, and the permissions of every update mutation per seeded
 * role. Mentions as each reader sees them are in api-mentions.test.js.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { openStream, startTestServers } from "./helpers.js";

async function setup(t) {
  const servers = await startTestServers();
  t.after(() => servers.close());
  const { users } = servers.ids;
  const client = (key) => servers.as(users[key]);
  const [item, other] = servers.store.listItems({
    boardId: servers.ids.boards.roadmap,
  }).items;
  return { ...servers, users, client, item, other };
}

const CREATE = `mutation C($i: ID!, $b: String!, $p: ID) {
  create_update(item_id: $i, body: $b, parent_id: $p) { id parent_update_id } }`;
const THREAD = `query T($i: [ID!]!) { items(ids: $i) { updates_count
  updates { id body pinned edited_at parent_update_id likes_count liked_by_me
    likers(limit: 1) { id } can_edit can_delete creator { id }
    replies { id body parent_update_id replies { id } } } } }`;
const ACT = (field, args, vars) =>
  `mutation A(${vars}) { ${field}(${args}) { id pinned likes_count edited_at body } }`;
const EDIT = ACT("edit_update", "id: $u, body: $b", "$u: ID!, $b: String!");
const DELETE = ACT("delete_update", "id: $u", "$u: ID!");
const LIKE = ACT("like_update", "update_id: $u", "$u: ID!");
const UNLIKE = ACT("unlike_update", "update_id: $u", "$u: ID!");
const PIN = ACT("pin_to_top", "id: $u, item_id: $i", "$u: ID!, $i: ID!");
const UNPIN = ACT("unpin_from_top", "id: $u, item_id: $i", "$u: ID!, $i: ID!");

test("replies, pins, likes, edits and deletes over GraphQL", async (t) => {
  const { client, users, item, other, hostUrl, sessionFor, ids } =
    await setup(t);
  const sam = client("sam");
  const noa = client("noa");
  const url = new URL(`/v2/events?board_id=${ids.boards.roadmap}`, hostUrl);
  const stream = await openStream(url, sessionFor(users.noa));
  t.after(() => stream.close());
  await stream.next(/^: connected\n\n/);
  const post = async (who, b, p) =>
    (await who.data(CREATE, { i: item.id, b, p })).create_update;
  const top = await post(sam, "Ready for review?");
  assert.equal(top.parent_update_id, null);
  const reply = await post(noa, "Yes", top.id);
  assert.equal(reply.parent_update_id, top.id);
  await stream.next(/"type":"update_created"[^\n]*"update_id":"\d+"/);
  const thread = async (who = sam) =>
    (await who.data(THREAD, { i: [item.id] })).items[0];
  let read = await thread();
  assert.equal(read.updates_count, 4, "2 seeded updates, 1 update, 1 reply");
  assert.deepEqual(
    read.updates.map((u) => [u.body, u.parent_update_id]),
    [
      ["Ready for review?", null],
      ["Yes, I will share the link before then.", null],
      ["Can we review the wireframes on Thursday?", null],
    ],
    "top-level updates, newest first",
  );
  assert.deepEqual(read.updates[0].replies, [
    { id: reply.id, body: "Yes", parent_update_id: top.id, replies: [] },
  ]);
  // Pinned first; replies and other items' updates can't be pinned here.
  const oldest = read.updates[2];
  const pinned = (await noa.data(PIN, { u: oldest.id, i: item.id })).pin_to_top;
  assert.equal(pinned.pinned, true);
  await stream.next(/"type":"update_edited"[^\n]*"pinned":true/);
  read = await thread();
  assert.deepEqual(
    read.updates.map((u) => [u.id, u.pinned]),
    [
      [oldest.id, true],
      [top.id, false],
      [read.updates[2].id, false],
    ],
  );
  assert.equal(
    await noa.code(PIN, { u: reply.id, i: item.id }),
    "BAD_USER_INPUT",
  );
  assert.equal(await noa.code(PIN, { u: top.id, i: other.id }), "NOT_FOUND");
  assert.equal(
    (await noa.data(UNPIN, { u: oldest.id, i: item.id })).unpin_from_top.pinned,
    false,
  );
  // Likes: once per user, counted, listed and "mine" per reader.
  await noa.data(LIKE, { u: top.id });
  await client("alex").data(LIKE, { u: top.id });
  const liked = (await noa.data(LIKE, { u: top.id })).like_update;
  assert.equal(liked.likes_count, 2);
  await stream.next(/"type":"update_liked"[^\n]*"liked":true/);
  const [mineNoa] = (await thread(noa)).updates;
  const [mineSam] = (await thread()).updates;
  assert.deepEqual(
    [mineNoa.liked_by_me, mineSam.liked_by_me, mineSam.likers],
    [true, false, [{ id: users.noa }]],
  );
  const unliked = (await noa.data(UNLIKE, { u: top.id })).unlike_update;
  assert.equal(unliked.likes_count, 1);
  // Edits mark the update; deleting it takes its replies along.
  const edited = (await sam.data(EDIT, { u: top.id, b: " Ready! " }))
    .edit_update;
  assert.equal(edited.body, "Ready!");
  assert.match(edited.edited_at, /^\d{4}-/);
  await stream.next(/"type":"update_edited"/);
  await sam.data(DELETE, { u: top.id });
  await stream.next(/"type":"update_deleted"[^\n]*"update_id":"\d+"/);
  read = await thread();
  assert.equal(read.updates_count, 2);
  assert.equal(await sam.code(LIKE, { u: reply.id }), "NOT_FOUND", "gone");
});

test("update input is checked: replies one level, bodies and mentions bounded", async (t) => {
  const { client, item, other, store, users } = await setup(t);
  const sam = client("sam");
  const code = (variables) => sam.code(CREATE, variables);
  const top = (await sam.data(CREATE, { i: item.id, b: "Top" })).create_update;
  const reply = (await sam.data(CREATE, { i: item.id, b: "Re", p: top.id }))
    .create_update;
  assert.equal(
    await code({ i: item.id, b: "No", p: reply.id }),
    "BAD_USER_INPUT",
  );
  const elsewhere = await sam.error(CREATE, {
    i: other.id,
    b: "No",
    p: top.id,
  });
  const unknown = await sam.error(CREATE, {
    i: other.id,
    b: "No",
    p: "999999",
  });
  assert.equal(elsewhere.extensions.code, "NOT_FOUND");
  assert.equal(
    elsewhere.message.replace(top.id, "<id>"),
    unknown.message.replace("999999", "<id>"),
  );
  assert.equal(await code({ i: item.id, b: " " }), "BAD_USER_INPUT");
  assert.equal(
    await code({ i: item.id, b: "x".repeat(10_001) }),
    "BAD_USER_INPUT",
  );
  const many = Array.from({ length: 51 }, () => `@[S](user:${users.sam})`);
  const refused = await sam.error(CREATE, { i: item.id, b: many.join(" ") });
  assert.equal(refused.extensions.code, "BAD_USER_INPUT");
  assert.match(refused.message, /at most 50/);
  assert.equal(await code({ i: "999999", b: "x" }), "NOT_FOUND");
  assert.equal(store.countUpdatesByItem().get(item.id), 4);
});

test("posting, replying, liking and pinning need editor; edits the author; deletes the author or an owner", async (t) => {
  const { client, item, store, users } = await setup(t);
  const top = store.createUpdate({
    itemId: item.id,
    body: "Sam's",
    creatorId: users.sam,
  });
  const flags = `query F($i: [ID!]!) { items(ids: $i) { updates { id can_edit can_delete } } }`;
  const verdicts = async (key) => {
    const [read] = (await client(key).data(flags, { i: [item.id] })).items;
    const mine = read.updates.find((u) => u.id === top.id);
    return [mine.can_edit, mine.can_delete];
  };
  // Roadmap roles: Alex owner (admin), Sam and Noa editors, Jordan viewer.
  assert.deepEqual(await verdicts("sam"), [true, true]);
  assert.deepEqual(await verdicts("noa"), [false, false]);
  assert.deepEqual(await verdicts("alex"), [false, true]);
  assert.deepEqual(await verdicts("jordan"), [false, false]);
  const probes = [
    [CREATE, { i: item.id, b: "x" }],
    [CREATE, { i: item.id, b: "x", p: top.id }],
    [LIKE, { u: top.id }],
    [UNLIKE, { u: top.id }],
    [PIN, { u: top.id, i: item.id }],
    [UNPIN, { u: top.id, i: item.id }],
    [EDIT, { u: top.id, b: "x" }],
    [DELETE, { u: top.id }],
  ];
  const codes = async (key) => {
    const found = [];
    for (const [query, variables] of probes)
      found.push(await client(key).code(query, variables));
    return found;
  };
  const F = "FORBIDDEN";
  assert.deepEqual(await codes("jordan"), [F, F, F, F, F, F, F, F]);
  assert.deepEqual(await codes("noa"), [
    null,
    null,
    null,
    null,
    null,
    null,
    F,
    F,
  ]);
  // Chris cannot open the board: every probe reads like an unknown ID.
  for (const [query, variables] of probes) {
    const hidden = await client("chris").error(query, variables);
    assert.equal(hidden.extensions.code, "NOT_FOUND", query);
    const missing = Object.fromEntries(
      Object.entries(variables).map(([k, v]) => [
        k,
        v === top.id ? "999999" : v,
      ]),
    );
    const unknown = await client("noa").error(query, missing);
    if (variables.u === top.id)
      assert.equal(
        hidden.message.replace(top.id, "<id>"),
        unknown.message.replace("999999", "<id>"),
      );
  }
  const sam = client("sam");
  assert.equal(
    (await sam.data(EDIT, { u: top.id, b: "Edited" })).edit_update.body,
    "Edited",
  );
  assert.equal(await client("alex").code(EDIT, { u: top.id, b: "x" }), F);
  await client("alex").data(DELETE, { u: top.id });
  assert.equal(store.getUpdate(top.id), null, "a board owner deletes");
});
