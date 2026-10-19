/**
 * Readers of a `store.importBoard` spec (SPEC-4 §4, SPEC-5 §2), used by
 * `imports.js`: columns with their roles and status labels (colors and
 * label types), groups, items with their values, parents and updates,
 * and the board's views. They check and convert; nothing is written, and
 * the first invalid entry fails the whole import (InputError).
 *
 * Items name their parent by key (`key`, `parentKey`): any item of the
 * same spec, whatever its group or position, under the subitem rules of
 * `subitems.js` (no self or cyclic parents, at most MAX_SUBITEM_DEPTH
 * levels). Each prepared item records its parent as an index into the
 * prepared items, so ids can be assigned before any parent is written.
 */
import { isValidStoredValue } from "../column-values.js";
import { LIMITS, isPlainObject } from "../input.js";
import {
  COLUMN_ROLES,
  COLUMN_TYPES,
  STATUS_LABEL_TYPES,
  byId,
  invalid,
  readChoice,
  readColor,
  readName,
  slugify,
} from "../store-state.js";
import { DEFAULT_VIEWS, VIEW_NAMES, columnRoleProblem } from "./boards.js";
import { parentProblem } from "./subitems.js";

const MAX_LABELS = 200;

/** `base`, else `base_2`, `base_3`… not in `taken` (which it joins). */
function freshId(base, taken) {
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}_${n}`;
  taken.add(id);
  return id;
}

export function readList(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

function readUserRef(ctx, id, label) {
  if (id === null || id === undefined) return null;
  return byId(ctx.state.users, id) ? id : invalid(`${label}: unknown user`);
}

function readStamp(value, label) {
  if (value === null || value === undefined) return null;
  const valid = typeof value === "string" && Number.isFinite(Date.parse(value));
  return valid ? new Date(value).toISOString() : invalid(`${label}: bad time`);
}

const present = (value) => value !== undefined && value !== null;

/**
 * Status labels `[{ label, color, type? }]` → column settings (with
 * `labels_types` when a label has a type) and a label → index map.
 */
function statusSettings(labels, title) {
  const list = readList(labels ?? [], "labels");
  if (list.length > MAX_LABELS)
    invalid(`${title}: at most ${MAX_LABELS} status labels`);
  const settings = { labels: {}, labels_colors: {} };
  const types = {};
  const indexes = new Map();
  for (const [index, entry] of list.entries()) {
    const label = readName(entry?.label, `${title} label`);
    if (indexes.has(label)) invalid(`${title}: duplicate label ${label}`);
    indexes.set(label, index);
    settings.labels[index] = label;
    settings.labels_colors[index] = readColor(entry.color, `${title} color`);
    if (present(entry.type))
      types[index] = readChoice(entry.type, STATUS_LABEL_TYPES, "Label type");
  }
  if (Object.keys(types).length > 0) settings.labels_types = types;
  return { settings, indexes };
}

/** Columns `[{ key, title, type, labels?, role? }]` (see the module comment). */
export function readColumns(columns) {
  const taken = new Set(["name"]);
  const keys = new Map();
  const prepared = readList(columns, "columns").map((raw, index) => {
    const title = readName(raw?.title, "Column title");
    const type = readChoice(raw.type, COLUMN_TYPES, "Column type");
    const { settings, indexes } =
      type === "status"
        ? statusSettings(raw.labels, title)
        : { settings: {}, indexes: null };
    if (keys.has(raw.key)) invalid(`Duplicate column key at ${index}`);
    const column = { id: freshId(type, taken), title, type, settings, indexes };
    if (present(raw.role))
      column.role = readChoice(raw.role, Object.keys(COLUMN_ROLES), "Role");
    keys.set(raw.key, column);
    return column;
  });
  const records = prepared.map(({ id, type, role }) => ({
    id,
    board_id: "(import)",
    type,
    role,
  }));
  const problem = columnRoleProblem(records);
  if (problem) invalid(problem);
  return { prepared, keys };
}

export function readGroups(groups) {
  const list = readList(groups, "groups");
  if (list.length === 0) invalid("An imported board needs a group");
  const taken = new Set();
  const keys = new Map();
  const prepared = list.map((raw, position) => {
    const title = readName(raw?.title, "Group name");
    const color = readColor(raw.color, "Group color");
    if (keys.has(raw.key)) invalid(`Duplicate group key at ${position}`);
    const group = {
      id: freshId(slugify(title), taken),
      title,
      color,
      position,
    };
    keys.set(raw.key, group);
    return group;
  });
  return { prepared, keys };
}

/**
 * Views `[{ type, name? }]` (default DEFAULT_VIEWS), each type once; one
 * of them is a List view, which every board has (SPEC-6 §1.1).
 */
export function readViews(views) {
  const list = readList(views ?? DEFAULT_VIEWS, "views");
  const types = new Set();
  const prepared = list.map((raw) => {
    const type = readChoice(raw?.type, Object.keys(VIEW_NAMES), "View type");
    if (types.has(type))
      invalid(`The ${VIEW_NAMES[type]} view is listed twice`);
    types.add(type);
    const name = present(raw.name)
      ? readName(raw.name, "View name")
      : VIEW_NAMES[type];
    return { type, name };
  });
  if (!types.has("list")) invalid("An imported board needs a List view");
  return prepared;
}

/** A stored value for `column`; people limited by `assignable(id)`. */
function storedValue(ctx, { column, value, assignable }) {
  let stored = value;
  let left = [];
  if (column.type === "status") {
    if (!column.indexes.has(value)) invalid(`Unknown status label ${value}`);
    stored = { index: column.indexes.get(value) };
  } else if (column.type === "people") {
    const ids = [...new Set(readList(value, "people value"))];
    stored = ids.filter(assignable);
    left = ids.filter((id) => !assignable(id));
    if (stored.length === 0) stored = null;
  }
  const getUser = (id) => byId(ctx.state.users, id);
  if (stored !== null && !isValidStoredValue(column, stored, { getUser }))
    invalid(`Invalid value for column ${column.title}`);
  return { stored, left };
}

/**
 * Updates `[{ body, creatorId, createdAt, authorName? }]`; `authorName`
 * names a source author without a Worklane user (SPEC-5 §1.4).
 */
function readUpdates(ctx, updates) {
  return readList(updates ?? [], "updates").map((raw) => {
    const body = typeof raw?.body === "string" ? raw.body.trim() : "";
    if (body === "" || body.length > LIMITS.updateBody)
      invalid(`Update bodies must be 1-${LIMITS.updateBody} characters`);
    const update = {
      body,
      creator_id: readUserRef(ctx, raw.creatorId, "Update author"),
      created_at: readStamp(raw.createdAt, "Update time"),
    };
    if (!present(raw.authorName)) return update;
    if (update.creator_id !== null)
      invalid("Only updates without a Worklane author name one");
    return { ...update, author_name: readName(raw.authorName, "Author name") };
  });
}

/** Item keys → indexes; keys are optional, unique and non-empty strings. */
function itemKeys(list) {
  const keys = new Map();
  for (const [index, raw] of list.entries()) {
    if (!present(raw?.key)) continue;
    const { key } = raw;
    if (typeof key !== "string" || key === "")
      invalid(`Item ${index}: keys are non-empty strings`);
    if (keys.has(key)) invalid(`Item ${index} repeats an item key`);
    keys.set(key, index);
  }
  return keys;
}

/**
 * The parent index (or null) of each item of `list`, checked against the
 * subitem rules (`subitems.js` parentProblem, items named by index).
 */
function readParents(list) {
  const keys = itemKeys(list);
  const links = list.map((raw, index) => {
    const link = { id: index, board_id: "(import)", state: "active" };
    if (!present(raw?.parentKey)) return link;
    const parent = keys.get(raw.parentKey);
    if (parent === undefined) invalid(`Item ${index} names an unknown parent`);
    return { ...link, parent_id: parent };
  });
  const problem = parentProblem(links);
  if (problem) invalid(`Subitems: ${problem}`);
  return links.map((link) => link.parent_id ?? null);
}

/**
 * Items `[{ key?, parentKey?, groupKey, name, values, creatorId,
 * createdAt, updates }]` → prepared records (`parent`: an index into
 * them, or null) and the people `assignable` left out.
 */
export function readItems(ctx, { items, groups, columns, assignable }) {
  const list = readList(items, "items");
  const parents = readParents(list);
  const unassigned = [];
  const prepared = list.map((raw, index) => {
    const group = groups.get(raw?.groupKey);
    if (!group) invalid(`Item ${index} names an unknown group`);
    if (!isPlainObject(raw.values)) throw new TypeError("values: object");
    const values = {};
    for (const [key, value] of Object.entries(raw.values)) {
      const column = columns.get(key);
      if (!column) invalid(`Item ${index} names an unknown column`);
      const converted = storedValue(ctx, { column, value, assignable });
      if (converted.stored !== null) values[column.id] = converted.stored;
      if (converted.left.length > 0)
        unassigned.push({ index, columnKey: key, userIds: converted.left });
    }
    return {
      group_id: group.id,
      parent: parents[index],
      name: readName(raw.name, "Item name"),
      values,
      creator_id: readUserRef(ctx, raw.creatorId, "Item creator"),
      created_at: readStamp(raw.createdAt, "Item time"),
      updates: readUpdates(ctx, raw.updates),
    };
  });
  return { prepared, unassigned };
}
