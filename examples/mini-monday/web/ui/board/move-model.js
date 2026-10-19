/**
 * Moving tasks in a board's manual order (SPEC-6 §1.2, §1.3), pure.
 *
 * A move request is `{ itemId, afterId?, beforeId?, parentId?, groupId?,
 * values? }` in UI terms:
 * - `afterId` / `beforeId` name the neighbors the task lands between,
 *   with `move_item`'s meaning: immediately after A, or immediately
 *   before B, in the board's manual order (all of its items by position,
 *   then ID, the task itself left out). Inside any grouping the tasks of
 *   a group are in that order, so naming the task's new previous (or,
 *   first in the list, next) sibling there is enough (`neighborsAt`).
 * - `parentId` is absent to keep the parent, null for the top level and
 *   an ID to nest the task; `groupId` (absent: kept) is a new board group;
 *   `values` (`{ [columnId]: uiValue }`) are the values of the grouping
 *   the task lands in.
 *
 * The server computes positions. Until the refresh after the call brings
 * them, the moved rows take a provisional place (`applyMove`) that
 * follows the same neighbor rule.
 *
 * `undoMoves` records, before a move, what puts each task back: the item
 * before it in the manual order outside its own subtree (else the next
 * item that does not move), its parent, its group and the values the
 * move changes. The records come in the tasks' original manual order, so
 * each lands next to an item that is already back in place.
 */

import { byManualOrder, descendantIds } from "./list-model.js";
import { displayText } from "./values.js";

/** Where a provisional place before the first or after the last item lies. */
const END_GAP = 512;

/** `items` in manual order, without the IDs in `skip`. */
export function manualOrder(items, skip = new Set()) {
  return items.filter((item) => !skip.has(item.id)).sort(byManualOrder);
}

/**
 * The neighbor that puts a task at `index` of `siblings` (in display
 * order, the moved tasks left out): the sibling before that place, else
 * the first one after it, else none. Siblings in `skip` (the moved task's
 * own subtasks, which `move_item` refuses as neighbors; a kanban lane can
 * show them) are passed over: the next sibling after the place is taken
 * instead, else the nearest one before it.
 */
export function neighborsAt(siblings, index, skip = new Set()) {
  const free = (sibling) => sibling && !skip.has(sibling.id);
  if (free(siblings[index - 1])) return { afterId: siblings[index - 1].id };
  const next = siblings.slice(index).find(free);
  if (next) return { beforeId: next.id };
  const earlier = siblings.slice(0, index).findLast(free);
  return earlier ? { afterId: earlier.id } : {};
}

/**
 * The provisional position of `item` once it lands next to `afterId` /
 * `beforeId` among `items` (the server's rule; its own position when the
 * request has no neighbors or names one that is not loaded).
 */
export function provisionalPosition(items, item, request) {
  const { afterId = null, beforeId = null } = request;
  if (afterId === null && beforeId === null) return item.position;
  const order = manualOrder(items, new Set([item.id]));
  const at = (id) => order.findIndex((entry) => entry.id === id);
  const low = afterId === null ? at(beforeId) - 1 : at(afterId);
  const high = beforeId === null ? low + 1 : at(beforeId);
  if ((afterId !== null && low < 0) || (beforeId !== null && high < 0)) {
    return item.position;
  }
  const from = order[low]?.position;
  const to = order[high]?.position;
  if (from === undefined) return to - END_GAP;
  if (to === undefined) return from + END_GAP;
  return (from + to) / 2;
}

/**
 * Applies `request` to the loaded `board` at once (the optimistic move):
 * the provisional place, the parent, the group and the values with their
 * display texts (`users` names people).
 */
export function applyMove(board, request, users) {
  const item = board.items.find((entry) => entry.id === request.itemId);
  if (!item) return;
  item.position = provisionalPosition(board.items, item, request);
  if (request.parentId !== undefined) item.parentId = request.parentId;
  if (request.groupId !== undefined) item.groupId = request.groupId;
  for (const [columnId, value] of Object.entries(request.values ?? {})) {
    const column = board.columns.find((entry) => entry.id === columnId);
    if (!column) continue;
    item.values[columnId] = value;
    item.texts[columnId] = displayText(column, value, users);
  }
}

/**
 * Where `item` sits in `order` (the board's manual order): after the
 * nearest earlier item outside its `subtree`, else before the nearest
 * later one that neither belongs to it nor `moves`, else nowhere.
 */
function placeOf(order, item, { subtree, moved }) {
  const index = order.indexOf(item);
  for (let at = index - 1; at >= 0; at -= 1) {
    if (!subtree.has(order[at].id)) return { afterId: order[at].id };
  }
  for (let at = index + 1; at < order.length; at += 1) {
    const { id } = order[at];
    if (!subtree.has(id) && !moved.has(id)) return { beforeId: id };
  }
  return {};
}

const copy = (value) => (value === undefined ? null : structuredClone(value));

/**
 * The requests that undo `requests` on `board`, recorded before they are
 * applied: each task's place, and its parent, group and values where a
 * request changes them; in the tasks' original manual order.
 */
export function undoMoves(board, requests) {
  const order = manualOrder(board.items);
  const moved = new Set(requests.map((request) => request.itemId));
  const records = [];
  for (const request of requests) {
    const item = order.find((entry) => entry.id === request.itemId);
    if (!item) continue;
    const subtree = descendantIds(board.items, item.id).add(item.id);
    const back = {
      itemId: item.id,
      ...placeOf(order, item, { subtree, moved }),
    };
    if (request.parentId !== undefined) back.parentId = item.parentId;
    if (request.groupId !== undefined) back.groupId = item.groupId;
    if (request.values) {
      const columns = Object.keys(request.values);
      back.values = Object.fromEntries(
        columns.map((id) => [id, copy(item.values[id])]),
      );
    }
    records.push({ back, rank: order.indexOf(item) });
  }
  return records.sort((a, b) => a.rank - b.rank).map((record) => record.back);
}

/**
 * Dropping kanban card `item` at `index` of `lane` (of status `column`):
 * `cards` are the lane's cards in display order (the card itself among
 * them when it comes from this lane, `fromKey` being its lane's key) and
 * `items` the board's, whose subtasks of `item` are no neighbors.
 * Returns the move request (its new neighbors and, from another lane, the
 * lane's label, or none for "No status"), or null when nothing changes.
 */
export function laneMove({ item, items, cards, index, lane, column, fromKey }) {
  const others = cards.filter((card) => card.id !== item.id);
  const slot = Math.max(0, Math.min(index, others.length));
  const same = fromKey === lane.key;
  if (same && cards.indexOf(item) === slot) return null;
  const subtree = descendantIds(items, item.id);
  const request = { itemId: item.id, ...neighborsAt(others, slot, subtree) };
  if (!same) request.values = { [column.id]: lane.index };
  return request;
}
