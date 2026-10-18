/**
 * Guest directory privacy across every field that can carry another
 * user's name or identity (SPEC-2 §6): a guest's directory is themselves,
 * the members of what is shared with them and their teams' members.
 * Everyone else is absent from user lists and User-valued fields and
 * reads "Someone" in texts (activity labels and from/to texts,
 * notification texts over GraphQL and SSE, people column text, with the
 * people column value keeping only visible IDs), while members see the
 * same records with real names.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { openStream, startTestServers } from "./helpers.js";

const NOTIFICATION = /event: notification\ndata: (.*)\n\n/;
const BOARD = `query B($b: ID!) { boards(ids: [$b]) {
  creator { id } members { kind id name } assignable_users { id }
  items_page(limit: 100) { items { name creator { id }
    column_values(ids: ["person"]) { text value } updates { creator { id } } } }
  activity_logs(limit: 100) { kind actor { id } actor_label from_text to_text } } }`;
const DOC = `query D($d: ID!) { docs(ids: [$d]) {
  created_by { id } updated_by { id } members { kind id name } } }`;
const INBOX = "{ notifications(limit: 100) { kind text actor { id } } }";
const DIRECTORY = `{ users(limit: 100) { id } account { user_count }
  noa: search(query: "noa") { kind id } alex: search(query: "alex") { kind id }
  teams { id members { user { id } } } }`;

/** Changes made by Noa and Alex that end with both outside Chris's directory. */
async function history(servers) {
  const { ids, as, store } = servers;
  const { users, boards, docs } = ids;
  const [priya, noa, alex] = ["priya", "noa", "alex"].map((key) =>
    as(users[key]),
  );
  const board = { resourceKind: "board", resourceId: boards.marketing };
  store.share({
    ...board,
    subjectKind: "user",
    subjectIds: [users.noa],
    role: "editor",
    actorId: users.priya,
  });
  const created = await noa.data(
    `mutation C($b: ID!) { create_item(board_id: $b, item_name: "Draft task",
      column_values: "{\\"status\\":\\"Stuck\\"}") { id } }`,
    { b: boards.marketing },
  );
  const item = created.create_item.id;
  await noa.data(
    `mutation P($b: ID!, $i: ID!, $v: String) { change_simple_column_value(board_id: $b,
      item_id: $i, column_id: "person", value: $v) { id } }`,
    { b: boards.marketing, i: item, v: `${users.noa},${users.chris}` },
  );
  await noa.data(
    `mutation U($i: ID!) { create_update(item_id: $i, body: "Mine") { id } }`,
    {
      i: item,
    },
  );
  await priya.data(
    `mutation U($b: ID!, $u: ID!) { unshare(resource_kind: board, resource_id: $b,
      subject_kind: user, subject_id: $u) { id } }`,
    { b: boards.marketing, u: users.noa },
  );
  // Alex takes over the brief, edits it and leaves it to Priya again.
  await alex.data(
    `mutation T($d: ID!) { admin_take_ownership(resource_kind: doc, resource_id: $d) { id } }`,
    { d: docs.brief },
  );
  const doc = store.getDoc(docs.brief);
  await alex.data(
    `mutation E($d: ID!, $v: Int!) { update_doc(doc_id: $d, expected_version: $v,
      title: "Launch brief v2") { id } }`,
    { d: docs.brief, v: doc.version },
  );
  await alex.data(
    `mutation L($d: ID!, $u: ID!) { unshare(resource_kind: doc, resource_id: $d,
      subject_kind: user, subject_id: $u) { id } }`,
    { d: docs.brief, u: users.alex },
  );
  return { item };
}

test("a guest reads Someone for people outside their directory, in every field", async (t) => {
  const servers = await startTestServers();
  t.after(() => servers.close());
  const { ids, as, hostUrl, sessionFor } = servers;
  const { users, boards, docs } = ids;
  const hidden = [users.noa, users.alex];
  const hiddenNames = /Noa|Alex/;
  const chris = as(users.chris);
  const inbox = await openStream(
    new URL("/v2/events?stream=me", hostUrl),
    sessionFor(users.chris),
  );
  t.after(() => inbox.close());
  await inbox.next(/^: connected\n\n/);
  await history(servers);
  // Alex makes Chris a member and a guest again: the second notification
  // reaches Chris as a guest, so Alex is "Someone" live and in the inbox.
  const role = `mutation R($u: ID!, $r: AccountRole!) { update_user(user_id: $u, role: $r) { id } }`;
  await as(users.alex).data(role, { u: users.chris, r: "member" });
  await as(users.alex).data(role, { u: users.chris, r: "guest" });
  let live = null;
  while (live?.kind !== "role" || !live.text.endsWith("guest")) {
    live = JSON.parse((await inbox.next(NOTIFICATION))[1]);
  }
  assert.equal(live.text, "Someone changed your account role to guest");

  const [board] = (await chris.data(BOARD, { b: boards.marketing })).boards;
  assert.equal(board.creator.id, users.priya);
  const ids_ = (list) => list.map((entry) => entry.id);
  for (const list of [board.members, board.assignable_users]) {
    assert.ok(!ids_(list).some((id) => hidden.includes(id)));
  }
  const task = board.items_page.items.find(
    (entry) => entry.name === "Draft task",
  );
  assert.equal(task.creator, null);
  assert.equal(task.updates[0].creator, null);
  assert.deepEqual(task.column_values[0], {
    text: "Someone, Chris Taylor",
    value: JSON.stringify({
      personsAndTeams: [{ id: Number(users.chris), kind: "person" }],
    }),
  });
  const texts = board.activity_logs.flatMap((e) => [
    e.actor_label,
    e.from_text,
    e.to_text,
  ]);
  assert.ok(
    texts.every((text) => !hiddenNames.test(text ?? "")),
    texts.join(" | "),
  );
  const byNoa = board.activity_logs.filter(
    (e) => e.kind === "item_created" && e.actor === null,
  );
  assert.ok(byNoa.some((e) => e.actor_label === "Someone"));
  assert.ok(texts.includes("Someone (editor)"), "member changes");
  assert.ok(texts.includes("Someone, Chris Taylor"), "people values");

  const [doc] = (await chris.data(DOC, { d: docs.brief })).docs;
  assert.equal(doc.updated_by, null, "Alex edited it last");
  assert.ok(!ids_(doc.members).some((id) => hidden.includes(id)));

  const notes = (await chris.data(INBOX)).notifications;
  const said = notes.map((n) => n.text);
  assert.ok(
    said.includes("Someone assigned you to “Draft task”"),
    said.join(" | "),
  );
  assert.ok(said.includes("Someone changed your account role to member"));
  assert.ok(
    said.every((text) => !hiddenNames.test(text)),
    said.join(" | "),
  );
  assert.ok(
    notes.every((n) => n.actor === null || !hidden.includes(n.actor.id)),
  );

  const directory = await chris.data(DIRECTORY);
  assert.deepEqual(
    ids_(directory.users).sort(),
    [users.sam, users.priya, users.chris].sort(),
  );
  assert.equal(directory.account.user_count, 3);
  assert.deepEqual(
    [directory.noa, directory.alex, directory.teams],
    [[], [], []],
  );
});

test("members see the same history with real names", async (t) => {
  const servers = await startTestServers();
  t.after(() => servers.close());
  const { ids, as } = servers;
  await history(servers);
  const priya = as(ids.users.priya);
  const [board] = (await priya.data(BOARD, { b: ids.boards.marketing })).boards;
  const task = board.items_page.items.find(
    (entry) => entry.name === "Draft task",
  );
  assert.equal(task.creator.id, ids.users.noa);
  assert.equal(task.column_values[0].text, "Noa Cohen, Chris Taylor");
  const texts = board.activity_logs.flatMap((e) => [
    e.actor_label,
    e.from_text,
    e.to_text,
  ]);
  assert.ok(texts.includes("Noa Cohen"), "Noa as an actor");
  assert.ok(texts.includes("Noa Cohen (editor)"), "member changes");
  assert.ok(!texts.includes("Someone"));
  const [doc] = (await priya.data(DOC, { d: ids.docs.brief })).docs;
  assert.equal(doc.updated_by.id, ids.users.alex);
  const notes = (await priya.data(INBOX)).notifications;
  assert.ok(
    notes.some((n) => n.text.startsWith("Alex Rivera (admin) took ownership")),
  );
});

test("a guest's teams show their members, who are in the guest's directory", async (t) => {
  const servers = await startTestServers();
  t.after(() => servers.close());
  const { ids, as } = servers;
  const create = `mutation T($u: [ID!]) { create_team(name: "Agency", member_ids: $u) { id } }`;
  await as(ids.users.noa).data(create, {
    u: [ids.users.chris, ids.users.jordan],
  });
  const seen = await as(ids.users.chris).data(DIRECTORY);
  const [team] = seen.teams;
  const members = team.members.map((m) => m.user.id).sort();
  assert.deepEqual(
    members,
    [ids.users.noa, ids.users.jordan, ids.users.chris].sort(),
  );
  for (const id of members) assert.ok(seen.users.some((u) => u.id === id));
  assert.equal(seen.noa.length, 1, "Noa is now findable");
});
