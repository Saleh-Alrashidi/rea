import assert from "node:assert/strict";
import test from "node:test";
import { boardAccess, canGrant, docAccess } from "../server/access.js";
import { createStore } from "../server/store.js";
import { plainEntry } from "./helpers.js";

// Grant rules (SPEC-2 §1.2): canGrant (roles per kind, subjects, guests,
// deactivated users, last owner), board kinds and admin takeovers.

async function seeded() {
  const store = await createStore();
  const users = Object.fromEntries(
    store.listUsers().map((u) => [u.name.split(" ")[0].toLowerCase(), u]),
  );
  const named = (list) => (name) =>
    list().find((r) => (r.name ?? r.title) === name);
  const events = [];
  store.on((event) => events.push(event));
  return {
    store,
    users,
    events,
    board: named(() => store.listBoards()),
    doc: named(() => store.listDocs()),
    note: named(() => store.listNotes()),
    team: named(() => store.listTeams()),
    workspace: named(() => store.listWorkspaces()),
  };
}
const user = (record) => ({ kind: "user", id: record.id });
const teamSubject = (record) => ({ kind: "team", id: record.id });
const lastActivity = (store, boardId) => {
  const [entry] = store.listActivity(boardId, { limit: 1 });
  const shown = plainEntry(store, entry);
  return [entry.kind, entry.actor_id, shown.from_text, shown.to_text];
};

test("canGrant: roles per resource kind, subjects and guests", async () => {
  const { store, users, board, doc, note, workspace, team } = await seeded();
  const check = (resourceKind, resource, subject, role) =>
    canGrant({ resourceKind, resource, subject, role, store }).reason ?? "ok";
  const roadmap = board("Product roadmap");
  const marketing = board("Marketing launch");
  const hiring = board("Hiring plan");
  const main = workspace("Main space");
  const brief = doc("Launch brief");
  const ideas = note("Ideas for Q1");
  assert.equal(
    check("planet", roadmap, user(users.sam), "viewer"),
    "invalid_kind",
  );
  assert.equal(check("board", null, user(users.sam), "viewer"), "not_found");
  assert.equal(
    check("workspace", main, user(users.sam), "viewer"),
    "invalid_role",
  );
  assert.equal(check("workspace", main, user(users.sam), "editor"), "ok");
  assert.equal(check("note", ideas, user(users.sam), "owner"), "invalid_role");
  assert.equal(check("note", ideas, user(users.sam), "editor"), "ok");
  assert.equal(
    check("board", roadmap, user(users.sam), "admin"),
    "invalid_role",
  );
  assert.equal(
    check("board", roadmap, { kind: "user", id: "999" }, "viewer"),
    "unknown_subject",
  );
  assert.equal(
    check("board", roadmap, { kind: "team", id: "999" }, "viewer"),
    "unknown_subject",
  );
  assert.equal(
    check("board", roadmap, { kind: "robot", id: "1" }, "viewer"),
    "unknown_subject",
  );
  assert.equal(
    check("board", roadmap, user(users.morgan), "viewer"),
    "deactivated",
  );
  // Guests: only share boards, docs and notes.
  const chris = user(users.chris);
  assert.equal(check("workspace", main, chris, "editor"), "guest_not_allowed");
  assert.equal(check("board", roadmap, chris, "viewer"), "guest_not_allowed");
  assert.equal(check("board", hiring, chris, "viewer"), "guest_not_allowed");
  assert.equal(check("board", marketing, chris, "owner"), "ok");
  assert.equal(check("doc", brief, chris, "editor"), "ok");
  assert.equal(check("note", ideas, chris, "viewer"), "ok");
  assert.equal(check("note", ideas, user(users.alex), "viewer"), "note_owner");
  // Teams can be granted anywhere; guests inside them are filtered by access.
  assert.equal(
    check("board", hiring, teamSubject(team("Marketing")), "editor"),
    "ok",
  );
  assert.equal(
    check("workspace", main, teamSubject(team("Product")), "owner"),
    "ok",
  );
});

test("canGrant: a resource always keeps a user owner", async () => {
  const { store, users, board, workspace } = await seeded();
  const check = (resourceKind, resource, subject, role) =>
    canGrant({ resourceKind, resource, subject, role, store }).reason ?? "ok";
  const roadmap = board("Product roadmap");
  const alex = user(users.alex);
  assert.equal(check("board", roadmap, alex, null), "last_owner", "remove");
  assert.equal(check("board", roadmap, alex, "editor"), "last_owner", "demote");
  assert.equal(check("board", roadmap, alex, "owner"), "ok");
  assert.equal(
    check("board", roadmap, user(users.sam), null),
    "ok",
    "not a member",
  );
  const leadership = workspace("Leadership");
  assert.equal(check("workspace", leadership, alex, null), "last_owner");
  const teamGrant = leadership.members.find((g) => g.kind === "team");
  assert.equal(check("workspace", leadership, teamGrant, null), "ok");
  const twoOwners = {
    ...roadmap,
    members: [
      ...roadmap.members,
      { kind: "user", id: users.noa.id, role: "owner" },
    ],
  };
  assert.equal(check("board", twoOwners, alex, null), "ok");
  const teamOwner = {
    ...roadmap,
    members: [...roadmap.members, { kind: "team", id: "30", role: "owner" }],
  };
  assert.equal(
    check("board", teamOwner, alex, null),
    "last_owner",
    "teams do not count",
  );
});

test("setBoardKind: leaving shareable removes guests and logs it", async () => {
  const { store, users, board, events } = await seeded();
  const marketing = board("Marketing launch");
  assert.equal(boardAccess(store, users.chris, marketing), "editor");
  const next = store.setBoardKind(marketing.id, "private", {
    actorId: users.priya.id,
  });
  assert.equal(next.board_kind, "private");
  assert.deepEqual(next.members, [
    { kind: "user", id: users.priya.id, role: "owner" },
  ]);
  assert.equal(boardAccess(store, users.chris, next), null);
  assert.deepEqual(events[0], {
    type: "board_kind_changed",
    board_id: marketing.id,
    resource_kind: "board",
    resource_id: marketing.id,
  });
  const log = store
    .listActivity(marketing.id, { limit: 2 })
    .reverse()
    .map((entry) => plainEntry(store, entry));
  assert.deepEqual(
    log.map((a) => [a.kind, a.from_text, a.to_text]),
    [
      ["board_kind_changed", "Shareable", "Private"],
      ["member_removed", "Chris Taylor (editor)", null],
    ],
  );
  assert.equal(
    store.setBoardKind(marketing.id, "private"),
    store.getBoard(marketing.id),
    "no-op",
  );
  assert.equal(store.setBoardKind(marketing.id, "secret").reason, "invalid");
  assert.equal(store.setBoardKind("999999", "public"), null);
  const shared = store.setBoardKind(marketing.id, "share");
  assert.equal(shared.board_kind, "share", "guests are not restored");
  const guestOwned = store.createBoard({
    name: "Agency board",
    creatorId: users.chris.id,
    boardKind: "share",
  });
  assert.equal(
    store.setBoardKind(guestOwned.id, "public").reason,
    "last_owner",
  );
});

test("admins take ownership visibly; others cannot", async () => {
  const { store, users, board, doc } = await seeded();
  const marketing = board("Marketing launch");
  assert.equal(boardAccess(store, users.alex, marketing), null);
  const taken = store.adminTakeOwnership({
    resourceKind: "board",
    resourceId: marketing.id,
    actorId: users.alex.id,
  });
  assert.equal(boardAccess(store, users.alex, taken), "owner");
  assert.deepEqual(lastActivity(store, marketing.id), [
    "ownership_taken",
    users.alex.id,
    null,
    "Alex Rivera (owner)",
  ]);
  const brief = doc("Launch brief");
  const takenDoc = store.adminTakeOwnership({
    resourceKind: "doc",
    resourceId: brief.id,
    actorId: users.alex.id,
  });
  assert.equal(docAccess(store, users.alex, takenDoc), "owner");
  const again = store.adminTakeOwnership({
    resourceKind: "doc",
    resourceId: brief.id,
    actorId: users.alex.id,
  });
  assert.equal(again, store.getDoc(brief.id), "already an owner");
  const denied = store.adminTakeOwnership({
    resourceKind: "doc",
    resourceId: brief.id,
    actorId: users.sam.id,
  });
  assert.equal(denied.reason, "forbidden");
  const notes = store.adminTakeOwnership({
    resourceKind: "note",
    resourceId: "50",
    actorId: users.alex.id,
  });
  assert.equal(notes.reason, "invalid", "notes are never taken over");
  assert.equal(
    store.adminTakeOwnership({
      resourceKind: "board",
      resourceId: "999999",
      actorId: "1",
    }),
    null,
  );
});
