/**
 * Item updates over GraphQL, monday-style (SPEC-6 §2.1, §2.2): replies,
 * edits, pins, likes and mentions, with monday's names where monday has
 * them. The store (`store/updates.js`) keeps the data rules and sends the
 * notifications; `mentions.js` owns the token syntax, which this module
 * never reads.
 *
 * Permissions (`access.js`): posting, replying, liking and pinning need
 * editor access to the item's board; editing needs the author with editor
 * access, deleting the author with editor access or a board owner
 * (`updateVerdicts`, also `Update.can_edit` and `can_delete`). An update
 * the caller cannot read is NOT_FOUND, worded like an unknown ID.
 *
 * `Item.updates` lists top-level updates, pinned first, then newest first,
 * and `Item.updates_page(limit, cursor)` pages through that order (the
 * cursor is a position, so posts and deletions never shift a page);
 * `Update.replies(limit, before_id)` gives the newest `limit` replies
 * (older than `before_id`; all without `limit`), oldest first, and
 * `Update.replies_count` how many there are, so a client can show the
 * newest few and load a whole thread in pages; `Item.updates_count`
 * counts updates and replies. `Query.updates(ids)` finds updates and
 * replies by ID (a link to an old one). Updates, replies, likes and the
 * counts are indexed once per request (`perRequest`), so a page of items
 * costs one pass over each.
 *
 * Bodies are rendered for the caller: `body_parts` gives text, links and
 * mentions with the current name of what the caller may see (users in
 * their directory, teams they may see, items on boards they can open)
 * and the token's snapshot otherwise; an item mention the caller cannot
 * open has a null name and board. `body` (`mentions.redactBody`) carries
 * a user or team the caller cannot see as the plain text "@<snapshot>"
 * and such an item as "Private task", so neither a task name nor a
 * hidden user's or team's ID leaks through either field.
 */
import {
  accessOutcome,
  boardAccess,
  forbiddenError,
  requireItem,
  teamVisible,
  updateVerdicts,
} from "../access.js";
import { ID_PATTERN, isPlainObject } from "../input.js";
import { bodyParts, redactBody } from "../mentions.js";
import {
  newestReplies,
  updatePosition,
  updatesAfter,
} from "../store/updates.js";
import {
  accessibleBoards,
  badInput,
  fail,
  lookupUser,
  notFound,
  perRequest,
  read,
  readIds,
  readLimit,
  storeResult,
  viewerOf,
  wrapAll,
  write,
} from "./common.js";

const CURSOR_PATTERN = /^[\w-]{1,512}$/;

const actor = (ctx) => ({ actorId: viewerOf(ctx).id });
const indexOf = (ctx) =>
  perRequest(ctx, "updates", () => ctx.store.indexUpdates());
const likesOf = (ctx, update) =>
  perRequest(ctx, "likes", () => ctx.store.indexLikes()).get(update.id) ?? [];
/** The IDs of the boards the caller can open (once per request). */
const openBoards = (ctx) =>
  perRequest(
    ctx,
    "board_ids",
    () => new Set(accessibleBoards(ctx).map((board) => board.id)),
  );
/** Item `id` when the caller can open its board, else null. */
function openItem(ctx, id) {
  const item = ctx.store.getItem(id);
  return item && openBoards(ctx).has(item.board_id) ? item : null;
}

/**
 * Update `id` when the caller holds `minRole` on its item's board:
 * NOT_FOUND without access (or for an unknown ID), FORBIDDEN below it.
 * `itemId`, when given, must be the update's item.
 */
function requireUpdate(ctx, { id, itemId = null, minRole }) {
  const update = ctx.store.getUpdate(id);
  const matches = update && (itemId === null || update.item_id === itemId);
  const item = matches ? ctx.store.getItem(update.item_id) : null;
  const board = item ? ctx.store.getBoard(item.board_id) : null;
  const role = boardAccess(ctx.store, viewerOf(ctx), board);
  const outcome = accessOutcome(role, minRole);
  if (outcome === "not_found") notFound("Update", id);
  if (outcome === "forbidden") throw forbiddenError("board", minRole);
  return update;
}

/** `updateVerdicts` for the caller (board roles once per request). */
function verdictsOf(ctx, update) {
  const boardId = ctx.store.getItem(update.item_id)?.board_id ?? null;
  const role = perRequest(ctx, `board_role\u0000${boardId}`, () =>
    boardAccess(ctx.store, viewerOf(ctx), ctx.store.getBoard(boardId)),
  );
  return updateVerdicts(role, viewerOf(ctx), update);
}

/**
 * What a mention names when the caller may see it (a user in their
 * directory, a team they may see, an item on a board they can open),
 * else null; once per request and mention (`body` and `body_parts`
 * both ask).
 */
const visibleMention = (ctx, kind, id) =>
  perRequest(ctx, `mention\u0000${kind}\u0000${id}`, () => {
    if (kind === "user") return lookupUser(ctx, id);
    if (kind === "item") return openItem(ctx, id);
    const team = ctx.store.getTeam(id);
    return teamVisible(viewerOf(ctx), team) ? team : null;
  });

/** A mention as the caller sees it (see the module comment). */
function mentionPart(ctx, { kind, id, display }) {
  const found = visibleMention(ctx, kind, id);
  if (kind === "user") {
    return { type: "user", user: found, text: found?.name ?? display };
  }
  if (kind === "team") {
    return { type: "team", team: found, text: found?.name ?? display };
  }
  const name = found?.name ?? null;
  const board_id = found?.board_id ?? null;
  return { type: "item", item_id: id, name, board_id, text: name };
}

// ------------------------------------------------------------- pagination

const encodeCursor = (itemId, { pinned, id }) =>
  Buffer.from(
    JSON.stringify({ i: itemId, p: pinned ? 1 : 0, u: id }),
    "utf8",
  ).toString("base64url");

/** The position (`updatePosition`) of a cursor made for item `itemId`. */
function decodeCursor(cursor, itemId) {
  let data = null;
  try {
    const text = Buffer.from(cursor, "base64url").toString("utf8");
    data = CURSOR_PATTERN.test(cursor) ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  const valid =
    isPlainObject(data) &&
    data.i === itemId &&
    (data.p === 0 || data.p === 1) &&
    typeof data.u === "string" &&
    ID_PATTERN.test(data.u);
  if (!valid) badInput("Invalid cursor for this item");
  return { pinned: data.p === 1, id: data.u };
}

/** One `Item.updates_page`: `{ cursor, updates }` (cursor null at the end). */
function updatesPage(item, args, ctx) {
  const limit = readLimit(args.limit);
  const all = indexOf(ctx).updates.get(item.id) ?? [];
  const cursor = args.cursor ?? null;
  const rest =
    cursor === null ? all : updatesAfter(all, decodeCursor(cursor, item.id));
  const updates = rest.slice(0, limit);
  const more = rest.length > limit;
  const next = more
    ? encodeCursor(item.id, updatePosition(updates.at(-1)))
    : null;
  return { cursor: next, updates };
}

/** `Update.replies`: the newest `limit` (older than `before_id`). */
function repliesOf(update, args, ctx) {
  const limit = args.limit ?? null;
  const beforeId = args.before_id ?? null;
  if (beforeId !== null && !ID_PATTERN.test(beforeId)) {
    badInput("before_id must be an update ID");
  }
  const thread = indexOf(ctx).replies.get(update.id) ?? [];
  const size = limit === null ? null : readLimit(limit);
  return newestReplies(thread, { limit: size, beforeId });
}

/** Every update and reply by ID (once per request). */
const updatesById = (ctx) =>
  perRequest(ctx, "update_ids", () => {
    const { updates, replies } = indexOf(ctx);
    const lists = [...updates.values(), ...replies.values()];
    return new Map(lists.flat().map((update) => [update.id, update]));
  });

const Query = wrapAll(read, {
  /** The updates of `ids` the caller can read, in the order asked. */
  updates(_p, { ids }, ctx) {
    const known = updatesById(ctx);
    return readIds(ids).flatMap((id) => {
      const update = known.get(id);
      return update && openItem(ctx, update.item_id) ? [update] : [];
    });
  },
});

const result = (ctx, id, value) =>
  storeResult(value, () => notFound("Update", id));

const Mutation = wrapAll(write, {
  create_update(_p, args, ctx) {
    const item = requireItem(ctx, args.item_id, "editor");
    const fields = {
      itemId: item.id,
      body: args.body,
      creatorId: viewerOf(ctx).id,
      parentId: args.parent_id ?? null,
    };
    return storeResult(ctx.store.createUpdate(fields), () =>
      notFound("Item", item.id),
    );
  },
  edit_update(_p, { id, body }, ctx) {
    const update = requireUpdate(ctx, { id, minRole: "viewer" });
    if (!verdictsOf(ctx, update).canEdit) {
      fail("FORBIDDEN", "Only the author can edit this update");
    }
    return result(ctx, id, ctx.store.editUpdate(id, body, actor(ctx)));
  },
  delete_update(_p, { id }, ctx) {
    const update = requireUpdate(ctx, { id, minRole: "viewer" });
    if (!verdictsOf(ctx, update).canDelete) {
      fail("FORBIDDEN", "Only the author or a board owner can delete this");
    }
    return result(ctx, id, ctx.store.deleteUpdate(id));
  },
  like_update(_p, { update_id: id }, ctx) {
    requireUpdate(ctx, { id, minRole: "editor" });
    return result(ctx, id, ctx.store.likeUpdate(id, viewerOf(ctx).id));
  },
  unlike_update(_p, { update_id: id }, ctx) {
    requireUpdate(ctx, { id, minRole: "editor" });
    return result(ctx, id, ctx.store.unlikeUpdate(id, viewerOf(ctx).id));
  },
  pin_to_top(_p, { id, item_id: itemId }, ctx) {
    requireUpdate(ctx, { id, itemId, minRole: "editor" });
    return result(ctx, id, ctx.store.pinUpdate(id));
  },
  unpin_from_top(_p, { id, item_id: itemId }, ctx) {
    requireUpdate(ctx, { id, itemId, minRole: "editor" });
    return result(ctx, id, ctx.store.unpinUpdate(id));
  },
});

const Update = {
  creator: (update, _a, ctx) => lookupUser(ctx, update.creator_id),
  body: (update, _a, ctx) =>
    redactBody(
      update.body,
      (kind, id) => visibleMention(ctx, kind, id) !== null,
    ),
  parent_update_id: (update) => update.parent_update_id ?? null,
  replies: repliesOf,
  replies_count: (update, _a, ctx) =>
    indexOf(ctx).replies.get(update.id)?.length ?? 0,
  edited_at: (update) => update.edited_at ?? null,
  pinned: (update) => update.pinned_at !== undefined,
  likes_count: (update, _a, ctx) => likesOf(ctx, update).length,
  liked_by_me: (update, _a, ctx) => {
    const viewer = viewerOf(ctx);
    return likesOf(ctx, update).some((like) => like.user_id === viewer.id);
  },
  likers: (update, { limit }, ctx) => {
    const size = readLimit(limit);
    const users = likesOf(ctx, update).flatMap(
      (like) => lookupUser(ctx, like.user_id) ?? [],
    );
    return users.slice(0, size);
  },
  body_parts: (update, _a, ctx) =>
    bodyParts(update.body, (mention) => mentionPart(ctx, mention)),
  can_edit: (update, _a, ctx) => verdictsOf(ctx, update).canEdit,
  can_delete: (update, _a, ctx) => verdictsOf(ctx, update).canDelete,
};

const Item = {
  updates: (item, { limit }, ctx) =>
    (indexOf(ctx).updates.get(item.id) ?? []).slice(0, readLimit(limit)),
  updates_page: updatesPage,
  updates_count: (item, _a, ctx) => {
    const counts = perRequest(ctx, "update_counts", () =>
      ctx.store.countUpdatesByItem(),
    );
    return counts.get(item.id) ?? 0;
  },
};

export const definition = {
  enums: { BodyPartType: ["text", "user", "team", "item", "link"] },
  types: {
    Query: "updates(ids:[ID!]!):[Update!]!",
    Item: `updates(limit:Int=25):[Update!]! updates_count:Int!
      updates_page(limit:Int=25,cursor:String):UpdatesPage!`,
    UpdatesPage: "cursor:String updates:[Update!]!",
    Update: `id:ID! body:String! author_name:String created_at:String!
      creator:User parent_update_id:ID replies(limit:Int,before_id:ID):[Update!]!
      replies_count:Int! edited_at:String
      pinned:Boolean! likes_count:Int! liked_by_me:Boolean!
      likers(limit:Int=20):[User!]! body_parts:[BodyPart!]!
      can_edit:Boolean! can_delete:Boolean!`,
    BodyPart: `type:BodyPartType! text:String user:User team:Team item_id:ID
      name:String board_id:ID url:String`,
    Mutation: `create_update(item_id:ID!,body:String!,parent_id:ID):Update!
      edit_update(id:ID!,body:String!):Update!
      delete_update(id:ID!):Update!
      like_update(update_id:ID!):Update!
      unlike_update(update_id:ID!):Update!
      pin_to_top(id:ID!,item_id:ID!):Update!
      unpin_from_top(id:ID!,item_id:ID!):Update!`,
  },
  resolvers: { Query, Mutation, Update, Item },
  extras: {
    "Query.updates": {
      description:
        "Updates and replies by ID: those you can read, in the order asked.",
    },
    "Item.updates": {
      description:
        "Top-level updates: pinned first, then newest first (replies are Update.replies).",
    },
    "Item.updates_page": {
      description:
        "Top-level updates in the order of Item.updates, by cursor (a position: posts and deletions never shift a page).",
    },
    "Item.updates_count": {
      description: "How many updates the item has, replies included.",
    },
    "Update.author_name": {
      description:
        "The source author of an imported update who has no user here.",
    },
    "Update.body": {
      description:
        "The body with its mention tokens @[Name](user:12), @[Team](team:3) and @[Task](item:345); a task you cannot open reads Private task, a person or team you cannot see plain @Name text. Render body_parts instead.",
    },
    "Update.replies": {
      description:
        "Replies, oldest first: the newest limit of them (all without limit), older than before_id when given.",
    },
    "Update.replies_count": { description: "How many replies it has." },
    "Update.body_parts": {
      description:
        "The body as text, link and mention parts, with the names you may see.",
    },
    "Update.can_delete": {
      description: "Whether you may delete it: its author or a board owner.",
    },
    "BodyPart.text": {
      description:
        "What to show: the text, link or mention name (null for a task you cannot open: show Private task).",
    },
    "BodyPart.name": {
      description:
        "An item mention's current name; null when you cannot open its board.",
    },
    "Mutation.create_update": {
      description:
        "Posts an update on an item, or with parent_id a reply to one of its top-level updates (one level of replies).",
    },
    "Mutation.edit_update": { description: "Edits your own update's body." },
    "Mutation.pin_to_top": {
      description: "Pins a top-level update of the item to the top.",
    },
  },
};
