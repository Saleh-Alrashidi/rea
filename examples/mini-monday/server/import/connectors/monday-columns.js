/**
 * Columns and values of the monday.com connector (SPEC-4 §3.1). Each board
 * column gets a plan: its snapshot column plus the reader that turns a
 * monday column value (`text` + JSON `value`) into the snapshot value.
 * Native types: status/color (labels and colors from `settings_str`,
 * ordered by `labels_positions_v2`, empty labels dropped), people/person
 * (persons of `personsAndTeams`; teams are reported), date (`value.date`;
 * times are reported), numbers (monday's number text), text and long_text
 * (`value.text`). Every other type becomes text from `display_value`
 * (mirror, connect boards, dependency) or `text`, with one warning per
 * column. `name` and `subtasks` columns are structure, not columns.
 * Parsing numbers and dates, limits and unknown people are the snapshot's.
 */
import { LIMITS } from "../../input.js";
import { COLUMN_LIMITS } from "../snapshot-columns.js";
import { idOf, isObject, scopeAt, str } from "./common.js";
import { colorOf, parseJson, settingsOf } from "./monday-common.js";

const NATIVE = Object.freeze({
  status: "status",
  color: "status",
  people: "people",
  person: "people",
  date: "date",
  numbers: "numbers",
  text: "text",
  long_text: "text",
});
const ALIAS_TYPES = Object.freeze({ color: "status", person: "people" });
const STRUCTURAL = new Set(["name", "subtasks"]);
const STATUS_COLOR = "#c4c4c4";
const SUFFIX = " (subitem)";

function addLabel(plan, label, color) {
  const { labels } = plan.column;
  const key = label.toLowerCase();
  if (labels.length >= COLUMN_LIMITS.labels) return;
  if (labels.some((entry) => entry.label.toLowerCase() === key)) return;
  labels.push({ label, color: colorOf(color, STATUS_COLOR) });
}

function labelEntries(settings) {
  const { labels, labels_positions_v2: positions } = settings;
  const source = isObject(labels) || Array.isArray(labels) ? labels : {};
  const place = isObject(positions) ? positions : {};
  const order = (index) =>
    Number.isFinite(place[index]) ? place[index] : Number(index);
  return Object.entries(source).sort(([a], [b]) => order(a) - order(b));
}

/** Adds the non-empty labels of `settings` to the column; index → label. */
function mergeLabels(plan, settings) {
  const colors = isObject(settings.labels_colors) ? settings.labels_colors : {};
  const byIndex = new Map();
  for (const [index, entry] of labelEntries(settings)) {
    const text = isObject(entry) ? (entry.label ?? entry.name) : entry;
    const label = str(text).trim();
    if (label === "") continue;
    const id =
      isObject(entry) && entry.id !== undefined ? str(entry.id) : index;
    byIndex.set(id, label);
    addLabel(
      plan,
      label,
      colors[index]?.color ?? colors[index] ?? entry?.color,
    );
  }
  return byIndex;
}

const orUndefined = (text) => (text.trim() === "" ? undefined : text);

function readStatus(plan, cv) {
  const index = str(parseJson(cv.value)?.index);
  const label = str(cv.text).trim() || plan.byIndex.get(index) || "";
  return orUndefined(label);
}

function peopleEntries(value) {
  if (Array.isArray(value?.personsAndTeams)) return value.personsAndTeams;
  return isObject(value) && value.id !== undefined ? [value] : [];
}

function readPeople(plan, cv) {
  const ids = [];
  for (const entry of peopleEntries(parseJson(cv.value))) {
    const id = idOf(entry?.id);
    if (entry?.kind === "team") {
      const message = `Team assignments in column "${plan.column.title}" were dropped (Worklane assigns people)`;
      plan.scope.count("teams_dropped", message);
    } else if (id !== null && !ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids.length > 0 ? ids : undefined;
}

function readDate(plan, cv) {
  const value = parseJson(cv.value);
  if (str(value?.date) !== "" && str(value.time) !== "") {
    const message = `Times of day in column "${plan.column.title}" were dropped (Worklane dates have no time)`;
    plan.scope.count("time_dropped", message);
  }
  return orUndefined(str(value?.date) || str(cv.text));
}

/** monday stores numbers as JSON strings ("42.5"); the snapshot parses them. */
function readNumber(plan, cv) {
  const value = parseJson(cv.value);
  if (typeof value === "number") return value;
  return orUndefined(typeof value === "string" ? value : str(cv.text));
}

function readText(plan, cv) {
  const value = parseJson(cv.value);
  return orUndefined(typeof cv.text === "string" ? cv.text : str(value));
}

function readLongText(plan, cv) {
  const value = parseJson(cv.value);
  return orUndefined(
    typeof value?.text === "string" ? value.text : str(cv.text),
  );
}

/** Text of any other type: `display_value` (linked columns) or `text`. */
export const readOther = (plan, cv) =>
  orUndefined(str(cv.display_value) || str(cv.text));

const READERS = Object.freeze({
  status: readStatus,
  color: readStatus,
  people: readPeople,
  person: readPeople,
  date: readDate,
  numbers: readNumber,
  text: readText,
  long_text: readLongText,
});

function columnWarnings(plan, settings) {
  const { title, original_type: type } = plan.column;
  if (!NATIVE[type]) {
    const message = `Column "${title}" (${type.slice(0, 40)}) was imported as text`;
    plan.scope.add("column_as_text", message);
  }
  const unit = isObject(settings.unit) ? settings.unit : {};
  const symbol = (str(unit.symbol) || str(unit.custom_unit)).trim();
  if (type === "numbers" && symbol !== "") {
    const message = `Column "${title}" shows the unit "${symbol.slice(0, 20)}"; Worklane keeps the numbers only`;
    plan.scope.add("unit_dropped", message);
  }
}

function skipColumn(state, id, type) {
  state.plans.set(id, null);
  if (STRUCTURAL.has(type)) return;
  const message = `Only the first ${COLUMN_LIMITS.columns} columns were imported; values of the others were left out`;
  state.scope.count("columns_capped", message);
}

/**
 * Adds board column `raw` ({ id, title, type, settings_str }) to the board
 * of `state` and returns its plan; structural columns (and columns beyond
 * the snapshot's limit) map to null, so their values are skipped.
 */
export function addColumn(ctx, state, raw) {
  const id = idOf(raw.id);
  const originalType = str(raw.type) || "unsupported";
  if (id === null || state.plans.has(id)) return state.plans.get(id) ?? null;
  const full = state.board.columns.length >= COLUMN_LIMITS.columns;
  if (STRUCTURAL.has(originalType) || full) {
    skipColumn(state, id, originalType);
    return null;
  }
  const path = `${state.path}.columns[${state.board.columns.length}]`;
  const type = NATIVE[originalType] ?? "text";
  const title = str(raw.title);
  const column = { source_id: id, title, type, original_type: originalType };
  const read = READERS[originalType] ?? readOther;
  const scope = scopeAt(ctx.report, path);
  const plan = { column, scope, read, byIndex: new Map() };
  const settings = settingsOf(raw.settings_str);
  if (type === "status") {
    column.labels = [];
    plan.byIndex = mergeLabels(plan, settings);
  }
  columnWarnings(plan, settings);
  state.board.columns.push(column);
  state.plans.set(id, plan);
  return plan;
}

const kindOf = (type) => ALIAS_TYPES[type] ?? type;

function matchingPlan(state, title, type) {
  const wanted = title.trim().toLowerCase();
  for (const plan of state.plans.values()) {
    const same =
      plan !== null &&
      plan.column.title.trim().toLowerCase() === wanted &&
      kindOf(plan.column.original_type) === kindOf(type);
    if (same) return plan;
  }
  return null;
}

/**
 * The plan for a subitem column value `cv` (with `column { title
 * settings_str }`): the board column with the same title and type (status
 * labels merged; the subitem's own label indexes kept), else a new column
 * "<title> (subitem)".
 */
export function subitemPlan(ctx, state, cv) {
  const id = idOf(cv.id);
  if (id === null) return null;
  if (state.subPlans.has(id)) return state.subPlans.get(id);
  const type = str(cv.type) || "unsupported";
  const title = str(cv.column?.title).trim() || type;
  const settings = settingsOf(cv.column?.settings_str);
  const match = STRUCTURAL.has(type) ? null : matchingPlan(state, title, type);
  let plan = null;
  if (match) {
    plan = { ...match };
    if (match.column.type === "status") {
      plan.byIndex = mergeLabels(match, settings);
    }
  } else if (!STRUCTURAL.has(type)) {
    // Keep the suffix visible when the snapshot cuts long titles.
    const named = `${title.slice(0, LIMITS.name - SUFFIX.length)}${SUFFIX}`;
    const column = {
      id: `subitem:${id}`,
      title: named,
      type,
      settings_str: settings,
    };
    plan = addColumn(ctx, state, column);
  }
  state.subPlans.set(id, plan);
  return plan;
}
