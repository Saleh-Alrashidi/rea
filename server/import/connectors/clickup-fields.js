/**
 * Columns and values of the ClickUp connector (SPEC-4 §3.2). Every board
 * has the standard columns Status (the list's statuses in order, with
 * their colors and status types), Assignees, Due date and Start date (UTC
 * days of epoch ms), Priority (Urgent/High/Normal/Low), Time estimate
 * (h), Tags (comma joined) and Description (`text_content`), each with
 * the column role of its ClickUp field (SPEC-5 §1.2), then one column per
 * custom field, and "Sprint points" once a task has points.
 *
 * Custom fields: drop_down → status (options in `orderindex` order with
 * their colors); labels → comma-joined text (warned); number, currency
 * and emoji (rating) → numbers; date → date; text, short_text, email,
 * phone, url → text; users → people; checkbox → text Yes/No; every other
 * type → text (warned once per column). Fields a task carries that the
 * list did not list become columns when first seen.
 *
 * Each column has a plan: its snapshot column, a reader and what the
 * reader needs. Readers return undefined for "no value"; values they
 * cannot interpret pass through for `../snapshot.js` to report, which
 * also owns parsing numbers and dates and checking people and labels.
 */
import { LIMITS } from "../../input.js";
import { COLUMN_LIMITS } from "../snapshot-columns.js";
import { truncate } from "../snapshot-rules.js";
import { dateOf, noteUser } from "./clickup-common.js";
import { hexColor, idOf, isObject, listOf, scopeAt, str } from "./common.js";

const LABEL_COLOR = "#c4c4c4";
const HOUR_MS = 3_600_000;
/** Time estimates keep 0.01 h (36 s). */
const ESTIMATE_STEP_MS = HOUR_MS / 100;
const MAX_TEXT_DEPTH = 3;
/** ClickUp's task priorities and their Worklane labels (SPEC-4 §3.2). */
export const PRIORITIES = Object.freeze({
  urgent: Object.freeze({ label: "Urgent", color: "#df2f4a" }),
  high: Object.freeze({ label: "High", color: "#fdab3d" }),
  normal: Object.freeze({ label: "Normal", color: "#579bfc" }),
  low: Object.freeze({ label: "Low", color: "#c4c4c4" }),
});
/** Custom field types with a Worklane column type of their own. */
const FIELD_TYPES = Object.freeze({
  drop_down: "status",
  labels: "text",
  number: "numbers",
  currency: "numbers",
  emoji: "numbers",
  date: "date",
  text: "text",
  short_text: "text",
  email: "text",
  phone: "text",
  url: "text",
  checkbox: "text",
  users: "people",
});
const TEXT_KEYS = Object.freeze([
  "formatted_address",
  "name",
  "title",
  "label",
  "username",
  "email",
  "url",
]);

const orUndefined = (text) => (text.trim() === "" ? undefined : text);

/**
 * Adds `label` (once, case-insensitively: the first casing, color and
 * type win) to a status plan; → the label. `type` is a ClickUp status
 * type, for the Status column only.
 */
function addLabel(plan, { label, color, type }) {
  const key = label.toLowerCase();
  const known = plan.known.get(key);
  if (known !== undefined) return known.label;
  // Past the limit the snapshot adds used labels itself (in its color).
  if (plan.column.labels.length >= COLUMN_LIMITS.labels) return label;
  const entry = { label, color: hexColor(color, LABEL_COLOR) };
  const kind = str(type).trim().toLowerCase();
  if (kind !== "") entry.type = kind;
  plan.column.labels.push(entry);
  plan.known.set(key, entry);
  return label;
}

/** The ClickUp type of a label of the Status column, if known. */
export const statusType = (plan, label) =>
  plan.known.get(label.toLowerCase())?.type;

// ---------------------------------------------------------- task fields

function readStatus(plan, task) {
  const status = isObject(task.status) ? task.status : {};
  const label = str(status.status).trim();
  if (label === "") return undefined;
  return addLabel(plan, { label, color: status.color, type: status.type });
}

function readAssignees(plan, task) {
  const ids = [];
  for (const user of listOf(task.assignees)) {
    const id = noteUser(plan.ctx, user);
    if (id !== null) ids.push(id);
  }
  if (listOf(task.group_assignees).length > 0) {
    const message = `Team assignments in "${plan.column.title}" were dropped (Worklane assigns people)`;
    plan.scope.count("teams_dropped", message);
  }
  return ids.length > 0 ? ids : undefined;
}

/** A due or start date; `timed` is ClickUp's `due_date_time` flag. */
function dated(plan, value, timed) {
  const date = dateOf(value, { dateOnly: timed === false });
  if (date === undefined) return date;
  if (timed === true) {
    const message = `Times of day in "${plan.column.title}" were dropped (Worklane dates have no time)`;
    plan.scope.count("time_dropped", message);
  } else if (timed === false) {
    const message = `Dates without a time in "${plan.column.title}" were read as the day ClickUp shows; ClickUp keeps them at 4 am in the time zone of whoever set them, which its API does not give, so for zones west of UTC−9:30 the day may be one late`;
    plan.scope.count("date_only", message);
  }
  return date;
}

const readDue = (plan, task) => dated(plan, task.due_date, task.due_date_time);
const readStart = (plan, task) =>
  dated(plan, task.start_date, task.start_date_time);

function readPriority(plan, task) {
  const priority = isObject(task.priority) ? task.priority : {};
  const name = str(priority.priority).trim();
  if (name === "") return undefined;
  const known = PRIORITIES[name.toLowerCase()];
  if (known) return known.label;
  // Other names pass through; the snapshot adds them as labels.
  return name;
}

/** Milliseconds → hours with two decimals (rounding is reported). */
function readEstimate(plan, task) {
  const raw = task.time_estimate;
  if (raw === undefined || raw === null || raw === "") return undefined;
  const ms = typeof raw === "string" ? Number(raw) : raw;
  if (!Number.isFinite(ms)) return raw;
  if (ms % ESTIMATE_STEP_MS !== 0) {
    const message = `Values of "${plan.column.title}" were rounded to 0.01 h`;
    plan.scope.count("rounded", message);
  }
  return Math.round(ms / ESTIMATE_STEP_MS) / 100;
}

function readTags(plan, task) {
  const names = listOf(task.tags).map((tag) => str(tag.name).trim());
  return orUndefined(names.filter((name) => name !== "").join(", "));
}

function readDescription(plan, task) {
  const text = str(task.text_content);
  if (text.trim() === "") return undefined;
  if (text.length <= LIMITS.textValue) return text;
  const limit = LIMITS.textValue.toLocaleString("en-US");
  const message = `Descriptions longer than ${limit} characters were cut`;
  plan.scope.count("truncated", message);
  return truncate(text, LIMITS.textValue);
}

/** Numbers as ClickUp sends them (numbers or digit strings). */
const readNumber = (plan, value) =>
  typeof value === "string" ? orUndefined(value) : value;

const readPoints = (plan, task) =>
  task.points === undefined || task.points === null
    ? undefined
    : readNumber(plan, task.points);

const STANDARD = Object.freeze([
  ["status", "Status", "status", readStatus],
  ["assignees", "Assignees", "people", readAssignees],
  ["due_date", "Due date", "date", readDue],
  ["start_date", "Start date", "date", readStart],
  ["priority", "Priority", "status", readPriority],
  ["time_estimate", "Time estimate (h)", "numbers", readEstimate],
  ["tags", "Tags", "text", readTags],
  ["description", "Description", "text", readDescription, "text_content"],
]);
const POINTS = Object.freeze([
  "points",
  "Sprint points",
  "numbers",
  readPoints,
]);

// --------------------------------------------------------- custom fields

/** Text of a value of any other type (location, progress, tasks, files…). */
export function otherText(value, depth = 0) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (depth >= MAX_TEXT_DEPTH) return "";
  if (Array.isArray(value)) {
    const parts = value.map((entry) => otherText(entry, depth + 1));
    return parts.filter((part) => part.trim() !== "").join(", ");
  }
  if (!isObject(value)) return "";
  if (Number.isFinite(value.percent_completed)) {
    return `${value.percent_completed}%`;
  }
  const key = TEXT_KEYS.find((name) => str(value[name]).trim() !== "");
  return key ? str(value[key]) : JSON.stringify(value);
}

const readOther = (plan, value) => orUndefined(otherText(value));
const readText = (plan, value) =>
  orUndefined(typeof value === "string" ? value : otherText(value));
const readDate = (plan, value) => dateOf(value);

function readCheckbox(plan, value) {
  if (value === true || value === "true") return "Yes";
  if (value === false || value === "false") return "No";
  return readOther(plan, value);
}

function unknownOption(plan) {
  const message = `Values of "${plan.column.title}" that name no option were left out`;
  plan.scope.count("unknown_option", message);
  return undefined;
}

/** drop_down values are the option's `orderindex` (or its ID). */
function readDropDown(plan, value) {
  const { byId, byOrder } = plan.options;
  const option =
    typeof value === "number"
      ? byOrder.get(value)
      : (byId.get(str(value)) ?? byOrder.get(Number(str(value))));
  return option ? option.name : unknownOption(plan);
}

/** labels values are option IDs; they become their names, comma joined. */
function readLabels(plan, value) {
  const names = [];
  for (const id of Array.isArray(value) ? value : [value]) {
    const option = plan.options.byId.get(str(id));
    if (option) names.push(option.name);
    else unknownOption(plan);
  }
  return orUndefined(names.join(", "));
}

function readUsers(plan, value) {
  const ids = [];
  for (const entry of Array.isArray(value) ? value : [value]) {
    const id = noteUser(plan.ctx, entry);
    if (id !== null) ids.push(id);
  }
  return ids.length > 0 ? ids : undefined;
}

const FIELD_READERS = Object.freeze({
  drop_down: readDropDown,
  labels: readLabels,
  number: readNumber,
  currency: readNumber,
  emoji: readNumber,
  date: readDate,
  text: readText,
  short_text: readText,
  email: readText,
  phone: readText,
  url: readText,
  checkbox: readCheckbox,
  users: readUsers,
});

const orderOf = (option, index) => {
  const order = Number(option.orderindex);
  return option.orderindex !== null && Number.isFinite(order) ? order : index;
};

/** drop_down and labels options: `{ id, name | label, color, orderindex }`. */
function optionsOf(config) {
  const list = listOf(config.options).map((option, index) => ({
    id: idOf(option.id),
    name: str(option.name ?? option.label).trim(),
    color: option.color,
    order: orderOf(option, index),
  }));
  const named = list.filter((option) => option.name !== "");
  named.sort((a, b) => a.order - b.order);
  return {
    list: named,
    byId: new Map(named.map((option) => [option.id, option])),
    byOrder: new Map(named.map((option) => [option.order, option])),
  };
}

function fieldWarnings(plan) {
  const { title, original_type: type } = plan.column;
  if (type === "labels") {
    const message = `Labels field "${title}" was imported as comma-separated text`;
    plan.scope.add("labels_as_text", message);
  } else if (!Object.hasOwn(FIELD_TYPES, type)) {
    const message = `Field "${title}" (${type.slice(0, 40)}) was imported as text`;
    plan.scope.add("column_as_text", message);
  }
  const unit = str(plan.config.currency_type).trim();
  if (type === "currency" && unit !== "") {
    const message = `Field "${title}" is in ${unit.slice(0, 20)}; Worklane keeps the numbers only`;
    plan.scope.add("unit_dropped", message);
  }
}

// --------------------------------------------------------------- plans

/** A new plan for `column`, or null (columns_capped) when the board is full. */
function addPlan(state, column, read) {
  if (state.board.columns.length >= COLUMN_LIMITS.columns) {
    const message = `Only the first ${COLUMN_LIMITS.columns} columns were imported; values of the others were left out`;
    state.scope.count("columns_capped", message);
    return null;
  }
  const path = `${state.path}.columns[${state.board.columns.length}]`;
  const scope = scopeAt(state.ctx.report, path);
  const plan = { ctx: state.ctx, column, scope, read, known: new Map() };
  if (column.type === "status") column.labels = [];
  state.board.columns.push(column);
  return plan;
}

function standardPlan(state, [id, title, type, read, original = id]) {
  const column = { source_id: id, title, type, original_type: original };
  return addPlan(state, column, read);
}

/**
 * Adds the standard columns (Priority with its four labels) to a board;
 * each has the role its ID names (`STANDARD` IDs are column roles).
 */
export function addStandardColumns(state) {
  for (const spec of STANDARD) {
    const plan = standardPlan(state, spec);
    plan.column.role = spec[0];
    state.standard.push(plan);
    if (spec[0] === "status") state.statusPlan = plan;
    if (spec[0] !== "priority") continue;
    for (const { label, color } of Object.values(PRIORITIES)) {
      addLabel(plan, { label, color });
    }
  }
}

/** Adds the list's statuses (in `orderindex` order) to the Status column. */
export function addStatuses(state, statuses) {
  const ordered = listOf(statuses)
    .map((status, index) => ({ status, order: orderOf(status, index) }))
    .sort((a, b) => a.order - b.order);
  for (const { status } of ordered) {
    const label = str(status.status).trim();
    if (label === "") continue;
    const { color, type } = status;
    addLabel(state.statusPlan, { label, color, type });
  }
}

/**
 * The plan of custom field `raw` ({ id, name, type, type_config }), added
 * as a column when first seen; null for fields without an ID or beyond the
 * column limit.
 */
export function fieldPlan(state, raw) {
  const id = idOf(raw.id);
  if (id === null) return null;
  if (state.fields.has(id)) return state.fields.get(id);
  const originalType = str(raw.type).trim().slice(0, 64) || "unsupported";
  const type = FIELD_TYPES[originalType] ?? "text";
  const column = {
    source_id: id,
    title: str(raw.name),
    type,
    original_type: originalType,
  };
  const plan = addPlan(state, column, FIELD_READERS[originalType] ?? readOther);
  state.fields.set(id, plan);
  if (plan === null) return null;
  plan.config = isObject(raw.type_config) ? raw.type_config : {};
  plan.options = optionsOf(plan.config);
  if (type === "status") {
    for (const option of plan.options.list) {
      addLabel(plan, { label: option.name, color: option.color });
    }
  }
  fieldWarnings(plan);
  return plan;
}

const put = (values, plan, value) => {
  if (plan !== null && value !== undefined) {
    values[plan.column.source_id] = value;
  }
};

/** The snapshot values of task `raw` on the board of `state`. */
export function readValues(state, raw) {
  const values = {};
  for (const plan of state.standard) put(values, plan, plan.read(plan, raw));
  for (const field of listOf(raw.custom_fields)) {
    const plan = fieldPlan(state, field);
    const { value } = field;
    if (plan === null || value === undefined || value === null) continue;
    if (value === "") continue;
    put(values, plan, plan.read(plan, value));
  }
  if (raw.points !== undefined && raw.points !== null) {
    if (state.pointsPlan === undefined) {
      state.pointsPlan = standardPlan(state, POINTS);
    }
    put(values, state.pointsPlan, readPoints(state.pointsPlan, raw));
  }
  return values;
}
