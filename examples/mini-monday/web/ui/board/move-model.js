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
 * `undoMoves` records, before a move, what puts each task back: its place
 * in the manual order (`placeOf`), its parent, its group and the values
 * the move changes. The records come in the tasks' original manual order,
 * so each lands next to an item that is already back in place.
 *
 * Limit: `move_item` refuses the moved task's own subtasks as neighbors,
 * so no request names a place strictly between two of them in the manual
 * order (one of them right before the place, one right after it), nor
 * one before (after) a run of them that starts (ends) the board. Undo
 * then puts the task back after the run, or before it when the run ends
 * the board (`placeOf`); a kanban drop there is refused (`laneMove`).
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
 * order, the moved tasks and their subtasks left out): the sibling before
 * that place, else the first one after it, else none.
 */
export function neighborsAt(siblings, index) {
  const before = siblings[Math.min(index, siblings.length) - 1];
  if (before) return { afterId: before.id };
  return siblings.length > 0 ? { beforeId: siblings[0].id } : {};
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
 * item right before it when that is outside its `subtree`; else (first,
 * or right after one of its own subtasks) before the nearest later item
 * outside the subtree that is not `moved` either (it is still in place
 * when this record runs); else after the nearest earlier item outside the
 * subtree; else nowhere. Between two of its own subtasks it comes back
 * after the run of later ones (the limit in the module comment).
 */
function placeOf(order, item, { subtree, moved }) {
  const index = order.indexOf(item);
  const free = (entry) => !subtree.has(entry.id);
  const previous = order[index - 1];
  if (previous && free(previous)) return { afterId: previous.id };
  const later = order
    .slice(index + 1)
    .find((entry) => free(entry) && !moved.has(entry.id));
  if (later) return { beforeId: later.id };
  const earlier = order.slice(0, index).findLast(free);
  return earlier ? { afterId: earlier.id } : {};
}

const copy = (value) => (value === undefined ? null : structuredClone(value));

/** Whether `request` names no neighbors: `move_item` keeps the position. */
const keepsPlace = (request) =>
  (request.afterId ?? null) === null && (request.beforeId ?? null) === null;

/**
 * The requests that undo `requests` on `board`, recorded before they are
 * applied: each task's place (none when its request keeps the position),
 * and its parent, group and values where a request changes them; in the
 * tasks' original manual order.
 */
export function undoMoves(board, requests) {
  const order = manualOrder(board.items);
  const moved = new Set(requests.map((request) => request.itemId));
  const records = [];
  for (const request of requests) {
    const item = order.find((entry) => entry.id === request.itemId);
    if (!item) continue;
    const back = { itemId: item.id };
    if (!keepsPlace(request)) {
      const subtree = descendantIds(board.items, item.id).add(item.id);
      Object.assign(back, placeOf(order, item, { subtree, moved }));
    }
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
 * The neighbors that put a kanban card between the lane's cards
 * `previous` and `next` (either may be missing), resolved in the board's
 * manual `order` (the card left out) rather than in the lane: the lane
 * can show the card's own subtasks (`subtree`), which are no neighbors,
 * and items of other lanes sit between its cards. "Free" items are
 * outside the subtree.
 * - After `previous` when it is free, else before the first free item
 *   after it (past its run of subtasks) unless that is past `next`.
 * - First in the lane: before `next` when it is free, else after the last
 *   free item before it.
 * Null when no neighbors name that place (the module comment's limit).
 */
function laneNeighbors(order, { previous, next, subtree }) {
  const free = (entry) => entry !== undefined && !subtree.has(entry.id);
  const at = (card) => order.findIndex((entry) => entry.id === card.id);
  if (free(previous)) return { afterId: previous.id };
  if (previous) {
    const later = order.slice(at(previous) + 1).find(free);
    const fits = later && (!next || at(later) <= at(next));
    return fits ? { beforeId: later.id } : null;
  }
  if (!next) return {};
  if (free(next)) return { beforeId: next.id };
  const earlier = order.slice(0, at(next)).findLast(free);
  return earlier ? { afterId: earlier.id } : null;
}

/**
 * Where kanban card `item` lands between the lane's cards `previous` and
 * `next` among the board's `items`: `{ stays, neighbors }`, `stays` when
 * it already sits there in the manual order (no neighbors needed), else
 * `laneNeighbors` (null when none name the place).
 */
function lanePlace(items, item, { previous, next }) {
  const full = manualOrder(items);
  const own = full.findIndex((entry) => entry.id === item.id);
  const order = full.filter((entry) => entry.id !== item.id);
  const at = (id) => order.findIndex((entry) => entry.id === id);
  const there =
    (!previous || at(previous.id) < own) && (!next || own <= at(next.id));
  if (there) return { stays: true, neighbors: {} };
  const subtree = descendantIds(items, item.id);
  const neighbors = laneNeighbors(order, { previous, next, subtree });
  return { stays: false, neighbors };
}

/**
 * Dropping kanban card `item` at `index` of `lane` (of status `column`):
 * `cards` are the lane's cards in display order, which is the manual
 * order (the card itself among them when it comes from this lane,
 * `fromKey` being its lane's key), and `items` the board's. Returns the
 * move request (from another lane the lane's label, or none for "No
 * status"; the neighbors that put the card at that place, none when it
 * already sits there, `lanePlace`), or null when the drop changes nothing
 * (dropped where it is, in its own lane) or no request lands it there
 * (a place only its own subtasks could name, the module comment's limit).
 */
export function laneMove({ item, items, cards, index, lane, column, fromKey }) {
  const others = cards.filter((card) => card.id !== item.id);
  const slot = Math.max(0, Math.min(index, others.length));
  const same = fromKey === lane.key;
  const place = { previous: others[slot - 1], next: others[slot] };
  const { stays, neighbors } = lanePlace(items, item, place);
  if (!neighbors || (same && stays)) return null;
  const request = { itemId: item.id, ...neighbors };
  if (!same) request.values = { [column.id]: lane.index };
  return request;
}
