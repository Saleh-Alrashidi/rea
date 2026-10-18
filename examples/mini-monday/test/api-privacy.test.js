/**
 * Adversarial privacy suite, part 2 (SPEC-2 §1.2, §3): enumeration through
 * search, shared_with_me, my_work, the user and team directory, account
 * counts and the admin content directory, and deactivated users. Each
 * seeded user must only ever see what they can access.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  SEED_USERS,
  apiClient,
  seedRole,
  seedRoleMap,
  startTestServers,
} from "./helpers.js";

const USERS = SEED_USERS.filter((user) => user !== "morgan");

async function setup(t) {
  const servers = await startTestServers();
  t.after(() => servers.close());
  const clients = Object.fromEntries(
    USERS.map((user) => [user, servers.as(servers.ids.users[user])]),
  );
  return { ...servers, clients };
}

test("search, shared_with_me, my_work and the directory never reveal hidden records", async (t) => {
  const { clients, ids, store } = await setup(t);
  const lists = `{ shared_with_me { kind id } my_work(limit: 500) { id board { id } }
    users(limit: 500) { id } teams { id } account { user_count } }`;
  const search =
    "query S($q: String!) { search(query: $q, limit: 50) { kind id title } }";
  const shared = {
    alex: [],
    sam: ["doc:brief", "note:oneOnOne", "note:checklist"],
    noa: ["board:hiring"],
    priya: [],
    jordan: [],
    chris: ["board:marketing", "doc:brief"],
  };
  const groups = { board: "boards", doc: "docs", note: "notes" };
  for (const user of USERS) {
    for (const term of [
      "a",
      "e",
      "launch",
      "hiring",
      "budget",
      "ideas",
      "crit",
      "offsite",
    ]) {
      const found = (await clients[user].data(search, { q: term })).search;
      for (const entry of found) {
        const role = searchRole(store, ids, entry, user);
        assert.notEqual(
          role,
          null,
          `${user} found ${entry.kind} ${entry.title}`,
        );
        assert.ok(entry.title.toLowerCase().includes(term));
      }
    }
    const data = await clients[user].data(lists);
    const boards = Object.keys(seedRoleMap(ids, "board", user));
    assert.ok(data.my_work.every((item) => boards.includes(item.board.id)));
    const want = shared[user].map((spec) => {
      const [kind, key] = spec.split(":");
      return `${kind}:${ids[groups[kind]][key]}`;
    });
    const got = data.shared_with_me.map((entry) => `${entry.kind}:${entry.id}`);
    assert.deepEqual(got.sort(), want.sort(), `${user} shared_with_me`);
    const directory = user === "chris" ? 3 : 7;
    assert.equal(data.users.length, directory, `${user} users`);
    assert.equal(data.account.user_count, directory);
    assert.equal(data.teams.length, user === "chris" ? 0 : 3);
  }
  const chris = await clients.chris.data(search, { q: "alex" });
  assert.deepEqual(
    chris.search,
    [],
    "a guest cannot find people outside their content",
  );
  // Items on hidden boards stay out of my_work even when assigned.
  const [hidden] = store.listItems({ boardId: ids.boards.hiring }).items;
  store.setColumnValue(hidden.id, "person", [ids.users.sam]);
  const work = await clients.sam.data("{ my_work { id } }");
  assert.ok(work.my_work.every((item) => item.id !== hidden.id));
});

/** The access `user` should have to a search result (null = leak). */
function searchRole(store, ids, entry, user) {
  const keyOf = (group, id) =>
    Object.entries(ids[group]).find(([, value]) => value === id)?.[0];
  const boardKey = (boardId) => keyOf("boards", boardId);
  if (entry.kind === "board")
    return seedRole("board", boardKey(entry.id), user);
  if (entry.kind === "item")
    return seedRole("board", boardKey(store.getItem(entry.id).board_id), user);
  if (entry.kind === "form")
    return seedRole("board", boardKey(store.getForm(entry.id).board_id), user);
  if (entry.kind === "doc")
    return seedRole("doc", keyOf("docs", entry.id), user);
  if (entry.kind === "note")
    return seedRole("note", keyOf("notes", entry.id), user);
  if (entry.kind === "workspace")
    return seedRole("workspace", keyOf("workspaces", entry.id), user);
  if (user !== "chris") return "viewer";
  // A guest sees only the people on their content and no teams.
  const people = ["sam", "priya", "chris"].map((key) => ids.users[key]);
  return entry.kind === "user" && people.includes(entry.id) ? "viewer" : null;
}

test("the admin directory is metadata only and admins-only", async (t) => {
  const { clients, ids } = await setup(t);
  const query =
    "{ admin_content_directory { kind id title privacy owner { name } } }";
  for (const user of USERS.filter((u) => u !== "alex")) {
    assert.equal(await clients[user].code(query), "FORBIDDEN", user);
  }
  const { admin_content_directory: entries } = await clients.alex.data(query);
  const listed = entries.map(
    (entry) => `${entry.kind}:${entry.title}:${entry.privacy}`,
  );
  assert.ok(listed.includes("board:Marketing launch:share"));
  assert.ok(listed.includes("doc:Launch brief:private"));
  assert.ok(
    entries.every((entry) => entry.kind !== "note"),
    "notes are never listed",
  );
  const marketing = entries.find((entry) => entry.id === ids.boards.marketing);
  assert.equal(marketing.owner.name, "Priya Nair");
  // Listing grants no content access.
  const read = await clients.alex.data(
    "query B($b: [ID!]) { boards(ids: $b) { id } }",
    { b: [ids.boards.marketing] },
  );
  assert.deepEqual(read.boards, []);
});

test("deactivated users: tokens and sessions stop working at once", async (t) => {
  const servers = await setup(t);
  const { store, ids, hostUrl } = servers;
  const morgan = ids.users.morgan;
  const token = servers.tokenFor(morgan);
  const asToken = apiClient(hostUrl, { token });
  assert.equal((await asToken.call("{ me { id } }")).status, 401);
  assert.throws(() => servers.sessionFor(morgan), TypeError);
  store.activateUser(morgan);
  const session = servers.as(morgan);
  assert.deepEqual(await session.data("{ me { status } }"), {
    me: { status: "active" },
  });
  const deactivate =
    "mutation D($u: ID!) { deactivate_user(user_id: $u) { status } }";
  for (const user of USERS.filter((u) => u !== "alex")) {
    assert.equal(
      await servers.clients[user].code(deactivate, { u: morgan }),
      "FORBIDDEN",
    );
  }
  const done = await servers.clients.alex.data(deactivate, { u: morgan });
  assert.equal(done.deactivate_user.status, "deactivated");
  assert.equal((await session.call("{ me { id } }")).status, 401);
  assert.equal((await asToken.call("{ me { id } }")).status, 401);
  // Shares to deactivated users are refused.
  const share = `mutation S($u: ID!) { share(resource_kind: board, resource_id: "${ids.boards.roadmap}",
    subject_kind: user, subject_ids: [$u], role: viewer) { id } }`;
  assert.equal(
    await servers.clients.alex.code(share, { u: morgan }),
    "BAD_USER_INPUT",
  );
});

test("a guest's directory includes people assigned on boards they can open", async (t) => {
  const { clients, ids, store } = await setup(t);
  const names = async () =>
    (await clients.chris.data("{ users { id } }")).users.map((u) => u.id);
  assert.ok(!(await names()).includes(ids.users.noa));
  const [item] = store.listItems({ boardId: ids.boards.marketing }).items;
  store.setColumnValue(item.id, "person", [ids.users.noa]);
  assert.ok((await names()).includes(ids.users.noa));
  // Re-saving an existing assignee works; unseen people stay unknown.
  const set = `mutation P($b: ID!, $i: ID!, $v: String) {
    change_simple_column_value(board_id: $b, item_id: $i, column_id: "person",
      value: $v) { column_values(ids: ["person"]) { text } } }`;
  const vars = { b: ids.boards.marketing, i: item.id };
  const both = `${ids.users.noa},${ids.users.chris}`;
  const saved = await clients.chris.data(set, { ...vars, v: both });
  assert.deepEqual(saved.change_simple_column_value.column_values, [
    { text: "Noa Cohen, Chris Taylor" },
  ]);
  const hidden = await clients.chris.code(set, {
    ...vars,
    v: ids.users.jordan,
  });
  assert.equal(hidden, "BAD_USER_INPUT");
});
