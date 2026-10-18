import assert from "node:assert/strict";
import test from "node:test";
import {
  boardAccess,
  docAccess,
  noteAccess,
  workspaceAccess,
} from "../server/access.js";
import { createStore } from "../server/store.js";
import { plainEntry, plainText } from "./helpers.js";

// Sharing through the store (SPEC-2 §1.2, §2): share/unshare with their
// activity and notifications, team shares, workspace/doc/note shares,
// workspaces and team deletion. canGrant, board kinds and admin takeovers
// are in store-grants.test.js.

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
const latest = (store, userId) => store.listNotifications(userId)[0] ?? null;
const lastActivity = (store, boardId) => {
  const [entry] = store.listActivity(boardId, { limit: 1 });
  const shown = plainEntry(store, entry);
  return [entry.kind, entry.actor_id, shown.from_text, shown.to_text];
};

test("share grants access, logs it and notifies the people it reaches", async () => {
  const { store, users, board, events } = await seeded();
  const hiring = board("Hiring plan");
  assert.equal(boardAccess(store, users.sam, hiring), null);
  const shared = store.share({
    resourceKind: "board",
    resourceId: hiring.id,
    subjectKind: "user",
    subjectIds: [users.sam.id],
    role: "editor",
    actorId: users.alex.id,
  });
  assert.deepEqual(shared.members.at(-1), {
    kind: "user",
    id: users.sam.id,
    role: "editor",
  });
  assert.equal(boardAccess(store, users.sam, shared), "editor");
  assert.deepEqual(events.slice(0, 2), [
    {
      type: "members_changed",
      resource_kind: "board",
      resource_id: hiring.id,
      board_id: hiring.id,
    },
    {
      type: "notification_created",
      user_ids: [users.sam.id],
      resource_kind: "notification",
      resource_id: latest(store, users.sam.id).id,
    },
  ]);
  const note = latest(store, users.sam.id);
  assert.deepEqual(
    [
      note.kind,
      note.url,
      note.actor_id,
      note.read,
      note.resource_kind,
      note.resource_id,
    ],
    [
      "share",
      `#/boards/${hiring.id}`,
      users.alex.id,
      false,
      "board",
      hiring.id,
    ],
  );
  assert.equal(
    plainText(store, note.text),
    "Alex Rivera shared the board “Hiring plan” with you (editor)",
  );
  assert.deepEqual(lastActivity(store, hiring.id), [
    "member_added",
    users.alex.id,
    null,
    "Sam Lee (editor)",
  ]);
  assert.equal(
    store.countUnreadNotifications(users.alex.id),
    2,
    "the actor is never notified",
  );
  const before = events.length;
  const again = store.share({
    resourceKind: "board",
    resourceId: hiring.id,
    subjectKind: "user",
    subjectIds: [users.sam.id],
    role: "editor",
    actorId: users.alex.id,
  });
  assert.equal(again, store.getBoard(hiring.id));
  assert.equal(events.length, before, "an unchanged grant emits nothing");
  store.share({
    resourceKind: "board",
    resourceId: hiring.id,
    subjectKind: "user",
    subjectIds: [users.sam.id],
    role: "viewer",
    actorId: users.alex.id,
  });
  assert.deepEqual(lastActivity(store, hiring.id), [
    "member_role_changed",
    users.alex.id,
    "Sam Lee (editor)",
    "Sam Lee (viewer)",
  ]);
  assert.equal(
    boardAccess(store, users.sam, store.getBoard(hiring.id)),
    "viewer",
  );
});

test("share is all or nothing and refuses guests outside shareable boards", async () => {
  const { store, users, board, events } = await seeded();
  const hiring = board("Hiring plan");
  const result = store.share({
    resourceKind: "board",
    resourceId: hiring.id,
    subjectKind: "user",
    subjectIds: [users.sam.id, users.chris.id],
    role: "viewer",
    actorId: users.alex.id,
  });
  assert.deepEqual(
    [result.ok, result.reason, result.subject_id],
    [false, "guest_not_allowed", users.chris.id],
  );
  assert.match(result.message, /Guests/);
  assert.deepEqual(store.getBoard(hiring.id), hiring, "nothing changed");
  assert.deepEqual(events, []);
  const share = (fields) =>
    store.share({
      resourceKind: "board",
      resourceId: hiring.id,
      actorId: "1",
      ...fields,
    });
  assert.equal(
    share({ subjectKind: "user", subjectIds: [], role: "viewer" }).reason,
    "invalid",
  );
  assert.equal(
    share({ subjectKind: "robot", subjectIds: ["2"], role: "viewer" }).reason,
    "invalid",
  );
  assert.equal(
    share({
      subjectKind: "user",
      subjectIds: [users.morgan.id],
      role: "viewer",
    }).reason,
    "deactivated",
  );
  assert.equal(
    store.share({
      resourceKind: "board",
      resourceId: "999999",
      subjectKind: "user",
      subjectIds: ["2"],
      role: "viewer",
    }),
    null,
  );
  assert.equal(
    store.share({
      resourceKind: "planet",
      resourceId: "4",
      subjectKind: "user",
      subjectIds: ["2"],
      role: "viewer",
    }).reason,
    "invalid",
  );
});

test("team shares reach current and future members who can access", async () => {
  const { store, users, board } = await seeded();
  const hiring = board("Hiring plan");
  const crew = store.createTeam({
    name: "Crew",
    creatorId: users.priya.id,
    memberIds: [users.sam.id, users.chris.id],
  });
  store.share({
    resourceKind: "board",
    resourceId: hiring.id,
    subjectKind: "team",
    subjectIds: [crew.id],
    role: "editor",
    actorId: users.alex.id,
  });
  const fresh = store.getBoard(hiring.id);
  assert.equal(boardAccess(store, users.sam, fresh), "editor");
  assert.equal(
    boardAccess(store, users.chris, fresh),
    null,
    "guest ignored on a private board",
  );
  assert.equal(latest(store, users.sam.id).kind, "share");
  assert.equal(latest(store, users.priya.id).kind, "share");
  assert.equal(
    store.countUnreadNotifications(users.chris.id),
    0,
    "no access, no notification",
  );
  assert.deepEqual(lastActivity(store, hiring.id)[3], "Crew (editor)");
  store.addTeamMembers(crew.id, [users.jordan.id]);
  assert.equal(
    boardAccess(store, users.jordan, fresh),
    "viewer",
    "future member, capped",
  );
});

test("unshare removes grants but never the last owner", async () => {
  const { store, users, board, events } = await seeded();
  const hiring = board("Hiring plan");
  const removed = store.unshare({
    resourceKind: "board",
    resourceId: hiring.id,
    subjectKind: "user",
    subjectId: users.noa.id,
    actorId: users.alex.id,
  });
  assert.deepEqual(removed.members, [
    { kind: "user", id: users.alex.id, role: "owner" },
  ]);
  assert.equal(boardAccess(store, users.noa, removed), null);
  assert.deepEqual(lastActivity(store, hiring.id), [
    "member_removed",
    users.alex.id,
    "Noa Cohen (editor)",
    null,
  ]);
  assert.equal(
    events.filter((e) => e.type === "notification_created").length,
    0,
  );
  const last = store.unshare({
    resourceKind: "board",
    resourceId: hiring.id,
    subjectKind: "user",
    subjectId: users.alex.id,
    actorId: users.alex.id,
  });
  assert.equal(last.reason, "last_owner");
  const count = events.length;
  const absent = store.unshare({
    resourceKind: "board",
    resourceId: hiring.id,
    subjectKind: "user",
    subjectId: users.sam.id,
  });
  assert.equal(absent, store.getBoard(hiring.id));
  assert.equal(events.length, count);
  const demote = store.share({
    resourceKind: "board",
    resourceId: hiring.id,
    subjectKind: "user",
    subjectIds: [users.alex.id],
    role: "editor",
  });
  assert.equal(demote.reason, "last_owner");
});

test("workspace, doc and note shares", async () => {
  const { store, users, workspace, board, doc, note } = await seeded();
  const leadership = workspace("Leadership");
  const shareWith = (resourceKind, resourceId, subjectIds, options) =>
    store.share({
      resourceKind,
      resourceId,
      subjectKind: "user",
      subjectIds,
      actorId: users.alex.id,
      ...options,
    });
  assert.equal(
    shareWith("workspace", leadership.id, [users.sam.id], { role: "viewer" })
      .reason,
    "invalid_role",
  );
  shareWith("workspace", leadership.id, [users.sam.id], { role: "editor" });
  const ws = store.getWorkspace(leadership.id);
  assert.equal(workspaceAccess(store, users.sam, ws), "editor");
  assert.equal(
    boardAccess(store, users.sam, board("Budget 2027")),
    "editor",
    "public boards follow",
  );
  assert.equal(
    boardAccess(store, users.sam, board("Hiring plan")),
    null,
    "private boards do not",
  );
  assert.equal(
    plainText(store, latest(store, users.sam.id).text),
    "Alex Rivera shared the workspace “Leadership” with you (editor)",
  );
  assert.equal(
    latest(store, users.sam.id).url,
    `#/workspaces/${leadership.id}`,
  );
  const brief = doc("Launch brief");
  shareWith("doc", brief.id, [users.chris.id], {
    role: "editor",
    actorId: users.priya.id,
  });
  assert.equal(docAccess(store, users.chris, store.getDoc(brief.id)), "editor");
  assert.equal(latest(store, users.chris.id).url, `#/docs/${brief.id}`);
  const crit = note("Design crit notes");
  assert.equal(
    shareWith("note", crit.id, [users.sam.id], {
      role: "viewer",
      actorId: users.sam.id,
    }).reason,
    "note_owner",
  );
  shareWith("note", crit.id, [users.chris.id, users.jordan.id], {
    role: "editor",
    actorId: users.sam.id,
  });
  const sharedNote = store.getNote(crit.id);
  assert.equal(noteAccess(store, users.chris, sharedNote), "editor");
  assert.equal(
    noteAccess(store, users.jordan, sharedNote),
    "viewer",
    "viewer accounts are capped",
  );
  assert.equal(
    noteAccess(store, users.alex, sharedNote),
    null,
    "admins see no notes",
  );
  assert.equal(latest(store, users.jordan.id).url, `#/notes/${crit.id}`);
  assert.equal(
    sharedNote.version,
    crit.version,
    "sharing is not a content write",
  );
});

test("workspaces: create, update, delete only when empty", async () => {
  const { store, users, workspace, events } = await seeded();
  const made = store.createWorkspace({
    name: "  Ops  ",
    kind: "closed",
    creatorId: users.sam.id,
  });
  assert.deepEqual(
    [made.name, made.kind, made.description, made.created_by, made.members],
    [
      "Ops",
      "closed",
      null,
      users.sam.id,
      [{ kind: "user", id: users.sam.id, role: "owner" }],
    ],
  );
  assert.match(made.color, /^#[0-9a-f]{6}$/);
  assert.deepEqual(events[0], {
    type: "workspace_created",
    resource_kind: "workspace",
    resource_id: made.id,
  });
  assert.equal(workspaceAccess(store, users.noa, made), null, "closed");
  assert.equal(
    workspaceAccess(store, users.alex, made),
    "owner",
    "admin management",
  );
  const updated = store.updateWorkspace(made.id, {
    kind: "open",
    color: "#ABCDEF",
    description: "Runbooks",
  });
  assert.deepEqual(
    [updated.kind, updated.color, updated.description],
    ["open", "#abcdef", "Runbooks"],
  );
  assert.equal(workspaceAccess(store, users.noa, updated), "editor");
  assert.equal(
    store.updateWorkspace(made.id, { name: "x".repeat(256) }).reason,
    "invalid",
  );
  assert.equal(
    store.updateWorkspace(made.id, { color: "red" }).reason,
    "invalid",
  );
  assert.equal(
    store.createWorkspace({ name: "", creatorId: "1" }).reason,
    "invalid",
  );
  assert.equal(
    store.createWorkspace({ name: "Ghost", creatorId: "999" }),
    null,
  );
  assert.equal(
    store.deleteWorkspace(workspace("Main workspace").id).reason,
    "not_empty",
  );
  const doc = store.createDoc({
    title: "Notes",
    workspaceId: made.id,
    creatorId: users.sam.id,
  });
  assert.equal(store.deleteWorkspace(made.id).reason, "not_empty");
  store.deleteDoc(doc.id);
  assert.equal(store.deleteWorkspace(made.id).id, made.id);
  assert.equal(store.getWorkspace(made.id), null);
  assert.equal(store.deleteWorkspace(made.id), null);
});

test("deleting a team removes its grants everywhere", async () => {
  const { store, users, team, doc, note } = await seeded();
  const marketing = team("Marketing");
  assert.equal(docAccess(store, users.sam, doc("Launch brief")), "editor");
  assert.equal(
    noteAccess(store, users.sam, note("Launch checklist")),
    "editor",
  );
  store.deleteTeam(marketing.id);
  assert.equal(store.getTeam(marketing.id), null);
  assert.equal(docAccess(store, users.sam, doc("Launch brief")), null);
  assert.equal(noteAccess(store, users.sam, note("Launch checklist")), null);
  assert.ok(doc("Launch brief").members.every((g) => g.kind !== "team"));
  assert.deepEqual(note("Launch checklist").shares, []);
  assert.equal(store.deleteTeam(marketing.id), null);
});
