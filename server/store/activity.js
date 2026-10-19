/**
 * Board activity logs and per-user notifications (SPEC-2 §2).
 *
 * Texts that name users or other boards (notification texts, activity
 * `from_text` and `to_text`) are stored as "rich text": a plain string,
 * or an array of parts `{ text }`, `{ user_id }` and `{ board_id }` that
 * `renderText` turns into a string for one viewer at read time, so a
 * guest sees "Someone" for people outside their directory (SPEC-2 §6)
 * and a board reads as OTHER_BOARD to anyone who cannot open it (SPEC-6
 * §3.2 `move_item_to_board`). Activity actors are their
 * `actor_id`; `actor_label` is stored for non-user actors (forms) and for
 * changes a user made through a tool that names itself (imports: actor
 * the importing admin, label "Import from monday.com", SPEC-4 §1).
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
 * and each user their newest MAX_NOTIFICATIONS notifications. `notify`
 * trims once per batch (`trimNotifications`: one pass counting the
 * recipients' notifications, one dropping their oldest beyond the cap),
 * so a team mention costs about the same as notifying one person.
 */
import { HIDDEN_USER_NAME, isActive, resourceAccess } from "../access.js";
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

// ------------------------------------------------------------- rich text

/** A rich-text part naming user `userId`. */
export const mention = (userId) => ({ user_id: userId });

/** A rich-text part naming board `boardId`. */
export const boardRef = (boardId) => ({ board_id: boardId });

/** How a board reads to a viewer who cannot open it. */
export const OTHER_BOARD = "another board";

/**
 * "<actor><rest>": the actor as a mention, or `fallback` when the change
 * has no acting user.
 */
export function byActor(actorId, rest, fallback = HIDDEN_USER_NAME) {
  if (actorId === null || actorId === undefined) return `${fallback}${rest}`;
  return [mention(actorId), { text: rest }];
}

/** "A, B": the users of a people value, or null when it is empty. */
export function peopleText(userIds) {
  if (userIds.length === 0) return null;
  return userIds.flatMap((id, index) =>
    index === 0 ? [mention(id)] : [{ text: ", " }, mention(id)],
  );
}

/**
 * Renders rich text for one viewer: `nameOf(userId)` is the name of a
 * user and `boardNameOf(boardId)` the name of a board that viewer sees
 * (without one, every board reads as OTHER_BOARD). Plain strings and
 * null are returned as they are.
 */
export function renderText(text, nameOf, boardNameOf = () => OTHER_BOARD) {
  if (!Array.isArray(text)) return text ?? null;
  const shown = (part) => {
    if (part.user_id !== undefined) return nameOf(part.user_id);
    if (part.board_id !== undefined) return boardNameOf(part.board_id);
    return part.text;
  };
  return text.map(shown).join("");
}

/**
 * The name of an activity entry's actor for one viewer (`nameOf`): the
 * stored label when there is one, else the acting user's name.
 */
export function actorLabel(entry, nameOf) {
  if (entry.actor_label !== null) return entry.actor_label;
  return entry.actor_id === null ? null : nameOf(entry.actor_id);
}

function trim(list, keep, max) {
  const matching = list.filter(keep);
  if (matching.length <= max) return;
  const drop = new Set(matching.slice(0, matching.length - max));
  removeWhere(list, (record) => drop.has(record));
}

/**
 * Appends an activity entry for `boardId`. `actorId` null with an
 * `actorLabel` marks non-user actors (form submissions); both name a user
 * acting through a tool (imports). `fromText` and `toText` are rich text.
 * `subitemsDeleted` (item and group deletions, SPEC-5 §1.1) is kept when
 * above 0.
 */
export function recordActivity(ctx, entry) {
  const { state } = ctx;
  const actorId = entry.actorId ?? null;
  const subitems = entry.subitemsDeleted ?? 0;
  const record = push(state.activity, {
    id: nextId(state),
    board_id: entry.boardId,
    actor_id: actorId,
    actor_label: entry.actorLabel ?? null,
    kind: entry.kind,
    item_id: entry.itemId ?? null,
    item_name: entry.itemName ?? null,
    column_id: entry.columnId ?? null,
    from_text: entry.fromText ?? null,
    to_text: entry.toText ?? null,
    ...(subitems > 0 ? { subitems_deleted: subitems } : {}),
    created_at: ctx.now(),
  });
  trim(state.activity, (r) => r.board_id === entry.boardId, MAX_ACTIVITY);
  return record;
}

/** Appends one notification record; `text` is rich text. */
function appendNotification(ctx, fields) {
  return push(ctx.state.notifications, {
    id: nextId(ctx.state),
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
}

/**
 * Keeps the newest MAX_NOTIFICATIONS notifications of each of `userIds`
 * (a Set): one pass counts theirs, one more drops each one's oldest
 * beyond the cap (notifications are kept oldest first).
 */
function trimNotifications(state, userIds) {
  const counts = new Map();
  for (const { user_id: id } of state.notifications) {
    if (userIds.has(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const excess = new Map();
  for (const [id, count] of counts) {
    if (count > MAX_NOTIFICATIONS) excess.set(id, count - MAX_NOTIFICATIONS);
  }
  if (excess.size === 0) return;
  removeWhere(state.notifications, (record) => {
    const left = excess.get(record.user_id) ?? 0;
    if (left > 0) excess.set(record.user_id, left - 1);
    return left > 0;
  });
}

/** Inserts one notification record (seed and imports); `text` is rich text. */
export function insertNotification(ctx, fields) {
  const record = appendNotification(ctx, fields);
  trimNotifications(ctx.state, new Set([fields.userId]));
  return record;
}

/**
 * Notifies each of `userIds` (deduplicated) except the actor, inactive
 * users and, when `resource` (`{ kind, id, record }`) is given, users
 * without access to it. `text` is rich text (see `byActor`). Returns the
 * created notifications.
 */
export function notify(
  ctx,
  { userIds, actorId = null, kind, text, url, resource = null },
) {
  const users = new Map(ctx.state.users.map((user) => [user.id, user]));
  const target = resource && { kind: resource.kind, id: resource.id };
  const created = [];
  for (const userId of new Set(userIds)) {
    const user = users.get(userId);
    if (!isActive(user) || userId === actorId) continue;
    const reachable =
      resource === null ||
      resourceAccess(ctx.reader, user, resource.kind, resource.record) !== null;
    if (!reachable) continue;
    const fields = { userId, kind, text, url, actorId, resource: target };
    created.push(appendNotification(ctx, fields));
  }
  if (created.length === 0) return created;
  trimNotifications(ctx.state, new Set(created.map((r) => r.user_id)));
  for (const record of created) {
    ctx.pending.push({
      type: "notification_created",
      user_ids: [record.user_id],
      resource_kind: "notification",
      resource_id: record.id,
    });
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
