/**
 * The board a file import builds (`files.js`): groups (at most
 * BOARD_LIMITS.groups; more join the last one), columns collected by key
 * with their cell texts and fill colors, items within the item limit and
 * the value budget (`cellLimit` non-empty cells: a row is added only while
 * a full row of FILE_LIMITS.columns cells still fits), and subitem
 * columns merged into item columns of the same title and type.
 */
import { FILE_LIMITS, paletteColor } from "../csv.js";
import { BOARD_LIMITS } from "../snapshot-board.js";
import { nearestColor } from "../snapshot.js";

export const DEFAULT_GROUP = "Imported";

/** The board being read: groups, collected columns, items and counts. */
export function createBoard({ limit, cellLimit }) {
  const board = { groups: [], columns: [], items: [], byKey: new Map() };
  Object.assign(board, { limit, dropped: 0, extraGroups: 0 });
  // Non-empty cells, and the rows left out because of `cellLimit`.
  return Object.assign(board, { cellLimit, cells: 0, cellDropped: 0 });
}

export function addGroup(board, { title, color = null }) {
  const { groups } = board;
  if (groups.length >= BOARD_LIMITS.groups) {
    board.extraGroups += 1;
    return groups.at(-1).source_id;
  }
  const id = `g${groups.length + 1}`;
  const name = title || DEFAULT_GROUP;
  groups.push({
    source_id: id,
    title: name,
    color: color ? nearestColor(color) : paletteColor(name, groups.length),
  });
  return id;
}

/** The column `key` (created with `title` and `extra` when new). */
export function columnFor(board, { key, title, extra = {} }) {
  const found = board.byKey.get(key);
  if (found) return found;
  const id = `c${board.columns.length + 1}`;
  const column = {
    source_id: id,
    title,
    cells: [],
    fills: new Map(),
    ...extra,
  };
  board.columns.push(column);
  board.byKey.set(key, column);
  return column;
}

/**
 * Adds an item → its index, or -1 past the item limit or when one more
 * row (at most FILE_LIMITS.columns cells) could pass the value limit.
 */
export function addItem(board, { name, group, parent = null }) {
  if (board.items.length >= board.limit) {
    board.dropped += 1;
    return -1;
  }
  if (board.cells + FILE_LIMITS.columns > board.cellLimit) {
    board.cellDropped += 1;
    return -1;
  }
  board.items.push({
    source_id: `i${board.items.length + 1}`,
    name,
    group_source_id: group,
    parent_source_id: parent,
    values: {},
    created_at: null,
    creator_source_id: null,
    updates: [],
  });
  return board.items.length - 1;
}

export function addCell(board, column, { index, text, color }) {
  if (text === "") return;
  board.cells += 1;
  column.cells.push([index, text]);
  const key = text.toLowerCase();
  if (color?.fill && !column.fills.has(key)) column.fills.set(key, color.fill);
}

/** Header cells → distinct titles ("Column 3" for blanks, "X (2)" repeats). */
export function titlesOf(cells, width) {
  const seen = new Map();
  return Array.from({ length: width }, (_, index) => {
    const base = cells[index] || `Column ${index + 1}`;
    const key = base.toLowerCase();
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return n === 1 ? base : `${base} (${n})`;
  });
}

export const filled = (row) =>
  row.reduce((n, cell) => n + (cell === "" ? 0 : 1), 0);
export const firstFilled = (row) => row.findIndex((cell) => cell !== "");

/** Subitem columns join item columns of the same title and type. */
export function mergeSubitemColumns(columns) {
  const items = new Map();
  for (const column of columns)
    if (!column.subitem) items.set(column.title.toLowerCase(), column);
  const titles = new Set(columns.map((column) => column.title.toLowerCase()));
  const out = [];
  for (const column of columns) {
    if (!column.subitem) {
      out.push(column);
      continue;
    }
    const target = items.get(column.title.toLowerCase());
    // An item column without values takes the subitem column's type.
    const open = target?.cells.length === 0 && !target.overridden;
    if (open) target.type = column.type;
    const fits =
      target && (column.cells.length === 0 || target.type === column.type);
    if (fits) {
      for (const cell of column.cells) target.cells.push(cell);
      for (const [key, fill] of column.fills)
        if (!target.fills.has(key)) target.fills.set(key, fill);
      continue;
    }
    if (target) {
      let title = `${column.title} (subitem)`;
      for (let n = 2; titles.has(title.toLowerCase()); n += 1)
        title = `${column.title} (subitem ${n})`;
      titles.add(title.toLowerCase());
      column.title = title;
    }
    out.push(column);
  }
  return out;
}
