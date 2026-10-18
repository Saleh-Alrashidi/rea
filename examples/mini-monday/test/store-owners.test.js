/**
 * Last-owner protection counts owners who really own (SPEC-2 §1.2 "a
 * resource always keeps at least one owner"): an owner grant held by a
 * deactivated user, a viewer account (capped at viewer) or a guest on a
 * resource that does not admit guests gives no owner access, so it cannot
 * stand in for the last real owner. Teams likewise keep an active owner.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { boardAccess, docAccess } from "../server/access.js";
import { createStore } from "../server/store.js";

async function seeded() {
  const store = await createStore();
  const users = Object.fromEntries(
    store.listUsers().map((u) => [u.name.split(" ")[0].toLowerCase(), u]),
  );
  const grant = (resourceKind, resource, userId, role) =>
    store.share({
      resourceKind,
      resourceId: resource.id,
      subjectKind: "user",
      subjectIds: [userId],
      role,
      actorId: resource.creator_id ?? resource.created_by,
    });
  const leave = (resourceKind, resource, userId) =>
    store.unshare({
      resourceKind,
      resourceId: resource.id,
      subjectKind: "user",
      subjectId: userId,
      actorId: userId,
    });
  return { store, users, grant, leave };
}

const privateBoard = (store, creator) =>
  store.createBoard({
    name: "Owners",
    creatorId: creator.id,
    boardKind: "private",
  });

test("an owner grant of a viewer account does not keep a board owned", async () => {
  const { store, users, grant, leave } = await seeded();
  const board = privateBoard(store, users.noa);
  grant("board", board, users.jordan.id, "owner");
  assert.equal(
    boardAccess(store, users.jordan, store.getBoard(board.id)),
    "viewer",
  );
  assert.equal(leave("board", board, users.noa.id).reason, "last_owner");
  const demote = grant(
    "board",
    store.getBoard(board.id),
    users.noa.id,
    "editor",
  );
  assert.equal(demote.reason, "last_owner");
  grant("board", store.getBoard(board.id), users.sam.id, "owner");
  const left = leave("board", store.getBoard(board.id), users.noa.id);
  assert.equal(boardAccess(store, users.sam, left), "owner");
});

test("a deactivated owner does not keep a doc owned", async () => {
  const { store, users, grant, leave } = await seeded();
  const doc = store.createDoc({
    title: "Plans",
    creatorId: users.noa.id,
    visibility: "private",
  });
  grant("doc", doc, users.priya.id, "owner");
  store.deactivateUser(users.priya.id);
  const refused = leave("doc", store.getDoc(doc.id), users.noa.id);
  assert.equal(refused.reason, "last_owner");
  assert.equal(docAccess(store, users.noa, store.getDoc(doc.id)), "owner");
  // Removing the deactivated owner's own grant is always allowed.
  const cleaned = leave("doc", store.getDoc(doc.id), users.priya.id);
  assert.deepEqual(cleaned.members, [
    { kind: "user", id: users.noa.id, role: "owner" },
  ]);
});

test("a guest's owner grant on a private board does not keep it owned", async () => {
  const { store, users, grant, leave } = await seeded();
  const board = privateBoard(store, users.noa);
  grant("board", board, users.priya.id, "owner");
  store.updateUser(users.priya.id, { role: "guest" });
  const priya = store.getUser(users.priya.id);
  assert.equal(boardAccess(store, priya, store.getBoard(board.id)), null);
  assert.equal(
    leave("board", store.getBoard(board.id), users.noa.id).reason,
    "last_owner",
  );
});

test("teams keep an active owner", async () => {
  const { store, users } = await seeded();
  const team = store.createTeam({
    name: "Owners",
    creatorId: users.sam.id,
    memberIds: [users.noa.id],
  });
  store.addTeamMembers(team.id, [users.noa.id], { asOwner: true });
  store.deactivateUser(users.noa.id);
  const refused = store.removeTeamMembers(team.id, [users.sam.id]);
  assert.equal(refused.reason, "last_owner");
  assert.ok(
    store.getTeam(team.id).members.some((m) => m.user_id === users.sam.id),
  );
  const cleaned = store.removeTeamMembers(team.id, [users.noa.id]);
  assert.deepEqual(cleaned.members, [{ user_id: users.sam.id, role: "owner" }]);
});
