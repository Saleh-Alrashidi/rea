/**
 * List view model (SPEC-5 §3, pure): the columns the List view shows,
 * how tasks group (status, priority, assignee, board group or none), the
 * subtask tree built from `parentId`, search that keeps the ancestors of
 * matches, and the per-board toolbar choices (`defaultListPrefs`).
 *
 * Columns are found by role (`column-roles.js`), never by title, and
 * finished work by label type (`isDoneOption`). Subtasks sit under their
 * parent in the parent's group, whatever their own status.
 *
 * Order (SPEC-6 §1.2): inside every displayed group, tasks follow the
 * board's manual order (`byManualOrder`: position, then ID), and so do the
 * subtasks under a parent; the tree (`buildTree`) is the one place that
 * orders them, for the List view and the task view alike.
 */

import { roleColumns } from "./column-roles.js";
import { laneKey, lanesFor } from "./status-lanes.js";
import {
  isDoneOption,
  isDoneStatus,
  isEmptyValue,
  personOf,
  safeColor,
} from "./values.js";

/** Group-by choices of the toolbar, in menu order. */
export const GROUP_BY = Object.freeze({
  status: "Status",
  priority: "Priority",
  assignee: "Assignee",
  group: "Board group",
  none: "None",
});
/** The role column each group-by choice needs (null: none). */
const GROUP_BY_ROLE = Object.freeze({
  status: "status",
  priority: "priority",
  assignee: "assignees",
  group: null,
  none: null,
});
const UNASSIGNED = "unassigned";

/** IDs compare as numbers (the API's IDs are digit strings), else as text. */
function compareIds(a, b) {
  const [x, y] = [Number(a), Number(b)];
  if (Number.isFinite(x) && Number.isFinite(y) && x !== y) return x - y;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * The board's manual order (SPEC-6 §1.2): `position` (`decodeItem`), then
 * ID, as the server sorts it.
 */
export const byManualOrder = (a, b) =>
  (a.position ?? 0) - (b.position ?? 0) || compareIds(a.id, b.id);

/**
 * A board's toolbar choices before the user changes any: group by
 * status, subtasks collapsed, closed tasks shown, and no overrides of
 * which columns show, which groups are collapsed or which tasks are
 * expanded (nor a task being renamed).
 */
export function defaultListPrefs() {
  return {
    groupBy: "status",
    showEmpty: false,
    subtasks: "collapsed",
    showClosed: true,
    /** Column ID → shown, overriding the default. */
    columns: new Map(),
    /** Group key → collapsed, overriding the default. */
    groups: new Map(),
    /** Item ID → expanded, overriding `subtasks`. */
    expanded: new Map(),
    /** Focus-key suffix (`<group key>:<item ID>`) of the row being renamed. */
    renaming: null,
    /** IDs of the selected tasks (SPEC-6 §1.4 multi-select). */
    selected: new Set(),
    /** Row key (`<group key>:<item ID>`) a Shift-click range starts from. */
    anchor: null,
  };
}

// ------------------------------------------------------------- columns

/** IDs of the value columns that are empty for every item of `board`. */
export function emptyColumnIds(board) {
  const empty = new Set();
  for (const column of board.columns) {
    if (column.type === "name") continue;
    const values = board.items.map((item) => item.values[column.id]);
    if (values.every((value) => isEmptyValue(value))) empty.add(column.id);
  }
  return empty;
}

/**
 * How a cell of `column` renders: "assignees", "due" or "priority" for
 * those role columns, else the column type.
 */
export function cellKind(column, roles) {
  if (column === roles.assignees) return "assignees";
  if (column === roles.due_date) return "due";
  if (column === roles.priority) return "priority";
  return column.type;
}

/**
 * The List view's columns: `roles` and the `cells` in display order
 * (assignees, due date, priority, then the other columns in board order),
 * each `{ column, kind, shown }`. The status column is the status circle
 * of the name cell, not a cell. A column shows when the user said so,
 * else unless it is empty for every item; the description shows as the
 * name cell's indicator instead of a cell unless the user shows it.
 */
export function listColumns(board, prefs) {
  const roles = roleColumns(board.columns);
  const empty = emptyColumnIds(board);
  const lead = [roles.assignees, roles.due_date, roles.priority].filter(
    Boolean,
  );
  const rest = board.columns.filter(
    (column) =>
      column.type !== "name" &&
      column !== roles.status &&
      !lead.includes(column),
  );
  const cells = [...lead, ...rest].map((column) => {
    const byDefault = !empty.has(column.id) && column !== roles.description;
    return {
      column,
      kind: cellKind(column, roles),
      shown: prefs.columns.get(column.id) ?? byDefault,
    };
  });
  return { roles, cells };
}

// ----------------------------------------------------------- the tree

/**
 * Children of each item by parent ID, in manual order (`byManualOrder`),
 * and the top-level items (`roots`) in that order too. An item whose
 * parent is not on the loaded board is top-level.
 */
export function buildTree(items) {
  const ids = new Set(items.map((item) => item.id));
  const children = new Map();
  const roots = [];
  for (const item of [...items].sort(byManualOrder)) {
    const parent = item.parentId;
    if (parent && parent !== item.id && ids.has(parent)) {
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(item);
    } else roots.push(item);
  }
  return { roots, children };
}

/**
 * IDs of every descendant among `items` of the items in `ids` (an ID or
 * a list of them), those items themselves excluded.
 */
export function descendantIds(items, ids) {
  const roots = new Set([ids].flat());
  const { children } = buildTree(items);
  const found = new Set();
  const stack = [...roots].flatMap((id) => children.get(id) ?? []);
  while (stack.length > 0) {
    const item = stack.pop();
    if (found.has(item.id) || roots.has(item.id)) continue;
    found.add(item.id);
    stack.push(...(children.get(item.id) ?? []));
  }
  return found;
}

/**
 * What deleting group `groupId` removes among `items`: its items and
 * every descendant of them, wherever it sits (the server cascades,
 * SPEC-5 §1.1). `ids` holds them all, `inGroup` counts the group's own
 * items and `elsewhere` the descendants in `otherGroups` other groups.
 */
export function groupDeletion(items, groupId) {
  const own = items.filter((item) => item.groupId === groupId);
  const ids = descendantIds(
    items,
    own.map((item) => item.id),
  );
  for (const item of own) ids.add(item.id);
  const away = items.filter(
    (item) => ids.has(item.id) && item.groupId !== groupId,
  );
  return {
    ids,
    inGroup: own.length,
    elsewhere: away.length,
    otherGroups: new Set(away.map((item) => item.groupId)).size,
  };
}

/** Name parts for highlighting `term`: `[{ text, match }]`. */
export function highlightParts(name, term) {
  const needle = term.trim().toLowerCase();
  const folded = name.toLowerCase();
  // Case folding that changes the length would misplace the marks.
  if (!needle || folded.length !== name.length)
    return [{ text: name, match: false }];
  const parts = [];
  let from = 0;
  for (
    let at = folded.indexOf(needle);
    at !== -1;
    at = folded.indexOf(needle, from)
  ) {
    if (at > from) parts.push({ text: name.slice(from, at), match: false });
    parts.push({ text: name.slice(at, at + needle.length), match: true });
    from = at + needle.length;
  }
  if (from < name.length) parts.push({ text: name.slice(from), match: false });
  return parts;
}

/**
 * Which items stay visible: not `isHidden` (nor under a hidden parent)
 * and, when searching, matching `term` or with a matching descendant.
 * Returns the kept IDs and, while searching, the IDs of the ancestors of
 * matches (shown expanded).
 */
function keptItems(tree, { term, isHidden }) {
  const kept = new Set();
  const opened = new Set();
  const visit = (item, seen) => {
    if (seen.has(item.id) || isHidden(item)) return false;
    seen.add(item.id);
    let below = false;
    for (const child of tree.children.get(item.id) ?? []) {
      if (visit(child, seen)) below = true;
    }
    const matches = !term || item.name.toLowerCase().includes(term);
    if (below && term) opened.add(item.id);
    if (matches || below) kept.add(item.id);
    return matches || below;
  };
  const seen = new Set();
  for (const root of tree.roots) visit(root, seen);
  return { kept, opened };
}

// -------------------------------------------------------------- groups

/**
 * The group-by choice in effect: the requested one when the board has the
 * column it needs, else the board's own groups.
 */
export function effectiveGroupBy(groupBy, roles) {
  if (!Object.hasOwn(GROUP_BY, groupBy)) return "group";
  const role = GROUP_BY_ROLE[groupBy];
  return role === null || roles[role] ? groupBy : "group";
}

/**
 * Status or priority groups: one per label in label order and the blank
 * lane last; for status, labels of `done`/`closed` types come after the
 * others (and before "No status").
 */
function laneGrouping(column, kind) {
  const blankLabel = kind === "priority" ? "No priority" : "No status";
  const lanes = lanesFor(column, { blankLabel });
  const finished = (lane) =>
    kind === "status" && lane.index !== null && isDoneOption(lane);
  const labelled = lanes.filter((lane) => lane.index !== null);
  const ordered =
    kind === "status"
      ? [
          ...labelled.filter((lane) => !finished(lane)),
          ...labelled.filter(finished),
          ...lanes.filter((lane) => lane.index === null),
        ]
      : lanes;
  return {
    groups: ordered.map((lane) => ({
      key: `${kind}:${lane.key}`,
      label: lane.label,
      color: lane.color,
      done: finished(lane),
      create: {
        groupId: null,
        values: lane.index === null ? {} : { [column.id]: lane.index },
      },
      // A task moved here takes the label, or loses it (SPEC-6 §1.4).
      move: { groupId: null, values: { [column.id]: lane.index } },
    })),
    keysOf: (item) => [
      `${kind}:${laneKey(column, item.values[column.id] ?? null)}`,
    ],
  };
}

/** One group per assignee of a top-level task (by name), then Unassigned. */
function assigneeGrouping(column, { roots, users }) {
  const ids = new Set(roots.flatMap((item) => item.values[column.id] ?? []));
  const people = [...ids]
    .map((id) => personOf(users, id))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const groups = people.map((person) => ({
    key: `assignee:${person.id}`,
    label: person.name,
    color: null,
    personId: person.id,
    done: false,
    create: { groupId: null, values: { [column.id]: [person.id] } },
    move: { groupId: null, values: { [column.id]: [person.id] } },
  }));
  groups.push({
    key: `assignee:${UNASSIGNED}`,
    label: "Unassigned",
    color: null,
    done: false,
    create: { groupId: null, values: {} },
    move: { groupId: null, values: { [column.id]: [] } },
  });
  return {
    groups,
    keysOf(item) {
      const assigned = item.values[column.id] ?? [];
      if (assigned.length === 0) return [`assignee:${UNASSIGNED}`];
      return assigned.map((id) => `assignee:${id}`);
    },
  };
}

function boardGrouping(board) {
  return {
    groups: board.groups.map((group) => ({
      key: `group:${group.id}`,
      label: group.title,
      color: safeColor(group.color),
      done: false,
      create: { groupId: group.id, values: {} },
      move: { groupId: group.id, values: {} },
    })),
    keysOf: (item) => [`group:${item.groupId}`],
  };
}

const NO_GROUPING = Object.freeze({
  groups: [
    {
      key: "all",
      label: "All tasks",
      color: null,
      done: false,
      create: { groupId: null, values: {} },
      move: { groupId: null, values: {} },
    },
  ],
  keysOf: () => ["all"],
});

function groupingOf(groupBy, { board, roles, users, roots }) {
  if (groupBy === "status") return laneGrouping(roles.status, "status");
  if (groupBy === "priority") return laneGrouping(roles.priority, "priority");
  if (groupBy === "assignee") {
    return assigneeGrouping(roles.assignees, { roots, users });
  }
  return groupBy === "group" ? boardGrouping(board) : NO_GROUPING;
}

/** The rows of `roots` and their visible subtasks, depth first. */
function flattenRows(roots, { tree, kept, expandedOf, term }) {
  const rows = [];
  const visit = (item, depth, seen) => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    const all = tree.children.get(item.id) ?? [];
    const children = all.filter((child) => kept.has(child.id));
    const expanded = all.length > 0 && expandedOf(item);
    const matched = term !== "" && item.name.toLowerCase().includes(term);
    rows.push({ item, depth, childCount: all.length, expanded, matched });
    if (!expanded) return;
    for (const child of children) visit(child, depth + 1, seen);
  };
  for (const root of roots) visit(root, 0, new Set());
  return rows;
}

/**
 * The List view's groups, in order: `{ key, label, color, done, create,
 * move, count, collapsed, rows }` where `rows` are `{ item, depth,
 * childCount, expanded, matched }` (subtasks under their parent, expanded
 * ones only, each level in manual order), `create` is `{ groupId, values }`
 * for a new task in the group and `move` the same for a task moved into it
 * (an Unassigned or "No status" move clears the value). Groups without
 * tasks are left out unless `prefs.showEmpty` (not while searching); when
 * every group is empty the first one stays, so editors can add a task.
 * `keysOf(item)` gives the keys of the groups a top-level `item` belongs to.
 *
 * @param {object} board loaded board (`board-data.js`)
 * @param {{ prefs: object, roles: object, users?: Map, search?: string }} options
 * @returns {{ groupBy: string, groups: object[],
 *   keysOf(item: object): string[] }}
 */
export function listGroups(board, { prefs, roles, users, search = "" }) {
  const groupBy = effectiveGroupBy(prefs.groupBy, roles);
  const term = search.trim().toLowerCase();
  const tree = buildTree(board.items);
  const status = roles.status;
  const finished = (item) =>
    Boolean(status) && isDoneStatus(status, item.values[status.id] ?? null);
  const { kept, opened } = keptItems(tree, {
    term,
    isHidden: (item) => !prefs.showClosed && finished(item),
  });
  const roots = tree.roots.filter((item) => kept.has(item.id));
  const grouping = groupingOf(groupBy, { board, roles, users, roots });
  const byKey = new Map(grouping.groups.map((group) => [group.key, []]));
  for (const root of roots) {
    for (const key of grouping.keysOf(root)) byKey.get(key)?.push(root);
  }
  const expandedOf = (item) =>
    (term !== "" && opened.has(item.id)) ||
    (prefs.expanded.get(item.id) ?? prefs.subtasks === "expanded");
  const groups = grouping.groups
    .filter((group) => prefs.showClosed || !group.done)
    .map((group) => {
      const members = byKey.get(group.key);
      return {
        ...group,
        count: members.length,
        collapsed: prefs.groups.get(group.key) ?? group.done,
        rows: flattenRows(members, { tree, kept, expandedOf, term }),
      };
    });
  const shown = groups.filter(
    (group) => group.count > 0 || (prefs.showEmpty && term === ""),
  );
  if (shown.length === 0 && term === "" && groups.length > 0) {
    shown.push(groups[0]);
  }
  return { groupBy, groups: shown, keysOf: grouping.keysOf };
}
