/**
 * The Updates pane's rules (SPEC-6 §2.3), pure: who wrote an update,
 * which replies show, how likes read, and the optimistic changes the
 * actions make before the server answers.
 *
 * Updates come decoded (`updates-data.js`): `{ id, body, parts, creator,
 * authorName, createdAt, editedAt, pinned, likesCount, likedByMe,
 * likers, canEdit, canDelete, replies, repliesCount }`, where `replies`
 * are the thread's newest ones (or all of it, once shown whole) and
 * `repliesCount` how many it has. Their order is the server's (pinned
 * first, then newest first; replies oldest first): nothing here sorts.
 * An optimistic change places one update where the server will put it
 * (a new post right after the pinned ones, a pinned one first) until
 * the refresh brings the server's list.
 */

import { SOMEONE } from "../components/labels.js";

/** Replies a thread shows before "Show N more replies". */
export const SHOWN_REPLIES = 3;

/**
 * The source tag of an imported update's author (`Board.import.source`):
 * the tool its author wrote in.
 */
const SOURCE_TAGS = Object.freeze({ clickup: "ClickUp", monday: "monday.com" });
const IMPORTED_TAG = "Imported";

/**
 * Who wrote `update`: its creator (`user`, a user record), else the
 * source author an import recorded (`authorName`, SPEC-5 §1.4) with the
 * `tag` of the board's import `source`, else "Someone" (the API hides
 * authors outside a guest's directory).
 * @returns {{ user: object | null, name: string, tag: string | null }}
 */
export function updateAuthor(update, source) {
  if (update.creator) {
    return { user: update.creator, name: update.creator.name, tag: null };
  }
  const name =
    typeof update.authorName === "string" ? update.authorName.trim() : "";
  if (name !== "") {
    const tag = Object.hasOwn(SOURCE_TAGS, source ?? "")
      ? SOURCE_TAGS[source]
      : IMPORTED_TAG;
    return { user: null, name, tag };
  }
  const someone = { id: "0", name: SOMEONE, initials: "?" };
  return { user: someone, name: SOMEONE, tag: null };
}

/**
 * The replies the thread of `update` shows: its loaded replies when
 * `expanded` (shown whole), else their newest SHOWN_REPLIES, with how
 * many of its `repliesCount` are `hidden`.
 */
export function replyWindow(update, expanded) {
  const loaded = update.replies;
  const from = expanded ? 0 : Math.max(0, loaded.length - SHOWN_REPLIES);
  const shown = loaded.slice(from);
  const count = Math.max(update.repliesCount ?? 0, loaded.length);
  return { hidden: count - shown.length, shown };
}

/**
 * "Liked by You, Sam Lee and 2 others" for `update` (its loaded `likers`
 * and `likesCount`); null without likes. `meId` reads as "You".
 */
export function likersText(update, meId) {
  const count = update.likesCount;
  if (!Number.isSafeInteger(count) || count <= 0) return null;
  const names = update.likers.map((user) =>
    user.id === meId ? "You" : user.name,
  );
  if (update.likedByMe && !update.likers.some((user) => user.id === meId)) {
    names.unshift("You");
  }
  const shown = names.slice(0, 3);
  const others = count - shown.length;
  if (shown.length === 0) {
    return `Liked by ${count} ${count === 1 ? "person" : "people"}`;
  }
  if (others <= 0) {
    const last = shown.pop();
    const list = shown.length > 0 ? `${shown.join(", ")} and ${last}` : last;
    return `Liked by ${list}`;
  }
  const more = `${others} ${others === 1 ? "other" : "others"}`;
  return `Liked by ${shown.join(", ")} and ${more}`;
}

/** The thread holding update `id`: `{ update, parent }` or null. */
export function findUpdate(list, id) {
  for (const update of list) {
    if (update.id === id) return { update, parent: null };
    const reply = update.replies.find((entry) => entry.id === id);
    if (reply) return { update: reply, parent: update };
  }
  return null;
}

/** `list` with update `id` (top-level or reply) replaced by `change(it)`. */
export function mapUpdate(list, id, change) {
  return list.map((update) => {
    if (update.id === id) return change(update);
    if (!update.replies.some((reply) => reply.id === id)) return update;
    const replies = update.replies.map((reply) =>
      reply.id === id ? change(reply) : reply,
    );
    return { ...update, replies };
  });
}

/** `list` without update `id` (a top-level one takes its replies along). */
export function removeUpdate(list, id) {
  return list
    .filter((update) => update.id !== id)
    .map((update) =>
      update.replies.some((reply) => reply.id === id)
        ? {
            ...update,
            replies: update.replies.filter((r) => r.id !== id),
            repliesCount: Math.max(0, (update.repliesCount ?? 1) - 1),
          }
        : update,
    );
}

/** `list` with a new top-level `update` right after the pinned ones. */
export function addPost(list, update) {
  const at = list.findIndex((entry) => !entry.pinned);
  const index = at === -1 ? list.length : at;
  return [...list.slice(0, index), update, ...list.slice(index)];
}

/** `list` with `reply` at the end of the thread of `parentId`. */
export const addReply = (list, parentId, reply) =>
  mapUpdate(list, parentId, (parent) => ({
    ...parent,
    replies: [...parent.replies, reply],
    repliesCount: (parent.repliesCount ?? parent.replies.length) + 1,
  }));

/**
 * `list` with the thread of `id` loaded whole (`loadThread`'s `{
 * replies, count }`).
 */
export const withThread = (list, id, thread) =>
  mapUpdate(list, id, (update) => ({
    ...update,
    replies: thread.replies,
    repliesCount: thread.count,
  }));

/**
 * `list` with `page` (the next page of older top-level updates) after
 * it, without updates it already shows.
 */
export function appendPage(list, page) {
  const shown = new Set(list.map((update) => update.id));
  return [...list, ...page.filter((update) => !shown.has(update.id))];
}

/**
 * `list` with update `id` pinned (moved first) or unpinned (it keeps its
 * place until the server's order arrives).
 */
export function setPinned(list, id, pinned) {
  const found = list.find((update) => update.id === id);
  if (!found) return list;
  const changed = { ...found, pinned };
  if (!pinned)
    return list.map((update) => (update === found ? changed : update));
  return [changed, ...list.filter((update) => update !== found)];
}

/** `update` after `me` liked (`liked`) or unliked it. */
export function withLike(update, me, liked) {
  if (update.likedByMe === liked) return update;
  const others = update.likers.filter((user) => user.id !== me.id);
  return {
    ...update,
    likedByMe: liked,
    likesCount: Math.max(0, update.likesCount + (liked ? 1 : -1)),
    likers: liked ? [{ id: me.id, name: me.name }, ...others] : others,
  };
}

let pendingSeq = 0;

/**
 * A not-yet-saved update by `me` showing `parts` (`draftParts`), with
 * `body` kept for a retry; its ID starts with "pending-".
 */
export function pendingUpdate({ me, body, parts }) {
  pendingSeq += 1;
  return {
    id: `pending-${pendingSeq}`,
    body,
    parts,
    creator: me,
    authorName: null,
    createdAt: new Date().toISOString(),
    editedAt: null,
    pinned: false,
    likesCount: 0,
    likedByMe: false,
    likers: [],
    canEdit: false,
    canDelete: false,
    replies: [],
    repliesCount: 0,
    pending: true,
  };
}

/** Whether `id` names an update the server has not saved yet. */
export const isPending = (id) => String(id).startsWith("pending-");
