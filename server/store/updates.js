/**
 * Item updates, monday-style (SPEC-6 §2.1): top-level updates and their
 * replies (`parent_update_id`, one level: replies to replies are refused),
 * edits (`edited_at`), pins (`pinned_at`, top-level updates only) and
 * likes (`state.likes`, one per user and update), with their mentions
 * (`server/mentions.js` owns the token syntax) and notifications.
 *
 * A reply keeps its item's `item_id`, so an item's updates and replies
 * are found and counted (`countUpdatesByItem`) the same way. Top-level
 * updates are listed pinned first, then newest first (by ID); replies
 * oldest first. `removeUpdates` is the one way updates leave the store:
 * it takes their replies and the likes of all of them along, and item,
 * group and board deletions reach it through `boards.removeItems`.
 *
 * Bodies are trimmed and 1-10,000 characters as submitted (tokens
 * included), with at most MAX_MENTIONS tokens. A mention of something its
 * author cannot see becomes plain text "@<display>": an unknown user,
 * team or item, a user outside a guest author's directory, a team a guest
 * is not in, an item on a board the author cannot open (`access.js`). The
 * body is stored canonically (`mentions.serializeBody`).
 *
 * Notifications go through `activity.notify` (never to the actor,
 * inactive users or users who cannot open the board, so nobody without
 * access learns about a post), at most one per user and post, the first
 * kind that applies winning:
 * - `mention`: mentioned users and the members of mentioned teams ("<actor>
 *   mentioned you in “<item>”"); an edit notifies only people it newly
 *   mentions;
 * - `reply`: the parent's author ("replied to your update on") and its
 *   earlier repliers ("replied to an update on");
 * - `update`: for top-level updates, the item's assignees (SPEC-2);
 * - `like`: the update's author, once per update and liker (while that
 *   notification is kept, `activity.MAX_NOTIFICATIONS`).
 * Mention, reply and like notifications link to the update
 * (`#/boards/<id>/items/<itemId>/updates/<updateId>`).
 *
 * Each change emits one board event `{ type, board_id, item_id, update_id
 * }`: `update_created`, `update_edited` (pins add `pinned`),
 * `update_deleted` or `update_liked` (with `liked`). A call that changes
 * nothing (the same body, a second like, pinning a pinned update) returns
 * the update and emits nothing.
 */
import { boardAccess, teamVisible, visibleUserIds } from "../access.js";
import { peopleIds } from "../column-values.js";
import { LIMITS, describe } from "../input.js";
import {
  MAX_MENTIONS,
  checkMentions,
  escapeText,
  mentionsOf,
} from "../mentions.js";
import {
  byId,
  commit,
  deepFreeze,
  failure,
  forBoard,
  invalid,
  nextId,
  push,
  removeWhere,
  replace,
  requireCount,
} from "../store-state.js";
import { byActor, notify, quoted, resourceUrl } from "./activity.js";

const BODY_RULE = `Update bodies must be 1-${LIMITS.updateBody} characters`;
const isReply = (update) => update.parent_update_id !== undefined;
const isPinned = (update) => update.pinned_at !== undefined;
const oldestFirst = (a, b) => Number(a.id) - Number(b.id);
/** Item order: pinned updates first, then newest first. */
const updateOrder = (a, b) =>
  Number(isPinned(b)) - Number(isPinned(a)) || oldestFirst(b, a);
const knownUser = (state, id) => id === null || byId(state.users, id) !== null;

/** The hash URL of `update` on board `boardId` (its task view, at it). */
export const updateUrl = (boardId, update) =>
  `${resourceUrl("board", boardId, update.item_id)}/updates/${update.id}`;

/**
 * Appends an update (the seed, imports and `createUpdate`): `parentId`
 * makes it a reply, `authorName` (SPEC-5 §1.4, imports) names a source
 * author without a Worklane user, `createdAt` keeps a source time. The
 * caller checked everything.
 */
export function insertUpdate(ctx, fields) {
  const { itemId, body, creatorId, authorName = null } = fields;
  const parentId = fields.parentId ?? null;
  const reply = parentId === null ? {} : { parent_update_id: parentId };
  const update = { id: nextId(ctx.state), item_id: itemId, ...reply, body };
  const at = fields.createdAt ?? ctx.now();
  const meta = { creator_id: creatorId, created_at: at };
  const author = authorName === null ? {} : { author_name: authorName };
  return push(ctx.state.updates, { ...update, ...meta, ...author });
}

/**
 * Removes the updates matching `predicate` with their replies and the
 * likes of all of them; returns the removed update IDs.
 */
export function removeUpdates(state, predicate) {
  const ids = new Set(state.updates.filter(predicate).map((u) => u.id));
  for (const update of state.updates) {
    if (isReply(update) && ids.has(update.parent_update_id)) ids.add(update.id);
  }
  removeWhere(state.updates, (update) => ids.has(update.id));
  removeWhere(state.likes, (like) => ids.has(like.update_id));
  return ids;
}

/**
 * Why `state`'s updates and likes break the rules (a reply's parent is a
 * top-level update of the same item, replies are never pinned, a like
 * names an existing update and user, once per pair), else null.
 */
export function updateProblem(state) {
  const updates = new Map(state.updates.map((update) => [update.id, update]));
  for (const update of state.updates.filter(isReply)) {
    const parent = updates.get(update.parent_update_id);
    if (!parent || isReply(parent) || parent.item_id !== update.item_id)
      return `update ${update.id} replies to an invalid parent update`;
    if (isPinned(update)) return `update ${update.id} is a pinned reply`;
  }
  const users = new Set(state.users.map((user) => user.id));
  const seen = new Set();
  for (const { update_id, user_id } of state.likes) {
    if (!updates.has(update_id) || !users.has(user_id))
      return `a like of update ${update_id} names a missing update or user`;
    const key = `${update_id}/${user_id}`;
    if (seen.has(key)) return `update ${update_id} is liked twice by one user`;
    seen.add(key);
  }
  return null;
}

/**
 * The `/5 → /6` upgrade: `/5` bodies were plain text, so any text that
 * reads as a token now is escaped (`mentions.escapeText`).
 */
export function upgradeUpdateBodies(state) {
  state.updates = state.updates.map((update) => {
    const body = escapeText(update.body);
    return body === update.body ? update : deepFreeze({ ...update, body });
  });
}

/**
 * `known(kind, id)` for mentions written by `authorId` (see the module
 * comment); without an author (store-level writes) existence suffices.
 */
function mentionable(ctx, authorId) {
  const { state, reader } = ctx;
  const author = authorId === null ? null : byId(state.users, authorId);
  let directory;
  const sees = (id) => {
    if (author === null) return true;
    if (directory === undefined) directory = visibleUserIds(reader, author);
    return directory === null || directory.has(id);
  };
  return (kind, id) => {
    if (kind === "user") return byId(state.users, id) !== null && sees(id);
    if (kind === "team") {
      const team = byId(state.teams, id);
      return team !== null && (author === null || teamVisible(author, team));
    }
    const item = byId(state.items, id);
    const board = item && byId(state.boards, item.board_id);
    if (!board) return false;
    return author === null || boardAccess(reader, author, board) !== null;
  };
}

/** A checked body `{ body, mentions }` (or a failure) written by `authorId`. */
function readBody(ctx, value, authorId) {
  if (typeof value !== "string") throw new TypeError("body must be a string");
  const body = value.trim();
  if (body === "" || body.length > LIMITS.updateBody) invalid(BODY_RULE);
  const checked = checkMentions(body, mentionable(ctx, authorId));
  if (checked === null) {
    const message = `An update can mention at most ${MAX_MENTIONS} people, teams or tasks`;
    return failure("too_many_mentions", { message });
  }
  return { ...checked, body: checked.body.trim() };
}

/** The users `mentions` name: users, and the members of teams. */
function mentionedUsers(state, mentions) {
  return mentions.flatMap(({ kind, id }) => {
    if (kind === "user") return [id];
    const team = kind === "team" ? byId(state.teams, id) : null;
    return team ? team.members.map((member) => member.user_id) : [];
  });
}

/**
 * `send(userIds, kind, phrase, url?)` for notifications about `update` on
 * `item` by `actorId`: "<actor><phrase> “<item>”", each user at most once.
 */
function notifier(ctx, { item, update, actorId }) {
  const board = byId(ctx.state.boards, item.board_id);
  const resource = { kind: "board", id: board.id, record: board };
  const notified = new Set();
  return (userIds, kind, phrase, url = updateUrl(board.id, update)) => {
    const fresh = userIds.filter((id) => id !== null && !notified.has(id));
    const text = byActor(actorId, `${phrase} ${quoted(item.name)}`);
    const fields = { userIds: fresh, actorId, kind, text, url, resource };
    for (const record of notify(ctx, fields)) notified.add(record.user_id);
  };
}

/** Notifications for a new update or reply (see the module comment). */
function notifyPost(ctx, { item, update, parent, mentions }) {
  const { state } = ctx;
  const send = notifier(ctx, { item, update, actorId: update.creator_id });
  send(mentionedUsers(state, mentions), "mention", " mentioned you in");
  if (parent) {
    send([parent.creator_id], "reply", " replied to your update on");
    const earlier = state.updates.filter(
      (u) => u.parent_update_id === parent.id && u !== update,
    );
    const repliers = earlier.map((reply) => reply.creator_id);
    send(repliers, "reply", " replied to an update on");
    return;
  }
  const columns = forBoard(state.columns, item.board_id);
  const assigned = columns.flatMap((c) => peopleIds(c, item.values[c.id]));
  const url = resourceUrl("board", item.board_id, item.id);
  send(assigned, "update", " posted an update on", url);
}

const updateEvent = (type, item, update, extra = {}) => ({
  type,
  board_id: item.board_id,
  item_id: item.id,
  update_id: update.id,
  ...extra,
});

const missing = (id) =>
  failure("not_found", { message: `Update ${describe(id)} was not found` });

function createUpdate(
  ctx,
  { itemId, body, creatorId = null, parentId = null },
) {
  const { state } = ctx;
  const item = byId(state.items, itemId);
  if (!item || !knownUser(state, creatorId)) return null;
  const parent = parentId === null ? null : byId(state.updates, parentId);
  if (parentId !== null && parent?.item_id !== item.id)
    return missing(parentId);
  if (parent && isReply(parent)) {
    const message = "Replies can't have replies: reply to the update instead";
    return failure("invalid_parent", { message });
  }
  const checked = readBody(ctx, body, creatorId);
  if (checked.ok === false) return checked;
  const fields = { itemId, body: checked.body, creatorId, parentId };
  const update = insertUpdate(ctx, fields);
  notifyPost(ctx, { item, update, parent, mentions: checked.mentions });
  return commit(ctx, updateEvent("update_created", item, update), update);
}

function updateReads(state) {
  return {
    getUpdate: (id) => byId(state.updates, id),
    /** Top-level updates of an item: pinned first, then newest first. */
    listUpdates(itemId, { limit = 25 } = {}) {
      requireCount(limit, "limit", 0);
      const updates = state.updates.filter(
        (update) => update.item_id === itemId && !isReply(update),
      );
      return updates.sort(updateOrder).slice(0, limit);
    },
    /** Replies to an update, oldest first. */
    listReplies: (id) =>
      state.updates.filter((u) => u.parent_update_id === id).sort(oldestFirst),
    /**
     * Both lists for every item in one pass: `{ updates: Map(itemId →
     * top-level updates, as listUpdates orders them), replies:
     * Map(updateId → replies, oldest first) }`.
     */
    indexUpdates() {
      const updates = new Map();
      const replies = new Map();
      for (const update of state.updates) {
        const [map, key] = isReply(update)
          ? [replies, update.parent_update_id]
          : [updates, update.item_id];
        if (map.has(key)) map.get(key).push(update);
        else map.set(key, [update]);
      }
      for (const list of updates.values()) list.sort(updateOrder);
      for (const list of replies.values()) list.sort(oldestFirst);
      return { updates, replies };
    },
    /** How many updates (replies included) each item has, no zeros. */
    countUpdatesByItem() {
      const counts = new Map();
      for (const { item_id } of state.updates) {
        counts.set(item_id, (counts.get(item_id) ?? 0) + 1);
      }
      return counts;
    },
    /** Likes of an update `{ update_id, user_id, created_at }`, in order. */
    listLikes: (id) => state.likes.filter((like) => like.update_id === id),
    /** `Map(updateId → likes in order)`. */
    indexLikes: () => Map.groupBy(state.likes, (like) => like.update_id),
  };
}

/** Pins and unpins (top-level updates only). */
function pinMutators(ctx, located) {
  const { state } = ctx;
  return {
    pinUpdate(id) {
      const { update, event } = located(id);
      if (!update) return null;
      if (isReply(update)) {
        return failure("invalid_update", {
          message: "Replies can't be pinned",
        });
      }
      if (isPinned(update)) return update;
      const next = { ...update, pinned_at: ctx.now() };
      replace(state.updates, update, next);
      return commit(ctx, event("update_edited", { pinned: true }), next);
    },
    unpinUpdate(id) {
      const { update, event } = located(id);
      if (!update) return null;
      if (!isPinned(update)) return update;
      const { pinned_at: _pinned, ...next } = update;
      replace(state.updates, update, next);
      return commit(ctx, event("update_edited", { pinned: false }), next);
    },
  };
}

/** Likes: one per user and update; the first like notifies the author. */
function likeMutators(ctx, located) {
  const { state } = ctx;
  const likeOf = (id, userId) =>
    state.likes.find((l) => l.update_id === id && l.user_id === userId);
  return {
    likeUpdate(id, userId) {
      const { update, item, event } = located(id);
      if (!update || !byId(state.users, userId)) return null;
      if (likeOf(id, userId)) return update;
      push(state.likes, {
        update_id: id,
        user_id: userId,
        created_at: ctx.now(),
      });
      const url = updateUrl(item.board_id, update);
      const authorId = update.creator_id;
      const told = state.notifications.some(
        (n) =>
          n.user_id === authorId &&
          n.kind === "like" &&
          n.actor_id === userId &&
          n.url === url,
      );
      if (!told) {
        const send = notifier(ctx, { item, update, actorId: userId });
        send([authorId], "like", " liked your update on");
      }
      return commit(ctx, event("update_liked", { liked: true }), update);
    },
    unlikeUpdate(id, userId) {
      const { update, event } = located(id);
      if (!update || !byId(state.users, userId)) return null;
      const like = likeOf(id, userId);
      if (!like) return update;
      removeWhere(state.likes, (record) => record === like);
      return commit(ctx, event("update_liked", { liked: false }), update);
    },
  };
}

export function updateApi(ctx) {
  const { state } = ctx;
  /** An update with its item and an event maker; `{}` when unknown. */
  const located = (id) => {
    const update = byId(state.updates, id);
    const item = update && byId(state.items, update.item_id);
    if (!item) return {};
    const event = (type, extra) => updateEvent(type, item, update, extra);
    return { update, item, event };
  };
  return {
    ...updateReads(state),
    ...pinMutators(ctx, located),
    ...likeMutators(ctx, located),
    /**
     * Adds an update, or with `parentId` a reply to a top-level update of
     * the same item (`not_found` otherwise, `invalid_parent` for a reply).
     */
    createUpdate: (fields) => createUpdate(ctx, fields),
    /**
     * Replaces the body (checked as on create, mentions as `actorId`
     * sees them) and sets `edited_at`; people it newly mentions are
     * notified.
     */
    editUpdate(id, body, { actorId = null } = {}) {
      const { update, item, event } = located(id);
      if (!update || !knownUser(state, actorId)) return null;
      const checked = readBody(ctx, body, actorId);
      if (checked.ok === false) return checked;
      if (checked.body === update.body) return update;
      const next = { ...update, body: checked.body, edited_at: ctx.now() };
      replace(state.updates, update, next);
      const before = new Set(mentionedUsers(state, mentionsOf(update.body)));
      const added = mentionedUsers(state, checked.mentions).filter(
        (userId) => !before.has(userId),
      );
      const send = notifier(ctx, { item, update: next, actorId });
      send(added, "mention", " mentioned you in");
      return commit(ctx, event("update_edited"), next);
    },
    /** Deletes the update with its replies and likes; returns it. */
    deleteUpdate(id) {
      const { update, event } = located(id);
      if (!update) return null;
      removeUpdates(state, (record) => record === update);
      return commit(ctx, event("update_deleted"), update);
    },
  };
}
