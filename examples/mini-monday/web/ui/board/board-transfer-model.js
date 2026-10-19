/**
 * Moving tasks to another board (SPEC-6 §3.2 `move_item_to_board`),
 * pure: which tasks a move takes, the columns whose values it would
 * leave behind (a preview for the confirm dialog) and the wording.
 *
 * The server owns the mapping and reports the columns it actually
 * dropped (`dropped_columns`); the preview follows the same published
 * rule so the confirm can list them first: each source column (but the
 * name) maps to the target column with the same role, else to one with
 * exactly the same title and type, each target column taken once; a
 * column without a match whose value is set on a moved task (or one of
 * its subtasks) is dropped.
 */

import { isEmptyValue } from "./values.js";

const valued = (columns) => columns.filter((column) => column.type !== "name");
const hasRole = (column) => column.role !== null && column.role !== undefined;

/** Target column per source column ID (role first, then title and type). */
export function columnMapping(sourceColumns, targetColumns) {
  const from = valued(sourceColumns);
  const to = valued(targetColumns);
  const mapping = new Map();
  const taken = new Set();
  const take = (column, match) => {
    const found = to.find((each) => !taken.has(each) && match(each));
    if (!found) return;
    mapping.set(column.id, found);
    taken.add(found);
  };
  for (const column of from.filter(hasRole)) {
    take(column, (target) => target.role === column.role);
  }
  for (const column of from) {
    if (mapping.has(column.id)) continue;
    take(
      column,
      (target) => target.title === column.title && target.type === column.type,
    );
  }
  return mapping;
}

/**
 * The tasks among `ids` (in their order) that are not below another one
 * of them: a selected subtask moves with its selected parent.
 */
export function transferRoots(items, ids) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const chosen = new Set(ids);
  const below = (item) => {
    const seen = new Set();
    for (let at = byId.get(item.parentId); at; at = byId.get(at.parentId)) {
      if (chosen.has(at.id)) return true;
      if (seen.has(at.id)) return false;
      seen.add(at.id);
    }
    return false;
  };
  return ids.map((id) => byId.get(id)).filter((item) => item && !below(item));
}

/** `roots` with every subtask of theirs among `items`. */
export function movedItems(items, roots) {
  const ids = new Set(roots.map((item) => item.id));
  let grew = true;
  while (grew) {
    grew = false;
    for (const item of items) {
      if (ids.has(item.id) || !ids.has(item.parentId)) continue;
      ids.add(item.id);
      grew = true;
    }
  }
  return items.filter((item) => ids.has(item.id));
}

const isSet = (item, column) =>
  !isEmptyValue(item.values?.[column.id]) || Boolean(item.texts?.[column.id]);

/**
 * The titles of the source columns, in board order, whose values moving
 * `items` to a board with `targetColumns` would leave behind.
 */
export function droppedColumnsPreview({ sourceColumns, targetColumns, items }) {
  const mapping = columnMapping(sourceColumns, targetColumns);
  return valued(sourceColumns)
    .filter((column) => !mapping.has(column.id))
    .filter((column) => items.some((item) => isSet(item, column)))
    .map((column) => column.title);
}

/** "“Name”" for one task, else "3 tasks". */
export const tasksLabel = (roots) =>
  roots.length === 1 ? `“${roots[0].name}”` : `${roots.length} tasks`;

/** The confirm dialog of a move that would drop `columns`. */
export function transferConfirm({ roots, target, columns }) {
  const list = columns.join(", ");
  const these = columns.length === 1 ? "column" : "columns";
  return {
    title: `Move ${tasksLabel(roots)} to “${target.name}”?`,
    message: `“${target.name}” has no matching ${these} for ${list}, so ${columns.length === 1 ? "its values stay" : "their values stay"} behind.`,
    confirmButton: "Move",
  };
}

/** The toast after a move: the target and the columns actually dropped. */
export function transferMessage({ roots, target, dropped }) {
  const moved = `Moved ${tasksLabel(roots)} to “${target.name}”`;
  return dropped.length > 0
    ? `${moved}. Not moved: ${dropped.join(", ")}`
    : moved;
}
