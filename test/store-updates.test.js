/**
 * The store's update model (SPEC-6 §2.1, `server/store/updates.js`):
 * replies one level deep, edits, pins, likes, the events of each change,
 * cascades through the single removal owner, and mention validation as
 * the author sees things (§2.2). Notifications are in
 * store-updates-notify.test.js, the data file in store-updates-file.test.js.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { visibleUserIds } from "../server/access.js";
import { parseBody } from "../server/mentions.js";
import { createStore } from "../server/store.js";
import { seedIds } from "./helpers.js";

async function seeded() {
  const store = await createStore({ file: null });
  const ids = seedIds(store);
  const events = [];
  store.on((event) => events.push(event));
  const items = (board) =>
    store.listItems({ boardId: ids.boards[board], limit: 100 }).items;
  const post = (fields) => store.createUpdate(fields);
  return { store, ids, events, items, post };
}
const boardEvents = (events) =>
  events.filter((event) => event.type !== "notification_created");

test("updates are listed newest first", async () => {
  const { store, ids, events, items } = await seeded();
  const [item] = items("roadmap");
  assert.deepEqual(
    store.listUpdates(item.id).map((u) => u.creator_id),
    [ids.users.alex, ids.users.sam],
  );
  events.length = 0;
  const update = store.createUpdate({
    itemId: item.id,
    body: "  Shipped!  ",
    creatorId: ids.users.noa,
  });
  assert.deepEqual(Object.keys(update), [
    "id",
    "item_id",
    "body",
    "creator_id",
    "created_at",
  ]);
  assert.equal(update.body, "Shipped!", "trimmed");
  assert.deepEqual(store.listUpdates(item.id, { limit: 1 }), [update]);
  assert.deepEqual(boardEvents(events), [
    {
      type: "update_created",
      board_id: ids.boards.roadmap,
      item_id: item.id,
      update_id: update.id,
    },
  ]);
  // SPEC-2: Alex is assigned to the item and hears about the update.
  assert.deepEqual(events[1].user_ids, [ids.users.alex]);
  assert.equal(store.createUpdate({ itemId: "999", body: "x" }), null);
  assert.equal(
    store.createUpdate({ itemId: item.id, body: "x", creatorId: "99" }),
    null,
  );
  for (const body of ["  ", "x".repeat(10_001)]) {
    const refused = store.createUpdate({ itemId: item.id, body });
    assert.equal(refused.reason, "invalid");
    assert.match(refused.message, /1-10000 characters/);
  }
  assert.throws(() => store.createUpdate({ itemId: item.id, body: 1 }));
  assert.equal(events.length, 2, "refusals emit nothing");
});

test("replies are one level deep, oldest first, and counted with their item", async () => {
  const { store, ids, items, post } = await seeded();
  const [item, other] = items("roadmap");
  const top = post({ itemId: item.id, body: "Top", creatorId: ids.users.sam });
  const reply = (body, parentId = top.id, itemId = item.id) =>
    post({ itemId, body, creatorId: ids.users.noa, parentId });
  const first = reply("First");
  const second = reply("Second");
  assert.deepEqual(Object.keys(first), [
    "id",
    "item_id",
    "parent_update_id",
    "body",
    "creator_id",
    "created_at",
  ]);
  assert.equal(first.parent_update_id, top.id);
  assert.deepEqual(store.listReplies(top.id), [first, second]);
  assert.ok(
    store.listUpdates(item.id).every((u) => u.parent_update_id === undefined),
    "the item lists top-level updates only",
  );
  assert.equal(store.countUpdatesByItem().get(item.id), 5, "2 seeded + 3");
  const index = store.indexUpdates();
  assert.deepEqual(index.updates.get(item.id), store.listUpdates(item.id));
  assert.deepEqual(index.replies.get(top.id), [first, second]);
  // Replies to replies, and parents of another item, are refused.
  const nested = reply("Nested", first.id);
  assert.deepEqual([nested.ok, nested.reason], [false, "invalid_parent"]);
  for (const result of [
    reply("Elsewhere", top.id, other.id),
    reply("?", "999"),
  ]) {
    assert.equal(result.reason, "not_found");
    assert.match(result.message, /^Update ".+" was not found$/);
  }
  assert.deepEqual(store.listReplies(top.id), [first, second]);
});

test("edits, pins and likes change one update and emit one event each", async () => {
  const { store, ids, events, items, post } = await seeded();
  const [item] = items("roadmap");
  const sam = ids.users.sam;
  const old = post({ itemId: item.id, body: "Old", creatorId: sam });
  const top = post({ itemId: item.id, body: "Draft", creatorId: sam });
  const reply = post({
    itemId: item.id,
    body: "Re",
    creatorId: ids.users.noa,
    parentId: top.id,
  });
  events.length = 0;
  const edited = store.editUpdate(top.id, " Final ", { actorId: sam });
  assert.equal(edited.body, "Final");
  assert.match(edited.edited_at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(store.editUpdate(top.id, "Final", { actorId: sam }), edited);
  assert.equal(store.editUpdate("999", "x", { actorId: sam }), null);
  assert.equal(store.editUpdate(top.id, " ").reason, "invalid");
  // Pinned first, then newest first; replies can't be pinned.
  const pinned = store.pinUpdate(old.id);
  assert.equal(typeof pinned.pinned_at, "string");
  assert.equal(store.pinUpdate(old.id), pinned, "pinning twice: no change");
  assert.deepEqual(
    store
      .listUpdates(item.id)
      .map((u) => u.id)
      .slice(0, 2),
    [old.id, top.id],
  );
  assert.equal(store.pinUpdate(reply.id).reason, "invalid_update");
  const unpinned = store.unpinUpdate(old.id);
  assert.equal("pinned_at" in unpinned, false, "absent, never null");
  assert.equal(store.unpinUpdate(old.id), unpinned);
  // One like per user and update.
  assert.equal(store.likeUpdate(top.id, ids.users.noa), edited);
  store.likeUpdate(top.id, ids.users.noa);
  store.likeUpdate(top.id, ids.users.alex);
  assert.deepEqual(
    store.listLikes(top.id).map((like) => like.user_id),
    [ids.users.noa, ids.users.alex],
  );
  store.unlikeUpdate(top.id, ids.users.noa);
  store.unlikeUpdate(top.id, ids.users.noa);
  assert.deepEqual(
    store
      .indexLikes()
      .get(top.id)
      .map((like) => like.user_id),
    [ids.users.alex],
  );
  assert.equal(store.likeUpdate(top.id, "999"), null);
  assert.equal(store.likeUpdate("999", ids.users.noa), null);
  const event = (type, extra = {}) => ({
    type,
    board_id: ids.boards.roadmap,
    item_id: item.id,
    update_id: extra.id ?? top.id,
    ...extra.fields,
  });
  assert.deepEqual(boardEvents(events), [
    event("update_edited"),
    event("update_edited", { id: old.id, fields: { pinned: true } }),
    event("update_edited", { id: old.id, fields: { pinned: false } }),
    event("update_liked", { fields: { liked: true } }),
    event("update_liked", { fields: { liked: true } }),
    event("update_liked", { fields: { liked: false } }),
  ]);
});

test("deleting an update, item, group or board removes its replies and likes", async () => {
  const { store, ids, events, items, post } = await seeded();
  const thread = (item) => {
    const top = post({
      itemId: item.id,
      body: "Top",
      creatorId: ids.users.sam,
    });
    const reply = post({
      itemId: item.id,
      body: "Re",
      creatorId: ids.users.noa,
      parentId: top.id,
    });
    store.likeUpdate(top.id, ids.users.noa);
    store.likeUpdate(reply.id, ids.users.sam);
    return [top.id, reply.id];
  };
  const gone = (updateIds) =>
    updateIds.every(
      (id) => store.getUpdate(id) === null && store.listLikes(id).length === 0,
    );
  const [first, second] = items("roadmap");
  const third = items("roadmap").find((item) => item.group_id === "done");
  const direct = thread(first);
  events.length = 0;
  const deleted = store.deleteUpdate(direct[0]);
  assert.equal(deleted.id, direct[0]);
  assert.ok(gone(direct), "its reply and both likes went with it");
  assert.deepEqual(
    boardEvents(events).map((e) => [e.type, e.update_id]),
    [["update_deleted", direct[0]]],
  );
  assert.equal(store.deleteUpdate(direct[0]), null);
  // Deleting only a reply keeps its parent.
  const [top, reply] = thread(first);
  store.deleteUpdate(reply);
  assert.equal(store.getUpdate(top).id, top);
  const viaItem = thread(second);
  store.deleteItem(second.id);
  assert.ok(gone(viaItem), "item deletion");
  const viaGroup = thread(third);
  store.deleteGroup(ids.boards.roadmap, "done");
  assert.ok(gone(viaGroup), "group deletion");
  const [hiring] = items("hiring");
  const viaBoard = thread(hiring);
  store.deleteBoard(ids.boards.hiring);
  assert.ok(gone(viaBoard), "board deletion");
  assert.equal(store.getUpdate(top).id, top, "other boards keep theirs");
});

test("mentions the author cannot see become text; at most 50 per body", async () => {
  const { store, ids, items, post } = await seeded();
  const { users, teams } = ids;
  const [roadmapItem] = items("roadmap");
  const [launch] = items("marketing");
  const chris = store.getUser(users.chris);
  const directory = visibleUserIds(store, chris);
  assert.equal(directory.has(users.noa), false, "the guest cannot see Noa");
  const body = [
    `@[Noa](user:${users.noa})`,
    `@[Priya](user:${users.priya})`,
    `@[Product](team:${teams.product})`,
    `@[Roadmap task](item:${roadmapItem.id})`,
    `@[Launch](item:${launch.id})`,
    "@[Ghost](user:999)",
  ].join(" ");
  const byGuest = post({ itemId: launch.id, body, creatorId: users.chris });
  const kinds = (update) =>
    parseBody(update.body)
      .map((s) => s.kind ?? s.text.trim())
      .filter((kind) => kind !== "");
  assert.deepEqual(kinds(byGuest), [
    "@Noa",
    "user",
    "@Product @Roadmap task",
    "item",
    "@Ghost",
  ]);
  // A member sees everyone, every team and the boards she can open.
  const byPriya = post({ itemId: launch.id, body, creatorId: users.priya });
  assert.deepEqual(kinds(byPriya), [
    "user",
    "user",
    "team",
    "item",
    "item",
    "@Ghost",
  ]);
  const bySam = post({ itemId: launch.id, body, creatorId: users.sam });
  assert.equal(kinds(bySam)[4], "@Launch @Ghost", "Sam cannot open it");
  const many = Array.from({ length: 51 }, () => "@[S](user:999)").join(" ");
  const refused = post({ itemId: launch.id, body: many, creatorId: users.sam });
  assert.equal(refused.reason, "too_many_mentions");
  // The 10,000-character limit counts the body as it reads: a mention as
  // "@<display>", escapes not at all.
  const token = `@[Sam](user:${users.sam})`;
  const literal = "\\@[x](user:1)";
  const fits = `${token}${literal}${"x".repeat(10_000 - 4 - 12)}`;
  assert.ok(fits.length > 10_000);
  assert.equal(post({ itemId: launch.id, body: fits }).body, fits);
  const over = post({ itemId: launch.id, body: `${fits}x` });
  assert.equal(over.reason, "invalid");
});
