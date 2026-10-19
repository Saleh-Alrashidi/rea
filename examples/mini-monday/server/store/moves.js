/**
 * Moving items (SPEC-6 §1.3): `moveItem` changes an item's place in its
 * board's manual order, its parent, its group and values of its target
 * grouping in one commit. Everything is checked before anything is
 * written, so a refused move changes nothing.
 *
 * Neighbors name items of the same board: the item lands immediately
 * after `afterId` and/or immediately before `beforeId` in the board's
 * manual order (`positions.byPosition`, the moved item left out):
 * - `afterId` A alone: between A and the item that follows A;
 * - `beforeId` B alone: between the item that precedes B and B;
 * - both: between A and B, where A must come before B (items between
 *   them, such as those of other groups, keep their places).
 *
 * The server computes the position (the midpoint, `positions.js`, which
 * renumbers the board inside this commit when a side has no neighbor or
 * the gap is too small); without neighbors the item keeps its position.
 * `parentId` makes the item a subitem of that parent and `detachParent`
 * a top-level item (SPEC-5 §1.1 invariants, `subitems.moveParent`); its
 * subitems keep their parent, group and position. `groupId` changes the
 * group; `values` (`{ [columnId]: storedValue }`) are applied like
 * `setColumnValues`. `toGroupEnd` (move_item_to_group) puts an item that
 * changes group after every item of the board, so at the end of its new
 * group.
 *
 * Refusals: `not_found` (a neighbor, parent, group or column that is
 * unknown or on another board), `invalid_neighbor` (the item itself or
 * one of its subitems, or A not before B) and `invalid_parent`.
 *
 * Events: one `item_moved` `{ position, parent_item_id, group_id }`, then
 * one `item_renamed` / `column_value_changed` per changed value, then the
 * notifications of newly assigned people. Activity: `item_moved` for a
 * new group (group titles) and for a new parent ("Top level" or
 * "Subitem of “…”"), and the entries of the value changes; a new place
 * in the order alone is not logged, like a move within a group before.
 */
import { describe, isPlainObject } from "../input.js";
import {
  byId,
  commit,
  failure,
  invalid,
  itemEvent,
  onBoard,
  readBoolean,
  replace,
} from "../store-state.js";
import { quoted, recordActivity } from "./activity.js";
import { changedFields, changesOf, valueEvents } from "./items.js";
import {
  byPosition,
  midpoint,
  nextItemPosition,
  renumber,
  renumberedMidpoint,
} from "./positions.js";
import { moveParent, subtreeOf } from "./subitems.js";

const notOnBoard = (what, id) =>
  failure("not_found", {
    message: `${what} ${describe(id)} is not on this board`,
  });
const badNeighbor = (message) => failure("invalid_neighbor", { message });

const optionalId = (value, label) => {
  if (value === null || typeof value === "string") return value;
  throw new TypeError(`${label} must be an ID string or null`);
};

/** The move request with its defaults; wrong types throw a TypeError. */
function readMove(request) {
  if (!isPlainObject(request)) throw new TypeError("move must be an object");
  const {
    afterId = null,
    beforeId = null,
    parentId = null,
    detachParent = false,
    groupId = null,
    values = {},
    toGroupEnd = false,
  } = request;
  const move = {
    afterId: optionalId(afterId, "afterId"),
    beforeId: optionalId(beforeId, "beforeId"),
    parentId: optionalId(parentId, "parentId"),
    groupId: optionalId(groupId, "groupId"),
    detachParent: readBoolean(detachParent, "detachParent"),
    toGroupEnd: readBoolean(toGroupEnd, "toGroupEnd"),
    values,
  };
  if (move.detachParent && move.parentId !== null) {
    invalid("Give a new parent or detach the item, not both");
  }
  if (move.toGroupEnd && (move.afterId !== null || move.beforeId !== null)) {
    throw new TypeError("toGroupEnd takes no neighbors");
  }
  return move;
}

/** A neighbor of `item` (outside its subtree `ids`), or a failure. */
function readNeighbor(state, { item, id, ids }) {
  if (id === null) return null;
  const neighbor = byId(state.items, id);
  if (!neighbor || neighbor.board_id !== item.board_id) {
    return notOnBoard("Item", id);
  }
  if (neighbor === item || ids.has(neighbor.id)) {
    return badNeighbor(
      "An item cannot be placed next to itself or its subitems",
    );
  }
  return neighbor;
}

/**
 * Where the item goes: null (no neighbors: it keeps its position), a
 * failure, or `{ order, slot }` with the board's other items in manual
 * order and the indexes `{ lo, hi }` of the neighbors it lands between
 * (-1 and `order.length` are the start and end of the board).
 */
function readPlace(state, { item, move, subtree }) {
  const after = readNeighbor(state, { item, id: move.afterId, ...subtree });
  if (after?.ok === false) return after;
  const before = readNeighbor(state, { item, id: move.beforeId, ...subtree });
  if (before?.ok === false) return before;
  if (!after && !before) return null;
  const order = state.items
    .filter((r) => r.board_id === item.board_id && r !== item)
    .sort(byPosition);
  const lo = after ? order.indexOf(after) : order.indexOf(before) - 1;
  const hi = before ? order.indexOf(before) : lo + 1;
  if (lo >= hi) {
    return badNeighbor("after_item_id must come before before_item_id");
  }
  return { order, slot: { lo, hi } };
}

/** The item's parent ID after the move (null: top level), or a failure. */
function readParent(state, { item, move, subtree }) {
  if (move.detachParent) return { parentId: null };
  if (move.parentId === null) return { parentId: item.parent_id ?? null };
  const { parentId } = move;
  const parent = moveParent(state, { item, parentId, subtree });
  return parent.ok === false ? parent : { parentId: parent.id };
}

/** Whether `fields` (`{ name, values }`) change `column` of `item`. */
function differs(item, fields, column) {
  if (column.type === "name") return fields.name !== item.name;
  const [from, to] = [item.values[column.id], fields.values[column.id]];
  return JSON.stringify(from) !== JSON.stringify(to);
}

/**
 * Everything the move needs, checked; or a failure. `changes` keeps the
 * values that change, so only those log and emit.
 */
function prepare(ctx, item, move) {
  const { state } = ctx;
  const subtree = subtreeOf(state.items, item);
  const place = readPlace(state, { item, move, subtree });
  if (place?.ok === false) return place;
  const parent = readParent(state, { item, move, subtree });
  if (parent.ok === false) return parent;
  const groupId = move.groupId ?? item.group_id;
  const group = onBoard(state.groups, item.board_id, groupId);
  if (!group) return notOnBoard("Group", groupId);
  const changes = changesOf(state, item, move.values);
  if (!changes) {
    const message = "The values name a column that is not on this board";
    return failure("not_found", { message });
  }
  const fields = changedFields(ctx, item, changes);
  const toEnd = move.toGroupEnd && group.id !== item.group_id;
  const changed = changes.filter(({ column }) => differs(item, fields, column));
  const parentId = parent.parentId;
  return { place, parentId, group, changes: changed, fields, toEnd };
}

/** The item's new position; renumbers the board when it must. */
function newPosition(state, { item, place, toEnd }) {
  if (toEnd) return nextItemPosition(state.items, item.board_id);
  if (place === null) return item.position;
  const mid = midpoint(place.order, place.slot);
  if (mid !== null) return mid;
  renumber(state.items, place.order);
  return renumberedMidpoint(place.slot);
}

/** "Top level" or "Subitem of “Parent”" (activity texts). */
function parentText(state, record) {
  if (record.parent_id === undefined) return "Top level";
  return `Subitem of ${quoted(byId(state.items, record.parent_id).name)}`;
}

/** Logs a new group and a new parent of `item` (now `next`). */
function logMove(ctx, { item, next, actorId }) {
  const { state } = ctx;
  const log = (fromText, toText) =>
    recordActivity(ctx, {
      boardId: next.board_id,
      itemId: next.id,
      itemName: next.name,
      kind: "item_moved",
      actorId,
      fromText,
      toText,
    });
  const titleOf = (record) =>
    onBoard(state.groups, record.board_id, record.group_id).title;
  if (next.group_id !== item.group_id) log(titleOf(item), titleOf(next));
  if (next.parent_id !== item.parent_id) {
    log(parentText(state, item), parentText(state, next));
  }
}

function moveItem(ctx, id, request, actorId) {
  const { state } = ctx;
  const item = byId(state.items, id);
  if (!item) return null;
  const move = readMove(request);
  const ready = prepare(ctx, item, move);
  if (ready.ok === false) return ready;
  const position = newPosition(state, { item, ...ready });
  const { parent_id: _parent, ...rest } = item;
  const next = {
    ...rest,
    ...(ready.parentId === null ? {} : { parent_id: ready.parentId }),
    ...ready.fields,
    group_id: ready.group.id,
    position,
    updated_at: ctx.now(),
  };
  replace(state.items, item, next);
  logMove(ctx, { item, next, actorId });
  const { changes } = ready;
  ctx.pending.unshift(...valueEvents(ctx, { item, next, changes, actorId }));
  const moved = { position, parent_item_id: ready.parentId };
  return commit(ctx, itemEvent("item_moved", next, moved), next);
}

export function moveApi(ctx) {
  return {
    /**
     * Moves item `id` (see the module comment): `move` is `{ afterId,
     * beforeId, parentId, detachParent, groupId, values, toGroupEnd }`,
     * all optional. Unknown item → null; refusals are failures and
     * change nothing.
     */
    moveItem: (id, move = {}, { actorId = null } = {}) =>
      moveItem(ctx, id, move, actorId),
  };
}
