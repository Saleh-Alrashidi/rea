/**
 * The people a caller may see, everywhere a user appears (SPEC-2 §3 lists
 * only accessible records; SPEC-2 §6 directory privacy, decided in
 * `server/access.js`): authors, actors, members and member teams resolve
 * through the caller's directory, and texts naming people outside it say
 * "Someone", so a guest never learns about them. Also checks that the
 * lists that scan everything a caller can access do so once per request,
 * however often a query aliases them.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "../server/store.js";
import { perRequest } from "../server/schema/common.js";
import { startTestServers } from "./helpers.js";

const SHARE = `mutation S($b: ID!, $u: ID!) { share(resource_kind: board,
  resource_id: $b, subject_kind: user, subject_ids: [$u], role: editor) { id } }`;
const UNSHARE = `mutation U($b: ID!, $u: ID!) { unshare(resource_kind: board,
  resource_id: $b, subject_kind: user, subject_id: $u) { id } }`;
const BOARD = `query B($b: ID!) { boards(ids: [$b]) {
  items_page(limit: 100) { items { name creator { id email }
    updates { creator { id email } } } }
  activity_logs(limit: 100) { actor { id } actor_label } } }`;
const HIDDEN_NAMES = /Alex Rivera|Noa Cohen/;

test("guests never see hidden people through authors, actors or member teams", async (t) => {
  const servers = await startTestServers();
  t.after(() => servers.close());
  const { ids, as } = servers;
  const [priya, noa, chris] = ["priya", "noa", "chris"].map((key) =>
    as(ids.users[key]),
  );
  const board = ids.boards.marketing;
  await priya.data(SHARE, { b: board, u: ids.users.noa });
  const created = await noa.data(
    `mutation C($b: ID!) { create_item(board_id: $b, item_name: "From Noa") { id } }`,
    { b: board },
  );
  const item = created.create_item.id;
  await noa.data(
    `mutation U($i: ID!) { create_update(item_id: $i, body: "Hi") { id } }`,
    { i: item },
  );
  await priya.data(UNSHARE, { b: board, u: ids.users.noa });
  const hidden = [ids.users.alex, ids.users.noa];
  const seen = await chris.data(
    "query U($u: [ID!]) { users(ids: $u) { id } }",
    {
      u: hidden,
    },
  );
  assert.deepEqual(seen.users, [], "outside the guest's directory");
  const [view] = (await chris.data(BOARD, { b: board })).boards;
  const users = [
    ...view.items_page.items.flatMap((entry) => [
      entry.creator,
      ...entry.updates.map((update) => update.creator),
    ]),
    ...view.activity_logs.map((entry) => entry.actor),
  ];
  assert.ok(users.every((user) => user === null || !hidden.includes(user.id)));
  const mine = view.items_page.items.find((entry) => entry.name === "From Noa");
  assert.equal(mine.creator, null);
  assert.equal(mine.updates[0].creator, null);
  // Activity names Noa and Alex only as "Someone" for the guest.
  const labels = view.activity_logs.map((entry) => entry.actor_label);
  assert.ok(labels.includes("Someone"));
  assert.ok(labels.every((label) => !HIDDEN_NAMES.test(label ?? "")));
  // Members keep their names; a team the guest is not in stays hidden.
  const docs = await chris.data(
    `query D($d: [ID!]) { docs(ids: $d) { members { kind name user { id } team { id } } } }`,
    { d: [ids.docs.brief] },
  );
  const team = docs.docs[0].members.find((member) => member.kind === "team");
  assert.deepEqual(team, {
    kind: "team",
    name: "Marketing",
    user: null,
    team: null,
  });
  assert.deepEqual((await chris.data("{ teams { id } }")).teams, []);
  // Non-guests see every author.
  const [full] = (await priya.data(BOARD, { b: board })).boards;
  const theirs = full.items_page.items.find(
    (entry) => entry.name === "From Noa",
  );
  assert.equal(theirs.creator.id, ids.users.noa);
});

test("a guest's role notifications do not reveal the admin behind them", async (t) => {
  const servers = await startTestServers();
  t.after(() => servers.close());
  const { ids, as } = servers;
  const role = `mutation R($u: ID!, $r: AccountRole!) { update_user(user_id: $u, role: $r) { id } }`;
  const alex = as(ids.users.alex);
  await alex.data(role, { u: ids.users.chris, r: "member" });
  await alex.data(role, { u: ids.users.chris, r: "guest" });
  const inbox = await as(ids.users.chris).data(
    "{ notifications { kind text actor { id } } }",
  );
  const changes = inbox.notifications.filter((entry) => entry.kind === "role");
  assert.equal(changes.length, 2);
  assert.ok(changes.every((entry) => entry.actor === null));
  assert.equal(changes[0].text, "Someone changed your account role to guest");
  assert.equal(changes[1].text, "Someone changed your account role to member");
});

/** A store view that counts calls of `listItems` and `listTeams`. */
function countingStore(store) {
  const counts = { listItems: 0, listTeams: 0 };
  const counted =
    (name) =>
    (...args) => {
      counts[name] += 1;
      return store[name](...args);
    };
  const view = Object.freeze({
    ...store,
    listItems: counted("listItems"),
    listTeams: counted("listTeams"),
  });
  return { view, counts };
}

test("aliased scans of everything a caller can access run once per request", async (t) => {
  const { view, counts } = countingStore(await createStore());
  const servers = await startTestServers({ store: view });
  t.after(() => servers.close());
  const { ids, as } = servers;
  const fields = [
    'search(query: "zz") { id }',
    "my_work { id }",
    "shared_with_me { id }",
    "admin_content_directory { id }",
    "boards(limit: 100) { id }",
  ];
  const query = (aliases) =>
    `{ ${fields
      .flatMap((field, f) =>
        Array.from({ length: aliases }, (_, a) => `f${f}a${a}: ${field}`),
      )
      .join(" ")} }`;
  const scans = async (client, text) => {
    counts.listItems = 0;
    counts.listTeams = 0;
    await client.data(text);
    return { ...counts };
  };
  const alex = as(ids.users.alex);
  const once = await scans(alex, query(1));
  assert.ok(once.listItems > 0);
  assert.deepEqual(await scans(alex, query(40)), once);
  // A guest's directory is also built once, however many fields use it.
  const chris = as(ids.users.chris);
  const people = (n) =>
    `{ ${Array.from({ length: n }, (_, i) => `u${i}: users { id } c${i}: account { user_count }`).join(" ")} }`;
  assert.deepEqual(
    await scans(chris, people(40)),
    await scans(chris, people(1)),
  );
});

test("per-request values are recomputed after any committed change", async () => {
  const store = await createStore();
  const ctx = { store };
  let computed = 0;
  const value = () => perRequest(ctx, "key", () => (computed += 1));
  assert.equal(value(), 1);
  assert.equal(value(), 1);
  store.createTeam({ name: "New team" });
  assert.equal(value(), 2);
  assert.equal(
    perRequest({ store }, "key", () => "other request"),
    "other request",
  );
  const stub = { store: { getUser: () => null } };
  perRequest(stub, "key", () => (computed += 1));
  perRequest(stub, "key", () => (computed += 1));
  assert.equal(computed, 4, "stores without a revision are never cached");
});
