/**
 * Task view model (SPEC-5 §4, pure): how the task view lays out a board's
 * columns (the fields grid by role, the description, every other column
 * as a custom field), a task's parent, subtasks and their progress and
 * the chips of a tags value (the Updates pane: `updates-model.js`).
 *
 * Columns are found by role (`column-roles.js`), never by title, and
 * finished work by label type (`isDoneOption`). Subtasks are the loaded
 * board's items under the task (`buildTree`), as in the List view.
 */

import { roleColumns } from "./column-roles.js";
import { buildTree } from "./list-model.js";
import { isDoneOption, isDoneStatus, isEmptyValue } from "./values.js";

/**
 * The fields grid's rows, in order, by the roles they show: Dates pairs
 * the start and due dates (SPEC-5 §4.2).
 */
const GRID_ROWS = Object.freeze([
  { key: "status", label: "Status", roles: ["status"] },
  { key: "assignees", label: "Assignees", roles: ["assignees"] },
  { key: "dates", label: "Dates", roles: ["start_date", "due_date"] },
  { key: "priority", label: "Priority", roles: ["priority"] },
  { key: "time_estimate", label: "Time estimate", roles: ["time_estimate"] },
  { key: "tags", label: "Tags", roles: ["tags"] },
]);

// ------------------------------------------------------------- fields

/**
 * How the task view lays out `columns` (prepared board columns): `roles`
 * (`roleColumns`), the fields `grid` rows `{ key, label, columns }` for
 * the role columns that exist (one column's row is labelled with its
 * title), the `description` column (or null) and the `custom` columns:
 * every other column but the name, in board order.
 */
export function taskLayout(columns) {
  const roles = roleColumns(columns);
  const grid = [];
  for (const row of GRID_ROWS) {
    const found = row.roles.map((role) => roles[role]).filter(Boolean);
    if (found.length === 0) continue;
    const label = found.length === 1 ? found[0].title : row.label;
    grid.push({ key: row.key, label, columns: found });
  }
  const used = new Set(grid.flatMap((row) => row.columns));
  if (roles.description) used.add(roles.description);
  const custom = columns.filter(
    (column) => column.type !== "name" && !used.has(column),
  );
  return { roles, grid, description: roles.description, custom };
}

/**
 * The custom fields of `item`, split into those with a value (`filled`)
 * and the `empty` ones the view collapses, both in board order.
 */
export function customFields(layout, item) {
  const filled = [];
  const empty = [];
  for (const column of layout.custom) {
    if (isEmptyValue(item.values[column.id])) empty.push(column);
    else filled.push(column);
  }
  return { filled, empty };
}

/**
 * The label "✓ Complete" sets on `column` (the status column): its first
 * label of a `done` or `closed` type, in label order, or null.
 */
export function completeOption(column) {
  return column?.status?.options.find((option) => isDoneOption(option)) ?? null;
}

/** The chips of a tags value: its comma-separated names, once each. */
export function tagList(text) {
  const names = String(text ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  return [...new Set(names)];
}

// --------------------------------------------------- parent, subtasks

/**
 * The task's parent `{ id, name }`, or null at the top level: the loaded
 * item's `parent_item` (the server's answer, even for a parent the board
 * did not load), else the board row of its `parentId` while the item
 * still loads.
 */
export function taskParent(board, item, detail) {
  if (detail?.parent) return detail.parent;
  if (detail || !item?.parentId) return null;
  const row = board.items.find((entry) => entry.id === item.parentId);
  return row ? { id: row.id, name: row.name } : null;
}

/**
 * The direct subtasks of `item` on the loaded board, in board order, as
 * `{ item, done }` with the `done` count and `total`; `missing` counts
 * subtasks the server has (`subitemsCount`) that the board did not load.
 * @param {object} board loaded board
 * @param {{ item: object, status: object | null, subitemsCount?: number }} options
 */
export function subtasksOf(board, { item, status, subitemsCount }) {
  const children = buildTree(board.items).children.get(item.id) ?? [];
  const rows = children.map((child) => ({
    item: child,
    done: Boolean(status) && isDoneStatus(status, child.values[status.id]),
  }));
  const done = rows.filter((row) => row.done).length;
  const known = Number.isSafeInteger(subitemsCount) ? subitemsCount : 0;
  return {
    rows,
    done,
    total: rows.length,
    missing: Math.max(0, known - rows.length),
  };
}
