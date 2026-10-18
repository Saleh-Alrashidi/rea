/**
 * People over GraphQL (SPEC-2 §3): `me`, `account`, the user directory,
 * user administration (invite, roles, deactivation, last active admin)
 * and teams (create, manage, owners, members).
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

test("me and account describe the caller and the account", async (t) => {
  const { users, ids } = await setup(t);
  const data = await users.alex.data(`{
    me { id name email is_admin initials role title status color created_at
      teams { name } }
    account { id name user_count role_counts_json } }`);
  const { created_at, color, teams, ...me } = data.me;
  assert.deepEqual(me, {
    id: ids.users.alex,
    name: "Alex Rivera",
    email: "alex@example.test",
    is_admin: true,
    initials: "AR",
    role: "admin",
    title: "Head of Product",
    status: "active",
  });
  assert.match(created_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(color, /^#[0-9a-f]{6}$/);
  assert.deepEqual(
    teams.map((team) => team.name),
    ["Product", "Leadership"],
  );
  const { account } = data;
  assert.deepEqual(
    { ...account, role_counts_json: undefined },
    {
      id: "1",
      name: "Worklane",
      user_count: 7,
      role_counts_json: undefined,
    },
  );
  assert.deepEqual(JSON.parse(account.role_counts_json), {
    admin: 1,
    member: 4,
    viewer: 1,
    guest: 1,
  });
  const chris = await users.chris.data(
    "{ me { is_admin role } users { name } }",
  );
  assert.deepEqual(chris.me, { is_admin: false, role: "guest" });
  assert.deepEqual(
    chris.users.map((user) => user.name),
    ["Sam Lee", "Priya Nair", "Chris Taylor"],
  );
});

test("invite_user: admins only, unique emails, valid roles", async (t) => {
  const { users } = await setup(t);
  const invite = `mutation I($n: String!, $e: String!, $r: AccountRole!, $t: String) {
    invite_user(name: $n, email: $e, role: $r, title: $t) { id name email role title status } }`;
  const vars = {
    n: " Robin Park ",
    e: "robin@example.test",
    r: "viewer",
    t: "Auditor",
  };
  for (const key of ["sam", "jordan", "chris"]) {
    assert.equal(await users[key].code(invite, vars), "FORBIDDEN", key);
  }
  const made = (await users.alex.data(invite, vars)).invite_user;
  assert.deepEqual(
    { ...made, id: undefined },
    {
      id: undefined,
      name: "Robin Park",
      email: "robin@example.test",
      role: "viewer",
      title: "Auditor",
      status: "active",
    },
  );
  const again = await users.alex.error(invite, {
    ...vars,
    e: "ROBIN@example.test",
  });
  assert.equal(again.extensions.code, "BAD_USER_INPUT");
  assert.match(again.message, /already in use/);
  for (const e of ["robin", "a@b@c", "with space@example.test", ""]) {
    assert.equal(
      await users.alex.code(invite, { ...vars, e }),
      "BAD_USER_INPUT",
      e,
    );
  }
  assert.equal(
    await users.alex.code(invite, { ...vars, n: " " }),
    "BAD_USER_INPUT",
  );
  assert.equal(
    await users.alex.code(invite, { ...vars, r: "owner" }),
    "BAD_USER_INPUT",
  );
  const { users: list } = await users.sam.data(
    "{ users(limit: 500) { name } }",
  );
  assert.ok(list.some((user) => user.name === "Robin Park"));
});

test("update_user: self for name and title, admins for roles", async (t) => {
  const { users, ids, store } = await setup(t);
  const update = `mutation U($u: ID!, $n: String, $t: String, $r: AccountRole) {
    update_user(user_id: $u, name: $n, title: $t, role: $r) { name title role } }`;
  const self = await users.sam.data(update, {
    u: ids.users.sam,
    n: "Sam L.",
    t: null,
  });
  assert.deepEqual(self.update_user, {
    name: "Sam L.",
    title: null,
    role: "member",
  });
  assert.equal(
    await users.sam.code(update, { u: ids.users.sam, r: "admin" }),
    "FORBIDDEN",
  );
  assert.equal(
    await users.sam.code(update, { u: ids.users.noa, n: "Noa" }),
    "FORBIDDEN",
  );
  // Chris cannot see Alex: the same answer as an unknown user.
  assert.equal(
    await users.chris.code(update, { u: ids.users.alex, n: "x" }),
    "NOT_FOUND",
  );
  assert.equal(
    await users.chris.code(update, { u: "999999", n: "x" }),
    "NOT_FOUND",
  );
  const promoted = await users.alex.data(update, {
    u: ids.users.noa,
    r: "admin",
  });
  assert.equal(promoted.update_user.role, "admin");
  const [note] = store.listNotifications(ids.users.noa);
  assert.equal(note.kind, "role");
  assert.equal(note.actor_id, ids.users.alex);
  assert.equal(
    await users.alex.code(update, { u: ids.users.sam, n: "x".repeat(256) }),
    "BAD_USER_INPUT",
  );
  // The last active admin cannot be demoted.
  await users.alex.data(update, { u: ids.users.noa, r: "member" });
  const last = await users.alex.error(update, {
    u: ids.users.alex,
    r: "member",
  });
  assert.equal(last.extensions.code, "BAD_USER_INPUT");
  assert.match(last.message, /at least one active admin/);
});

test("deactivate_user and activate_user: admins, never themselves", async (t) => {
  const { users, ids, as } = await setup(t);
  const set = (op) =>
    `mutation S($u: ID!) { ${op}(user_id: $u) { id status } }`;
  assert.equal(
    await users.sam.code(set("deactivate_user"), { u: ids.users.noa }),
    "FORBIDDEN",
  );
  assert.equal(
    await users.alex.code(set("deactivate_user"), { u: ids.users.alex }),
    "FORBIDDEN",
  );
  assert.equal(
    await users.alex.code(set("activate_user"), { u: "999999" }),
    "NOT_FOUND",
  );
  const back = await users.alex.data(set("activate_user"), {
    u: ids.users.morgan,
  });
  assert.equal(back.activate_user.status, "active");
  const morgan = as(ids.users.morgan);
  assert.equal((await morgan.data("{ me { name } }")).me.name, "Morgan Diaz");
  const off = await users.alex.data(set("deactivate_user"), {
    u: ids.users.morgan,
  });
  assert.equal(off.deactivate_user.status, "deactivated");
  assert.equal(await morgan.code("{ me { id } }"), "UNAUTHENTICATED");
  // A second admin can deactivate the first; then they are the last one.
  await users.alex.data(
    `mutation { update_user(user_id: "${ids.users.noa}", role: admin) { id } }`,
  );
  const noa = as(ids.users.noa);
  await noa.data(set("deactivate_user"), { u: ids.users.alex });
  assert.equal(await users.alex.code("{ me { id } }"), "UNAUTHENTICATED");
  assert.equal(
    await noa.code(set("deactivate_user"), { u: ids.users.noa }),
    "FORBIDDEN",
  );
});

test("teams: members create them, owners and admins manage them", async (t) => {
  const { users, ids } = await setup(t);
  const fields =
    "id name description member_count my_role can_manage members { user { id } role }";
  const create = `mutation C($n: String!, $d: String, $m: [ID!]) {
    create_team(name: $n, description: $d, member_ids: $m) { ${fields} } }`;
  for (const key of ["jordan", "chris"]) {
    assert.equal(
      await users[key].code(create, { n: "Nope" }),
      "FORBIDDEN",
      key,
    );
  }
  const vars = { n: "Design", d: "Craft", m: [ids.users.noa, ids.users.sam] };
  const team = (await users.sam.data(create, vars)).create_team;
  assert.deepEqual(
    team.members.map((m) => [m.user.id, m.role]),
    [
      [ids.users.sam, "owner"],
      [ids.users.noa, "member"],
    ],
  );
  assert.deepEqual(
    [team.member_count, team.my_role, team.can_manage],
    [2, "owner", true],
  );
  const seen = (await users.noa.data("{ teams { id my_role can_manage } }"))
    .teams;
  assert.deepEqual(
    seen.find((entry) => entry.id === team.id),
    {
      id: team.id,
      my_role: "member",
      can_manage: false,
    },
  );
  const update = `mutation U($t: ID!, $n: String) { update_team(team_id: $t, name: $n) { name } }`;
  assert.equal(
    await users.noa.code(update, { t: team.id, n: "Mine" }),
    "FORBIDDEN",
  );
  assert.equal(
    await users.chris.code(update, { t: team.id, n: "Mine" }),
    "NOT_FOUND",
  );
  assert.equal(
    (await users.alex.data(update, { t: team.id, n: "Design team" }))
      .update_team.name,
    "Design team",
  );
  const add = `mutation A($t: ID!, $u: [ID!]!, $o: Boolean) {
    add_team_members(team_id: $t, user_ids: $u, as_owner: $o) { members { user { id } role } } }`;
  const owners = await users.sam.data(add, {
    t: team.id,
    u: [ids.users.noa],
    o: true,
  });
  assert.ok(owners.add_team_members.members.every((m) => m.role === "owner"));
  for (const u of [["999999"], [ids.users.morgan], []]) {
    assert.equal(
      await users.sam.code(add, { t: team.id, u }),
      "BAD_USER_INPUT",
      String(u),
    );
  }
  assert.equal(
    await users.sam.code(create, { n: "x".repeat(256) }),
    "BAD_USER_INPUT",
  );
  const remove = "mutation D($t: ID!) { delete_team(team_id: $t) { id } }";
  assert.equal(await users.priya.code(remove, { t: team.id }), "FORBIDDEN");
  assert.equal(
    (await users.noa.data(remove, { t: team.id })).delete_team.id,
    team.id,
  );
  assert.equal(await users.noa.code(remove, { t: team.id }), "NOT_FOUND");
});
