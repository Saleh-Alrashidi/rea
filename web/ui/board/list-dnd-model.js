/**
 * Drop resolution of the List view (SPEC-6 §1.4), pure: where dragging
 * over a row, a group header or an empty group puts the dragged tasks,
 * whether that is allowed, the move requests that do it (`move-model.js`)
 * and the indicator the view paints. Keyboard moves and the row menu
 * resolve through the same `resolveDrop`.
 *
 * Targets:
 * - `{ type: "row", rowKey, zone, strict? }`: a row's top 35% is
 *   "before", its bottom 35% "after" and the middle 30% "inside"
 *   (`zoneAt`). Before / after make the task that row's sibling (its
 *   parent; the top level at depth 0). "After" an expanded parent whose
 *   subtasks show lands before its first subtask, where the line is
 *   drawn, unless `strict` (the keyboard's "after this row"). Inside
 *   makes the task the row's last subtask.
 * - `{ type: "group", groupKey }`: a group header or an empty group: the
 *   end of that group, at the top level.
 * - `{ type: "parent", itemId }`: the last subtask of that task, wherever
 *   it shows (the row menu's "Make subtask of…").
 *
 * Landing at the top level of a group the task is not in applies the
 * group's `move` (`listGroups`: a status or priority label or none, the
 * assignees replaced or cleared, the board group); a nested landing keeps
 * the task's own values, as subtasks carry their own status.
 *
 * Invalid drops (`reason`): "own-subtree" (into or next to a dragged
 * task's subtree), "too-deep" (past MAX_SUBTASK_DEPTH), "no-op" (nothing
 * would change) and "mixed" (a selection holding a task and one of its
 * descendants). Several tasks land in display order, each right after
 * the one before.
 */

import { buildTree, descendantIds } from "./list-model.js";
import { manualOrder, neighborsAt } from "./move-model.js";

/** Deepest subtask level (SPEC-5 §1.1; a top-level task is at depth 0). */
export const MAX_SUBTASK_DEPTH = 5;
/** The share of a row's height that means "before" (and "after"). */
const EDGE_SHARE = 0.35;

/** The zone of a row at `offset` px from its top, of `height` px. */
export function zoneAt(offset, height) {
  const share = height > 0 ? offset / height : 0.5;
  if (share < EDGE_SHARE) return "before";
  if (share >= 1 - EDGE_SHARE) return "after";
  return "inside";
}

/**
 * The List view's rows as drops see them: `rows` in display order, each
 * `{ item, depth, childCount, expanded, key, groupKey, parentId, index }`
 * (`key` is `<group key>:<item ID>`, `parentId` the row's parent in the
 * display, null at the top level), by `key` in `byKey`; the `groups`
 * (`listGroups`) by key, the grouping's `keysOf`, the board's full `tree`
 * and its items `byId`.
 */
export function listLayout(board, { groups, keysOf }) {
  const rows = [];
  for (const group of groups) {
    const parents = [];
    for (const row of group.rows) {
      parents.length = row.depth;
      rows.push({
        ...row,
        key: `${group.key}:${row.item.id}`,
        groupKey: group.key,
        parentId: parents[row.depth - 1] ?? null,
        index: rows.length,
      });
      parents[row.depth] = row.item.id;
    }
  }
  return {
    board,
    rows,
    byKey: new Map(rows.map((row) => [row.key, row])),
    groups: new Map(groups.map((group) => [group.key, group])),
    keysOf,
    tree: buildTree(board.items),
    byId: new Map(board.items.map((item) => [item.id, item])),
  };
}

/** The loaded ancestors' IDs of `item`, nearest first. */
function ancestorIds(layout, item) {
  const ids = [];
  let at = item;
  while (at.parentId && layout.byId.has(at.parentId)) {
    if (ids.includes(at.parentId) || at.parentId === item.id) break;
    ids.push(at.parentId);
    at = layout.byId.get(at.parentId);
  }
  return ids;
}

/** How many levels of subtasks `id` has below it (0 for none). */
function heightOf(tree, id, seen = new Set()) {
  if (seen.has(id)) return 0;
  seen.add(id);
  const children = tree.children.get(id) ?? [];
  let height = 0;
  for (const child of children) {
    height = Math.max(height, 1 + heightOf(tree, child.id, seen));
  }
  return height;
}

/** Rows of one sibling list: same group, depth and display parent. */
function siblingRows(layout, { groupKey, depth, parentId }) {
  return layout.rows.filter(
    (row) =>
      row.groupKey === groupKey &&
      row.depth === depth &&
      row.parentId === parentId,
  );
}

const itemsOf = (rows) => rows.map((row) => row.item);

/** A landing at the end of `item`'s subtasks. */
function insideOf(layout, { item, depth, group, indicator }) {
  const context = layout.tree.children.get(item.id) ?? [];
  return {
    group,
    parentId: item.id,
    depth,
    context,
    index: context.length,
    anchor: item,
    indicator,
  };
}

/** Where a row target lands (see the module comment). */
function rowLanding(layout, target) {
  const row = layout.byKey.get(target.rowKey);
  if (!row) return null;
  const group = layout.groups.get(row.groupKey) ?? null;
  const { item, depth } = row;
  if (target.zone === "inside") {
    const expand = row.childCount > 0 && !row.expanded;
    const indicator = { type: "inside", rowKey: row.key, expand };
    return insideOf(layout, { item, depth: depth + 1, group, indicator });
  }
  const next = layout.rows[row.index + 1];
  const opened =
    target.zone === "after" &&
    !target.strict &&
    row.expanded &&
    next?.groupKey === row.groupKey &&
    next.parentId === item.id;
  const level = opened ? depth + 1 : depth;
  const indicator = { type: "line", rowKey: row.key, edge: target.zone, level };
  if (opened) {
    const children = {
      groupKey: row.groupKey,
      depth: level,
      parentId: item.id,
    };
    const context = itemsOf(siblingRows(layout, children));
    return {
      group,
      parentId: item.id,
      depth: level,
      context,
      index: 0,
      indicator,
    };
  }
  const context = itemsOf(siblingRows(layout, row));
  const at = context.indexOf(item);
  const index = target.zone === "before" ? at : at + 1;
  const { parentId } = row;
  return { group, parentId, depth, context, index, anchor: item, indicator };
}

function landing(layout, target) {
  if (target.type === "row") return rowLanding(layout, target);
  if (target.type === "parent") {
    const item = layout.byId.get(target.itemId);
    if (!item) return null;
    const depth = ancestorIds(layout, item).length + 1;
    return insideOf(layout, { item, depth, group: null, indicator: null });
  }
  const group = layout.groups.get(target.groupKey);
  if (!group) return null;
  const top = { groupKey: group.key, depth: 0, parentId: null };
  const context = itemsOf(siblingRows(layout, top));
  const indicator = { type: "end", groupKey: group.key };
  const index = context.length;
  return { group, parentId: null, depth: 0, context, index, indicator };
}

const sameValue = (a, b) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The group and values `item` takes at the top level of `group`. */
function groupChange(layout, item, group) {
  if (!group || layout.keysOf(item).includes(group.key)) return {};
  const change = {};
  const { groupId, values } = group.move;
  if (groupId !== null && groupId !== item.groupId) change.groupId = groupId;
  const changed = Object.entries(values).filter(
    ([columnId, value]) => !sameValue(item.values[columnId], value),
  );
  if (changed.length > 0) change.values = Object.fromEntries(changed);
  return change;
}

/** The requests landing `items` at `index` of `siblings` in `place`. */
function landRequests(layout, { items, place, siblings, index }) {
  let previous = null;
  return items.map((item) => {
    const neighbors = previous
      ? { afterId: previous.id }
      : neighborsAt(siblings, index);
    const request = { itemId: item.id, ...neighbors };
    if ((item.parentId ?? null) !== place.parentId) {
      request.parentId = place.parentId;
    }
    if (place.depth === 0)
      Object.assign(request, groupChange(layout, item, place.group));
    previous = item;
    return request;
  });
}

/** Whether `moves` leave everything as it is. */
function changesNothing(place, { items, siblings, index, moves }) {
  const changes = (move) =>
    move.parentId !== undefined || move.groupId !== undefined || move.values;
  if (moves.some(changes)) return false;
  const after = [
    ...siblings.slice(0, index),
    ...items,
    ...siblings.slice(index),
  ];
  const ids = (list) => list.map((item) => item.id).join(",");
  return ids(after) === ids(place.context);
}

/** Why dropping `items` at `place` is not allowed, or null. */
function refusal(layout, { items, ids, place }) {
  const dragged = new Set(ids);
  const nested = (item) =>
    ancestorIds(layout, item).some((id) => dragged.has(id));
  if (items.some(nested)) return "mixed";
  const blocked = descendantIds(layout.board.items, ids);
  const anchor = place.anchor?.id;
  if (anchor && dragged.has(anchor) && place.parentId !== anchor) {
    return "no-op";
  }
  const inside = (id) => dragged.has(id) || blocked.has(id);
  if (
    (anchor && inside(anchor)) ||
    (place.parentId && inside(place.parentId))
  ) {
    return "own-subtree";
  }
  const height = Math.max(
    ...items.map((item) => heightOf(layout.tree, item.id)),
  );
  return place.depth + height > MAX_SUBTASK_DEPTH ? "too-deep" : null;
}

/**
 * Resolves dropping the tasks `ids` (in the order they land) on `target`.
 * Returns null when the target names nothing, else `{ ok, reason?, moves,
 * indicator, place }`: `moves` are the requests (empty unless `ok`),
 * `indicator` `{ type: "line", rowKey, edge, level } | { type: "inside",
 * rowKey, expand } | { type: "end", groupKey } | null` and `place` the
 * landing `{ group, parentId, depth, anchor? }`.
 */
export function resolveDrop(layout, { ids, target }) {
  const items = ids.map((id) => layout.byId.get(id));
  if (items.length === 0 || items.some((item) => !item)) return null;
  const place = target ? landing(layout, target) : null;
  if (!place) return null;
  const { indicator } = place;
  const reason = refusal(layout, { items, ids, place });
  if (reason) return { ok: false, reason, moves: [], indicator, place };
  const dragged = new Set([...ids, ...descendantIds(layout.board.items, ids)]);
  const siblings = place.context.filter((item) => !dragged.has(item.id));
  const index = place.context
    .slice(0, place.index)
    .filter((item) => !dragged.has(item.id)).length;
  const moves = landRequests(layout, { items, place, siblings, index });
  if (changesNothing(place, { items, siblings, index, moves })) {
    return { ok: false, reason: "no-op", moves: [], indicator, place };
  }
  return { ok: true, moves, indicator, place };
}

/**
 * The target of a keyboard move of row `rowKey` (SPEC-6 §1.4): Alt+Up /
 * Alt+Down move it among its siblings, Alt+Right makes it a subtask of
 * the previous sibling, Alt+Left moves it out of its parent, right after
 * it. `key` is the arrow key's name; null when there is nowhere to go.
 */
export function keyboardTarget(layout, { rowKey, key }) {
  const row = layout.byKey.get(rowKey);
  if (!row) return null;
  const siblings = siblingRows(layout, row);
  const at = siblings.indexOf(row);
  const rowTarget = (other, zone) =>
    other ? { type: "row", rowKey: other.key, zone, strict: true } : null;
  if (key === "ArrowUp") return rowTarget(siblings[at - 1], "before");
  if (key === "ArrowDown") return rowTarget(siblings[at + 1], "after");
  if (key === "ArrowRight") return rowTarget(siblings[at - 1], "inside");
  if (key !== "ArrowLeft" || row.parentId === null) return null;
  return rowTarget(
    layout.byKey.get(`${row.groupKey}:${row.parentId}`),
    "after",
  );
}

/**
 * The tasks a row menu can make `itemId` a subtask of: every loaded task
 * outside its subtree, other than its parent, with room for its subtasks
 * below; `{ item, depth }` in tree order.
 */
export function parentChoices(layout, itemId) {
  const item = layout.byId.get(itemId);
  if (!item) return [];
  const blocked = descendantIds(layout.board.items, itemId).add(itemId);
  const room = MAX_SUBTASK_DEPTH - 1 - heightOf(layout.tree, itemId);
  const choices = [];
  const visit = (entry, depth, seen) => {
    if (seen.has(entry.id) || blocked.has(entry.id)) return;
    seen.add(entry.id);
    if (depth <= room && entry.id !== item.parentId) {
      choices.push({ item: entry, depth });
    }
    for (const child of layout.tree.children.get(entry.id) ?? []) {
      visit(child, depth + 1, seen);
    }
  };
  const seen = new Set();
  for (const root of layout.tree.roots) visit(root, 0, seen);
  return choices;
}

// ------------------------------------------------------------ selection

/** `ids` in display order (rows first, then the board's manual order). */
export function selectionOrder(layout, ids) {
  const wanted = new Set(ids);
  const order = [];
  for (const row of layout.rows) {
    if (wanted.delete(row.item.id)) order.push(row.item.id);
  }
  for (const item of manualOrder(layout.board.items)) {
    if (wanted.delete(item.id)) order.push(item.id);
  }
  return order;
}

/** The IDs of the rows from `fromKey` to `toKey` (either way), inclusive. */
export function rowRange(layout, fromKey, toKey) {
  const to = layout.byKey.get(toKey);
  if (!to) return [];
  const from = layout.byKey.get(fromKey) ?? to;
  const [start, end] = [from.index, to.index].sort((a, b) => a - b);
  return layout.rows.slice(start, end + 1).map((row) => row.item.id);
}

/** The tasks a drag from row `rowKey` moves: the selection, if it holds it. */
export function draggedIds(layout, { rowKey, selected }) {
  const row = layout.byKey.get(rowKey);
  if (!row) return [];
  if (!selected.has(row.item.id)) return [row.item.id];
  return selectionOrder(layout, [...selected]);
}

// ------------------------------------------------------------- wording

const quote = (text) => `“${text}”`;

/** "“Name”" for one task, "3 tasks" for several. */
export function movedWhat(layout, moves) {
  if (moves.length !== 1) return `${moves.length} tasks`;
  return quote(layout.byId.get(moves[0].itemId)?.name ?? "task");
}

/** What a resolved drop did, for the live region. */
export function moveMessage(layout, { moves, place, indicator }) {
  const what = movedWhat(layout, moves);
  const parent = place.parentId && layout.byId.get(place.parentId);
  const into = place.group ? ` in ${place.group.label}` : "";
  if (indicator?.type === "end")
    return `Moved ${what} to the end of ${place.group.label}`;
  if (place.anchor && indicator?.type === "line") {
    return `Moved ${what} ${indicator.edge} ${quote(place.anchor.name)}${into}`;
  }
  if (parent) return `Moved ${what} into ${quote(parent.name)} as a subtask`;
  return `Moved ${what}${into}`;
}
