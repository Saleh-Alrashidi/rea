/**
 * The Updates pane's pure rules (`web/ui/board/updates-model.js`): who
 * wrote an update, the reply window, how likes read, and the optimistic
 * changes that place an update where the server will put it (the list
 * keeps the server's order otherwise: nothing sorts it).
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  SHOWN_REPLIES,
  addPost,
  addReply,
  appendPage,
  findUpdate,
  isPending,
  likersText,
  mapUpdate,
  pendingUpdate,
  removeUpdate,
  replyWindow,
  setPinned,
  updateAuthor,
  withLike,
  withThread,
} from "../web/ui/board/updates-model.js";

const update = (id, extra = {}) => ({
  id,
  pinned: false,
  likesCount: 0,
  likedByMe: false,
  likers: [],
  replies: [],
  ...extra,
});
const ids = (list) => list.map((entry) => entry.id);
const ME = { id: "1", name: "Alex Rivera" };

test("authors: the user, else the source author with its tag", () => {
  const alex = { id: "1", name: "Alex" };
  assert.deepEqual(updateAuthor({ creator: alex }, "clickup"), {
    user: alex,
    name: "Alex",
    tag: null,
  });
  const imported = { creator: null, authorName: " Fox Mulder " };
  assert.deepEqual(updateAuthor(imported, "clickup"), {
    user: null,
    name: "Fox Mulder",
    tag: "ClickUp",
  });
  assert.equal(updateAuthor(imported, "monday").tag, "monday.com");
  assert.equal(updateAuthor(imported, "csv").tag, "Imported");
  // The API hides authors outside a guest's directory.
  const hidden = updateAuthor({ creator: null }, "clickup");
  assert.equal(hidden.name, "Someone");
  assert.equal(hidden.tag, null);
});

test("threads show their newest replies until shown whole", () => {
  const replies = ["1", "2", "3", "4", "5"].map((id) => update(id));
  const thread = update("9", { replies, repliesCount: 5 });
  const folded = replyWindow(thread, false);
  assert.equal(SHOWN_REPLIES, 3);
  assert.equal(folded.hidden, 2);
  assert.deepEqual(ids(folded.shown), ["3", "4", "5"]);
  assert.deepEqual(replyWindow(thread, true), { hidden: 0, shown: replies });
  // Only the newest three loaded: the count says how many are hidden,
  // also while the whole thread is still loading.
  const newest = update("9", { replies: replies.slice(2), repliesCount: 211 });
  assert.equal(replyWindow(newest, false).hidden, 208);
  assert.equal(replyWindow(newest, true).hidden, 208);
  const whole = withThread([newest], "9", { replies, count: 5 });
  assert.deepEqual(replyWindow(whole[0], true), { hidden: 0, shown: replies });
  assert.equal(replyWindow(update("9", { replies }), false).hidden, 2);
});

test("an older page appends without the updates already shown", () => {
  const list = [update("9"), update("8")];
  assert.deepEqual(ids(appendPage(list, [update("8"), update("5")])), [
    "9",
    "8",
    "5",
  ]);
});

test("likes read as names, You first, then a count", () => {
  const sam = { id: "2", name: "Sam Lee" };
  const noa = { id: "3", name: "Noa Cohen" };
  const priya = { id: "4", name: "Priya Nair" };
  assert.equal(likersText(update("1"), "1"), null);
  assert.equal(
    likersText(update("1", { likesCount: 1, likers: [sam] }), "1"),
    "Liked by Sam Lee",
  );
  assert.equal(
    likersText(update("1", { likesCount: 2, likers: [ME, sam] }), "1"),
    "Liked by You and Sam Lee",
  );
  assert.equal(
    likersText(
      update("1", { likesCount: 5, likers: [sam, noa, priya, ME] }),
      "1",
    ),
    "Liked by Sam Lee, Noa Cohen, Priya Nair and 2 others",
  );
  // Liked, but not among the loaded likers (an optimistic like).
  assert.equal(
    likersText(
      update("1", { likesCount: 2, likedByMe: true, likers: [sam] }),
      "1",
    ),
    "Liked by You and Sam Lee",
  );
  // Likers the reader may not see are counted only.
  assert.equal(
    likersText(update("1", { likesCount: 3, likers: [] }), "1"),
    "Liked by 3 people",
  );
});

test("optimistic posts go after the pinned ones; replies at the end", () => {
  const list = [update("9", { pinned: true }), update("8"), update("5")];
  const pending = pendingUpdate({ me: ME, body: "Hi", parts: [] });
  assert.ok(isPending(pending.id));
  assert.equal(pending.creator, ME);
  assert.deepEqual(ids(addPost(list, pending)), ["9", pending.id, "8", "5"]);
  assert.deepEqual(ids(addPost([], pending)), [pending.id]);
  const all = [update("9", { pinned: true }), update("7", { pinned: true })];
  assert.deepEqual(ids(addPost(all, pending)), ["9", "7", pending.id]);
  const replied = addReply(list, "8", update("12"));
  assert.deepEqual(ids(findUpdate(replied, "8").update.replies), ["12"]);
  assert.equal(findUpdate(replied, "8").update.repliesCount, 1, "counted");
  assert.equal(findUpdate(replied, "12").parent.id, "8");
  assert.equal(findUpdate(replied, "99"), null);
  // The input list is not changed.
  assert.deepEqual(list[1].replies, []);
});

test("pins move first; unpinning waits for the server's order", () => {
  const list = [update("9", { pinned: true }), update("8"), update("5")];
  const pinned = setPinned(list, "5", true);
  assert.deepEqual(ids(pinned), ["5", "9", "8"]);
  assert.equal(pinned[0].pinned, true);
  const unpinned = setPinned(list, "9", false);
  assert.deepEqual(ids(unpinned), ["9", "8", "5"]);
  assert.equal(unpinned[0].pinned, false);
  assert.equal(setPinned(list, "77", true), list);
});

test("likes, edits and deletions reach replies too", () => {
  const list = [update("8", { replies: [update("12"), update("13")] })];
  const liked = mapUpdate(list, "12", (reply) => withLike(reply, ME, true));
  const reply = findUpdate(liked, "12").update;
  assert.deepEqual(
    [reply.likedByMe, reply.likesCount, reply.likers],
    [true, 1, [{ id: "1", name: "Alex Rivera" }]],
  );
  const back = withLike(reply, ME, false);
  assert.deepEqual(
    [back.likedByMe, back.likesCount, back.likers],
    [false, 0, []],
  );
  assert.equal(withLike(reply, ME, true), reply, "already liked");
  assert.deepEqual(ids(removeUpdate(list, "12")[0].replies), ["13"]);
  const counted = [{ ...list[0], repliesCount: 7 }];
  assert.equal(removeUpdate(counted, "12")[0].repliesCount, 6);
  assert.deepEqual(removeUpdate(list, "8"), []);
  const edited = mapUpdate(list, "8", (entry) => ({ ...entry, body: "x" }));
  assert.equal(edited[0].body, "x");
});
