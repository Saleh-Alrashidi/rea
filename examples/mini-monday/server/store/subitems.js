/**
 * Subitems (SPEC-5 §1.1): an item may have a parent item on the same
 * board, stored as `parent_id` (absent for top-level items, never null).
 *
 * This module owns the parent invariants that every write and the data
 * file check apply: the parent exists, is active and is on the same board;
 * it is not the item itself; there are no cycles; and an item is at most
 * MAX_SUBITEM_DEPTH levels deep (a top-level item has depth 0). A subitem
 * may sit in another group than its parent, and nesting is by `parent_id`,
 * never by position. Removing an item removes its descendants
 * (`withDescendants`, applied by `boards.removeItems`), so no `parent_id`
 * can dangle.
 */
import { describe } from "../input.js";
import { byId, failure } from "../store-state.js";

export const MAX_SUBITEM_DEPTH = 5;

/** Why the parent link of `item` is broken (`items` by ID), else null. */
function linkProblem(items, item) {
  const parentId = item.parent_id;
  if (parentId === undefined) return null;
  if (parentId === item.id) return `item ${item.id} is its own parent`;
  const parent = items.get(parentId);
  if (!parent) return `item ${item.id} has a missing parent ${parentId}`;
  if (parent.board_id !== item.board_id) {
    return `item ${item.id} has a parent on another board (${parentId})`;
  }
  if (parent.state !== "active") {
    return `item ${item.id} has an inactive parent ${parentId}`;
  }
  return null;
}

/**
 * Records the depth of `item` and of its ancestors in `depths` (each item
 * is walked once overall); returns why the chain is broken, else null.
 */
function chainProblem(items, depths, item) {
  const path = [];
  const onPath = new Set();
  let at = item;
  while (at && !depths.has(at.id)) {
    if (onPath.has(at.id)) return `item ${at.id} is in a parent cycle`;
    onPath.add(at.id);
    path.push(at);
    at = at.parent_id === undefined ? null : items.get(at.parent_id);
  }
  let depth = at ? depths.get(at.id) : -1;
  for (const record of path.reverse()) {
    depth += 1;
    depths.set(record.id, depth);
    if (depth > MAX_SUBITEM_DEPTH) {
      return `item ${record.id} is nested ${depth} levels deep (at most ${MAX_SUBITEM_DEPTH})`;
    }
  }
  return null;
}

/**
 * Why `items` (item records of any boards) break the parent invariants: a
 * message naming the first offending item, else null. Linear in `items`.
 */
export function parentProblem(items) {
  const index = new Map(items.map((item) => [item.id, item]));
  for (const item of items) {
    const problem = linkProblem(index, item);
    if (problem) return problem;
  }
  const depths = new Map();
  for (const item of items) {
    const problem = chainProblem(index, depths, item);
    if (problem) return problem;
  }
  return null;
}

/** The depth of a stored item (0 for top-level items). */
function depthOf(state, item) {
  let depth = 0;
  for (let at = item; at.parent_id !== undefined; depth += 1) {
    at = byId(state.items, at.parent_id);
  }
  return depth;
}

/**
 * The parent of a new item on `boardId`: the active item `parentId` of
 * that board, with room for one more level. Fails with `not_found`
 * (unknown, or on another board) or `invalid_parent` (too deep).
 */
export function newItemParent(state, { boardId, parentId }) {
  const parent = byId(state.items, parentId);
  if (!parent || parent.board_id !== boardId || parent.state !== "active") {
    return failure("not_found", {
      message: `Parent item ${describe(parentId)} is not on this board`,
    });
  }
  if (depthOf(state, parent) >= MAX_SUBITEM_DEPTH) {
    return failure("invalid_parent", {
      message: `Subitems nest at most ${MAX_SUBITEM_DEPTH} levels deep`,
    });
  }
  return parent;
}

/** Adds to `ids` (a Set of item IDs) every descendant of those items. */
export function withDescendants(items, ids) {
  const children = new Map();
  for (const item of items) {
    if (item.parent_id === undefined) continue;
    const list = children.get(item.parent_id);
    if (list) list.push(item.id);
    else children.set(item.parent_id, [item.id]);
  }
  const queue = [...ids];
  while (queue.length > 0) {
    for (const child of children.get(queue.pop()) ?? []) {
      if (ids.has(child)) continue;
      ids.add(child);
      queue.push(child);
    }
  }
  return ids;
}
