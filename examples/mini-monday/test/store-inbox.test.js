import assert from "node:assert/strict";
import test from "node:test";
import { notificationVisible } from "../server/access.js";
import { createStore } from "../server/store.js";
import { MAX_ACTIVITY, MAX_NOTIFICATIONS } from "../server/store/activity.js";
import { plainText } from "./helpers.js";

// Notifications and activity (SPEC-2 §2): who is told what, never the
// actor, never someone without access, one event per recipient, read
// marking, visibility after access changes and bounded retention.

async function seeded() {
  const store = await createStore();
  const users = Object.fromEntries(
    store.listUsers().map((u) => [u.name.split(" ")[0].toLowerCase(), u]),
  );
  const [roadmap, marketing, hiring] = store.listBoards();
  const events = [];
  store.on((event) => events.push(event));
  return { store, users, roadmap, marketing, hiring, events };
}
const unreadOf = (store, users) =>
  Object.fromEntries(
    Object.entries(users).map(([key, u]) => [
      key,
      store.countUnreadNotifications(u.id),
    ]),
  );
const diff = (before, after) =>
  Object.keys(after).filter((key) => after[key] !== before[key]);

test("assignments notify newly added people who can see the board", async () => {
  const { store, users, roadmap, events } = await seeded();
  const item = store.listItems({ boardId: roadmap.id, groupId: "next_up" })
    .items[2];
  assert.equal(item.name, "API rate limits");
  const before = unreadOf(store, users);
  // People who cannot open the board (a guest on a Main board, a
  // deactivated user) cannot be assigned at all (SPEC-2 §6).
  for (const outsider of [users.chris, users.morgan]) {
    const refused = store.setColumnValue(
      item.id,
      "person",
      [users.noa.id, outsider.id],
      { actorId: users.sam.id },
    );
    assert.deepEqual(refused, {
      ok: false,
      reason: "invalid",
      message: `${outsider.name} cannot access this board`,
    });
  }
  assert.deepEqual(events, [], "a refused write changes nothing");
  assert.equal(store.getItem(item.id).values.person, undefined);
  const people = [users.sam.id, users.noa.id];
  store.setColumnValue(item.id, "person", people, { actorId: users.sam.id });
  const after = unreadOf(store, users);
  assert.deepEqual(diff(before, after), ["noa"], "not the actor");
  const [note] = store.listNotifications(users.noa.id);
  assert.deepEqual(
    [note.kind, plainText(store, note.text), note.url, note.actor_id],
    [
      "assign",
      "Sam Lee assigned you to “API rate limits”",
      `#/boards/${roadmap.id}/items/${item.id}`,
      users.sam.id,
    ],
  );
  assert.deepEqual(
    events.map((e) => e.type),
    ["column_value_changed", "notification_created"],
  );
  assert.deepEqual(
    events[1].user_ids,
    [users.noa.id],
    "each event names one recipient",
  );
  const again = unreadOf(store, users);
  store.setColumnValue(item.id, "person", [users.noa.id, users.alex.id], {
    actorId: users.sam.id,
  });
  assert.deepEqual(
    diff(again, unreadOf(store, users)),
    ["alex"],
    "only people newly added",
  );
  const quiet = unreadOf(store, users);
  store.setColumnValue(item.id, "person", null, { actorId: users.sam.id });
  assert.deepEqual(
    diff(quiet, unreadOf(store, users)),
    [],
    "removals notify nobody",
  );
  const anonymous = store.createItem({
    boardId: roadmap.id,
    name: "Seeded",
    values: { person: [users.sam.id] },
  });
  assert.equal(
    plainText(store, store.listNotifications(users.sam.id)[0].text),
    "Someone assigned you to “Seeded”",
  );
  assert.equal(store.listNotifications(users.sam.id)[0].actor_id, null);
  assert.ok(anonymous);
});

test("updates notify the item's assignees except the author", async () => {
  const { store, users, roadmap, hiring, events } = await seeded();
  const kanban = store.listItems({ boardId: roadmap.id, groupId: "next_up" })
    .items[0];
  assert.deepEqual(kanban.values.person, [users.alex.id, users.sam.id]);
  const before = unreadOf(store, users);
  store.createUpdate({
    itemId: kanban.id,
    body: "Spec is ready",
    creatorId: users.noa.id,
  });
  assert.deepEqual(diff(before, unreadOf(store, users)), ["alex", "sam"]);
  assert.deepEqual(
    events
      .filter((e) => e.type === "notification_created")
      .map((e) => e.user_ids),
    [[users.alex.id], [users.sam.id]],
  );
  const [note] = store.listNotifications(users.sam.id);
  assert.deepEqual(
    [note.kind, plainText(store, note.text)],
    ["update", "Noa Cohen posted an update on “Kanban drag and drop”"],
  );
  const mid = unreadOf(store, users);
  store.createUpdate({
    itemId: kanban.id,
    body: "Thanks",
    creatorId: users.sam.id,
  });
  assert.deepEqual(diff(mid, unreadOf(store, users)), ["alex"]);
  // Assignees who lost access to the board stay assigned (values are
  // never rewritten) but hear nothing about it.
  const role = store.listItems({ boardId: hiring.id }).items[0];
  const grant = { resourceKind: "board", resourceId: hiring.id };
  const subject = { ...grant, subjectKind: "user" };
  store.share({ ...subject, subjectIds: [users.sam.id], role: "editor" });
  store.setColumnValue(role.id, "person", [users.noa.id, users.sam.id], {
    actorId: users.alex.id,
  });
  store.unshare({ ...subject, subjectId: users.sam.id });
  assert.deepEqual(store.getItem(role.id).values.person, [
    users.noa.id,
    users.sam.id,
  ]);
  const late = unreadOf(store, users);
  store.createUpdate({
    itemId: role.id,
    body: "Interviews next week",
    creatorId: users.alex.id,
  });
  assert.deepEqual(diff(late, unreadOf(store, users)), ["noa"]);
});

test("notifications stay visible only while their resource is accessible", async () => {
  const { store, users, hiring } = await seeded();
  store.share({
    resourceKind: "board",
    resourceId: hiring.id,
    subjectKind: "user",
    subjectIds: [users.sam.id],
    role: "viewer",
    actorId: users.alex.id,
  });
  const [note] = store.listNotifications(users.sam.id);
  const sam = () => store.getUser(users.sam.id);
  assert.equal(notificationVisible(store, sam(), note), true);
  assert.equal(
    notificationVisible(store, users.noa, note),
    false,
    "someone else's",
  );
  store.unshare({
    resourceKind: "board",
    resourceId: hiring.id,
    subjectKind: "user",
    subjectId: users.sam.id,
    actorId: users.alex.id,
  });
  assert.equal(
    notificationVisible(store, sam(), note),
    false,
    "access revoked",
  );
  const role = { ...note, resource_kind: null, resource_id: null };
  assert.equal(notificationVisible(store, sam(), role), true);
  store.deactivateUser(users.sam.id);
  assert.equal(notificationVisible(store, sam(), role), false);
  const deleted = { ...note, user_id: users.alex.id };
  store.deleteBoard(hiring.id);
  assert.equal(
    notificationVisible(store, users.alex, deleted),
    false,
    "deleted resource",
  );
  assert.equal(
    notificationVisible(store, users.alex, {
      ...deleted,
      resource_kind: "planet",
    }),
    false,
  );
});

test("markNotificationsRead marks only the user's own notifications", async () => {
  const { store, users, events } = await seeded();
  const [newest, older] = store.listNotifications(users.alex.id);
  const samIds = store.listNotifications(users.sam.id).map((n) => n.id);
  assert.equal(
    store.markNotificationsRead(users.alex.id, { ids: [newest.id, ...samIds] }),
    1,
  );
  assert.deepEqual(events, [
    { type: "notifications_read", user_ids: [users.alex.id] },
  ]);
  assert.equal(store.getNotification(newest.id).read, true);
  assert.equal(
    store.countUnreadNotifications(users.sam.id),
    samIds.length,
    "others untouched",
  );
  assert.deepEqual(
    store
      .listNotifications(users.alex.id, { unreadOnly: true })
      .map((n) => n.id),
    [older.id],
  );
  assert.equal(
    store.markNotificationsRead(users.alex.id, { ids: [newest.id] }),
    0,
    "already read",
  );
  assert.equal(events.length, 1, "no change, no event");
  assert.equal(store.markNotificationsRead(users.alex.id, { all: true }), 1);
  assert.equal(store.countUnreadNotifications(users.alex.id), 0);
  assert.equal(store.listNotifications(users.alex.id, { limit: 1 }).length, 1);
  assert.throws(
    () => store.listNotifications(users.alex.id, { limit: -1 }),
    TypeError,
  );
  assert.throws(
    () => store.markNotificationsRead(users.alex.id, { ids: "1" }),
    TypeError,
  );
});

test("activity and notifications keep bounded history, newest first", async () => {
  const { store, users, roadmap } = await seeded();
  const item = store.listItems({ boardId: roadmap.id }).items[0];
  for (let n = 0; n < MAX_NOTIFICATIONS + 5; n += 1) {
    store.createUpdate({
      itemId: item.id,
      body: `Ping ${n}`,
      creatorId: users.sam.id,
    });
  }
  const inbox = store.listNotifications(users.alex.id, { limit: 1000 });
  assert.equal(inbox.length, MAX_NOTIFICATIONS);
  assert.equal(inbox[0].kind, "update");
  assert.equal(inbox.at(-1).kind, "update", "the oldest were dropped first");
  assert.equal(
    store.countUnreadNotifications(users.sam.id),
    2,
    "other inboxes untouched",
  );
  for (let n = 0; n < MAX_ACTIVITY + 5; n += 1) {
    store.renameItem(item.id, `Name ${n}`, { actorId: users.sam.id });
  }
  const log = store.listActivity(roadmap.id, { limit: 5000 });
  assert.equal(log.length, MAX_ACTIVITY);
  assert.equal(log[0].to_text, `Name ${MAX_ACTIVITY + 4}`);
  assert.equal(
    store.listActivity(store.listBoards()[1].id).length,
    1,
    "per board",
  );
});
