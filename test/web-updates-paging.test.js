/**
 * The Updates pane loads in pages that fit the server's field budget
 * (SPEC-6 §2.3, `updates-data.js` and `updates-actions.js` against the
 * real schema and store): threads show their newest replies until "Show
 * N more replies" loads them whole, however many or heavy they are;
 * "Show older updates" appends one page; a page over the budget is asked
 * for smaller while what is shown stays; and a link to an old update or
 * reply finds it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { updateActions } from "../web/ui/board/updates-actions.js";
import {
  UPDATES_PAGE,
  loadThread,
  loadUpdates,
} from "../web/ui/board/updates-data.js";
import { findUpdate } from "../web/ui/board/updates-model.js";
import { realServer } from "./web-updates-server.js";

const ME = { id: "1", name: "Alex Rivera" };
const ids = (list) => list.map((update) => update.id);
const operations = (server) =>
  server.requests.map((request) => request.operation);

/** The open task's update actions over `server`, with what they drew. */
function pane(itemId, updates) {
  const state = { me: ME, card: { itemId, updates } };
  const calls = [];
  const kit = {
    state,
    render: (parts) => calls.push(["render", parts]),
    refresh: (options) => calls.push(["refresh", options]),
    run: () => assert.fail("no mutation expected"),
  };
  return { state, calls, actions: updateActions(kit) };
}

/** A task with `count` plain top-level updates (newest last). */
function manyUpdates(server, count) {
  const task = server.item("Product roadmap", "API rate limits");
  const posted = Array.from({ length: count }, (_, n) =>
    server.store.createUpdate({
      itemId: task.id,
      body: `Plain ${n}`,
      creatorId: server.users.get("sam"),
    }),
  );
  const all = server.store.listUpdates(task.id, { limit: 500 });
  return { task, posted, all: ids(all) };
}

test("heavy replies: the thread shows its newest three, then loads whole", async (t) => {
  const server = await realServer(t);
  const task = server.item("Product roadmap", "Set up CI pipeline");
  const sam = server.users.get("sam");
  const noa = server.users.get("noa");
  const post = (body, parentId = null) =>
    server.store.createUpdate({
      itemId: task.id,
      body,
      creatorId: sam,
      parentId,
    });
  const top = post("Top");
  // Fifty mentions each: eight of them used to exceed the budget at once.
  const heavy = Array.from({ length: 50 }, () => `@[S](user:${noa}) x`).join(
    " ",
  );
  const replies = Array.from({ length: 8 }, () => post(heavy, top.id));
  const loaded = await loadUpdates(task.id);
  const thread = loaded.list.find((update) => update.id === top.id);
  assert.equal(thread.repliesCount, 8);
  assert.deepEqual(ids(thread.replies), ids(replies.slice(-3)));
  assert.equal(thread.replies[0].parts.length, 100);
  const whole = await loadThread(top.id);
  assert.deepEqual(ids(whole.replies), ids(replies));
  assert.equal(whole.count, 8);
});

test("211 plain replies load whole through Show N more replies, in pages", async (t) => {
  const server = await realServer(t);
  const task = server.item("Product roadmap", "Set up CI pipeline");
  const sam = server.users.get("sam");
  const top = server.store.createUpdate({
    itemId: task.id,
    body: "Top",
    creatorId: sam,
  });
  const replies = Array.from({ length: 211 }, (_, n) =>
    server.store.createUpdate({
      itemId: task.id,
      body: `ok ${n}`,
      creatorId: sam,
      parentId: top.id,
    }),
  );
  const shown = { status: "ready", ...(await loadUpdates(task.id)), limit: 25 };
  const { state, actions } = pane(task.id, shown);
  const before = shown.list.find((update) => update.id === top.id);
  assert.equal(before.replies.length, 3);
  server.requests.length = 0;
  await actions.showMoreReplies(before);
  const after = state.card.updates.list.find((update) => update.id === top.id);
  assert.deepEqual(ids(after.replies), ids(replies), "oldest first, all of it");
  assert.deepEqual(operations(server), [
    "UpdateThread",
    "UpdateThread",
    "UpdateThread",
  ]);
  assert.ok(state.card.updates.threads.has(top.id));
  assert.equal(state.card.updates.loadingThreads.size, 0);
  // A refresh keeps the thread whole.
  const again = await loadUpdates(task.id, { shown: state.card.updates });
  const kept = again.list.find((update) => update.id === top.id);
  assert.equal(kept.replies.length, 211);
});

test("260 updates: Show older appends one page per click; refreshes reload what is shown", async (t) => {
  const server = await realServer(t);
  const { task, all } = manyUpdates(server, 260);
  const shown = {
    status: "ready",
    limit: UPDATES_PAGE,
    ...(await loadUpdates(task.id)),
  };
  assert.deepEqual(ids(shown.list), all.slice(0, 25));
  const { state, actions } = pane(task.id, shown);
  server.requests.length = 0;
  let clicks = 0;
  while (state.card.updates.hasMore) {
    await actions.showOlderUpdates();
    clicks += 1;
    const { list } = state.card.updates;
    assert.equal(list.length, Math.min(all.length, 25 * (clicks + 1)));
  }
  assert.deepEqual(ids(state.card.updates.list), all, "every update, once");
  assert.equal(server.requests.length, clicks, "one request per click");
  assert.equal(state.card.updates.limit, all.length);
  // A refresh reloads as many as are shown, page by page.
  for (const limit of [25, 150, 175, 200, 225, 500]) {
    const reloaded = await loadUpdates(task.id, { shown: { limit } });
    assert.deepEqual(ids(reloaded.list), all.slice(0, limit), String(limit));
  }
});

test("over the field budget a smaller page loads, and what is shown stays", async (t) => {
  const server = await realServer(t);
  const { task, all } = manyUpdates(server, 40);
  server.overBudget = ({ operation, variables }) =>
    operation === "ItemUpdates" && variables.limit > 10;
  const limits = () =>
    server.requests.map((request) => request.variables.limit);
  const first = await loadUpdates(task.id);
  assert.deepEqual(ids(first.list), all.slice(0, 25), "smaller pages make 25");
  // Halved until a page fits, then growing back after each page that fit.
  assert.deepEqual(limits(), [25, 13, 7, 7, 11, 6, 5]);
  assert.equal(first.pageSize, 10);
  const { state, actions } = pane(task.id, {
    status: "ready",
    limit: 25,
    ...first,
  });
  server.requests.length = 0;
  await actions.showOlderUpdates();
  assert.deepEqual(ids(state.card.updates.list), all.slice(0, 35));
  assert.deepEqual(limits(), [10], "the size that fit, at once");
  assert.equal(state.card.updates.pageSize, 20);
  // Nothing fits: the toast says so and the list stays.
  server.overBudget = () => true;
  await actions.showOlderUpdates();
  assert.deepEqual(ids(state.card.updates.list), all.slice(0, 35));
  assert.equal(state.card.updates.loadingOlder.size, 0);
  // Last, a page of one update with its newest reply only.
  server.overBudget = ({ variables }) => variables.replies !== 1;
  const single = await loadUpdates(task.id, { shown: { limit: 1 } });
  assert.deepEqual(ids(single.list), all.slice(0, 1));
});

test("a link to an old update or reply finds it", async (t) => {
  const server = await realServer(t);
  const { task, all, posted } = manyUpdates(server, 120);
  const old = all[80];
  server.requests.length = 0;
  const found = await loadUpdates(task.id, { target: old });
  assert.ok(findUpdate(found.list, old));
  assert.equal(found.limit, found.list.length);
  assert.deepEqual(ids(found.list), all.slice(0, 100), "pages up to it");
  assert.deepEqual(operations(server), [
    "ItemUpdates",
    "UpdateTarget",
    ...Array(3).fill("ItemUpdates"),
  ]);
  // An older reply: its thread shows whole.
  const sam = server.users.get("sam");
  const replies = Array.from({ length: 6 }, (_, n) =>
    server.store.createUpdate({
      itemId: task.id,
      body: `Re ${n}`,
      creatorId: sam,
      parentId: posted[0].id,
    }),
  );
  const shown = {};
  const threaded = await loadUpdates(task.id, { shown, target: replies[0].id });
  const { parent } = findUpdate(threaded.list, replies[0].id);
  assert.equal(parent.id, posted[0].id);
  assert.equal(parent.replies.length, 6);
  assert.ok(shown.threads.has(posted[0].id));
  // A newest reply needs no whole thread; an unknown update no paging.
  const near = await loadUpdates(task.id, { shown: {}, target: replies[5].id });
  assert.ok(findUpdate(near.list, replies[5].id));
  const unknown = await loadUpdates(task.id, { target: "999999" });
  assert.equal(unknown.list.length, 25);
  assert.equal("limit" in unknown, false);
});
