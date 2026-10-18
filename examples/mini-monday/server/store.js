/**
 * The mini-monday store: data model API, ordering, change events and app
 * storage over the state kept by `server/store-state.js`.
 *
 * Records returned by the store are frozen. Each mutator emits exactly one
 * change event `{ type, board_id, item_id?, group_id?, column_id? }` and
 * returns the new or updated record; unknown IDs return null and emit
 * nothing. Arguments of the wrong type (for example an invalid stored column
 * value) throw a TypeError, because callers validate user input first.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { isValidStoredValue } from "./column-values.js";
import {
  COLUMN_TYPES,
  DEFAULT_CONTENT,
  GROUP_COLOR,
  SCOPE_KEY,
  byId,
  createPersistence,
  emptyState,
  forBoard,
  insertBoard,
  insertColumn,
  insertContent,
  insertGroup,
  insertItem,
  insertUpdate,
  isObject,
  loadState,
  nextPosition,
  onBoard,
  push,
  removeWhere,
  replace,
  seedState,
} from "./store-state.js";

const digest = (text) => createHash("sha256").update(text, "utf8").digest();
const knownUser = (state, id) => id === null || byId(state.users, id) !== null;

function requireText(value, label, optional = false) {
  if (optional && (value === undefined || value === null)) return;
  if (typeof value !== "string" || (!optional && value.trim() === "")) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function requireCount(value, label, minimum) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${label} must be an integer >= ${minimum}`);
  }
}

/** Copies `record` with every defined entry of `changes`. */
function withChanges(record, changes) {
  const defined = Object.entries(changes).filter(([, v]) => v !== undefined);
  return { ...record, ...Object.fromEntries(defined) };
}

/** Schedules a save, emits one change event and returns `record`. */
function commit(ctx, event, record) {
  ctx.persist.schedule();
  const frozen = Object.freeze(event);
  for (const entry of Array.from(ctx.listeners)) {
    try {
      entry.listener(frozen);
    } catch (error) {
      ctx.log.error?.("mini-monday: change listener failed", error);
    }
  }
  return record;
}

function itemEvent(type, item, extra = {}) {
  const { board_id, id: item_id, group_id } = item;
  return { type, board_id, item_id, group_id, ...extra };
}

function sortedGroups(state, boardId) {
  const groups = forBoard(state.groups, boardId);
  return groups.sort((a, b) => a.position - b.position);
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

function removeItems(state, predicate) {
  const ids = new Set(state.items.filter(predicate).map((item) => item.id));
  removeWhere(state.items, (item) => ids.has(item.id));
  removeWhere(state.updates, (update) => ids.has(update.item_id));
}

function findToken(tokens, token) {
  if (typeof token !== "string" || token === "") return null;
  // Compare digests of every token so timing reveals no partial matches.
  const wanted = digest(token);
  const same = (record) => timingSafeEqual(digest(record.token), wanted);
  return tokens.filter(same)[0] ?? null;
}

function readApi({ state }) {
  return {
    listUsers: () => [...state.users],
    getUser: (id) => byId(state.users, id),
    findApiToken: (token) => findToken(state.tokens, token),
    /** All API tokens, for printing at startup. */
    listApiTokens: () => [...state.tokens],
    listBoards({ ids = null, limit = 25, page = 1 } = {}) {
      requireCount(limit, "limit", 1);
      requireCount(page, "page", 1);
      const wanted = ids === null ? null : new Set(ids);
      const boards = state.boards.filter((b) => !wanted || wanted.has(b.id));
      return boards.slice((page - 1) * limit, page * limit);
    },
    getBoard: (id) => byId(state.boards, id),
    listGroups: (boardId) => sortedGroups(state, boardId),
    getGroup: (boardId, id) => onBoard(state.groups, boardId, id),
    listColumns: (boardId) => forBoard(state.columns, boardId),
    getColumn: (boardId, id) => onBoard(state.columns, boardId, id),
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
    listApps: () => [...state.apps],
    getApp: (id) => byId(state.apps, id),
    listInstalls: ({ boardId } = {}) =>
      boardId === undefined
        ? [...state.installs]
        : forBoard(state.installs, boardId),
    getInstall: (id) => byId(state.installs, id),
    listViews: (boardId) => forBoard(state.views, boardId),
  };
}

function boardApi(ctx) {
  const { state } = ctx;
  const groupEvent = (type, group) => {
    const { board_id, id: group_id } = group;
    return { type, board_id, group_id };
  };
  return {
    createBoard({ name, description = null, creatorId = null } = {}) {
      requireText(name, "name");
      requireText(description, "description", true);
      if (!knownUser(state, creatorId)) return null;
      const board = insertBoard(ctx, { name, description, creatorId });
      insertContent(ctx, board.id, DEFAULT_CONTENT);
      return commit(ctx, { type: "board_created", board_id: board.id }, board);
    },
    updateBoard(id, { name, description } = {}) {
      const board = byId(state.boards, id);
      if (!board) return null;
      if (name !== undefined) requireText(name, "name");
      requireText(description, "description", true);
      const next = withChanges(board, { name, description });
      replace(state.boards, board, next);
      return commit(ctx, { type: "board_updated", board_id: id }, next);
    },
    /** Deletes the board with its groups, items, views and installs. */
    deleteBoard(id) {
      const board = byId(state.boards, id);
      if (!board) return null;
      const installs = forBoard(state.installs, id);
      const scopes = new Set(installs.map((i) => `install:${i.id}`));
      removeWhere(state.storage, (entry) => scopes.has(entry.scope));
      removeItems(state, (item) => item.board_id === id);
      for (const name of ["groups", "columns", "views", "installs"]) {
        removeWhere(state[name], (record) => record.board_id === id);
      }
      removeWhere(state.boards, (record) => record === board);
      const deleted = Object.freeze({ ...board, state: "deleted" });
      return commit(ctx, { type: "board_deleted", board_id: id }, deleted);
    },
    createGroup(boardId, { title, color = GROUP_COLOR } = {}) {
      if (!byId(state.boards, boardId)) return null;
      requireText(title, "title");
      requireText(color, "color");
      const group = insertGroup(ctx, boardId, { title, color });
      return commit(ctx, groupEvent("group_created", group), group);
    },
    updateGroup(boardId, groupId, { title, color } = {}) {
      const group = onBoard(state.groups, boardId, groupId);
      if (!group) return null;
      if (title !== undefined) requireText(title, "title");
      if (color !== undefined) requireText(color, "color");
      const next = withChanges(group, { title, color });
      replace(state.groups, group, next);
      return commit(ctx, groupEvent("group_updated", next), next);
    },
    /** Deletes the group and its items. */
    deleteGroup(boardId, groupId) {
      const group = onBoard(state.groups, boardId, groupId);
      if (!group) return null;
      const inGroup = (r) => r.board_id === boardId && r.group_id === groupId;
      removeItems(state, inGroup);
      removeWhere(state.groups, (record) => record === group);
      return commit(ctx, groupEvent("group_deleted", group), group);
    },
    createColumn(boardId, { title, type } = {}) {
      if (!byId(state.boards, boardId)) return null;
      requireText(title, "title");
      if (!COLUMN_TYPES.includes(type)) {
        throw new TypeError(`Unsupported column type ${String(type)}`);
      }
      const column = insertColumn(ctx, boardId, { title, type });
      const event = { board_id: boardId, column_id: column.id };
      return commit(ctx, { type: "column_created", ...event }, column);
    },
  };
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

function storedValues(state, boardId, values) {
  if (!isObject(values)) throw new TypeError("values must be an object");
  const stored = {};
  for (const [columnId, value] of Object.entries(values)) {
    const column = onBoard(state.columns, boardId, columnId);
    const empty = value === null || value === undefined;
    if (!empty || !column) stored[columnId] = storedValue(state, column, value);
  }
  return stored;
}

function itemApi(ctx) {
  const { state } = ctx;
  const change = (item, changes) => {
    const next = { ...item, ...changes, updated_at: ctx.now() };
    return replace(state.items, item, next);
  };
  const rename = (item, name) => {
    requireText(name, "name");
    const next = change(item, { name });
    return commit(ctx, itemEvent("item_renamed", next), next);
  };
  return {
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
      const stored = storedValues(state, boardId, values);
      const fields = { boardId, name, values: stored, creatorId };
      const item = insertItem(ctx, { ...fields, groupId: group.id });
      return commit(ctx, itemEvent("item_created", item), item);
    },
    renameItem(id, name) {
      const item = byId(state.items, id);
      return item ? rename(item, name) : null;
    },
    /** Sets a stored value; null clears it. The name column renames. */
    setColumnValue(id, columnId, value) {
      const item = byId(state.items, id);
      const column = item && onBoard(state.columns, item.board_id, columnId);
      if (!column) return null;
      if (column.type === "name") return rename(item, value);
      const values = { ...item.values };
      if (value === null || value === undefined) delete values[columnId];
      else values[columnId] = storedValue(state, column, value);
      const next = change(item, { values });
      const extra = { column_id: columnId };
      return commit(ctx, itemEvent("column_value_changed", next, extra), next);
    },
    /** Moves the item to the end of another group of its board. */
    moveItem(id, groupId) {
      const item = byId(state.items, id);
      const group = item && onBoard(state.groups, item.board_id, groupId);
      if (!group) return null;
      const inTarget = (r) =>
        r.board_id === item.board_id && r.group_id === groupId;
      const position =
        groupId === item.group_id
          ? item.position
          : nextPosition(state.items.filter(inTarget));
      const next = change(item, { group_id: groupId, position });
      return commit(ctx, itemEvent("item_moved", next), next);
    },
    deleteItem(id) {
      const item = byId(state.items, id);
      if (!item) return null;
      removeItems(state, (record) => record === item);
      const deleted = Object.freeze({ ...item, state: "deleted" });
      return commit(ctx, itemEvent("item_deleted", item), deleted);
    },
    createUpdate({ itemId, body, creatorId = null }) {
      const item = byId(state.items, itemId);
      if (!item || !knownUser(state, creatorId)) return null;
      requireText(body, "body");
      const update = insertUpdate(ctx, { itemId, body, creatorId });
      const event = { board_id: item.board_id, item_id: itemId };
      return commit(ctx, { type: "update_created", ...event }, update);
    },
  };
}

/**
 * App storage. A deleted key keeps a tombstone (`value: null`) with its last
 * version, so a key written again never reuses a version number and stale
 * `previousVersion` values keep conflicting. Storage writes are not board
 * changes and emit no change event.
 */
function storageApi(ctx) {
  const { state } = ctx;
  const entryOf = (scope, key) => {
    if (typeof scope !== "string" || !SCOPE_KEY.test(scope)) {
      throw new TypeError("scopeKey must be install:<id> or app:<id>");
    }
    if (typeof key !== "string") throw new TypeError("key must be a string");
    return state.storage.find((e) => e.scope === scope && e.key === key);
  };
  const put = (entry, next) => {
    if (entry) replace(state.storage, entry, next);
    else push(state.storage, next);
    ctx.persist.schedule();
  };
  const liveVersion = (entry) =>
    entry === undefined || entry.value === null ? null : entry.version;
  return {
    getAppStorage(scope, key) {
      const entry = entryOf(scope, key);
      const version = liveVersion(entry);
      return version === null ? null : { value: entry.value, version };
    },
    setAppStorage(scope, key, value, previousVersion = null) {
      const entry = entryOf(scope, key);
      if (typeof value !== "string") throw new TypeError("value must be text");
      if (previousVersion !== null) requireCount(previousVersion, "version", 0);
      const current = liveVersion(entry);
      if (previousVersion !== null && previousVersion !== current) {
        return { success: false, version: current, reason: "version_conflict" };
      }
      const version = (entry?.version ?? 0) + 1;
      put(entry, { scope, key, value, version });
      return { success: true, version };
    },
    deleteAppStorage(scope, key) {
      const entry = entryOf(scope, key);
      if (liveVersion(entry) !== null) put(entry, { ...entry, value: null });
      return { success: true, version: null };
    },
  };
}

/**
 * Creates the store. Loads `file` when it exists (an invalid file is an
 * error and is never overwritten); otherwise seeds when `seed` is true and
 * saves the result. `file: null` (or `":memory:"`) keeps data in memory.
 * Writes are debounced (50 ms) and atomic; `flush()` awaits them. `now`
 * returns a Date; `log.error` receives background save and listener errors.
 */
export async function createStore({
  file = null,
  now = () => new Date(),
  seed = true,
  log = console,
} = {}) {
  const memory = file === null || file === ":memory:";
  const target = memory ? null : path.resolve(file);
  const loaded = target ? await loadState(target) : null;
  const state = loaded ?? emptyState();
  const listeners = new Set();
  const ctx = { state, now: () => now().toISOString(), log, listeners };
  if (!loaded && seed) seedState(ctx);
  ctx.persist = createPersistence({ file: target, state, log });
  if (!loaded) ctx.persist.schedule();
  const on = (listener) => {
    if (typeof listener !== "function") {
      throw new TypeError("listener must be a function");
    }
    const entry = { listener };
    listeners.add(entry);
    return () => void listeners.delete(entry);
  };
  const flush = () => ctx.persist.flush();
  const api = { ...readApi(ctx), ...boardApi(ctx), ...itemApi(ctx) };
  return Object.freeze({ ...api, ...storageApi(ctx), on, flush });
}
