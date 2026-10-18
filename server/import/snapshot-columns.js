/**
 * Columns and values of snapshot boards (SPEC-4 §2): column records with
 * status labels, and item values in their column's snapshot format
 * (status → label, text → string, numbers → finite number, date →
 * "YYYY-MM-DD", people → user source IDs). Used by `snapshot-board.js`.
 *
 * Values follow the column formats `server/column-values.js` owns (it
 * parses numeric and date text and checks stored values). A status value
 * that names a label the column does not list adds that label (lossless);
 * a status column left with more than MAX_LABELS labels becomes a text
 * column, whose values (the labels) stay valid.
 */
import {
  isValidStoredValue,
  parseSimpleColumnValue,
} from "../column-values.js";
import { LIMITS } from "../input.js";
import { COLUMN_TYPES } from "../store-state.js";
import {
  LABEL_COLOR,
  keyPath,
  readArray,
  readChoice,
  readColor,
  readName,
  readObject,
  readSourceId,
  shown,
  truncate,
  uniqueSourceId,
} from "./snapshot-rules.js";

export const COLUMN_LIMITS = Object.freeze({ columns: 500, labels: 10_000 });
/** Labels a status column may keep; more make it a text column. */
export const MAX_LABELS = 200;
const ISO_DATE_TIME = /^(\d{4}-\d{2}-\d{2})T/;

// ----------------------------------------------------------------- columns

function readLabels(c, raw, { path, title }) {
  const list = readArray(c, raw, {
    path,
    max: COLUMN_LIMITS.labels,
    optional: true,
  });
  const labels = [];
  const byLower = new Map();
  for (const [index, entry] of (list ?? []).entries()) {
    const at = `${path}[${index}]`;
    if (!readObject(c, entry, at)) continue;
    if (typeof entry.label !== "string" || entry.label.trim() === "") continue;
    const label = readName(c, entry.label, { path: `${at}.label` });
    const key = label.toLowerCase();
    if (byLower.has(key)) {
      const message = `Duplicate label ${shown(label)} in “${title}” was merged`;
      c.warn(at, "duplicate_label", message);
      continue;
    }
    const color = readColor(c, entry.color, {
      path: `${at}.color`,
      fallback: LABEL_COLOR,
    });
    labels.push({ label, color });
    byLower.set(key, label);
  }
  return { labels, byLower };
}

function readColumn(c, raw, { path, taken, scope }) {
  if (!readObject(c, raw, path)) return null;
  const id = readSourceId(c, raw.source_id, `${path}.source_id`);
  const title = readName(c, raw.title, {
    path: `${path}.title`,
    fallback: "Untitled column",
  });
  const type = readChoice(c, raw.type, {
    path: `${path}.type`,
    choices: COLUMN_TYPES,
  });
  if (id === null || title === undefined || type === null) return null;
  const original =
    typeof raw.original_type === "string" && raw.original_type.trim() !== ""
      ? truncate(raw.original_type.trim(), 64)
      : type;
  const column = { path, title, type, original_type: original };
  column.source_id = uniqueSourceId(c, { id, taken, path, scope });
  if (type === "status") {
    const labelPath = `${path}.labels`;
    Object.assign(
      column,
      readLabels(c, raw.labels, { path: labelPath, title }),
    );
  }
  return column;
}

export function readColumns(c, raw, { path, scope }) {
  const list = readArray(c, raw, {
    path,
    max: COLUMN_LIMITS.columns,
    optional: true,
  });
  const taken = new Set();
  const columns = (list ?? []).map((entry, index) =>
    readColumn(c, entry, { path: `${path}[${index}]`, taken, scope }),
  );
  // The readable columns, so items are still checked against them.
  const usable = columns.filter(Boolean);
  return {
    columns: usable,
    ok: list !== null && usable.length === columns.length,
  };
}

/** Status columns over MAX_LABELS become text (their values are labels). */
export function capLabels(c, columns) {
  for (const column of columns) {
    if (column.type !== "status" || column.labels.length <= MAX_LABELS)
      continue;
    const message = `“${column.title}” has ${column.labels.length} labels (at most ${MAX_LABELS}); it was imported as a text column`;
    c.warn(column.path, "too_many_labels", message);
    column.type = "text";
  }
}

// ------------------------------------------------------------------ values

function invalidValue(c, { column, value, at, scope }) {
  const message = `${shown(value)} is not a valid ${column.type} value for “${column.title}” and was left out`;
  c.repeat(scope, "invalid_value", at, message);
  return undefined;
}

function statusValue(c, { column, value }) {
  const label = value.trim();
  if (label === "") return undefined;
  const known = column.byLower.get(label.toLowerCase());
  if (known !== undefined) return known;
  const added = truncate(label, LIMITS.name);
  column.labels.push({ label: added, color: LABEL_COLOR });
  column.byLower.set(added.toLowerCase(), added);
  const message = `Label ${shown(added)} was added to “${column.title}”: items use it but the column did not list it`;
  c.warn(column.path, "status_label_added", message);
  return added;
}

function textValue(c, { column, value, at, scope }) {
  const text = typeof value === "string" ? value : String(value);
  if (text.trim() === "") return undefined;
  if (text.length <= LIMITS.textValue) return text;
  const message = `Text longer than ${LIMITS.textValue} characters in “${column.title}” was cut`;
  c.repeat(scope, "truncated", at, message);
  return truncate(text, LIMITS.textValue);
}

/** Numbers and dates: stored values as they are, text through the parsers. */
function parsedValue(column, value) {
  if (isValidStoredValue(column, value)) return value;
  if (typeof value !== "string") return undefined;
  const text = ISO_DATE_TIME.exec(value)?.[1] ?? value;
  const parsed = parseSimpleColumnValue(
    column,
    column.type === "date" ? text : value,
  );
  return parsed.ok && parsed.value !== null ? parsed.value : undefined;
}

function peopleValue(c, { column, value, at, scope, users }) {
  const ids = [];
  for (const raw of value) {
    const id = Number.isSafeInteger(raw) ? String(raw) : raw;
    if (typeof id === "string" && users.has(id)) {
      if (!ids.includes(id)) ids.push(id);
      continue;
    }
    const message = `Unknown person ${shown(raw)} in “${column.title}” was left out`;
    c.repeat(scope, "unknown_user", at, message);
  }
  return ids.length === 0 ? undefined : ids;
}

/** A value in its column's snapshot format, or undefined (left out). */
function readValue(c, args) {
  const { column, value } = args;
  if (value === null || value === undefined || value === "") return undefined;
  const scalar = ["string", "number", "boolean"].includes(typeof value);
  switch (column.type) {
    case "status":
      return typeof value === "string"
        ? statusValue(c, args)
        : invalidValue(c, args);
    case "text":
      return scalar ? textValue(c, args) : invalidValue(c, args);
    case "people":
      return Array.isArray(value)
        ? peopleValue(c, args)
        : invalidValue(c, args);
    default:
      return parsedValue(column, value) ?? invalidValue(c, args);
  }
}

export function readValues(c, raw, { path, columns, users, scope }) {
  if (raw === undefined || raw === null) return {};
  if (!readObject(c, raw, path)) return null;
  const values = [];
  for (const [key, value] of Object.entries(raw)) {
    const at = keyPath(path, key);
    const column = columns.get(key);
    if (!column) {
      c.repeat(
        scope,
        "unknown_column",
        at,
        `Unknown column ${shown(key)}: the value was left out`,
      );
      continue;
    }
    const read = readValue(c, { column, value, at, scope, users });
    if (read !== undefined) values.push([key, read]);
  }
  return Object.fromEntries(values);
}
