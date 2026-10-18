import assert from "node:assert/strict";
import test from "node:test";
import { boardAccess, can, isAdmin } from "../server/access.js";
import { createStore } from "../server/store.js";
import { plainText } from "./helpers.js";

// Users and teams (SPEC-2 §2): invitations, unique emails, roles, titles,
// deactivation with last-admin protection, role notifications, and team
// membership with last-owner protection.

async function seeded() {
  const store = await createStore();
  const users = Object.fromEntries(
    store.listUsers().map((u) => [u.name.split(" ")[0].toLowerCase(), u]),
  );
  const events = [];
  store.on((event) => events.push(event));
  return { store, users, events };
}

test("createUser validates names, emails and roles", async () => {
  const { store, events } = await seeded();
  const user = store.createUser({
    name: "  Robin Park ",
    email: " Robin@Example.test ",
    role: "viewer",
    title: "Support Lead",
  });
  assert.deepEqual(
    [user.name, user.email, user.role, user.title, user.status],
    ["Robin Park", "Robin@Example.test", "viewer", "Support Lead", "active"],
  );
  assert.match(user.color, /^#[0-9a-f]{6}$/);
  assert.deepEqual(events, [{ type: "user_created", user_ids: [user.id] }]);
  assert.equal(store.findUserByEmail("robin@EXAMPLE.test"), user);
  assert.equal(store.findUserByEmail("nobody@example.test"), null);
  const taken = store.createUser({
    name: "Again",
    email: "ROBIN@example.test",
  });
  assert.deepEqual([taken.ok, taken.reason], [false, "email_taken"]);
  const invalid = [
    { name: "", email: "a@b.c" },
    { name: "x".repeat(256), email: "a@b.c" },
    { name: "A", email: "no-at-sign" },
    { name: "A", email: "two@@b.c" },
    { name: "A", email: "a@b@c" },
    { name: "A", email: "@b.c" },
    { name: "A", email: "a@" },
    { name: "A", email: "a b@c.d" },
    { name: "A", email: `${"a".repeat(251)}@b.cd` },
    { name: "A", email: "a@b.c", role: "owner" },
    { name: "A", email: "a@b.c", title: "t".repeat(256) },
  ];
  for (const fields of invalid) {
    const result = store.createUser(fields);
    assert.equal(result.reason, "invalid", JSON.stringify(fields));
    assert.equal(typeof result.message, "string");
  }
  assert.throws(() => store.createUser({ name: 5, email: "a@b.c" }), TypeError);
  const plain = store.createUser({
    name: "Kim",
    email: "kim@example.test",
    title: " ",
  });
  assert.deepEqual([plain.role, plain.title], ["member", null]);
  assert.equal(events.length, 2, "failed invitations emit nothing");
});

test("updateUser changes profile fields and notifies role changes", async () => {
  const { store, users, events } = await seeded();
  const renamed = store.updateUser(
    users.sam.id,
    { name: "Sam Lee-Park", title: null },
    { actorId: users.sam.id },
  );
  assert.deepEqual(
    [renamed.name, renamed.title, renamed.role],
    ["Sam Lee-Park", null, "member"],
  );
  assert.deepEqual(events, [
    { type: "user_updated", user_ids: [users.sam.id] },
  ]);
  const before = store.countUnreadNotifications(users.sam.id);
  const promoted = store.updateUser(
    users.sam.id,
    { role: "admin" },
    { actorId: users.alex.id },
  );
  assert.equal(promoted.role, "admin");
  assert.ok(isAdmin(promoted) && can(promoted, "manage_users"));
  const [note] = store.listNotifications(users.sam.id);
  assert.deepEqual(
    [
      note.kind,
      plainText(store, note.text),
      note.actor_id,
      note.url,
      note.resource_kind,
    ],
    [
      "role",
      "Alex Rivera changed your account role to admin",
      users.alex.id,
      "#/home",
      null,
    ],
  );
  assert.equal(store.countUnreadNotifications(users.sam.id), before + 1);
  assert.deepEqual(
    events.slice(1).map((e) => e.type),
    ["user_updated", "notification_created"],
  );
  store.updateUser(
    users.sam.id,
    { title: "Design Lead" },
    { actorId: users.alex.id },
  );
  assert.equal(
    store.countUnreadNotifications(users.sam.id),
    before + 1,
    "no role change, no notice",
  );
  store.updateUser(
    users.alex.id,
    { role: "member" },
    { actorId: users.alex.id },
  );
  assert.equal(
    store.getUser(users.alex.id).role,
    "member",
    "another admin remains",
  );
  assert.equal(
    store.countUnreadNotifications(users.alex.id),
    2,
    "changing your own role does not notify you",
  );
  assert.equal(store.updateUser("999", { name: "x" }), null);
  assert.equal(
    store.updateUser(users.sam.id, { role: "root" }).reason,
    "invalid",
  );
  assert.equal(store.updateUser(users.sam.id, { name: " " }).reason, "invalid");
});

test("the last active admin cannot be demoted or deactivated", async () => {
  const { store, users } = await seeded();
  const demote = store.updateUser(users.alex.id, { role: "member" });
  assert.deepEqual([demote.ok, demote.reason], [false, "last_admin"]);
  assert.equal(store.deactivateUser(users.alex.id).reason, "last_admin");
  assert.equal(store.getUser(users.alex.id).role, "admin");
  store.updateUser(users.noa.id, { role: "admin" });
  assert.equal(store.deactivateUser(users.alex.id).status, "deactivated");
  assert.equal(
    store.updateUser(users.noa.id, { role: "member" }).reason,
    "last_admin",
    "Alex no longer counts",
  );
  assert.equal(store.activateUser(users.alex.id).status, "active");
  assert.equal(
    store.updateUser(users.noa.id, { role: "member" }).role,
    "member",
  );
});

test("deactivation removes access at once and activation restores it", async () => {
  const { store, users, events } = await seeded();
  const roadmap = store.listBoards()[0];
  assert.equal(boardAccess(store, users.sam, roadmap), "editor");
  const off = store.deactivateUser(users.sam.id);
  assert.equal(off.status, "deactivated");
  assert.deepEqual(events, [
    { type: "user_updated", user_ids: [users.sam.id] },
  ]);
  assert.equal(boardAccess(store, store.getUser(users.sam.id), roadmap), null);
  assert.equal(can(store.getUser(users.sam.id), "create_note"), false);
  assert.equal(
    store.deactivateUser(users.sam.id),
    store.getUser(users.sam.id),
    "no-op",
  );
  assert.equal(events.length, 1);
  store.activateUser(users.sam.id);
  assert.equal(
    boardAccess(store, store.getUser(users.sam.id), roadmap),
    "editor",
  );
  assert.equal(store.deactivateUser("999"), null);
  // Deactivated users get no notifications.
  store.deactivateUser(users.noa.id);
  const item = store.listItems({ boardId: roadmap.id }).items[0];
  store.setColumnValue(item.id, "person", [users.noa.id], {
    actorId: users.alex.id,
  });
  assert.equal(store.countUnreadNotifications(users.noa.id), 0);
});

test("teams: create with an owner, add, promote and remove members", async () => {
  const { store, users, events } = await seeded();
  const team = store.createTeam({
    name: " Design guild ",
    description: "Crit every Friday",
    creatorId: users.sam.id,
    memberIds: [users.noa.id, users.sam.id, users.noa.id],
  });
  assert.deepEqual(
    [team.name, team.description, team.members],
    [
      "Design guild",
      "Crit every Friday",
      [
        { user_id: users.sam.id, role: "owner" },
        { user_id: users.noa.id, role: "member" },
      ],
    ],
  );
  assert.deepEqual(events[0], {
    type: "team_created",
    resource_kind: "team",
    resource_id: team.id,
  });
  assert.deepEqual(
    store.listUserTeams(users.noa.id).map((t) => t.name),
    ["Product", "Design guild"],
  );
  const grown = store.addTeamMembers(team.id, [users.priya.id, users.chris.id]);
  assert.deepEqual(
    grown.members.slice(2).map((m) => m.role),
    ["member", "member"],
  );
  const promoted = store.addTeamMembers(team.id, [users.noa.id], {
    asOwner: true,
  });
  assert.equal(
    promoted.members.find((m) => m.user_id === users.noa.id).role,
    "owner",
  );
  const kept = store.addTeamMembers(team.id, [users.noa.id]);
  assert.equal(
    kept.members.find((m) => m.user_id === users.noa.id).role,
    "owner",
    "adding never demotes",
  );
  assert.equal(
    store.addTeamMembers(team.id, [users.morgan.id]).reason,
    "invalid",
    "deactivated",
  );
  assert.equal(store.addTeamMembers(team.id, ["999"]).reason, "invalid");
  const smaller = store.removeTeamMembers(team.id, [
    users.sam.id,
    users.chris.id,
  ]);
  assert.deepEqual(
    smaller.members.map((m) => m.user_id),
    [users.noa.id, users.priya.id],
  );
  assert.equal(
    store.removeTeamMembers(team.id, [users.noa.id]).reason,
    "last_owner",
  );
  const renamed = store.updateTeam(team.id, {
    name: "Guild",
    description: null,
  });
  assert.deepEqual([renamed.name, renamed.description], ["Guild", null]);
  assert.equal(store.updateTeam(team.id, { name: "" }).reason, "invalid");
  assert.equal(
    store.createTeam({ name: "x".repeat(256), creatorId: "1" }).reason,
    "invalid",
  );
  assert.equal(
    store.createTeam({ name: "T", description: "d".repeat(2001) }).reason,
    "invalid",
  );
  assert.equal(store.addTeamMembers("999", ["1"]), null);
  assert.equal(store.removeTeamMembers("999", ["1"]), null);
  assert.equal(store.updateTeam("999", { name: "x" }), null);
});
