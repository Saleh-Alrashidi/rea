/**
 * Update actions of the task view (SPEC-6 §2.3): posting, replying,
 * editing, deleting, liking and pinning, each optimistic. The change
 * shows at once on the open task's updates (`state.card.updates.list`,
 * through the pure helpers of `updates-model.js`); a refused call puts
 * the list back as it was (and the error toast says why), and the
 * refresh after every call brings the server's list either way (the
 * board's mutation runner, `actions.js`).
 *
 * Drafts are `{ body, parts }` from a composer (`update-composer.js`):
 * the body with its mention tokens, and the parts it shows until the
 * server's `body_parts` arrive.
 *
 * "Show older updates" appends the next page (`loadOlderUpdates` after
 * the shown list's cursor) and "Show N more replies" loads that thread
 * whole (`loadThread`, and `threads` keeps it whole on refreshes); both
 * keep what is shown when a load fails. A refresh that replaced the
 * list meanwhile is reloaded rather than patched.
 */

import { confirmDialog } from "../components/dialog.js";
import { plural } from "../components/format.js";
import { showError } from "../components/toast.js";
import {
  UPDATES_PAGE,
  loadOlderUpdates,
  loadThread,
  nextPageSize,
  threadsOf,
} from "./updates-data.js";
import {
  addPost,
  addReply,
  appendPage,
  isPending,
  mapUpdate,
  pendingUpdate,
  removeUpdate,
  setPinned,
  withLike,
  withThread,
} from "./updates-model.js";

/**
 * How update actions refresh: the open task always reloads, the board
 * view redraws only when the board changed (a new update's count), so a
 * like never rebuilds a wide board's table.
 */
const CARD_ONLY = Object.freeze({ ifChanged: true });

/**
 * Runs `load(card)` for the open task with `key` in its updates state's
 * Set `flag` (what is loading, which the pane shows) meanwhile. Resolves
 * with `{ now, value }` (`now`: the task's updates state by then; value
 * null when the load failed, with a toast saying `failure`) while that
 * task is still open, else null.
 */
async function loading(kit, { flag, key, failure }, load) {
  const card = kit.state.card;
  const shown = card?.updates;
  if (!shown?.list || shown[flag]?.has(key)) return null;
  shown[flag] = new Set(shown[flag]).add(key);
  kit.render(["card"]);
  let value = null;
  try {
    value = await load(card);
  } catch (error) {
    showError(error, failure);
  }
  if (kit.state.card !== card) return null;
  const now = card.updates;
  now[flag] = new Set(now[flag]);
  now[flag].delete(key);
  return { now, value };
}

/**
 * Appends the next page of the open task's older top-level updates (a
 * smaller one when the field budget asks; what is shown stays when the
 * load fails).
 */
async function showOlder(kit) {
  const cursor = kit.state.card?.updates?.cursor ?? null;
  if (cursor === null) return;
  const flag = { flag: "loadingOlder", key: cursor };
  const failure = "Couldn’t load older updates";
  const size = kit.state.card.updates.pageSize ?? UPDATES_PAGE;
  const done = await loading(kit, { ...flag, failure }, (card) =>
    loadOlderUpdates(card.itemId, { cursor, size }),
  );
  if (!done?.value) {
    if (done) kit.render(["card"]);
    return;
  }
  const { now, value: page } = done;
  if (now.cursor !== cursor) {
    // A refresh replaced the list meanwhile: load as many again.
    now.limit = Math.max(now.limit ?? 0, now.list.length + page.list.length);
    kit.refresh(CARD_ONLY);
    return;
  }
  now.list = appendPage(now.list, page.list);
  now.cursor = page.cursor;
  now.hasMore = page.cursor !== null;
  now.pageSize = nextPageSize(size, size, page.size);
  now.limit = now.list.length;
  kit.render(["card"]);
}

/**
 * Shows the whole thread of top-level `update`: loaded replies at once,
 * the rest after `loadThread` (refreshes keep it whole).
 */
async function showThread(kit, update) {
  const shown = kit.state.card?.updates;
  if (!shown?.list || isPending(update.id)) return;
  threadsOf(shown).add(update.id);
  if (update.replies.length >= update.repliesCount) {
    kit.render(["card"]);
    return;
  }
  const flag = { flag: "loadingThreads", key: update.id };
  const failure = "Couldn’t load the replies";
  const done = await loading(kit, { ...flag, failure }, () =>
    loadThread(update.id),
  );
  if (!done) return;
  if (done.value) {
    done.now.list = withThread(done.now.list, update.id, done.value);
  } else threadsOf(done.now).delete(update.id);
  kit.render(["card"]);
}

/** The actions that load more of the open task's updates. */
function loadActions(kit) {
  return {
    showOlderUpdates: () => showOlder(kit),
    showMoreReplies: (update) => showThread(kit, update),
    /** Loads the open task's updates again (after a failed load). */
    reloadUpdates() {
      const shown = kit.state.card?.updates;
      if (shown) shown.status = "loading";
      kit.render(["card"]);
      kit.refresh(CARD_ONLY);
    },
  };
}

/**
 * The update actions (`createActions` adds them). `kit`: the board's
 * mutation runner (`run`, `render`, `refresh`, `state`).
 */
export function updateActions(kit) {
  const { state } = kit;
  const updates = () => state.card?.updates ?? null;

  /**
   * Runs mutation `name` after `apply(list)` changed the open task's
   * updates; a refusal restores the list. Resolves with whether the
   * server took it.
   */
  async function change(name, variables, apply) {
    const shown = updates();
    const before = shown?.list ?? null;
    const saved = await kit.run(name, variables, {
      regions: ["card"],
      refresh: CARD_ONLY,
      optimistic() {
        if (shown?.list) shown.list = apply(shown.list);
      },
      rollback() {
        if (shown && updates() === shown) shown.list = before;
        kit.render(["card"]);
      },
    });
    return saved !== null;
  }

  return {
    /** Posts `draft` on `item`; resolves with whether it was saved. */
    postUpdate(item, draft) {
      const pending = pendingUpdate({ me: state.me, ...draft });
      const variables = { itemId: item.id, body: draft.body, parentId: null };
      return change("createUpdate", variables, (list) =>
        addPost(list, pending),
      );
    },
    /** Replies to top-level `parent` with `draft`. */
    replyToUpdate(item, parent, draft) {
      if (isPending(parent.id)) return Promise.resolve(false);
      const pending = pendingUpdate({ me: state.me, ...draft });
      const variables = {
        itemId: item.id,
        body: draft.body,
        parentId: parent.id,
      };
      return change("createUpdate", variables, (list) =>
        addReply(list, parent.id, pending),
      );
    },
    /** Saves the author's edit of `update` (`draft`). */
    editUpdate(update, draft) {
      if (draft.body === update.body) return Promise.resolve(true);
      const variables = { id: update.id, body: draft.body };
      const editedAt = new Date().toISOString();
      return change("editUpdate", variables, (list) =>
        mapUpdate(list, update.id, (entry) => ({
          ...entry,
          body: draft.body,
          parts: draft.parts,
          editedAt,
        })),
      );
    },
    /** Deletes `update` (and its replies) after a confirmation. */
    async deleteUpdate(update) {
      const replies = update.repliesCount ?? update.replies?.length ?? 0;
      const confirmed = await confirmDialog({
        title: "Delete this update?",
        message:
          replies > 0
            ? `It will be deleted with its ${plural(replies, "reply", "replies")} and likes for everyone.`
            : "It will be deleted with its likes for everyone.",
        confirmButton: "Delete",
        danger: true,
      });
      if (!confirmed) return false;
      return change("deleteUpdate", { id: update.id }, (list) =>
        removeUpdate(list, update.id),
      );
    },
    /** Likes `update`, or takes the like back. */
    likeUpdate(update) {
      if (isPending(update.id)) return Promise.resolve(false);
      const liked = !update.likedByMe;
      const name = liked ? "likeUpdate" : "unlikeUpdate";
      return change(name, { id: update.id }, (list) =>
        mapUpdate(list, update.id, (entry) => withLike(entry, state.me, liked)),
      );
    },
    /** Pins top-level `update` of `item` to the top, or unpins it. */
    pinUpdate(item, update) {
      const pinned = !update.pinned;
      const name = pinned ? "pinUpdate" : "unpinUpdate";
      return change(name, { id: update.id, itemId: item.id }, (list) =>
        setPinned(list, update.id, pinned),
      );
    },
    ...loadActions(kit),
  };
}
