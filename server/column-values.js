/**
 * Column value parsing, validation and formatting.
 *
 * This module owns the meaning of every column value format. Stored values
 * are: status `{ index }`, text `string`, numbers finite `number`, date
 * `"YYYY-MM-DD"`, people `string[]` of user IDs. A missing value means empty.
 * The store validates with `isValidStoredValue` and the GraphQL layer parses
 * and formats with the functions below, so no other module reinterprets raw
 * column input. Limits, the ID format and the name rule come from
 * `input.js`; formatting people takes the viewer's lookup (`getUser`), so
 * people outside a guest's directory read as `hiddenName`.
 */
import {
  ID_PATTERN,
  LIMITS,
  describe,
  isPlainObject,
  nameRule,
  validName,
} from "./input.js";

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const NUMBER_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const INDEX_PATTERN = /^\d{1,4}$/;
const STATUS_HINT =
  'Status values must be {"index":<n>} or {"label":"<label>"}';
const PEOPLE_HINT =
  'People values must be {"personsAndTeams":[{"id":<user ID>,"kind":"person"}]}';

/** Labels and colors of a new status column; index 5 is the blank default. */
export const DEFAULT_STATUS_SETTINGS = Object.freeze({
  labels: Object.freeze({ 0: "Working on it", 1: "Done", 2: "Stuck", 5: "" }),
  labels_colors: Object.freeze({
    0: "#fdab3d",
    1: "#00c875",
    2: "#df2f4a",
    5: "#c4c4c4",
  }),
});

const ok = (value) => ({ ok: true, value });
const fail = (message) => ({ ok: false, message });

function statusLabels(column) {
  const labels = column?.settings?.labels;
  return isPlainObject(labels) ? labels : DEFAULT_STATUS_SETTINGS.labels;
}

function isRealDate(text) {
  const match = DATE_PATTERN.exec(text);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [
    31,
    leap ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  const days = monthDays[month - 1];
  return year >= 1 && days !== undefined && day >= 1 && day <= days;
}

function isClearValue(value) {
  return (
    value === null ||
    value === undefined ||
    value === "" ||
    (isPlainObject(value) && Object.keys(value).length === 0)
  );
}

function statusFromIndex(column, raw) {
  const text = typeof raw === "number" ? String(raw) : raw;
  if (typeof text !== "string" || !INDEX_PATTERN.test(text)) {
    return fail("Status index must be a non-negative integer");
  }
  const index = Number(text);
  return Object.hasOwn(statusLabels(column), String(index))
    ? ok({ index })
    : fail(`Unknown status index ${index}`);
}

function statusFromLabel(column, raw) {
  if (typeof raw !== "string") return fail("Status label must be a string");
  const wanted = raw.trim();
  if (wanted === "") return ok(null);
  const entries = Object.entries(statusLabels(column)).filter(
    ([, label]) => typeof label === "string" && label !== "",
  );
  const folded = wanted.toLowerCase();
  const match =
    entries.find(([, label]) => label === wanted) ??
    entries.find(([, label]) => label.toLowerCase() === folded);
  return match
    ? ok({ index: Number(match[0]) })
    : fail(`Unknown status label ${describe(wanted)}`);
}

function numberResult(number) {
  if (!Number.isFinite(number)) return fail("Numbers must be finite");
  return ok(number === 0 ? 0 : number);
}

function dateResult(text) {
  const date = text.trim();
  return isRealDate(date)
    ? ok(date)
    : fail(`Invalid date ${describe(date)}; expected a real YYYY-MM-DD date`);
}

/** Returns the user ID string of a person entry, or null when invalid. */
function personId(entry) {
  if (!isPlainObject(entry)) return null;
  if (entry.kind !== undefined && entry.kind !== "person") return null;
  const raw = typeof entry.id === "number" ? String(entry.id) : entry.id;
  return typeof raw === "string" && ID_PATTERN.test(raw) ? raw : null;
}

function peopleResult(ids, getUser) {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return ok(null);
  const unknown =
    typeof getUser === "function"
      ? unique.find((id) => !getUser(id))
      : undefined;
  return unknown === undefined
    ? ok(unique)
    : fail(`Unknown user ID ${describe(unknown)}`);
}

function peopleFromJson(value, getUser) {
  const list = isPlainObject(value) ? value.personsAndTeams : undefined;
  if (!Array.isArray(list)) return fail(PEOPLE_HINT);
  const ids = [];
  for (const entry of list) {
    const id = personId(entry);
    if (id === null) return fail(`${PEOPLE_HINT}; teams are not supported`);
    ids.push(id);
  }
  return peopleResult(ids, getUser);
}

function peopleFromText(text, getUser) {
  const ids = text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const invalid = ids.find((id) => !ID_PATTERN.test(id));
  return invalid === undefined
    ? peopleResult(ids, getUser)
    : fail(`Invalid user ID ${describe(invalid)}`);
}

/**
 * Per-type parsers. `json` receives a decoded non-string, non-clearing value;
 * `simple` receives non-blank text. Decoded JSON strings use `simple`.
 */
const PARSERS = Object.freeze({
  status: {
    json(value, column) {
      if (!isPlainObject(value)) return fail(STATUS_HINT);
      if (Object.hasOwn(value, "index")) {
        return statusFromIndex(column, value.index);
      }
      if (Object.hasOwn(value, "label")) {
        return statusFromLabel(column, value.label);
      }
      return fail(STATUS_HINT);
    },
    simple: (text, column) => statusFromLabel(column, text),
  },
  text: {
    json: () => fail("Text values must be JSON strings"),
    simple: (text) =>
      text.length <= LIMITS.textValue
        ? ok(text)
        : fail(`Text values must be at most ${LIMITS.textValue} characters`),
  },
  numbers: {
    json: (value) =>
      typeof value === "number"
        ? numberResult(value)
        : fail("Number values must be a number or a numeric string"),
    simple(text) {
      const trimmed = text.trim();
      return NUMBER_PATTERN.test(trimmed)
        ? numberResult(Number(trimmed))
        : fail(`Invalid number ${describe(trimmed)}`);
    },
  },
  date: {
    json(value) {
      if (!isPlainObject(value) || !Object.hasOwn(value, "date")) {
        return fail('Date values must be {"date":"YYYY-MM-DD"}');
      }
      if (value.date === null || value.date === "") return ok(null);
      return typeof value.date === "string"
        ? dateResult(value.date)
        : fail("Date must be a YYYY-MM-DD string");
    },
    simple: (text) => dateResult(text),
  },
  people: {
    json: (value, column, options) => peopleFromJson(value, options.getUser),
    simple: (text, column, options) => peopleFromText(text, options.getUser),
  },
});

function parserFor(column) {
  const type = column?.type;
  return typeof type === "string" && Object.hasOwn(PARSERS, type)
    ? PARSERS[type]
    : null;
}

function unsupported(column) {
  return fail(`Unsupported column type ${describe(String(column?.type))}`);
}

function decodeJson(json) {
  // Values that are not strings were already decoded by the caller (for
  // example entries of a column_values object).
  if (typeof json !== "string") return ok(json);
  if (json.trim() === "") return ok(null);
  try {
    return ok(JSON.parse(json));
  } catch {
    return fail("Column value must be valid JSON");
  }
}

function parseName(text) {
  const name = validName(text);
  return name === null ? fail(nameRule("Item name")) : ok(name);
}

/**
 * Parses `change_column_value` input (JSON text) for `column`.
 * A decoded JSON string is read as the simple text format. Pass
 * `{ getUser }` to reject unknown user IDs in people values.
 * @returns {{ ok: true, value: unknown } | { ok: false, message: string }}
 */
export function parseColumnValue(column, json, options = {}) {
  if (column?.type === "name") {
    return fail(
      "The name column can only be changed with a simple string value",
    );
  }
  const parser = parserFor(column);
  if (!parser) return unsupported(column);
  const decoded = decodeJson(json);
  if (!decoded.ok) return decoded;
  if (isClearValue(decoded.value)) return ok(null);
  if (typeof decoded.value === "string") {
    return parseSimpleColumnValue(column, decoded.value, options);
  }
  return parser.json(decoded.value, column, options);
}

/**
 * Parses `change_simple_column_value` text for `column`. `null` or blank text
 * clears, except for the `name` column, which needs 1–255 characters.
 * @returns {{ ok: true, value: unknown } | { ok: false, message: string }}
 */
export function parseSimpleColumnValue(column, text, options = {}) {
  if (column?.type === "name") return parseName(text);
  const parser = parserFor(column);
  if (!parser) return unsupported(column);
  if (text === null || text === undefined) return ok(null);
  if (typeof text !== "string") {
    return fail("Simple column values must be strings");
  }
  if (text.trim() === "") return ok(null);
  return parser.simple(text, column, options);
}

const STORED_CHECKS = Object.freeze({
  text: (value) =>
    typeof value === "string" &&
    value.trim() !== "" &&
    value.length <= LIMITS.textValue,
  numbers: (value) => Number.isFinite(value),
  date: (value) => typeof value === "string" && isRealDate(value),
  status: (value, column) =>
    isPlainObject(value) &&
    Object.keys(value).length === 1 &&
    Number.isSafeInteger(value.index) &&
    Object.hasOwn(statusLabels(column), String(value.index)),
  people: (value, column, getUser) =>
    Array.isArray(value) &&
    value.length > 0 &&
    new Set(value).size === value.length &&
    value.every(
      (id) =>
        typeof id === "string" &&
        ID_PATTERN.test(id) &&
        (typeof getUser !== "function" || Boolean(getUser(id))),
    ),
});

/**
 * Reports whether `stored` is a valid stored value for `column`. `null` and
 * `undefined` (empty) are valid; the `name` column has no stored value.
 */
export function isValidStoredValue(column, stored, { getUser } = {}) {
  if (stored === null || stored === undefined) return true;
  const type = column?.type;
  if (typeof type !== "string" || !Object.hasOwn(STORED_CHECKS, type)) {
    return false;
  }
  return STORED_CHECKS[type](stored, column, getUser);
}

/**
 * The user IDs in a stored people value (in order); `[]` for empty values
 * and other column types. Assignment checks (notifications, "my work") use
 * this instead of reading stored people values themselves.
 */
export function peopleIds(column, stored) {
  if (column?.type !== "people" || !Array.isArray(stored)) return [];
  return stored.filter((id) => typeof id === "string");
}

/**
 * The selectable labels of a status column in index order, without the
 * blank label: `[{ index, label, color }]` (public form options).
 */
export function statusOptions(column) {
  if (column?.type !== "status") return [];
  const labels = statusLabels(column);
  const colors = isPlainObject(column?.settings?.labels_colors)
    ? column.settings.labels_colors
    : {};
  return Object.entries(labels)
    .filter(([index, label]) => INDEX_PATTERN.test(index) && label !== "")
    .filter(([, label]) => typeof label === "string")
    .map(([index, label]) => ({
      index: Number(index),
      label,
      color: typeof colors[index] === "string" ? colors[index] : null,
    }))
    .sort((a, b) => a.index - b.index);
}

function textOutput(text) {
  return { text, value: JSON.stringify(text) };
}

const FORMATTERS = Object.freeze({
  name: (stored) => textOutput(String(stored)),
  text: (stored) => textOutput(String(stored)),
  numbers: (stored) => textOutput(String(stored)),
  date: (stored) => ({
    text: String(stored),
    value: JSON.stringify({ date: String(stored) }),
  }),
  status(stored, column) {
    const label = statusLabels(column)[String(stored?.index)];
    return {
      text: typeof label === "string" ? label : null,
      value: JSON.stringify({ index: stored?.index }),
    };
  },
  people(stored, column, { getUser, hiddenName }) {
    const ids = Array.isArray(stored) ? stored : [];
    const lookup = typeof getUser === "function" ? getUser : null;
    const shown = lookup ? ids.filter((id) => lookup(id)) : ids;
    const name = (id) => lookup?.(id)?.name ?? hiddenName ?? id;
    return {
      text: ids.map(name).join(", "),
      value: JSON.stringify({
        personsAndTeams: shown.map((id) => ({
          id: Number(id),
          kind: "person",
        })),
      }),
    };
  },
});

/**
 * Formats a stored value as GraphQL `ColumnValue` output. `value` is JSON
 * text; both fields are null for empty values. With `getUser`, people it
 * does not return (unknown, or outside the viewer's directory) are left
 * out of `value` and shown in `text` as `hiddenName` (default: their ID).
 * @returns {{ text: string | null, value: string | null }}
 */
export function formatColumnValue(column, stored, options = {}) {
  const type = column?.type;
  if (
    stored === null ||
    stored === undefined ||
    typeof type !== "string" ||
    !Object.hasOwn(FORMATTERS, type)
  ) {
    return { text: null, value: null };
  }
  return FORMATTERS[type](stored, column, options);
}

/**
 * `stored`, a value of column `from`, as a value of `to`: a column of the
 * same type on another board (SPEC-6 §3.2 `move_item_to_board`). A
 * status keeps its label when `to` has one of that name (exact, else
 * case-insensitive); people keep the users `keepUser(id)` accepts; text,
 * numbers and dates carry over as they are. Null when nothing carries
 * over.
 */
export function convertStoredValue({ from, to, stored, keepUser }) {
  if (stored === null || stored === undefined || from?.type !== to?.type) {
    return null;
  }
  if (to.type === "status") {
    const label = statusLabels(from)[String(stored.index)];
    if (typeof label !== "string") return null;
    const match = statusFromLabel(to, label);
    return match.ok ? match.value : null;
  }
  if (to.type === "people") {
    const kept = peopleIds(from, stored).filter((id) => keepUser(id));
    return kept.length > 0 ? kept : null;
  }
  return isValidStoredValue(to, stored) ? structuredClone(stored) : null;
}
