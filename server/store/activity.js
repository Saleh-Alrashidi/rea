/**
 * Board activity logs and per-user notifications (SPEC-2 §2).
 *
 * Domain mutators call `recordActivity` and `notify` while they change
 * state; neither emits on its own. `notify` queues one
 * `notification_created` event per recipient on `ctx.pending`, which the
 * mutator's `commit` emits after its own event, so a recipient's event
 * never names anyone else. The actor is never notified, and neither are
 * deactivated users or users who cannot access the resource the
 * notification points at (checked through `server/access.js`).
 *
 * Retention is bounded: each board keeps its newest MAX_ACTIVITY entries
 * and each user their newest MAX_NOTIFICATIONS notifications.
 */
import { isActive, resourceAccess } from "../access.js";
import {
  byId,
  commit,
  nextId,
  push,
  removeWhere,
  replace,
  requireCount,
} from "../store-state.js";

// Unspecified: retention limits keep the data file bounded.
export const MAX_ACTIVITY = 1000;
export const MAX_NOTIFICATIONS = 200;

const ROUTES = Object.freeze({
  workspace: "workspaces",
  board: "boards",
  doc: "docs",
  note: "notes",
});

/** The hash URL of a resource (`#/boards/4`), or of an item on a board. */
export function resourceUrl(kind, id, itemId = null) {
  const base = `#/${ROUTES[kind]}/${id}`;
  return itemId === null ? base : `${base}/items/${itemId}`;
}

/** The display name of a user for activity labels and texts. */
export function actorName(ctx, actorId) {
  return byId(ctx.state.users, actorId)?.name ?? null;
}

function trim(list, keep, max) {
  const matching = list.filter(keep);
  if (matching.length <= max) return;
  const drop = new Set(matching.slice(0, matching.length - max));
  removeWhere(list, (record) => drop.has(record));
}

/**
 * Appends an activity entry for `boardId`. `actorId` null with an
 * `actorLabel` marks non-user actors (form submissions).
 */
export function recordActivity(ctx, entry) {
  const { state } = ctx;
  const actorId = entry.actorId ?? null;
  const record = push(state.activity, {
    id: nextId(state),
    board_id: entry.boardId,
    actor_id: actorId,
    actor_label: entry.actorLabel ?? actorName(ctx, actorId),
    kind: entry.kind,
    item_id: entry.itemId ?? null,
    item_name: entry.itemName ?? null,
    column_id: entry.columnId ?? null,
    from_text: entry.fromText ?? null,
    to_text: entry.toText ?? null,
    created_at: ctx.now(),
  });
  trim(state.activity, (r) => r.board_id === entry.boardId, MAX_ACTIVITY);
  return record;
}

/** Inserts one notification record (seed and `notify`). */
export function insertNotification(ctx, fields) {
  const { state } = ctx;
  const record = push(state.notifications, {
    id: nextId(state),
    user_id: fields.userId,
    kind: fields.kind,
    text: fields.text,
    url: fields.url,
    read: fields.read ?? false,
    actor_id: fields.actorId ?? null,
    resource_kind: fields.resource?.kind ?? null,
    resource_id: fields.resource?.id ?? null,
    created_at: ctx.now(),
  });
  const mine = (r) => r.user_id === fields.userId;
  trim(state.notifications, mine, MAX_NOTIFICATIONS);
  return record;
}

/**
 * Notifies each of `userIds` (deduplicated) except the actor, inactive
 * users and, when `resource` (`{ kind, id, record }`) is given, users
 * without access to it. Returns the created notifications.
 */
export function notify(
  ctx,
  { userIds, actorId = null, kind, text, url, resource = null },
) {
  const created = [];
  for (const userId of new Set(userIds)) {
    const user = byId(ctx.state.users, userId);
    if (!isActive(user) || userId === actorId) continue;
    const reachable =
      resource === null ||
      resourceAccess(ctx.reader, user, resource.kind, resource.record) !== null;
    if (!reachable) continue;
    const target = resource && { kind: resource.kind, id: resource.id };
    const fields = { userId, kind, text, url, actorId, resource: target };
    const record = insertNotification(ctx, fields);
    ctx.pending.push({
      type: "notification_created",
      user_ids: [userId],
      resource_kind: "notification",
      resource_id: record.id,
    });
    created.push(record);
  }
  return created;
}

/** A quoted display title for notification texts. */
export const quoted = (text) => `“${text}”`;

export function activityApi(ctx) {
  const { state } = ctx;
  const mine = (userId) =>
    state.notifications.filter((n) => n.user_id === userId);
  return {
    /** Activity of a board, newest first. */
    listActivity(boardId, { limit = 50 } = {}) {
      requireCount(limit, "limit", 0);
      const entries = state.activity.filter((a) => a.board_id === boardId);
      return entries.reverse().slice(0, limit);
    },
    /** Notifications of a user, newest first. */
    listNotifications(userId, { unreadOnly = false, limit = 50 } = {}) {
      requireCount(limit, "limit", 0);
      const list = mine(userId).filter((n) => !unreadOnly || !n.read);
      return list.reverse().slice(0, limit);
    },
    getNotification: (id) => byId(state.notifications, id),
    countUnreadNotifications: (userId) =>
      mine(userId).filter((n) => !n.read).length,
    /**
     * Marks the user's notifications `ids` (or all with `all: true`) read
     * and returns how many changed. Other users' IDs are ignored.
     */
    markNotificationsRead(userId, { ids = [], all = false } = {}) {
      if (!Array.isArray(ids)) throw new TypeError("ids must be an array");
      const wanted = new Set(ids);
      const targets = mine(userId).filter(
        (n) => !n.read && (all || wanted.has(n.id)),
      );
      for (const record of targets) {
        replace(state.notifications, record, { ...record, read: true });
      }
      if (targets.length === 0) return 0;
      const event = { type: "notifications_read", user_ids: [userId] };
      return commit(ctx, event, targets.length);
    },
  };
}
