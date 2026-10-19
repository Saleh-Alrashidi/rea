/**
 * Moving an item to another board (SPEC-6 §3.2 `move_item_to_board`).
 * The item keeps its ID and takes its subitems along, so its updates,
 * their replies and likes (which name the item) move with it. Everything
 * is checked before anything is written, so a refused move changes
 * nothing.
 *
 * - Place: the item becomes a top-level item of the target board, in
 *   `groupId` (else the board's first group), after every item of that
 *   board (so at the end of the group); its subitems follow in their
 *   manual order, in the same group, and keep their parents, so the
 *   moved subtree keeps its shape (its depth only shrinks).
 * - Values: each column of the source board maps to the target column
 *   with the same role, else to one with exactly the same title and
 *   type (each target column takes at most one); the name always
 *   carries over. Values are converted by `column-values.js`
 *   (`convertStoredValue`): status labels by name, case-insensitively,
 *   else no status; people only who can open the target board
 *   (`access.canBeAssigned`). `droppedColumns` lists the titles of the
 *   unmapped source columns that held a value on a moved item, in board
 *   order.
 * - Activity: one `item_moved` entry on each board, from the source
 *   board to the target. The entry's own board is named as text; the
 *   other board is a rich-text reference (`activity.boardRef`), which
 *   each reader sees by name only when they can open that board, else as
 *   "another board" (`activity.OTHER_BOARD`), so a log tells nobody the
 *   name of a board they may not open.
 * - Events: `item_moved_to_board` on the target board (`from_board_id`)
 *   for the item, then for each subitem, then on the source board
 *   (`to_board_id`) for the item and each subitem.
 *
 * Refusals: `not_found` (a group not on the target board) and
 * `same_board`.
 */
import { canBeAssigned } from "../access.js";
import { convertStoredValue } from "../column-values.js";
import { describe } from "../input.js";
import {
  byId,
  commit,
  failure,
  forBoard,
  itemEvent,
  replace,
  sortedGroups,
} from "../store-state.js";
import { boardRef, recordActivity } from "./activity.js";
import { POSITION_SPACING, byPosition, nextItemPosition } from "./positions.js";
import { withDescendants } from "./subitems.js";

/**
 * Target column per source column ID: by role first, then by exact title
 * and type; each target column is taken once.
 */
function columnMapping(state, { source, target }) {
  const valued = (boardId) =>
    forBoard(state.columns, boardId).filter((c) => c.type !== "name");
  const from = valued(source.id);
  const to = valued(target.id);
  const mapping = new Map();
  const taken = new Set();
  const take = (column, match) => {
    const found = to.find((each) => !taken.has(each) && match(each));
    if (!found) return;
    mapping.set(column.id, found);
    taken.add(found);
  };
  for (const column of from) {
    if (column.role !== undefined) take(column, (t) => t.role === column.role);
  }
  for (const column of from) {
    if (mapping.has(column.id)) continue;
    take(column, (t) => t.title === column.title && t.type === column.type);
  }
  return { from, mapping };
}

/**
 * The values of `item` on the target board, adding the IDs of source
 * columns it loses to `dropped`.
 */
function mappedValues({ item, columns, keepUser, dropped }) {
  const values = {};
  for (const column of columns.from) {
    const stored = item.values[column.id];
    if (stored === undefined) continue;
    const to = columns.mapping.get(column.id);
    if (!to) {
      dropped.add(column.id);
      continue;
    }
    const value = convertStoredValue({ from: column, to, stored, keepUser });
    if (value !== null) values[to.id] = value;
  }
  return values;
}

/** Everything the move writes, checked; or a failure. */
function prepare(ctx, { item, target, groupId }) {
  const { state } = ctx;
  const source = byId(state.boards, item.board_id);
  if (source === target) {
    const message = "The item is already on this board";
    return failure("same_board", { message });
  }
  const groups = sortedGroups(state, target.id);
  const group = groupId === null ? groups[0] : byId(groups, groupId);
  if (!group) {
    const message = `Group ${describe(groupId)} is not on this board`;
    return failure("not_found", { message });
  }
  const ids = withDescendants(state.items, new Set([item.id]));
  const subitems = state.items
    .filter((each) => each !== item && ids.has(each.id))
    .sort(byPosition);
  const columns = columnMapping(state, { source, target });
  const memo = new Map();
  const keepUser = (id) => {
    if (!memo.has(id)) {
      memo.set(id, canBeAssigned(ctx.reader, byId(state.users, id), target));
    }
    return memo.get(id);
  };
  const dropped = new Set();
  const first = nextItemPosition(state.items, target.id);
  const at = ctx.now();
  const moved = [item, ...subitems].map((record, index) => {
    const { parent_id: parentId, ...rest } = record;
    const values = mappedValues({ item: record, columns, keepUser, dropped });
    const next = {
      ...rest,
      board_id: target.id,
      group_id: group.id,
      ...(record === item ? {} : { parent_id: parentId }),
      position: first + index * POSITION_SPACING,
      updated_at: at,
      values,
    };
    return { record, next };
  });
  const droppedColumns = columns.from
    .filter((column) => dropped.has(column.id))
    .map((column) => column.title);
  return { source, moved, droppedColumns };
}

function moveItemToBoard(ctx, { id, boardId, groupId, actorId }) {
  const { state } = ctx;
  const item = byId(state.items, id);
  const target = byId(state.boards, boardId);
  if (!item || !target) return null;
  const ready = prepare(ctx, { item, target, groupId });
  if (ready.ok === false) return ready;
  const { source, moved, droppedColumns } = ready;
  for (const { record, next } of moved) replace(state.items, record, next);
  const log = (boardId, fromText, toText) =>
    recordActivity(ctx, {
      boardId,
      actorId,
      kind: "item_moved",
      itemId: item.id,
      itemName: item.name,
      fromText,
      toText,
    });
  log(source.id, source.name, [boardRef(target.id)]);
  log(target.id, [boardRef(source.id)], target.name);
  const into = { from_board_id: source.id };
  const out = { to_board_id: target.id };
  const [main, ...rest] = moved.map(({ next }) =>
    itemEvent("item_moved_to_board", next, into),
  );
  ctx.pending.unshift(
    ...rest,
    ...moved.map(({ record }) => itemEvent("item_moved_to_board", record, out)),
  );
  const result = { item: moved[0].next, droppedColumns };
  return commit(ctx, main, Object.freeze(result));
}

export function transferApi(ctx) {
  return {
    /**
     * Moves item `id` with its subitems to board `boardId` (see the
     * module comment): `{ boardId, groupId }` (`groupId` null: the first
     * group). Returns `{ item, droppedColumns }`; unknown item or board →
     * null; refusals are failures and change nothing.
     */
    moveItemToBoard(id, { boardId, groupId = null } = {}, opts = {}) {
      const { actorId = null } = opts;
      return moveItemToBoard(ctx, { id, boardId, groupId, actorId });
    },
  };
}
