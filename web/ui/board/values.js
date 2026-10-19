/**
 * Client-side owner of column value formats.
 *
 * Board data is decoded here once, when it arrives from the API: status
 * settings come from `settings_str`, and each `column_values[].value` JSON is
 * turned into a small UI value. Mutations encode UI values back into the
 * `change_column_value` JSON formats from the spec. No other UI module reads
 * raw column JSON.
 */

import { SOMEONE } from "../components/labels.js";

/** Column types that can be added from the UI (`name` is built in). */
export const ADDABLE_COLUMN_TYPES = Object.freeze([
  { type: "status", label: "Status" },
  { type: "people", label: "People" },
  { type: "date", label: "Date" },
  { type: "numbers", label: "Numbers" },
  { type: "text", label: "Text" },
]);

/** Group colors offered in the group menu (`#rrggbb`, as the API wants). */
export const GROUP_COLORS = Object.freeze([
  { color: "#579bfc", name: "Bright blue" },
  { color: "#a25ddc", name: "Purple" },
  { color: "#00c875", name: "Green" },
  { color: "#fdab3d", name: "Orange" },
  { color: "#df2f4a", name: "Red" },
  { color: "#ff158a", name: "Pink" },
  { color: "#ffcb00", name: "Yellow" },
  { color: "#9cd326", name: "Lime" },
  { color: "#66ccff", name: "Sky" },
  { color: "#037f4c", name: "Grass" },
  { color: "#784bd1", name: "Violet" },
  { color: "#7f5347", name: "Brown" },
]);

/** JSON that clears any column value (`{}` clears every type). */
export const CLEAR_VALUE = "{}";
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ID_PATTERN = /^\d{1,20}$/;
const FALLBACK_COLOR = "#c4c4c4";

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text) {
  if (typeof text !== "string" || text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Returns `color` when it is a `#rrggbb` color, else the fallback. */
export function safeColor(color, fallback = FALLBACK_COLOR) {
  return typeof color === "string" && COLOR_PATTERN.test(color)
    ? color
    : fallback;
}

const DARK_TEXT = "#1c1e2e";
const LIGHT_TEXT = "#ffffff";

function luminance(hex) {
  const [r, g, b] = hex
    .slice(1)
    .match(/../g)
    .map((pair) => Number.parseInt(pair, 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * The text color (white or near-black) with the higher WCAG contrast on a
 * label color from the data, so status pills stay readable whatever color
 * a board uses.
 */
export function textColorOn(color) {
  const background = luminance(safeColor(color));
  const onWhite = 1.05 / (background + 0.05);
  const onDark = (background + 0.05) / (luminance(DARK_TEXT) + 0.05);
  return onWhite >= onDark ? LIGHT_TEXT : DARK_TEXT;
}

/** Status label types (SPEC-5 §1.3); `done` and `closed` finish work. */
const LABEL_TYPES = new Set(["open", "custom", "done", "closed"]);
const DONE_TYPES = new Set(["done", "closed"]);

const objectAt = (settings, key) =>
  isPlainObject(settings?.[key]) ? settings[key] : {};

/**
 * Parses a status column's `settings_str` into ordered label options.
 * Labels with empty text are "blank" options (index 5 by default). An
 * option has a `type` when `labels_types` gives a known one for its index.
 * @returns {{ options: { index: number, label: string, color: string,
 *   type?: "open" | "custom" | "done" | "closed" }[],
 *   blank: { index: number, color: string } | null }}
 */
export function parseStatusSettings(settingsStr) {
  const settings = parseJson(settingsStr);
  const labels = objectAt(settings, "labels");
  const colors = objectAt(settings, "labels_colors");
  const types = objectAt(settings, "labels_types");
  const entries = Object.entries(labels)
    .filter(
      ([key, label]) => /^\d{1,4}$/.test(key) && typeof label === "string",
    )
    .map(([key, label]) => {
      const entry = {
        index: Number(key),
        label,
        color: safeColor(colors[key]),
      };
      return LABEL_TYPES.has(types[key])
        ? { ...entry, type: types[key] }
        : entry;
    })
    .sort((a, b) => a.index - b.index);
  const blank = entries.find((entry) => entry.label === "") ?? null;
  return {
    options: entries.filter((entry) => entry.label !== ""),
    blank: blank && { index: blank.index, color: blank.color },
  };
}

/** Adds parsed `status` settings to status columns. */
export function prepareColumns(columns) {
  return columns.map((column) =>
    column.type === "status"
      ? { ...column, status: parseStatusSettings(column.settings_str) }
      : { ...column },
  );
}

function decodeStatus(json) {
  const index = json?.index;
  return Number.isSafeInteger(index) && index >= 0 ? index : null;
}

function decodePeople(json) {
  const list = Array.isArray(json?.personsAndTeams) ? json.personsAndTeams : [];
  const ids = list
    .filter((entry) => isPlainObject(entry) && entry.kind !== "team")
    .map((entry) => String(entry.id))
    .filter((id) => ID_PATTERN.test(id));
  return [...new Set(ids)];
}

function decodeDate(json) {
  const date = json?.date;
  return typeof date === "string" && DATE_PATTERN.test(date) ? date : null;
}

function decodeScalar(json) {
  if (typeof json === "number" && Number.isFinite(json)) return String(json);
  return typeof json === "string" && json !== "" ? json : null;
}

const DECODERS = Object.freeze({
  status: decodeStatus,
  people: decodePeople,
  date: decodeDate,
  numbers: decodeScalar,
  text: decodeScalar,
});

/**
 * Decodes one `ColumnValue.value` for `column` into the UI value:
 * status → index | null, people → id[], date → "YYYY-MM-DD" | null,
 * numbers/text → string | null. Unknown types decode to null.
 */
export function decodeValue(column, valueJson) {
  const decode = DECODERS[column?.type];
  if (!decode) return null;
  const json = parseJson(valueJson);
  return decode(json === undefined ? null : json);
}

/**
 * Decodes an API item into `{ id, name, groupId, values, texts, ... }` where
 * `values[columnId]` is a UI value and `texts[columnId]` the server text.
 */
export function decodeItem(raw, columns) {
  const byId = new Map(columns.map((column) => [column.id, column]));
  const values = {};
  const texts = {};
  for (const cell of raw.column_values ?? []) {
    const column = byId.get(cell.id);
    if (!column || column.type === "name") continue;
    values[column.id] = decodeValue(column, cell.value);
    texts[column.id] = typeof cell.text === "string" ? cell.text : null;
  }
  const parent = raw.parent_item_id;
  return {
    id: String(raw.id),
    name: String(raw.name ?? ""),
    groupId: raw.group?.id ?? null,
    createdAt: raw.created_at ?? null,
    // SPEC-5 §1.6: null at the top level (and when not selected).
    parentId: parent === null || parent === undefined ? null : String(parent),
    updatesCount: Number.isSafeInteger(raw.updates_count)
      ? raw.updates_count
      : 0,
    values,
    texts,
  };
}

/** Returns true when a UI value is empty for its column type. */
export function isEmptyValue(value) {
  return (
    value === null ||
    value === undefined ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}

/**
 * The value of a UI value for `column` as the API reads it (before JSON
 * encoding): `{}` clears; text and numbers travel as strings (the simple
 * format), so the server stays the only validator of number syntax and
 * length limits. `create_item` sends several of these in one JSON object.
 */
export function valuePayload(column, value) {
  if (isEmptyValue(value)) return {};
  switch (column.type) {
    case "status":
      return { index: value };
    case "people":
      return {
        personsAndTeams: value.map((id) => ({
          id: Number(id),
          kind: "person",
        })),
      };
    case "date":
      return { date: value };
    case "numbers":
    case "text":
      return String(value);
    default:
      throw new TypeError(`Unsupported column type ${column.type}`);
  }
}

/** Encodes a UI value as `change_column_value` JSON text for `column`. */
export const encodeValue = (column, value) =>
  JSON.stringify(valuePayload(column, value));

/**
 * Whether a status option marks work as finished: its `done` or `closed`
 * type (SPEC-5 §1.3) when it has one, else a label reading "Done" (the
 * default label at index 1, SPEC.md "Status settings"), in any case.
 */
export function isDoneOption(option) {
  if (!option) return false;
  if (option.type) return DONE_TYPES.has(option.type);
  return option.label.trim().toLowerCase() === "done";
}

/**
 * Whether status `index` of `column` marks work as finished
 * (`isDoneOption`). The API has no completion flag, so this is the one
 * place the UI decides it (My work and Home keep finished items out of
 * Overdue; the List view sorts finished labels last).
 */
export function isDoneStatus(column, index) {
  return isDoneOption(statusOption(column, index));
}

/** Returns the status option for `index`, the blank option, or null. */
export function statusOption(column, index) {
  if (index === null || index === undefined) return null;
  const status = column.status;
  const option = status?.options.find((entry) => entry.index === index);
  if (option) return option;
  if (status?.blank?.index === index) return { ...status.blank, label: "" };
  return null;
}

/**
 * The user record for `id` in `users` (a Map of directory users), or a
 * placeholder named "Someone" when the viewer has no record of them.
 */
export function personOf(users, id) {
  return users?.get(id) ?? { id, name: SOMEONE, initials: "?" };
}

/**
 * Display text for an optimistic update, matching the server `text` formats
 * (`users` maps user IDs to `{ name }`).
 */
export function displayText(column, value, users) {
  if (isEmptyValue(value)) return null;
  if (column.type === "status") {
    return statusOption(column, value)?.label || null;
  }
  if (column.type === "people") {
    return value.map((id) => personOf(users, id).name).join(", ");
  }
  return String(value);
}
