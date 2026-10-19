/**
 * Task view model (SPEC-5 §4, pure): how the task view lays out a board's
 * columns (the fields grid by role, the description, every other column
 * as a custom field), a task's parent, subtasks and their progress, its
 * activity stream (oldest first), who wrote an update, the links in a
 * comment, the chips of a tags value and when an edited text is saved.
 *
 * Columns are found by role (`column-roles.js`), never by title, and
 * finished work by label type (`isDoneOption`). Subtasks are the loaded
 * board's items under the task (`buildTree`), as in the List view.
 */

import { SOMEONE } from "../components/labels.js";
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

/**
 * The source tag of an imported update's author (`Board.import.source`):
 * the tool its author wrote in.
 */
const SOURCE_TAGS = Object.freeze({ clickup: "ClickUp", monday: "monday.com" });
const IMPORTED_TAG = "Imported";
/** Characters that end a sentence rather than a URL. */
const TRAILING = /[.,;:!?'"،؛؟…]+$/u;
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"]+/giu;
const CLOSERS = Object.freeze({ ")": "(", "]": "[", "}": "{" });

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

/**
 * What saving an edited text gives: `changed` only when the text differs
 * from `initial` as the editor first showed it (so leaving an editor
 * unchanged saves nothing), and the `value` to store (null when blank).
 */
export function textCommit(initial, next) {
  return {
    changed: next !== initial,
    value: next.trim() === "" ? null : next,
  };
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

// ------------------------------------------------------------ activity

const timeOf = (iso) => {
  const time = Date.parse(iso ?? "");
  return Number.isNaN(time) ? 0 : time;
};

/** Oldest first; a pending update (not saved yet) after saved ones. */
function oldestFirst(a, b) {
  if (Boolean(a.pending) !== Boolean(b.pending)) return a.pending ? 1 : -1;
  const delta = timeOf(a.created_at) - timeOf(b.created_at);
  if (delta !== 0) return delta;
  return (Number(a.id) || 0) - (Number(b.id) || 0);
}

/**
 * The Activity stream of a loaded item (`loadItem`), oldest first: the
 * "created this task" line, a note when older comments were not loaded
 * (`hidden` of them), then each comment. Empty before the item loads.
 * @returns {({ kind: "created", creator: object | null, at: string | null }
 *   | { kind: "older", hidden: number }
 *   | { kind: "comment", update: object })[]}
 */
export function activityEntries(detail) {
  if (!detail) return [];
  const updates = [...(detail.updates ?? [])].sort(oldestFirst);
  const saved = updates.filter((update) => !update.pending).length;
  const hidden = Math.max(0, (detail.updatesCount ?? 0) - saved);
  return [
    {
      kind: "created",
      creator: detail.creator ?? null,
      at: detail.createdAt ?? null,
    },
    ...(hidden > 0 ? [{ kind: "older", hidden }] : []),
    ...updates.map((update) => ({ kind: "comment", update })),
  ];
}

/**
 * Who wrote `update`: its creator (`user`, a user record), else the
 * source author an import recorded (`author_name`, SPEC-5 §1.4) with the
 * `tag` of the board's import `source`, else "Someone" (the API hides
 * authors outside a guest's directory).
 * @returns {{ user: object | null, name: string, tag: string | null }}
 */
export function updateAuthor(update, source) {
  if (update.creator) {
    return { user: update.creator, name: update.creator.name, tag: null };
  }
  const name =
    typeof update.author_name === "string" ? update.author_name.trim() : "";
  if (name !== "") {
    const tag = Object.hasOwn(SOURCE_TAGS, source ?? "")
      ? SOURCE_TAGS[source]
      : IMPORTED_TAG;
    return { user: null, name, tag };
  }
  const someone = { id: "0", name: SOMEONE, initials: "?" };
  return { user: someone, name: SOMEONE, tag: null };
}

/** `url` without trailing punctuation or unbalanced closing brackets. */
function trimUrl(url) {
  let text = url.replace(TRAILING, "");
  while (Object.hasOwn(CLOSERS, text.at(-1) ?? "")) {
    const close = text.at(-1);
    const opens = text.split(CLOSERS[close]).length - 1;
    const closes = text.split(close).length - 1;
    if (closes <= opens) break;
    text = text.slice(0, -1).replace(TRAILING, "");
  }
  return text;
}

/** The http(s) URL `text` names, normalized, or null. */
function linkTarget(text) {
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/**
 * A comment body split into text and `http(s)` links, in order:
 * `[{ text }, { text, href }]`. Trailing punctuation and unbalanced
 * closing brackets stay text. The view builds the links as DOM nodes.
 */
export function linkParts(body) {
  const text = String(body ?? "");
  const parts = [];
  let from = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = trimUrl(match[0]);
    const href = linkTarget(url);
    if (!href) continue;
    if (match.index > from) parts.push({ text: text.slice(from, match.index) });
    parts.push({ text: url, href });
    from = match.index + url.length;
  }
  if (from < text.length) parts.push({ text: text.slice(from) });
  return parts;
}
