/**
 * The caller's notification inbox and board activity logs. Notifications
 * (lists, filtered by kind on request, e.g. the Inbox's Mentions filter,
 * SPEC-6 §2.2; unread counts; marking read) only ever include entries that
 * `access.notificationVisible` allows: the caller's own, about resources
 * they can still access. Activity logs need viewer access to the board,
 * which reaching `Board.activity_logs` already implies.
 *
 * Texts that name people or boards (notification `text`, activity
 * `actor_label`, `from_text`, `to_text`) are rendered for the caller:
 * people outside a guest's directory read "Someone" (SPEC-2 §6), and a
 * board the caller cannot open reads "another board" (`OTHER_BOARD`).
 */
import { boardAccess, notificationVisible } from "../access.js";
import { NOTIFICATION_KINDS } from "../store-state.js";
import { OTHER_BOARD, actorLabel, renderText } from "../store/activity.js";
import {
  lookupUser,
  namesFor,
  read,
  readIds,
  readLimit,
  viewerOf,
  wrapAll,
  write,
} from "./common.js";

/** The caller's visible notifications, newest first. */
function visibleNotifications(ctx, { unreadOnly = false } = {}) {
  const viewer = viewerOf(ctx);
  const all = ctx.store.listNotifications(viewer.id, {
    unreadOnly,
    limit: Number.MAX_SAFE_INTEGER,
  });
  return all.filter((entry) => notificationVisible(ctx.store, viewer, entry));
}

const Query = wrapAll(read, {
  notifications(_p, args, ctx) {
    const limit = readLimit(args.limit);
    const kinds = (args.kinds ?? null) === null ? null : new Set(args.kinds);
    return visibleNotifications(ctx, { unreadOnly: args.unread_only })
      .filter((entry) => kinds === null || kinds.has(entry.kind))
      .slice(0, limit);
  },
  unread_notifications_count: (_p, _a, ctx) =>
    visibleNotifications(ctx, { unreadOnly: true }).length,
});

const Mutation = wrapAll(write, {
  /** Marks visible notifications read; returns how many changed. */
  mark_notifications_read(_p, args, ctx) {
    const wanted = new Set(readIds(args.ids) ?? []);
    const ids = visibleNotifications(ctx, { unreadOnly: true })
      .filter((entry) => args.all || wanted.has(entry.id))
      .map((entry) => entry.id);
    if (ids.length === 0) return 0;
    const userId = viewerOf(ctx).id;
    return ctx.store.markNotificationsRead(userId, { ids });
  },
});

const actor = (record, _a, ctx) => lookupUser(ctx, record.actor_id);

/** `boardNameOf(boardId)` for the caller: a board's name if they can open it. */
function boardNamesFor(ctx) {
  const viewer = viewerOf(ctx);
  return (id) => {
    const board = ctx.store.getBoard(id);
    const open = boardAccess(ctx.store, viewer, board) !== null;
    return open ? board.name : OTHER_BOARD;
  };
}

/** A resolver rendering the rich-text `field` for the caller. */
const rendered = (field) => (record, _a, ctx) =>
  renderText(record[field], namesFor(ctx), boardNamesFor(ctx));

export const definition = {
  enums: { NotificationKind: [...NOTIFICATION_KINDS] },
  types: {
    Query: `notifications(unread_only:Boolean=false,kinds:[NotificationKind!],limit:Int=50):[Notification!]!
      unread_notifications_count:Int!`,
    Board: "activity_logs(limit:Int=50):[ActivityLog!]!",
    Notification: `id:ID! kind:String! text:String! url:String! read:Boolean!
      actor:User created_at:String!`,
    ActivityLog: `id:ID! kind:String! actor:User actor_label:String item_id:ID
      item_name:String column_id:String from_text:String to_text:String
      subitems_deleted:Int created_at:String!`,
    Mutation: "mark_notifications_read(ids:[ID!],all:Boolean=false):Int!",
  },
  resolvers: {
    Query,
    Mutation,
    Notification: { actor, text: rendered("text") },
    ActivityLog: {
      actor,
      actor_label: (entry, _a, ctx) => actorLabel(entry, namesFor(ctx)),
      from_text: rendered("from_text"),
      to_text: rendered("to_text"),
    },
    Board: {
      activity_logs: (board, { limit }, { store }) =>
        store.listActivity(board.id, { limit: readLimit(limit) }),
    },
  },
  extras: {
    "Query.notifications": {
      description:
        "Your inbox, newest first; kinds keeps only those kinds (the Mentions filter is [mention]).",
    },
    "ActivityLog.subitems_deleted": {
      description:
        "For item_deleted: how many subitems went with the item. For group_deleted: how many subitems in other groups went with the group's items.",
    },
  },
};
