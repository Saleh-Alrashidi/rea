/**
 * Items and updates (part-1 API) with SPEC-2 activity entries and
 * notifications: item create/rename/move/delete and column value changes
 * are logged with `from_text`/`to_text` from `formatColumnValue`; users
 * newly added to a people column get an `assign` notification and users
 * assigned to an item get an `update` notification for its updates.
 *
 * Mutators without a creator take a trailing `{ actorId }` option.
 */
import {
  formatColumnValue,
  isValidStoredValue,
  peopleIds,
} from "../column-values.js";
import {
  byId,
  commit,
  forBoard,
  isObject,
  nextId,
  nextPosition,
  onBoard,
  push,
  replace,
  requireCount,
  requireText,
} from "../store-state.js";
import { notify, quoted, recordActivity, resourceUrl } from "./activity.js";
import { removeItems, sortedGroups } from "./boards.js";

const knownUser = (state, id) => id === null || byId(state.users, id) !== null;

/** Appends a new item at the end of its group. */
export function insertItem(ctx, { boardId, groupId, name, values, creatorId }) {
  const { state } = ctx;
  const inGroup = (r) => r.board_id === boardId && r.group_id === groupId;
  const at = ctx.now();
  return push(state.items, {
    id: nextId(state),
    board_id: boardId,
    group_id: groupId,
    name,
    position: nextPosition(state.items.filter(inGroup)),
    state: "active",
    creator_id: creatorId,
    created_at: at,
    updated_at: at,
    values,
  });
}

export function insertUpdate(ctx, { itemId, body, creatorId }) {
  const update = { id: nextId(ctx.state), item_id: itemId, body };
  const fields = { creator_id: creatorId, created_at: ctx.now() };
  return push(ctx.state.updates, { ...update, ...fields });
}

function itemEvent(type, item, extra = {}) {
  const { board_id, id: item_id, group_id } = item;
  return { type, board_id, item_id, group_id, ...extra };
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

/** Validates and copies a stored value for an existing non-name column. */
function storedValue(state, column, value) {
  if (!column || column.type === "name") {
    throw new TypeError("Values can only be set on existing non-name columns");
  }
  const getUser = (id) => byId(state.users, id);
  if (!isValidStoredValue(column, value, { getUser })) {
    throw new TypeError(`Invalid stored value for column ${column.id}`);
  }
  return structuredClone(value);
}

/** Validates a `{ [columnId]: storedValue }` map; empty values are dropped. */
export function storedValues(state, boardId, values) {
  if (!isObject(values)) throw new TypeError("values must be an object");
  const stored = {};
  for (const [columnId, value] of Object.entries(values)) {
    const column = onBoard(state.columns, boardId, columnId);
    const empty = value === null || value === undefined;
    if (!empty || !column) stored[columnId] = storedValue(state, column, value);
  }
  return stored;
}

const textOf = (state, column, stored) =>
  formatColumnValue(column, stored, { getUser: (id) => byId(state.users, id) })
    .text;

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
  const who = byId(state.users, actorId)?.name ?? "Someone";
  notify(ctx, {
    userIds: added,
    actorId,
    kind: "assign",
    text: `${who} assigned you to ${quoted(item.name)}`,
    url: resourceUrl("board", board.id, item.id),
    resource: { kind: "board", id: board.id, record: board },
  });
}

/** Creates an item; shared by `createItem` and form submissions. */
export function addItem(ctx, fields, activity) {
  const { state } = ctx;
  const { boardId, groupId, name, values, creatorId } = fields;
  const stored = storedValues(state, boardId, values);
  const item = insertItem(ctx, {
    boardId,
    groupId,
    name,
    values: stored,
    creatorId,
  });
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
    /** Updates of an item, newest first. */
    listUpdates(itemId, { limit = 25 } = {}) {
      requireCount(limit, "limit", 0);
      const updates = state.updates.filter((u) => u.item_id === itemId);
      return updates.reverse().slice(0, limit);
    },
  };
}

function valueChange(ctx, { item, column, value, actorId }) {
  const { state } = ctx;
  const values = { ...item.values };
  if (value === null || value === undefined) delete values[column.id];
  else values[column.id] = storedValue(state, column, value);
  const fromText = textOf(state, column, item.values[column.id]);
  const toText = textOf(state, column, values[column.id]);
  if (
    JSON.stringify(item.values[column.id]) !== JSON.stringify(values[column.id])
  ) {
    const entry = { boardId: item.board_id, actorId, itemId: item.id };
    const texts = { columnId: column.id, fromText, toText };
    recordActivity(ctx, {
      ...entry,
      kind: "column_value_changed",
      itemName: item.name,
      ...texts,
    });
  }
  return values;
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
  const who = byId(state.users, creatorId)?.name ?? "Someone";
  notify(ctx, {
    userIds: assigned,
    actorId: creatorId,
    kind: "update",
    text: `${who} posted an update on ${quoted(item.name)}`,
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
  const rename = (item, name, actorId) => {
    requireText(name, "name");
    const next = change(item, { name });
    log(next, "item_renamed", { actorId, fromText: item.name, toText: name });
    return commit(ctx, itemEvent("item_renamed", next), next);
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
    /** Creates an item at the end of `groupId` (default: the first group). */
    createItem({
      boardId,
      groupId = null,
      name,
      values = {},
      creatorId = null,
    }) {
      const groups = sortedGroups(state, boardId);
      const group = groupId === null ? groups[0] : byId(groups, groupId);
      if (!group || !knownUser(state, creatorId)) return null;
      requireText(name, "name");
      const fields = { boardId, groupId: group.id, name, values, creatorId };
      const activity = { kind: "item_created", actorId: creatorId };
      const item = addItem(ctx, fields, activity);
      return commit(ctx, itemEvent("item_created", item), item);
    },
    renameItem(id, name, { actorId = null } = {}) {
      const item = byId(state.items, id);
      return item ? rename(item, name, actorId) : null;
    },
    /** Sets a stored value; null clears it. The name column renames. */
    setColumnValue(id, columnId, value, { actorId = null } = {}) {
      const item = byId(state.items, id);
      const column = item && onBoard(state.columns, item.board_id, columnId);
      if (!column) return null;
      if (column.type === "name") return rename(item, value, actorId);
      const values = valueChange(ctx, { item, column, value, actorId });
      const next = change(item, { values });
      const before = item.values;
      notifyAssigned(ctx, { item: next, before, after: values, actorId });
      const extra = { column_id: columnId };
      return commit(ctx, itemEvent("column_value_changed", next, extra), next);
    },
    /** Moves the item to the end of another group of its board. */
    moveItem(id, groupId, { actorId = null } = {}) {
      const item = byId(state.items, id);
      const group = item && onBoard(state.groups, item.board_id, groupId);
      return group ? move(item, group, actorId) : null;
    },
    deleteItem(id, { actorId = null } = {}) {
      const item = byId(state.items, id);
      if (!item) return null;
      removeItems(state, (record) => record === item);
      log(item, "item_deleted", { actorId });
      const deleted = Object.freeze({ ...item, state: "deleted" });
      return commit(ctx, itemEvent("item_deleted", item), deleted);
    },
    createUpdate: (fields) => createUpdate(ctx, fields),
  };
}
