/**
 * File connector (SPEC-4 §3.3): `scan({ file: { name, kind, bytes },
 * options, signal, onProgress })` reads one CSV file (`../csv.js`) or
 * Excel workbook (`../xlsx.js`) into a snapshot (SPEC-4 §2) with one
 * closed workspace ("Imported from <file>") holding one private board.
 *
 * - A CSV, and a workbook whose first sheet is not a monday.com board
 *   export, is a table: the first row is the header, a Name / Task name /
 *   Item header (else the first column) holds item names, and a Group /
 *   List / Status type header (if any, with at most 500 values) the
 *   groups; otherwise every item is in one group "Imported".
 * - monday.com's board export: the board title row, then per group a title
 *   row (its font color is the group color), a header row whose first cell
 *   names the items, item rows, and "Subitems" header rows (one column in)
 *   followed by that item's subitems. Subitem columns join the item column
 *   of the same title when their types match, else they are added as
 *   "<title> (subitem)"; the item header's "Subitems" list is left out
 *   when subitems were read from their own rows. Status cell fills give
 *   label colors.
 *
 * Column types come from `inferType` unless `options.column_types` names
 * the column's title (`../csv.js`). People named in people columns become
 * snapshot users (`email:<address>` or `name:<name>`) and editors of the
 * board, so the admin's user mapping decides who gets access. At most
 * `options.limits.items` (default and maximum 50,000) items and subitems
 * are read, and no more rows once the board holds SNAPSHOT_LIMITS.values
 * cells (what one import can store); the rest is reported. File boards
 * keep the file name as their source ID, so importing the same file again
 * is flagged as a re-import. Parsing and conversion run in time slices
 * (`../slices.js`), so a large file neither stalls the server nor delays
 * a cancel. Failures are ImportError: INVALID_FILE, EMPTY_FILE,
 * FILE_TOO_LARGE, INVALID_CSV, the xlsx reader's codes, or ABORTED.
 */
import {
  FILE_LIMITS,
  columnType,
  convertColumnsSteps,
  decodeText,
  parseCsvSteps,
  readOverrides,
} from "../csv.js";
import { ImportError } from "../engine.js";
import { drainSliced } from "../slices.js";
import { BOARD_LIMITS } from "../snapshot-board.js";
import { truncate } from "../snapshot-rules.js";
import { SNAPSHOT_LIMITS } from "../snapshot.js";
import { XLSX_LIMITS, readXlsxSteps } from "../xlsx.js";
import {
  DEFAULT_GROUP,
  addCell,
  addGroup,
  addItem,
  columnFor,
  createBoard,
  filled,
  firstFilled,
  mergeSubitemColumns,
  titlesOf,
} from "./file-board.js";

const BOARD_PATH = "workspaces[0].boards[0]";
const NAME_TITLES = Object.freeze(["name", "task name", "item", "item name"]);
// In priority order (SPEC-4 names the first three).
const GROUP_TITLES = Object.freeze([
  "group",
  "list",
  "status type",
  "group name",
  "list name",
]);
const SUBITEMS = "subitems";
const EXTENSION = /\.(?:csv|tsv|txt|xlsx|xlsm)$/i;
const MAX_NAME = 255;
// Rows read between the conversion's yields (`../slices.js`).
const ROWS_PER_STEP = 256;

// ------------------------------------------------------------------ table

function groupColumn(titles, rows, ctx) {
  for (const title of GROUP_TITLES) {
    const at = titles.findIndex((t) => t.toLowerCase() === title);
    if (at === -1) continue;
    const values = new Set(rows.map((row) => (row[at] ?? "").toLowerCase()));
    if (values.size <= BOARD_LIMITS.groups) return at;
    const message = `“${titles[at]}” has more than ${BOARD_LIMITS.groups} different values, so it was imported as a column, not as groups`;
    ctx.warn(BOARD_PATH, "too_many_groups", message);
    return -1;
  }
  return -1;
}

/** A table: the first row is the header (see the module comment). */
function* readTable(rows, ctx) {
  const { board } = ctx;
  const [header = [], ...body] = rows.filter((row) => filled(row) > 0);
  const width = body.reduce(
    (max, row) => Math.max(max, row.length),
    header.length,
  );
  const titles = titlesOf(header, width);
  const groupAt = groupColumn(titles, body, ctx);
  const named = titles.findIndex((t) => NAME_TITLES.includes(t.toLowerCase()));
  const nameAt = named !== -1 ? named : groupAt === 0 ? 1 : 0;
  ctx.special = [titles[nameAt], titles[groupAt]].filter(Boolean);
  const columns = titles.map((title, at) =>
    at === nameAt || at === groupAt
      ? null
      : columnFor(board, { key: `${at}`, title }),
  );
  const groups = new Map();
  for (const [at, row] of body.entries()) {
    if (at % ROWS_PER_STEP === 0) yield;
    const label = groupAt === -1 ? "" : (row[groupAt] ?? "");
    const key = (label || DEFAULT_GROUP).toLowerCase();
    if (!groups.has(key)) groups.set(key, addGroup(board, { title: label }));
    const index = addItem(board, {
      name: row[nameAt] ?? "",
      group: groups.get(key),
    });
    if (index === -1) continue;
    for (const [col, column] of columns.entries())
      if (column) addCell(board, column, { index, text: row[col] ?? "" });
  }
  if (board.groups.length === 0) addGroup(board, { title: DEFAULT_GROUP });
}

// ------------------------------------------------------- monday layout

/**
 * The export's frame, or null when the sheet is not a monday.com board
 * export: `{ title, description, start (first group title row), nameTitle }`.
 */
function mondayShape(rows) {
  if (rows.length === 0 || filled(rows[0]) !== 1 || rows[0][0] === "")
    return null;
  const header = rows.findIndex((row) => filled(row) >= 2);
  if (header === -1 || rows[header][0] === "") return null;
  let group = header - 1;
  while (group > 0 && filled(rows[group]) === 0) group -= 1;
  if (group < 1 || filled(rows[group]) !== 1 || rows[group][0] === "")
    return null;
  const description = rows
    .slice(1, group)
    .filter((row) => filled(row) > 0)
    .map((row) => row[firstFilled(row)])
    .join("\n");
  const nameTitle = rows[header][0].toLowerCase();
  return { title: rows[0][0], description, start: group, nameTitle };
}

function nextFilled(rows, from) {
  for (let at = from + 1; at < rows.length; at += 1)
    if (filled(rows[at]) > 0) return rows[at];
  return null;
}

/** What row `at` is in the export (see the module comment). */
function rowKind(rows, at, { state, shape }) {
  const row = rows[at];
  const count = filled(row);
  if (count === 0) return "blank";
  if (count === 1 && row[0] !== "") {
    const next = nextFilled(rows, at);
    const header =
      next && filled(next) >= 2 && next[0].toLowerCase() === shape.nameTitle;
    if (header) return "group";
  }
  if (state.header === null) return "header";
  const first = firstFilled(row);
  const sub =
    row[first].toLowerCase() === SUBITEMS && (first > 0 || count >= 2);
  if (sub) return "subheader";
  const nested =
    state.sub && row.slice(0, state.sub.offset).every((c) => c === "");
  return nested ? "subitem" : "item";
}

/** Columns of a header row from `offset` (the name cell) on, by position. */
function headerColumns(board, { row, offset, subitem }) {
  const titles = titlesOf(row.slice(offset + 1), row.length - offset - 1);
  const map = new Map();
  for (const [index, title] of titles.entries()) {
    const key = `${subitem ? "sub" : "item"}:${title.toLowerCase()}`;
    const extra = subitem
      ? { subitem, keys: [`${title} (subitem)`, title] }
      : { list: title.toLowerCase() === SUBITEMS };
    map.set(offset + 1 + index, columnFor(board, { key, title, extra }));
  }
  return { offset, map, subitem };
}

/** Adds the item or subitem of `row` with the cells its header names. */
function readItemRow(ctx, { row, at, header, parent }) {
  const { board, state } = ctx;
  const index = addItem(board, {
    name: row[header.offset] ?? "",
    group: state.group,
    parent,
  });
  if (index === -1) return null;
  for (let col = header.offset + 1; col < row.length; col += 1) {
    if (row[col] === "") continue;
    let column = header.map.get(col);
    if (!column) {
      const title = `Column ${col + 1}`;
      const key = `${header.subitem ? "sub" : "item"}:${title.toLowerCase()}`;
      const extra = header.subitem ? { subitem: true, keys: [title] } : {};
      column = columnFor(board, { key, title, extra });
      header.map.set(col, column);
    }
    const color = ctx.colorAt(at, col);
    addCell(board, column, { index, text: row[col], color });
  }
  return board.items[index].source_id;
}

const ROW_READERS = {
  blank(ctx) {
    if (ctx.state.sub?.offset === 0) ctx.state.sub = null;
  },
  group(ctx, { row, at }) {
    const color = ctx.colorAt(at, 0)?.font ?? null;
    const group = addGroup(ctx.board, { title: row[0], color });
    Object.assign(ctx.state, { group, header: null, sub: null, parent: null });
  },
  header(ctx, { row }) {
    const header = headerColumns(ctx.board, { row, offset: 0, subitem: false });
    Object.assign(ctx.state, { header, sub: null, parent: null });
  },
  subheader(ctx, { row }) {
    const offset = firstFilled(row);
    ctx.state.sub = headerColumns(ctx.board, { row, offset, subitem: true });
  },
  item(ctx, { row, at }) {
    const { state } = ctx;
    state.sub = null;
    state.parent = readItemRow(ctx, {
      row,
      at,
      header: state.header,
      parent: null,
    });
  },
  subitem(ctx, { row, at }) {
    const { state } = ctx;
    readItemRow(ctx, { row, at, header: state.sub, parent: state.parent });
  },
};

function* readMonday(rows, shape, ctx) {
  ctx.state = { group: null, header: null, sub: null, parent: null };
  ctx.special = [shape.nameTitle];
  for (let at = shape.start; at < rows.length; at += 1) {
    if (at % ROWS_PER_STEP === 0) yield;
    const kind = rowKind(rows, at, { state: ctx.state, shape });
    ROW_READERS[kind](ctx, { row: rows[at], at });
  }
}

// ----------------------------------------------------------------- columns

function reportOverrides(ctx) {
  const special = new Set((ctx.special ?? []).map((t) => t.toLowerCase()));
  for (const [key, override] of ctx.overrides) {
    if (override.used) continue;
    const shown = JSON.stringify(override.title.slice(0, 80));
    const message = special.has(key)
      ? `column_types names ${shown}, which holds item names or groups; its type was not changed`
      : `column_types names ${shown}, which is not a column of this file; it was ignored`;
    ctx.warn(BOARD_PATH, "unknown_column", message);
  }
}

function* typedColumns(ctx) {
  const { board } = ctx;
  const nested = board.items.some((item) => item.parent_source_id !== null);
  const lists = board.columns.filter((column) => column.list && nested);
  for (const list of lists) {
    const message = `“${list.title}” lists subitem names; the subitems were imported from their own rows instead`;
    ctx.warn(BOARD_PATH, "subitems_column", message);
  }
  const kept = board.columns.filter((column) => !lists.includes(column));
  for (const column of kept) {
    columnType(column, ctx.overrides);
    yield;
  }
  reportOverrides(ctx);
  return mergeSubitemColumns(kept);
}

function reportLimits(ctx, { extraRows = 0, truncated = false }) {
  const { board } = ctx;
  if (board.cellDropped > 0) {
    const limit = board.cellLimit.toLocaleString("en-US");
    const message = `Only the first ${board.items.length} items were imported: one import holds at most ${limit} values, so ${board.cellDropped} more rows were left out`;
    ctx.warn(BOARD_PATH, "too_many_values", message);
  }
  const left = board.dropped + extraRows;
  if (left > 0 || truncated) {
    const more = left > 0 ? `; ${left} more rows were left out` : "";
    const message = `Only the first ${board.items.length} items were imported${more}${truncated ? " (the rest of the sheet was not read)" : ""}`;
    ctx.warn(BOARD_PATH, "too_many_items", message);
  }
  if (board.extraGroups > 0) {
    const message = `Only ${BOARD_LIMITS.groups} groups are kept; ${board.extraGroups} more groups joined the last one`;
    ctx.warn(BOARD_PATH, "too_many_groups", message);
  }
}

/** The finished snapshot board. */
function* finishBoard(ctx, { name, description }) {
  const { board, users } = ctx;
  const typed = yield* typedColumns(ctx);
  const columns = yield* convertColumnsSteps(typed, board.items, ctx);
  const ids = [...users.keys()];
  if (ids.length > BOARD_LIMITS.members) {
    const message = `${ids.length} people are named; only the first ${BOARD_LIMITS.members} were added as board members`;
    ctx.warn(BOARD_PATH, "too_many_members", message);
  }
  const members = ids
    .slice(0, BOARD_LIMITS.members)
    .map((id) => ({ user_source_id: id, role: "editor" }));
  return {
    source_id: truncate(`file:${ctx.fileName}`, MAX_NAME),
    name,
    description: description || null,
    kind: "private",
    source_url: null,
    members,
    columns,
    groups: board.groups,
    items: board.items,
  };
}

// -------------------------------------------------------------------- scan

function readFile(file) {
  const kind = file?.kind;
  const bytes = file?.bytes;
  if (!["csv", "xlsx"].includes(kind) || !(bytes instanceof Uint8Array))
    throw new ImportError("INVALID_FILE", "Expected a CSV or .xlsx file");
  if (bytes.length === 0)
    throw new ImportError("EMPTY_FILE", "The file is empty");
  if (bytes.length > FILE_LIMITS.bytes)
    throw new ImportError(
      "FILE_TOO_LARGE",
      "Import files are limited to 20 MiB",
    );
  const name =
    typeof file.name === "string" && file.name.trim() !== ""
      ? file.name.trim()
      : `import.${kind}`;
  return { kind, bytes, name };
}

/** `options.limits[key]` when it lowers `max`, else `max`. */
function limitOf(options, key, max) {
  const asked = options?.limits?.[key];
  return Number.isSafeInteger(asked) && asked > 0 ? Math.min(asked, max) : max;
}

/** `rows` with trimmed cells, in steps. */
function* trimRows(rows) {
  const out = [];
  for (const [at, row] of rows.entries()) {
    if (at % ROWS_PER_STEP === 0) yield;
    out.push(row.map((cell) => cell.trim()));
  }
  return out;
}

function* readCsvFile(bytes, ctx) {
  const { text, encoding } = decodeText(bytes);
  if (encoding === "windows-1252") {
    const message = "The file is not UTF-8; it was read as Windows-1252";
    ctx.warn(BOARD_PATH, "encoding", message);
  }
  const parsed = yield* parseCsvSteps(text, {
    maxRows: ctx.board.limit,
    maxCells: ctx.board.cellLimit,
    signal: ctx.signal,
  });
  ctx.board.cellDropped += parsed.cellRows;
  if (parsed.strayQuotes > 0) {
    const message = `${parsed.strayQuotes} quoted values have text after their closing quote (the first in line ${parsed.strayRecord}); it was kept as written, so those rows may have fewer columns than the header`;
    ctx.warn(BOARD_PATH, "csv_malformed_quote", message);
  }
  return {
    rows: yield* trimRows(parsed.rows),
    label: `CSV file ${ctx.fileName}`,
    extraRows: parsed.extraRows,
    droppedCells: parsed.droppedCells,
  };
}

function* readXlsxFile(bytes, ctx) {
  const rows = Math.min(XLSX_LIMITS.rows, 2 * ctx.board.limit + 1_000);
  const limits = { rows };
  const book = yield* readXlsxSteps(bytes, { limits, signal: ctx.signal });
  if (book.sheets > 1) {
    const message = `Only the first sheet “${book.sheet}” was imported; ${book.sheets - 1} other sheets were left out`;
    ctx.warn(BOARD_PATH, "other_sheets", message);
  }
  if (book.formulas > 0) {
    const message = `${book.formulas} cells hold formulas; their last calculated values were imported (formulas are never evaluated)`;
    ctx.warn(BOARD_PATH, "formula_values", message);
  }
  ctx.colorAt = (at, col) => book.colors.get(`${at}:${col}`) ?? null;
  return {
    rows: yield* trimRows(book.rows),
    label: `Excel workbook ${ctx.fileName}`,
    truncated: book.truncated,
    droppedCells: book.droppedCells,
  };
}

function createContext({ name, options, signal }) {
  const warnings = [];
  return {
    fileName: name,
    signal,
    warnings,
    warn: (path, code, message) => warnings.push({ code, message, path }),
    board: createBoard({
      limit: limitOf(options, "items", FILE_LIMITS.rows),
      // Not a route option (the routes refuse it): tests lower it.
      cellLimit: limitOf(options, "values", SNAPSHOT_LIMITS.values),
    }),
    overrides: readOverrides(options?.column_types),
    users: new Map(),
    maxUsers: SNAPSHOT_LIMITS.users,
    path: BOARD_PATH,
    colorAt: () => null,
  };
}

/** Reads `file` into a snapshot (see the module comment). */
export async function scan({
  file,
  options = {},
  signal = null,
  onProgress = () => {},
} = {}) {
  const { kind, bytes, name } = readFile(file);
  const ctx = createContext({ name, options, signal });
  const sliced = (steps) => drainSliced(steps, { signal });
  onProgress({
    phase: "reading",
    done: 0,
    total: 1,
    message: `Reading ${name}`,
  });
  const read = await sliced(
    kind === "csv" ? readCsvFile(bytes, ctx) : readXlsxFile(bytes, ctx),
  );
  if (read.rows.length === 0)
    throw new ImportError("EMPTY_FILE", "The file has no rows");
  if (read.droppedCells > 0) {
    const message = `${read.droppedCells} values past the first ${FILE_LIMITS.columns} columns were left out`;
    ctx.warn(BOARD_PATH, "too_many_columns", message);
  }
  onProgress({
    phase: "converting",
    done: 0,
    total: read.rows.length,
    message: "Reading rows",
  });
  const shape = kind === "xlsx" ? mondayShape(read.rows) : null;
  await sliced(
    shape ? readMonday(read.rows, shape, ctx) : readTable(read.rows, ctx),
  );
  reportLimits(ctx, read);
  const title =
    shape?.title ?? (name.replace(EXTENSION, "").trim() || "Imported board");
  const board = await sliced(
    finishBoard(ctx, { name: title, description: shape?.description }),
  );
  const total = board.items.length;
  onProgress({
    phase: "converting",
    done: total,
    total,
    message: `Read ${total} items`,
  });
  return {
    source: kind,
    source_label: shape ? `monday.com Excel export ${name}` : read.label,
    users: [...ctx.users.values()],
    workspaces: [
      {
        source_id: "file",
        name: truncate(`Imported from ${name}`, MAX_NAME),
        description: null,
        kind: "closed",
        boards: [board],
        docs: [],
      },
    ],
    warnings: ctx.warnings,
  };
}
