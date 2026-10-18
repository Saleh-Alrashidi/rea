/**
 * CSV files and the column typing every file import shares (SPEC-4 §3.3).
 *
 * - `decodeText(bytes)` reads UTF-8 (with or without BOM), UTF-16 with a
 *   BOM, and falls back to Windows-1252 for bytes that are not UTF-8.
 * - `parseCsv(text, { maxRows, maxColumns, signal })` is an RFC 4180
 *   reader: quoted fields with `""` escapes and line breaks, CRLF, LF or
 *   CR records, `,` (or `;` / tab when the first record uses more of
 *   them). Blank records are skipped. It keeps the first record and at
 *   most `maxRows` more, and at most `maxColumns` fields per record, and
 *   counts what it left out. A quoted field that never ends is an
 *   INVALID_CSV error (it would swallow the rest of the file).
 * - `inferType(values, title)` and `columnType(column, overrides)` pick a
 *   column's type from its non-empty, trimmed values (the override hook:
 *   `options.column_types` by column title, case-insensitive, wins).
 * - `numberText` and `serialText` render spreadsheet numbers and date
 *   serials (`xlsx.js`) as the text `numberOf` and `dateOf` read, so
 *   workbook cells and CSV text share one format.
 * - `convertColumns(columns, items, ctx)` turns the collected cell texts
 *   into snapshot values, status labels and people (users), with one
 *   warning per column for what changed.
 *
 * Formula-looking values (`=`, `+`, `-` or `@` first, unless the value is
 * a plain number such as `-5`) are never evaluated or parsed: a column
 * that holds one is a text column unless the admin overrides its type,
 * and the value is kept exactly as written.
 */
import { isValidStoredValue } from "../column-values.js";
import { InputError } from "../store-state.js";
import { readEmail } from "../store/people.js";
import { ImportError } from "./engine.js";
import { MAX_LABELS } from "./snapshot-columns.js";
import { WORKLANE_COLORS, nearestColor } from "./snapshot-rules.js";

export const FILE_LIMITS = Object.freeze({
  bytes: 20 * 1024 * 1024,
  rows: 50_000,
  columns: 200,
  // Status inference: at most this many distinct values of this length.
  statusValues: 30,
  statusLength: 50,
  // People named in a cell (name or email), so source IDs stay short.
  person: 200,
});
const QUOTE = 34;
const CR = 13;
const LF = 10;
const DELIMITERS = Object.freeze([",", ";", "\t"]);
const ABORT_EVERY = 1024;
const NUMBER = /^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d{1,3})?$/i;
// Doubles keep 15 significant digits; longer numbers stay text (IDs).
const MAX_DIGITS = 15;
const DATE =
  /^(\d{4})([-/])(\d{2})\2(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const FORMULA_START = /^[=+\-@]/;
// The last day spreadsheets have (9999-12-31) and seconds per day.
const MAX_SERIAL = 2_958_465;
const DAY = 86_400;
const PEOPLE_TITLE = /^(?:assignees?|owners?|persons?|people)$/i;
const NAMED_EMAIL = /^(.*?)\s*<([^<>\s]+)>$/;
const TOKEN_SPLIT = /[,;\n]/;
/** Colors of common status and priority words; others cycle the palette. */
const KNOWN_COLORS = Object.freeze({
  done: "#00c875",
  complete: "#00c875",
  completed: "#00c875",
  closed: "#00c875",
  finished: "#00c875",
  "working on it": "#fdab3d",
  "in progress": "#fdab3d",
  "in review": "#fdab3d",
  stuck: "#df2f4a",
  blocked: "#df2f4a",
  "not started": "#c4c4c4",
  "to do": "#c4c4c4",
  todo: "#c4c4c4",
  open: "#579bfc",
  urgent: "#df2f4a",
  critical: "#df2f4a",
  high: "#fdab3d",
  medium: "#579bfc",
  normal: "#579bfc",
  low: "#c4c4c4",
});
// Windows-1252 characters 0x80-0x9f (WHATWG Encoding), unassigned ones kept.
const CP1252 =
  "\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f" +
  "\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178";
const PALETTE = WORKLANE_COLORS.filter((color) => color !== "#c4c4c4");

export const aborted = () =>
  new ImportError("ABORTED", "The import was cancelled");

export function throwIfAborted(signal) {
  if (signal?.aborted) throw aborted();
}

/** The color for status label or group `title`, the `index`th of its kind. */
export function paletteColor(title, index) {
  return (
    KNOWN_COLORS[title.trim().toLowerCase()] ?? PALETTE[index % PALETTE.length]
  );
}

// ----------------------------------------------------------------- reading

/** → `{ text, encoding }` (see the module comment). */
export function decodeText(bytes) {
  const [a, b, c] = bytes;
  if (a === 0xff && b === 0xfe)
    return {
      text: new TextDecoder("utf-16le").decode(bytes),
      encoding: "utf-16le",
    };
  if (a === 0xfe && b === 0xff)
    return {
      text: new TextDecoder("utf-16be").decode(bytes),
      encoding: "utf-16be",
    };
  const bom = a === 0xef && b === 0xbb && c === 0xbf;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { text, encoding: bom ? "utf-8-bom" : "utf-8" };
  } catch {
    // Node's TextDecoder reads windows-1252 as Latin-1, so 0x80-0x9f map here.
    const latin1 = Buffer.from(bytes).toString("latin1");
    const text = latin1.replace(
      /[\x80-\x9f]/g,
      (char) => CP1252[char.charCodeAt(0) - 0x80],
    );
    return { text, encoding: "windows-1252" };
  }
}

const isBreak = (code, sep) => code === sep || code === CR || code === LF;

/** The delimiter the first record uses most outside quotes (`,` on ties). */
function sniffDelimiter(text) {
  const counts = new Map(DELIMITERS.map((d) => [d, 0]));
  let quoted = false;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (char === '"') quoted = !quoted;
    else if (!quoted && (char === "\n" || char === "\r")) break;
    else if (!quoted && counts.has(char))
      counts.set(char, counts.get(char) + 1);
  }
  let best = ",";
  for (const [char, count] of counts) if (count > counts.get(best)) best = char;
  return best;
}

/** A quoted field from `start` (after its quote) → `{ value, next }`. */
function readQuoted(text, { start, sep, record }) {
  let value = "";
  let at = start;
  for (;;) {
    const close = text.indexOf('"', at);
    if (close === -1) {
      const message = `Record ${record} opens a quoted field that never ends`;
      throw new ImportError("INVALID_CSV", message);
    }
    value += text.slice(at, close);
    if (text.charCodeAt(close + 1) === QUOTE) {
      value += '"';
      at = close + 2;
      continue;
    }
    // Text after the closing quote is kept as written (not RFC 4180).
    let end = close + 1;
    while (end < text.length && !isBreak(text.charCodeAt(end), sep)) end += 1;
    return { value: value + text.slice(close + 1, end), next: end };
  }
}

/** The record at `at` → `{ fields, next }` (`next` past its line break). */
function readRecord(text, { at, sep, record }) {
  const fields = [];
  let next = at;
  for (;;) {
    let field;
    if (text.charCodeAt(next) === QUOTE) {
      field = readQuoted(text, { start: next + 1, sep, record });
    } else {
      let end = next;
      while (end < text.length && !isBreak(text.charCodeAt(end), sep)) end += 1;
      field = { value: text.slice(next, end), next: end };
    }
    fields.push(field.value);
    next = field.next;
    const code = text.charCodeAt(next);
    if (code === sep) {
      next += 1;
      continue;
    }
    if (code === CR) next += text.charCodeAt(next + 1) === LF ? 2 : 1;
    else if (code === LF) next += 1;
    return { fields, next };
  }
}

/**
 * Parses `text` (see the module comment) → `{ rows, delimiter, extraRows,
 * droppedCells, width }`: `rows[0]` is the first (header) record,
 * `extraRows` the non-blank records past `maxRows`, `droppedCells` the
 * non-empty fields past `maxColumns`, `width` the widest record.
 */
export function parseCsv(text, options = {}) {
  const {
    maxRows = FILE_LIMITS.rows,
    maxColumns = FILE_LIMITS.columns,
    signal = null,
  } = options;
  const delimiter = sniffDelimiter(text);
  const sep = delimiter.charCodeAt(0);
  const rows = [];
  const result = { rows, delimiter, extraRows: 0, droppedCells: 0, width: 0 };
  let at = 0;
  for (let record = 1; at < text.length; record += 1) {
    if (record % ABORT_EVERY === 0) throwIfAborted(signal);
    const { fields, next } = readRecord(text, { at, sep, record });
    at = next;
    if (fields.every((field) => field.trim() === "")) continue;
    if (rows.length > maxRows) {
      result.extraRows += 1;
      continue;
    }
    result.width = Math.max(result.width, fields.length);
    for (const field of fields.slice(maxColumns))
      if (field.trim() !== "") result.droppedCells += 1;
    rows.push(
      fields.length > maxColumns ? fields.slice(0, maxColumns) : fields,
    );
  }
  return result;
}

// --------------------------------------------------------------- inference

/** A plain number literal's value (≤ 15 significant digits), else null. */
export function numberOf(text) {
  if (!NUMBER.test(text)) return null;
  const digits = text
    .replace(/^[+-]/, "")
    .split(/e/i)[0]
    .replace(".", "")
    .replace(/^0+/, "");
  const number = Number(text);
  return digits.length <= MAX_DIGITS && Number.isFinite(number)
    ? number === 0
      ? 0
      : number
    : null;
}

/** `{ date: "YYYY-MM-DD", time }` for ISO dates (and date-times), else null. */
export function dateOf(text) {
  const match = DATE.exec(text);
  if (!match) return null;
  const [, year, , month, day, hours = "00", minutes = "00", seconds = "00"] =
    match;
  const date = `${year}-${month}-${day}`;
  const clock = [hours, minutes, seconds].map(Number);
  const valid =
    isValidStoredValue({ type: "date" }, date) &&
    clock[0] < 24 &&
    clock[1] < 60 &&
    clock[2] < 60;
  return valid ? { date, time: clock.some((part) => part !== 0) } : null;
}

/** A spreadsheet number as Excel shows it (15 significant digits). */
export const numberText = (number) => String(Number(number.toPrecision(15)));

function clock(seconds) {
  const parts = [seconds / 3600, (seconds % 3600) / 60, seconds % 60];
  return parts
    .map((part) => String(Math.floor(part)).padStart(2, "0"))
    .join(":");
}

/**
 * Spreadsheet date or time serial `serial` (`kind` "date" | "time") as
 * the text `dateOf` reads: "YYYY-MM-DD", "YYYY-MM-DD HH:MM:SS", or
 * "HH:MM:SS" for times, in the 1900 or 1904 date system (`date1904`).
 */
export function serialText(serial, { date1904, kind }) {
  if (!(serial >= 0) || serial > MAX_SERIAL) return numberText(serial);
  const total = Math.round(serial * DAY);
  const days = Math.floor(total / DAY);
  const time = clock(total % DAY);
  if (kind === "time" || (days === 0 && !date1904))
    return days === 0 ? time : numberText(serial);
  // The 1900 system counts a 29 February 1900 that never was (serial 60).
  if (!date1904 && days === 60) return "1900-02-29";
  const epoch = date1904
    ? Date.UTC(1904, 0, 1)
    : Date.UTC(1899, 11, days > 60 ? 30 : 31);
  const date = new Date(epoch + days * DAY * 1000).toISOString().slice(0, 10);
  return total % DAY === 0 ? date : `${date} ${time}`;
}

/** Looks like a spreadsheet formula (see the module comment). */
export const isFormulaLike = (text) =>
  text.length > 1 && FORMULA_START.test(text) && numberOf(text) === null;

function emailOf(text) {
  try {
    const email = readEmail(text);
    return email.length <= FILE_LIMITS.person ? email : null;
  } catch (error) {
    if (error instanceof InputError) return null;
    throw error;
  }
}

/**
 * The person a cell names: "Name <email>", an email or a name (a
 * bracketed part that is not an email stays in the name) → `{ source_id,
 * name, email }`, or null (too long, or formula-like).
 */
export function personOf(token) {
  const named = NAMED_EMAIL.exec(token);
  const email = emailOf(named ? named[2] : token);
  const name = email === null ? token : named?.[1].trim() || email;
  if (name.length > FILE_LIMITS.person || isFormulaLike(name)) return null;
  const key = email === null ? `name:${name}` : `email:${email}`;
  return { source_id: key.toLowerCase(), name, email };
}

/** The names in a people cell ("Ann Lee, bob@acme.test"). */
export const tokensOf = (text) =>
  text
    .split(TOKEN_SPLIT)
    .map((token) => token.trim())
    .filter(Boolean);

const everyPerson = (values, test) =>
  values.every((value) =>
    tokensOf(value).every((token) => test(personOf(token))),
  );

function isCategorical(values) {
  const distinct = new Set();
  for (const value of values) {
    if (value.length > FILE_LIMITS.statusLength || value.includes("\n"))
      return false;
    distinct.add(value.toLowerCase());
    if (distinct.size > FILE_LIMITS.statusValues) return false;
  }
  return true;
}

/**
 * The type of a column titled `title` with non-empty trimmed `values`:
 * formula-looking values → text; Assignee/Owner/Person headers → people;
 * all dates → date; all numbers → numbers; all emails → people; at most
 * 30 distinct short values → status; else text.
 */
export function inferType(values, title) {
  if (values.length === 0 || values.some(isFormulaLike)) return "text";
  if (PEOPLE_TITLE.test(title) && everyPerson(values, Boolean)) return "people";
  if (values.every((value) => dateOf(value) !== null)) return "date";
  if (values.every((value) => numberOf(value) !== null)) return "numbers";
  if (everyPerson(values, (person) => person?.email != null)) return "people";
  return isCategorical(values) ? "status" : "text";
}

/** `options.column_types` → Map(lower-case title → { title, type, used }). */
export function readOverrides(raw) {
  const overrides = new Map();
  for (const [title, type] of Object.entries(raw ?? {}))
    overrides.set(title.trim().toLowerCase(), { title, type, used: false });
  return overrides;
}

/**
 * The type of collected `column` (`{ title, cells: [[index, text]],
 * keys? }`): the first override among `column.keys` (default its title),
 * else `inferType`. Sets `column.type` and `column.overridden`.
 */
export function columnType(column, overrides) {
  for (const key of column.keys ?? [column.title]) {
    const override = overrides.get(key.toLowerCase());
    if (!override) continue;
    override.used = true;
    Object.assign(column, { type: override.type, overridden: true });
    return column.type;
  }
  const values = column.cells.map(([, text]) => text);
  Object.assign(column, {
    type: inferType(values, column.title),
    overridden: false,
  });
  return column.type;
}

// -------------------------------------------------------------- conversion

function statusColumn(column, ctx) {
  const labels = new Map();
  for (const [, text] of column.cells) {
    const key = text.toLowerCase();
    if (labels.has(key)) continue;
    const fill = column.fills?.get(key);
    const color = fill ? nearestColor(fill) : paletteColor(text, labels.size);
    labels.set(key, { label: text, color });
  }
  if (labels.size <= MAX_LABELS) return { labels: [...labels.values()] };
  const message = `“${column.title}” has ${labels.size} different values (a status column keeps at most ${MAX_LABELS}); it was imported as text`;
  ctx.warn(ctx.at, "too_many_labels", message);
  return { type: "text" };
}

const bare = (person) => person.name === person.email;

/** People cells → user IDs; new users join `ctx.users` (bounded). */
function peopleColumn(column, ctx) {
  const added = new Map();
  const values = new Map();
  let invalid = 0;
  for (const [index, text] of column.cells) {
    const ids = [];
    for (const token of tokensOf(text)) {
      const person = personOf(token);
      if (person === null) {
        invalid += 1;
        continue;
      }
      const id = person.source_id;
      // A spelled-out name ("Ann <ann@x.test>") wins over a bare email.
      const known = added.get(id) ?? ctx.users.get(id);
      if (!known || (bare(known) && !bare(person))) added.set(id, person);
      if (!ids.includes(person.source_id)) ids.push(person.source_id);
    }
    if (ids.length > 0) values.set(index, ids);
  }
  const fresh = [...added.keys()].filter((id) => !ctx.users.has(id));
  if (ctx.users.size + fresh.length > ctx.maxUsers) {
    const message = `“${column.title}” names more people than an import can hold (${ctx.maxUsers}); it was imported as text`;
    ctx.warn(ctx.at, "too_many_people", message);
    return { type: "text" };
  }
  for (const [id, person] of added) ctx.users.set(id, person);
  if (invalid > 0) {
    const message = `${invalid} names in “${column.title}” are not people (too long, or formula-like) and were left out`;
    ctx.warn(ctx.at, "invalid_person", message);
  }
  return { values };
}

const CONVERTERS = Object.freeze({
  status: statusColumn,
  people: peopleColumn,
});

/** The snapshot value of `text` in a column of `type` (text when invalid). */
function valueOf(type, text) {
  if (type === "numbers") return numberOf(text) ?? text;
  if (type === "date") return dateOf(text)?.date ?? text;
  return text;
}

function noteColumn(column, ctx, type) {
  const texts = column.cells.map(([, text]) => text);
  const formulas = texts.filter(isFormulaLike).length;
  if (formulas > 0) {
    const message = `${formulas} values in “${column.title}” look like spreadsheet formulas; they were kept as plain text and never evaluated`;
    ctx.warn(ctx.at, "formula_text", message);
  }
  if (type === "date" && texts.some((text) => dateOf(text)?.time)) {
    const message = `Times in “${column.title}” were left out (date columns keep the day)`;
    ctx.warn(ctx.at, "time_dropped", message);
  }
}

/**
 * Converts typed `columns` (see `columnType`) into snapshot columns and
 * sets `items[index].values`. `ctx`: `{ path, users (Map of source ID →
 * user), maxUsers, warn(path, code, message) }`.
 */
export function convertColumns(columns, items, ctx) {
  return columns.map((column, position) => {
    const local = { ...ctx, at: `${ctx.path}.columns[${position}]` };
    // `{ labels }`, `{ values }` (people) or `{ type: "text" }` (fallback).
    const typed = CONVERTERS[column.type]?.(column, local) ?? {};
    const type = typed.type ?? column.type;
    noteColumn(column, local, type);
    for (const [index, text] of column.cells) {
      const value =
        type === "people" ? typed.values.get(index) : valueOf(type, text);
      if (value !== undefined) items[index].values[column.source_id] = value;
    }
    const out = { source_id: column.source_id, title: column.title, type };
    return type === "status" ? { ...out, labels: typed.labels } : out;
  });
}
