/**
 * The caller's notification inbox and board activity logs. Notifications
 * (lists, unread counts, marking read) only ever include entries that
 * `access.notificationVisible` allows: the caller's own, about resources
 * they can still access. Activity logs need viewer access to the board,
 * which reaching `Board.activity_logs` already implies.
 */
import { notificationVisible } from "../access.js";
import {
  lookupUser,
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
  notifications: (_p, args, ctx) =>
    visibleNotifications(ctx, { unreadOnly: args.unread_only }).slice(
      0,
      readLimit(args.limit),
    ),
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

export const definition = {
  types: {
    Query: `notifications(unread_only:Boolean=false,limit:Int=50):[Notification!]!
      unread_notifications_count:Int!`,
    Board: "activity_logs(limit:Int=50):[ActivityLog!]!",
    Notification: `id:ID! kind:String! text:String! url:String! read:Boolean!
      actor:User created_at:String!`,
    ActivityLog: `id:ID! kind:String! actor:User actor_label:String item_id:ID
      item_name:String column_id:String from_text:String to_text:String
      created_at:String!`,
    Mutation: "mark_notifications_read(ids:[ID!],all:Boolean=false):Int!",
  },
  resolvers: {
    Query,
    Mutation,
    Notification: { actor },
    ActivityLog: { actor },
    Board: {
      activity_logs: (board, { limit }, { store }) =>
        store.listActivity(board.id, { limit: readLimit(limit) }),
    },
  },
  extras: {
    "Query.notifications": { description: "Your inbox, newest first." },
  },
};
