/**
 * The Updates pane's optimistic actions (`web/ui/board/updates-actions.js`)
 * over a fake mutation runner: each change shows at once on the open
 * task's updates, a refused call puts the list back, and every call asks
 * for a refresh that redraws the board only when it changed. Loading
 * older updates and whole threads is in web-updates-paging.test.js.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { updateActions } from "../web/ui/board/updates-actions.js";

const ME = { id: "1", name: "Alex Rivera" };
const update = (id, extra = {}) => ({
  id,
  body: `Body ${id}`,
  parts: [],
  pinned: false,
  likesCount: 0,
  likedByMe: false,
  likers: [],
  replies: [],
  ...extra,
});

/**
 * A kit whose `run` applies the optimistic change, records what the list
 * looked like meanwhile, then succeeds or (with `refuse`) rolls back.
 */
function fakeKit({ refuse = false } = {}) {
  const list = [update("9", { pinned: true }), update("8")];
  const state = { me: ME, card: { updates: { list, limit: 25 } } };
  const calls = [];
  const kit = {
    state,
    render: (parts) => calls.push(["render", parts]),
    refresh: (options) => calls.push(["refresh", options]),
    async run(name, variables, options) {
      options.optimistic();
      const during = state.card.updates.list.map((entry) => entry.id);
      calls.push([name, variables, options.regions, options.refresh, during]);
      if (!refuse) return { id: "99" };
      await options.rollback(0);
      return null;
    },
  };
  return { kit, state, calls, actions: updateActions(kit) };
}

const ids = (state) => state.card.updates.list.map((entry) => entry.id);
const draft = {
  body: "@[Sam](user:2) hi",
  parts: [{ type: "text", text: "hi" }],
};

test("a post shows at once after the pinned ones, a reply in its thread", async () => {
  const { actions, state, calls } = fakeKit();
  assert.equal(await actions.postUpdate({ id: "5" }, draft), true);
  const [name, variables, regions, refresh, during] = calls.at(-1);
  assert.deepEqual(variables, {
    itemId: "5",
    body: draft.body,
    parentId: null,
  });
  assert.equal(name, "createUpdate");
  assert.deepEqual(regions, ["card"]);
  assert.deepEqual(refresh, { ifChanged: true });
  assert.equal(during[0], "9");
  assert.match(during[1], /^pending-/);
  assert.equal(state.card.updates.list[1].creator, ME);
  await actions.replyToUpdate({ id: "5" }, update("8"), draft);
  assert.deepEqual(calls.at(-1)[1], {
    itemId: "5",
    body: draft.body,
    parentId: "8",
  });
  const thread = state.card.updates.list.find((entry) => entry.id === "8");
  assert.match(thread.replies[0].id, /^pending-/);
});

test("a refused call puts the list back", async () => {
  const { actions, state, calls } = fakeKit({ refuse: true });
  const before = ids(state);
  assert.equal(await actions.postUpdate({ id: "5" }, draft), false);
  assert.equal(calls.at(-2)[4].length, 3, "shown meanwhile");
  assert.deepEqual(ids(state), before);
  assert.deepEqual(calls.at(-1), ["render", ["card"]]);
  assert.equal(await actions.likeUpdate(state.card.updates.list[1]), false);
  assert.equal(state.card.updates.list[1].likesCount, 0);
  assert.equal(
    await actions.pinUpdate({ id: "5" }, state.card.updates.list[1]),
    false,
  );
  assert.deepEqual(ids(state), before);
});

test("likes toggle, pins move, edits keep the server's later order", async () => {
  const { actions, state, calls } = fakeKit();
  await actions.likeUpdate(state.card.updates.list[1]);
  assert.deepEqual(calls.at(-1).slice(0, 2), ["likeUpdate", { id: "8" }]);
  const liked = state.card.updates.list[1];
  assert.deepEqual([liked.likedByMe, liked.likesCount], [true, 1]);
  await actions.likeUpdate(liked);
  assert.equal(calls.at(-1)[0], "unlikeUpdate");
  await actions.pinUpdate({ id: "5" }, state.card.updates.list[1]);
  assert.deepEqual(calls.at(-1).slice(0, 2), [
    "pinUpdate",
    { id: "8", itemId: "5" },
  ]);
  assert.deepEqual(ids(state), ["8", "9"]);
  await actions.pinUpdate({ id: "5" }, state.card.updates.list[0]);
  assert.equal(calls.at(-1)[0], "unpinUpdate");
  // An edit that changes nothing sends nothing.
  const count = calls.length;
  assert.equal(
    await actions.editUpdate(update("9"), { body: "Body 9", parts: [] }),
    true,
  );
  assert.equal(calls.length, count);
  await actions.editUpdate(update("9"), draft);
  const edited = state.card.updates.list.find((entry) => entry.id === "9");
  assert.deepEqual([edited.body, edited.parts], [draft.body, draft.parts]);
  assert.ok(edited.editedAt);
  // Without a cursor there is nothing older to load.
  await actions.showOlderUpdates();
  assert.equal(calls.at(-1)[0], "editUpdate");
});

test("a thread already loaded shows whole at once, kept whole by refreshes", async () => {
  const { actions, state, calls } = fakeKit();
  const thread = { ...state.card.updates.list[1], replies: [update("12")] };
  thread.repliesCount = 1;
  await actions.showMoreReplies(thread);
  assert.deepEqual([...state.card.updates.threads], ["8"]);
  assert.deepEqual(calls.at(-1), ["render", ["card"]]);
  await actions.showMoreReplies({ ...thread, id: "pending-1" });
  assert.deepEqual([...state.card.updates.threads], ["8"], "not a pending one");
});
