/**
 * Items and updates (part-1 API) with SPEC-2 activity entries and
 * notifications: item create/rename/move/delete and column value changes
 * are logged with `from_text`/`to_text` from `formatColumnValue` (people
 * values as rich text naming each user); users newly added to a people
 * column get an `assign` notification and users assigned to an item get
 * an `update` notification for its updates.
 *
 * People values may only add users who can open the board (SPEC-2 §6,
 * `access.canBeAssigned`), on every write path: item creation (also by
 * form submissions) and value changes. People already in a value stay
 * when they lose access; nothing rewrites existing values.
 *
 * Items may be subitems of another item on their board (`parent_id`,
 * SPEC-5 §1.1, invariants in `subitems.js`); deleting an item deletes its
 * subitems too.
 *
 * Mutators without a creator take a trailing `{ actorId }` option.
 */
import { canBeAssigned } from "../access.js";
import {
  formatColumnValue,
  isValidStoredValue,
  peopleIds,
} from "../column-values.js";
import { isPlainObject } from "../input.js";
import {
  byId,
  commit,
  forBoard,
  invalid,
  itemEvent,
  nextId,
  nextPosition,
  onBoard,
  push,
  replace,
  requireCount,
  requireText,
} from "../store-state.js";
import {
  byActor,
  notify,
  peopleText,
  quoted,
  recordActivity,
  resourceUrl,
} from "./activity.js";
import { removeItems, sortedGroups } from "./boards.js";
import { newItemParent } from "./subitems.js";

const knownUser = (state, id) => id === null || byId(state.users, id) !== null;
/** Every board's name column: its value is the item name. */
const NAME_COLUMN = Object.freeze({ id: "name", type: "name" });

/**
 * Appends a new item at the end of its group; `parentId` (a checked
 * parent, see `newItemParent`) makes it a subitem.
 */
export function insertItem(ctx, fields) {
  const { boardId, groupId, name, values, creatorId } = fields;
  const { state } = ctx;
  const inGroup = (r) => r.board_id === boardId && r.group_id === groupId;
  const parentId = fields.parentId ?? null;
  const at = ctx.now();
  return push(state.items, {
    id: nextId(state),
    board_id: boardId,
    group_id: groupId,
    ...(parentId === null ? {} : { parent_id: parentId }),
    name,
    position: nextPosition(state.items.filter(inGroup)),
    state: "active",
    creator_id: creatorId,
    created_at: at,
    updated_at: at,
    values,
  });
}

/**
 * Appends an update; `authorName` (SPEC-5 §1.4, imports) names a source
 * author without a Worklane user and is absent otherwise.
 */
export function insertUpdate(ctx, fields) {
  const { itemId, body, creatorId, authorName = null } = fields;
  const update = { id: nextId(ctx.state), item_id: itemId, body };
  const meta = { creator_id: creatorId, created_at: ctx.now() };
  const author = authorName === null ? {} : { author_name: authorName };
  return push(ctx.state.updates, { ...update, ...meta, ...author });
}

/** Items ordered by group position, then item position. */
function boardItems(state, boardId, groupId) {
  const groups = sortedGroups(state, boardId);
  const rank = new Map(groups.map((group, index) => [group.id, index]));
  const wanted = (item) => groupId === null || item.group_id === groupId;
  const order = (a, b) =>
    rank.get(a.group_id) - rank.get(b.group_id) ||
    a.position - b.position ||
    Number(a.id) - Number(b.id);
  return forBoard(state.items, boardId).filter(wanted).sort(order);
}

/**
 * Fails (InputError) when `value` adds people to `column` who cannot open
 * the board; people already in `before` may stay.
 */
function checkAssignees(ctx, { column, before, value }) {
  if (column.type !== "people") return;
  const board = byId(ctx.state.boards, column.board_id);
  const had = new Set(peopleIds(column, before));
  for (const id of peopleIds(column, value)) {
    const user = byId(ctx.state.users, id);
    if (had.has(id) || canBeAssigned(ctx.reader, user, board)) continue;
    invalid(`${user?.name ?? id} cannot access this board`);
  }
}

/**
 * Validates and copies a stored value for an existing non-name column
 * that held `before`.
 */
function storedValue(ctx, { column, before, value }) {
  if (!column || column.type === "name") {
    throw new TypeError("Values can only be set on existing non-name columns");
  }
  const getUser = (id) => byId(ctx.state.users, id);
  if (!isValidStoredValue(column, value, { getUser })) {
    throw new TypeError(`Invalid stored value for column ${column.id}`);
  }
  checkAssignees(ctx, { column, before, value });
  return structuredClone(value);
}

/** Validates a new item's `{ [columnId]: storedValue }`; empty values are dropped. */
export function storedValues(ctx, boardId, values) {
  if (!isPlainObject(values)) throw new TypeError("values must be an object");
  const stored = {};
  for (const [columnId, value] of Object.entries(values)) {
    const column = onBoard(ctx.state.columns, boardId, columnId);
    const empty = value === null || value === undefined;
    if (empty && column) continue;
    stored[columnId] = storedValue(ctx, { column, before: null, value });
  }
  return stored;
}

/** The activity text of a stored value (people as rich text). */
function textOf(column, stored) {
  if (column.type === "people") return peopleText(peopleIds(column, stored));
  return formatColumnValue(column, stored).text;
}

/** Notifies users newly present in people columns (`before` → `after`). */
export function notifyAssigned(ctx, { item, before, after, actorId }) {
  const { state } = ctx;
  const board = byId(state.boards, item.board_id);
  const added = [];
  for (const column of forBoard(state.columns, item.board_id)) {
    const had = new Set(peopleIds(column, before[column.id]));
    added.push(
      ...peopleIds(column, after[column.id]).filter((id) => !had.has(id)),
    );
  }
  if (added.length === 0 || !board) return;
  notify(ctx, {
    userIds: added,
    actorId,
    kind: "assign",
    text: byActor(actorId, ` assigned you to ${quoted(item.name)}`),
    url: resourceUrl("board", board.id, item.id),
    resource: { kind: "board", id: board.id, record: board },
  });
}

/** Creates an item; shared by `createItem` and form submissions. */
export function addItem(ctx, fields, activity) {
  const { state } = ctx;
  const { boardId, groupId, name, values } = fields;
  const stored = storedValues(ctx, boardId, values);
  const item = insertItem(ctx, { ...fields, values: stored });
  recordActivity(ctx, {
    boardId,
    itemId: item.id,
    itemName: name,
    toText: byId(sortedGroups(state, boardId), groupId)?.title ?? null,
    ...activity,
  });
  const actorId = activity.actorId ?? null;
  notifyAssigned(ctx, { item, before: {}, after: stored, actorId });
  return item;
}

function itemReads(state) {
  return {
    listItems({ boardId, groupId = null, offset = 0, limit = 25 } = {}) {
      requireCount(offset, "offset", 0);
      requireCount(limit, "limit", 0);
      const items = boardItems(state, boardId, groupId);
      const page = items.slice(offset, offset + limit);
      return { items: page, total: items.length };
    },
    countItems: (boardId) => forBoard(state.items, boardId).length,
    getItem: (id) => byId(state.items, id),
    /** How many updates each item has: `Map(itemId → count)`, no zeros. */
    countUpdatesByItem() {
      const counts = new Map();
      for (const { item_id } of state.updates) {
        counts.set(item_id, (counts.get(item_id) ?? 0) + 1);
      }
      return counts;
    },
    /** Updates of an item, newest first. */
    listUpdates(itemId, { limit = 25 } = {}) {
      requireCount(limit, "limit", 0);
      const updates = state.updates.filter((u) => u.item_id === itemId);
      return updates.reverse().slice(0, limit);
    },
  };
}

/** The item's values with `value` (validated) in `column`; null clears. */
function withValue(ctx, { item, column, value }) {
  const values = { ...item.values };
  const before = item.values[column.id];
  if (value === null || value === undefined) delete values[column.id];
  else values[column.id] = storedValue(ctx, { column, before, value });
  return values;
}

/** Logs the change of `column` from `before` to `after` values. */
function logValueChange(ctx, { item, column, before, after, actorId }) {
  const from = before[column.id];
  const to = after[column.id];
  if (JSON.stringify(from) === JSON.stringify(to)) return;
  recordActivity(ctx, {
    boardId: item.board_id,
    actorId,
    itemId: item.id,
    kind: "column_value_changed",
    itemName: item.name,
    columnId: column.id,
    fromText: textOf(column, from),
    toText: textOf(column, to),
  });
}

/** Logs a rename of `item` (now `next`). */
const logRename = (ctx, { item, next, actorId }) =>
  recordActivity(ctx, {
    boardId: next.board_id,
    itemId: next.id,
    itemName: next.name,
    kind: "item_renamed",
    actorId,
    fromText: item.name,
    toText: next.name,
  });

/**
 * Applies `changes` (`[{ column, value }]`, distinct columns) to `item` in
 * one commit: the name column renames, other columns take stored values
 * (null clears). Everything is validated before anything changes; each
 * change is logged and emits its own event, newly assigned people are
 * notified.
 */
function setValues(ctx, { item, changes, actorId }) {
  let values = item.values;
  let name = item.name;
  for (const { column, value } of changes) {
    if (column.type !== "name") {
      values = withValue(ctx, { item: { ...item, values }, column, value });
      continue;
    }
    requireText(value, "name");
    name = value;
  }
  const at = ctx.now();
  const next = { ...item, name, values, updated_at: at };
  replace(ctx.state.items, item, next);
  const events = changes.map(({ column }) => {
    if (column.type === "name") {
      logRename(ctx, { item, next, actorId });
      return itemEvent("item_renamed", next);
    }
    const before = item.values;
    logValueChange(ctx, { item: next, column, before, after: values, actorId });
    return itemEvent("column_value_changed", next, { column_id: column.id });
  });
  notifyAssigned(ctx, {
    item: next,
    before: item.values,
    after: values,
    actorId,
  });
  const [first, ...rest] = events;
  ctx.pending.unshift(...rest);
  return commit(ctx, first, next);
}

/** Adds an update; users assigned to the item are notified. */
function createUpdate(ctx, { itemId, body, creatorId = null }) {
  const { state } = ctx;
  const item = byId(state.items, itemId);
  if (!item || !knownUser(state, creatorId)) return null;
  requireText(body, "body");
  const update = insertUpdate(ctx, { itemId, body, creatorId });
  const board = byId(state.boards, item.board_id);
  const columns = forBoard(state.columns, item.board_id);
  const assigned = columns.flatMap((c) => peopleIds(c, item.values[c.id]));
  notify(ctx, {
    userIds: assigned,
    actorId: creatorId,
    kind: "update",
    text: byActor(creatorId, ` posted an update on ${quoted(item.name)}`),
    url: resourceUrl("board", board.id, item.id),
    resource: { kind: "board", id: board.id, record: board },
  });
  const event = { board_id: item.board_id, item_id: itemId };
  return commit(ctx, { type: "update_created", ...event }, update);
}

export function itemApi(ctx) {
  const { state } = ctx;
  const change = (item, changes) => {
    const next = { ...item, ...changes, updated_at: ctx.now() };
    return replace(state.items, item, next);
  };
  const log = (item, kind, extra) =>
    recordActivity(ctx, {
      boardId: item.board_id,
      itemId: item.id,
      itemName: item.name,
      kind,
      ...extra,
    });
  /** The `[{ column, value }]` changes of a values map, or null. */
  const changesOf = (item, values) => {
    if (!isPlainObject(values)) throw new TypeError("values must be an object");
    const changes = Object.entries(values).map(([columnId, value]) => ({
      column: onBoard(state.columns, item.board_id, columnId),
      value,
    }));
    return changes.some((entry) => !entry.column) ? null : changes;
  };
  const setAll = (id, values, actorId) => {
    const item = byId(state.items, id);
    const changes = item && changesOf(item, values);
    if (!changes) return null;
    if (changes.length === 0) return item;
    return setValues(ctx, { item, changes, actorId });
  };
  const move = (item, group, actorId) => {
    const inTarget = (r) =>
      r.board_id === item.board_id && r.group_id === group.id;
    const same = group.id === item.group_id;
    const position = same
      ? item.position
      : nextPosition(state.items.filter(inTarget));
    const next = change(item, { group_id: group.id, position });
    if (!same) {
      const from = onBoard(state.groups, item.board_id, item.group_id);
      const texts = { fromText: from.title, toText: group.title };
      log(next, "item_moved", { actorId, ...texts });
    }
    return commit(ctx, itemEvent("item_moved", next), next);
  };
  return {
    ...itemReads(state),
    /**
     * Creates an item at the end of `groupId` (default: the first group),
     * or a subitem of `parentId` (default group: the parent's). A bad
     * parent fails with `not_found` or `invalid_parent`.
     */
    createItem({
      boardId,
      groupId = null,
      name,
      values = {},
      creatorId = null,
      parentId = null,
    }) {
      if (!byId(state.boards, boardId)) return null;
      const parent =
        parentId === null ? null : newItemParent(state, { boardId, parentId });
      if (parent?.ok === false) return parent;
      const groups = sortedGroups(state, boardId);
      const target = groupId ?? parent?.group_id ?? null;
      const group = target === null ? groups[0] : byId(groups, target);
      if (!group || !knownUser(state, creatorId)) return null;
      requireText(name, "name");
      const fields = { boardId, groupId: group.id, name, values, creatorId };
      if (parent) fields.parentId = parent.id;
      const activity = { kind: "item_created", actorId: creatorId };
      const item = addItem(ctx, fields, activity);
      return commit(ctx, itemEvent("item_created", item), item);
    },
    renameItem(id, name, { actorId = null } = {}) {
      const item = byId(state.items, id);
      const changes = [{ column: NAME_COLUMN, value: name }];
      return item ? setValues(ctx, { item, changes, actorId }) : null;
    },
    /** Sets a stored value; null clears it. The name column renames. */
    setColumnValue(id, columnId, value, { actorId = null } = {}) {
      return setAll(id, { [columnId]: value }, actorId);
    },
    /**
     * Sets several values (`{ [columnId]: storedValue }`, the name column
     * renames) in one change: all are validated before any is written.
     * Unknown item or column → null.
     */
    setColumnValues(id, values, { actorId = null } = {}) {
      return setAll(id, values, actorId);
    },
    /** Moves the item to the end of another group of its board. */
    moveItem(id, groupId, { actorId = null } = {}) {
      const item = byId(state.items, id);
      const group = item && onBoard(state.groups, item.board_id, groupId);
      return group ? move(item, group, actorId) : null;
    },
    /**
     * Deletes the item with its subitems: one activity entry (counting
     * the subitems) and one `item_deleted` event per removed item.
     */
    deleteItem(id, { actorId = null } = {}) {
      const item = byId(state.items, id);
      if (!item) return null;
      const removed = removeItems(state, (record) => record === item);
      const subitems = removed.filter((record) => record !== item);
      const subitemsDeleted = subitems.length;
      log(item, "item_deleted", { actorId, subitemsDeleted });
      ctx.pending.unshift(...subitems.map((r) => itemEvent("item_deleted", r)));
      const deleted = Object.freeze({ ...item, state: "deleted" });
      return commit(ctx, itemEvent("item_deleted", item), deleted);
    },
    createUpdate: (fields) => createUpdate(ctx, fields),
  };
}
