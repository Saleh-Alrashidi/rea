/**
 * The mini-monday GraphQL API: type definitions, scope rules and resolvers
 * over the store (see SPEC.md "server/schema.js").
 *
 * Resolvers receive the context built by `server/http.js`:
 * `{ store, principal, apiVersion, hostOrigin, appsOrigin, log,
 * requireScope(scope) }`. Every root field checks its scope before touching
 * the store. This module validates user input and maps it to store calls;
 * `column-values.js` owns every column value format.
 */
import {
  formatColumnValue,
  parseColumnValue,
  parseSimpleColumnValue,
} from "./column-values.js";
import { GraphQLError } from "./graphql/errors.js";
import { buildSchema } from "./graphql/schema.js";
import { API_VERSIONS } from "./versions.js";

const MAX_NAME_LENGTH = 255;
const MAX_UPDATE_LENGTH = 10_000;
// Unspecified in SPEC.md: board descriptions share the update body limit,
// and every `limit` and `ids` argument is capped at the items_page maximum
// so that one request cannot ask for unbounded work.
const MAX_DESCRIPTION_LENGTH = 10_000;
const MAX_LIMIT = 500;
const MAX_STORAGE_KEY_LENGTH = 256;
const MAX_STORAGE_VALUE_LENGTH = 65_536;
const DEFAULT_GROUP_COLOR = "#579bfc";
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const CURSOR_PATTERN = /^[\w-]{1,512}$/;

/** True when `text` has a C0 control character (U+0000-U+001F) or U+007F. */
const hasControlCharacter = (text) =>
  Array.prototype.some.call(text, (unit) => unit < " " || unit === "\x7f");
const isPlainObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const describe = (value) => {
  const text = String(value);
  return JSON.stringify(text.length > 40 ? `${text.slice(0, 40)}…` : text);
};
const fail = (code, message) => {
  throw new GraphQLError(message, { code });
};
const badInput = (message) => fail("BAD_USER_INPUT", message);
const notFound = (what, id) =>
  fail("NOT_FOUND", `${what} ${describe(id)} was not found`);

// ------------------------------------------------------------- validation

function readName(value, label) {
  const name = value.trim();
  const valid = name.length > 0 && name.length <= MAX_NAME_LENGTH;
  return valid ? name : badInput(`${label} must be 1-${MAX_NAME_LENGTH} chars`);
}

function readDescription(value) {
  if (value === undefined || value === null) return null;
  return value.length <= MAX_DESCRIPTION_LENGTH
    ? value
    : badInput(`Descriptions must be at most ${MAX_DESCRIPTION_LENGTH} chars`);
}

function readColor(value) {
  if (value === undefined || value === null) return DEFAULT_GROUP_COLOR;
  return COLOR_PATTERN.test(value)
    ? value
    : badInput("Group colors must look like #RRGGBB");
}

function readLimit(value, label = "limit") {
  const valid = Number.isInteger(value) && value >= 1 && value <= MAX_LIMIT;
  return valid ? value : badInput(`${label} must be from 1 to ${MAX_LIMIT}`);
}

/** Returns the requested IDs without duplicates, or null when absent. */
function readIds(ids) {
  if (ids === undefined || ids === null) return null;
  if (ids.length > MAX_LIMIT) badInput(`ids may list at most ${MAX_LIMIT}`);
  return [...new Set(ids)];
}

/** Filters `records` by an optional `ids` argument, keeping record order. */
function pick(records, ids) {
  const wanted = readIds(ids);
  if (wanted === null) return records;
  const set = new Set(wanted);
  return records.filter((record) => set.has(record.id));
}

// ----------------------------------------------------------------- lookups

const boardOf = (store, id) => store.getBoard(id) ?? notFound("Board", id);
const groupOf = (store, boardId, id) =>
  store.getGroup(boardId, id) ?? notFound("Group", id);
const columnOf = (store, boardId, id) =>
  store.getColumn(boardId, id) ?? notFound("Column", id);
const userOf = (store, id) => (id ? store.getUser(id) : null);

/** The item `itemId`; with `boardId`, it must belong to that board. */
function itemOf(store, itemId, boardId) {
  const item = store.getItem(itemId);
  const onBoard = item && (boardId === undefined || item.board_id === boardId);
  return onBoard ? item : notFound("Item", itemId);
}

/** The item of a `board_id` + `item_id` mutation. */
const boardItem = (store, args) =>
  itemOf(store, args.item_id, boardOf(store, args.board_id).id);

// ------------------------------------------------------------- pagination

const encodeCursor = (b, g, o) =>
  Buffer.from(JSON.stringify({ b, g, o }), "utf8").toString("base64url");

/** Returns the offset of a cursor made for this board and group. */
function decodeCursor(cursor, boardId, groupId) {
  let data = null;
  try {
    const text = Buffer.from(cursor, "base64url").toString("utf8");
    data = CURSOR_PATTERN.test(cursor) ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  const valid =
    isPlainObject(data) &&
    data.b === boardId &&
    data.g === groupId &&
    Number.isSafeInteger(data.o) &&
    data.o >= 0;
  return valid ? data.o : badInput("Invalid cursor for this board or group");
}

/** One `items_page` of a board (`groupId` null) or of one group. */
function itemsPage(store, { boardId, groupId, args }) {
  const limit = readLimit(args.limit);
  const cursor = args.cursor ?? null;
  const offset = cursor === null ? 0 : decodeCursor(cursor, boardId, groupId);
  const { items, total } = store.listItems({ boardId, groupId, offset, limit });
  const next = offset + items.length;
  const more = items.length > 0 && next < total;
  return { items, cursor: more ? encodeCursor(boardId, groupId, next) : null };
}

// ---------------------------------------------------------- column values

/** Turns a column-values parse result into a stored value or an error. */
function parsed(column, result) {
  return result.ok
    ? result.value
    : badInput(`Column ${column.id}: ${result.message}`);
}

/**
 * Parses a `column_values` JSON object into `[columnId, storedValue]`
 * pairs. Entries use the change_column_value formats; strings use the simple
 * format. Every entry is validated before the caller writes anything.
 */
function parseValueMap(store, { boardId, text, allowName }) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  if (!isPlainObject(data)) badInput("column_values must be a JSON object");
  const options = { getUser: store.getUser };
  return Object.entries(data).map(([columnId, raw]) => {
    const column = store.getColumn(boardId, columnId);
    if (!column) badInput(`Unknown column ${describe(columnId)}`);
    if (column.type === "name" && !allowName) {
      badInput("Set the item name with item_name");
    }
    const simple = typeof raw === "string" || column.type === "name";
    const parse = simple ? parseSimpleColumnValue : parseColumnValue;
    return [column.id, parsed(column, parse(column, raw, options))];
  });
}

function columnValues(item, { ids }, { store }) {
  const options = { getUser: store.getUser };
  return pick(store.listColumns(item.board_id), ids).map((column) => {
    const stored = column.type === "name" ? item.name : item.values[column.id];
    const { text, value } = formatColumnValue(column, stored, options);
    return { id: column.id, type: column.type, text, value };
  });
}

/** Resolver for change_column_value / change_simple_column_value. */
const changeValue =
  (parse) =>
  (_parent, args, { store }) => {
    const item = boardItem(store, args);
    const column = columnOf(store, item.board_id, args.column_id);
    const options = { getUser: store.getUser };
    const value = parsed(column, parse(column, args.value ?? null, options));
    return store.setColumnValue(item.id, column.id, value);
  };

// ------------------------------------------------------------ app storage

/**
 * Checks `scope` and that the caller is the app principal of `install_id`,
 * validates the key and returns the storage scope key of the segment.
 */
function storageScope(ctx, args, scope) {
  ctx.requireScope(scope);
  const { principal } = ctx;
  if (principal?.kind !== "app" || args.install_id !== principal.installId) {
    fail("FORBIDDEN", "App storage is only available to the install's app");
  }
  const { length } = args.key;
  if (length < 1 || length > MAX_STORAGE_KEY_LENGTH) {
    badInput(`Storage keys must be 1-${MAX_STORAGE_KEY_LENGTH} characters`);
  }
  if (hasControlCharacter(args.key)) {
    badInput("Storage keys must not contain control characters");
  }
  const { installId, appId } = principal;
  return args.segment === "instance" ? `install:${installId}` : `app:${appId}`;
}

const writeResult = ({ success, version, reason }) => ({
  success,
  version: version ?? null,
  reason: reason ?? null,
});

function setAppStorage(_parent, args, ctx) {
  const scopeKey = storageScope(ctx, args, "storage:write");
  if (args.value.length > MAX_STORAGE_VALUE_LENGTH) {
    badInput(`Storage values must be at most ${MAX_STORAGE_VALUE_LENGTH}`);
  }
  const previous = args.previous_version ?? null;
  if (previous !== null && previous < 0) {
    badInput("previous_version must not be negative");
  }
  const { key, value } = args;
  return writeResult(ctx.store.setAppStorage(scopeKey, key, value, previous));
}

// -------------------------------------------------------------- resolvers

/** Wraps a root resolver so that it first requires `scope`. */
const scoped = (scope, resolve) => (parent, args, ctx, info) => {
  ctx.requireScope(scope);
  return resolve(parent, args, ctx, info);
};
const read = (resolve) => scoped("boards:read", resolve);
const write = (resolve) => scoped("boards:write", resolve);

function initials(name) {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  const ends = words.length > 1 ? [words[0], words.at(-1)] : words;
  return ends
    .map((word) => Array.from(word)[0])
    .join("")
    .toUpperCase();
}

function appUrl(view, _args, { store, appsOrigin }) {
  if (view.type !== "app" || !view.app_install_id) return null;
  const install = store.getInstall(view.app_install_id);
  const app = install ? store.getApp(install.app_id) : null;
  if (!app) return null;
  return `${appsOrigin}${app.path}?install_id=${encodeURIComponent(install.id)}`;
}

const Query = {
  me: read((_p, _a, { store, principal }) => {
    const { userId } = principal;
    return store.getUser(userId) ?? notFound("User", userId);
  }),
  users: read((_p, { ids, limit }, { store }) =>
    pick(store.listUsers(), ids).slice(0, readLimit(limit)),
  ),
  boards: read((_p, { ids, limit, page }, { store }) => {
    if (page < 1) badInput("page must be a positive integer");
    const filter = { ids: readIds(ids), limit: readLimit(limit), page };
    return store.listBoards(filter);
  }),
  items: read((_p, { ids }, { store }) =>
    readIds(ids)
      .map((id) => store.getItem(id))
      .filter(Boolean),
  ),
  version: (_p, _a, { apiVersion }) =>
    API_VERSIONS.find((version) => version.value === apiVersion),
  versions: () => API_VERSIONS,
  app_storage(_parent, args, ctx) {
    const scopeKey = storageScope(ctx, args, "storage:read");
    const entry = ctx.store.getAppStorage(scopeKey, args.key);
    return entry ? { key: args.key, ...entry } : null;
  },
};

function updateBoard(_p, args, { store }) {
  const board = boardOf(store, args.board_id);
  const value = args.new_value;
  const changes =
    args.board_attribute === "name"
      ? { name: readName(value, "Board name") }
      : { description: readDescription(value) };
  return store.updateBoard(board.id, changes);
}

function updateGroup(_p, args, { store }) {
  const board = boardOf(store, args.board_id);
  const group = groupOf(store, board.id, args.group_id);
  const value = args.new_value;
  const changes =
    args.group_attribute === "title"
      ? { title: readName(value, "Group name") }
      : { color: readColor(value) };
  return store.updateGroup(board.id, group.id, changes);
}

function createItem(_p, args, { store, principal }) {
  const board = boardOf(store, args.board_id);
  const name = readName(args.item_name, "Item name");
  const groupId = args.group_id ?? null;
  if (groupId !== null) groupOf(store, board.id, groupId);
  const text = args.column_values ?? null;
  const request = { boardId: board.id, text, allowName: false };
  const pairs = text === null ? [] : parseValueMap(store, request);
  const values = Object.fromEntries(pairs);
  const fields = { boardId: board.id, groupId, name, values };
  const item = store.createItem({ ...fields, creatorId: principal.userId });
  return item ?? badInput("The board has no group for new items");
}

function changeMultipleValues(_p, args, { store }) {
  const item = boardItem(store, args);
  const request = { boardId: item.board_id, text: args.column_values };
  const pairs = parseValueMap(store, { ...request, allowName: true });
  for (const [columnId, value] of pairs) {
    store.setColumnValue(item.id, columnId, value);
  }
  return store.getItem(item.id);
}

const Mutation = {
  create_board: write((_p, args, { store, principal }) =>
    store.createBoard({
      name: readName(args.board_name, "Board name"),
      description: readDescription(args.description),
      creatorId: principal.userId,
    }),
  ),
  update_board: write(updateBoard),
  delete_board: write((_p, { board_id }, { store }) =>
    store.deleteBoard(boardOf(store, board_id).id),
  ),
  create_group: write((_p, args, { store }) => {
    const board = boardOf(store, args.board_id);
    const title = readName(args.group_name, "Group name");
    const color = readColor(args.group_color);
    return store.createGroup(board.id, { title, color });
  }),
  update_group: write(updateGroup),
  delete_group: write((_p, args, { store }) => {
    const board = boardOf(store, args.board_id);
    const group = groupOf(store, board.id, args.group_id);
    return store.deleteGroup(board.id, group.id);
  }),
  create_column: write((_p, args, { store }) => {
    const board = boardOf(store, args.board_id);
    const title = readName(args.title, "Column title");
    const type = args.column_type;
    if (type === "name") badInput("A board has exactly one name column");
    return store.createColumn(board.id, { title, type });
  }),
  create_item: write(createItem),
  change_column_value: write(changeValue(parseColumnValue)),
  change_simple_column_value: write(changeValue(parseSimpleColumnValue)),
  change_multiple_column_values: write(changeMultipleValues),
  move_item_to_group: write((_p, args, { store }) => {
    const item = itemOf(store, args.item_id);
    const group = groupOf(store, item.board_id, args.group_id);
    return store.moveItem(item.id, group.id);
  }),
  delete_item: write((_p, { item_id }, { store }) =>
    store.deleteItem(itemOf(store, item_id).id),
  ),
  create_update: write((_p, args, { store, principal }) => {
    const item = itemOf(store, args.item_id);
    const body = args.body.trim();
    if (body.length === 0 || body.length > MAX_UPDATE_LENGTH) {
      badInput(`Update bodies must be 1-${MAX_UPDATE_LENGTH} characters`);
    }
    const creatorId = principal.userId;
    return store.createUpdate({ itemId: item.id, body, creatorId });
  }),
  set_app_storage: setAppStorage,
  delete_app_storage(_parent, args, ctx) {
    const scopeKey = storageScope(ctx, args, "storage:write");
    return writeResult(ctx.store.deleteAppStorage(scopeKey, args.key));
  },
};

const creator = (record, _a, { store }) => userOf(store, record.creator_id);
const RESOLVERS = {
  Query,
  Mutation,
  User: { initials: (user) => initials(user.name) },
  Board: {
    url: (board, _a, { hostOrigin }) => `${hostOrigin}/#/boards/${board.id}`,
    creator,
    columns: (board, a, { store }) => pick(store.listColumns(board.id), a.ids),
    groups: (board, a, { store }) => pick(store.listGroups(board.id), a.ids),
    items_page: (board, args, { store }) =>
      itemsPage(store, { boardId: board.id, groupId: null, args }),
    items: (board, { limit }, { store }) =>
      store.listItems({ boardId: board.id, limit: readLimit(limit) }).items,
    items_count: (board, _a, { store }) => store.countItems(board.id),
    views: (board, _a, { store }) => store.listViews(board.id),
  },
  Group: {
    items_page: (group, args, { store }) =>
      itemsPage(store, { boardId: group.board_id, groupId: group.id, args }),
  },
  Item: {
    board: (item, _a, { store }) => store.getBoard(item.board_id),
    group: (item, _a, { store }) =>
      store.getGroup(item.board_id, item.group_id),
    creator,
    column_values: columnValues,
    updates: (item, { limit }, { store }) =>
      store.listUpdates(item.id, { limit: readLimit(limit) }),
    url: (item, _a, { hostOrigin }) =>
      `${hostOrigin}/#/boards/${item.board_id}/items/${item.id}`,
  },
  Update: { creator },
  BoardView: { app_url: appUrl },
};

// ------------------------------------------------------------ definitions

// Fields as `name(arg:Type=default,...):Type`, separated by whitespace;
// defaults are JSON. Mirrors the SDL in SPEC.md.
const TYPES = {
  Query: `me:User! users(ids:[ID!],limit:Int=50):[User!]!
    boards(ids:[ID!],limit:Int=25,page:Int=1):[Board!]!
    items(ids:[ID!]!):[Item!]! version:Version! versions:[Version!]!
    app_storage(install_id:ID!,segment:StorageSegment!,key:String!):StorageValue`,
  Version: "value:String! kind:String!",
  User: "id:ID! name:String! email:String! is_admin:Boolean! initials:String!",
  Board: `id:ID! name:String! description:String state:State! url:String!
    creator:User columns(ids:[String!]):[Column!]!
    groups(ids:[String!]):[Group!]!
    items_page(limit:Int=25,cursor:String):ItemsPage!
    items(limit:Int=25):[Item!]! items_count:Int! views:[BoardView!]!`,
  Group: `id:String! title:String! color:String! position:Int!
    items_page(limit:Int=25,cursor:String):ItemsPage!`,
  ItemsPage: "cursor:String items:[Item!]!",
  Column: "id:String! title:String! type:ColumnType! settings_str:String!",
  Item: `id:ID! name:String! state:State! created_at:String!
    updated_at:String! board:Board! group:Group! creator:User
    column_values(ids:[String!]):[ColumnValue!]!
    updates(limit:Int=25):[Update!]! url:String!`,
  ColumnValue: "id:String! type:ColumnType! text:String value:String",
  Update: "id:ID! body:String! created_at:String! creator:User",
  BoardView:
    "id:ID! name:String! type:String! app_install_id:ID app_url:String",
  StorageValue: "key:String! value:String! version:Int!",
  StorageWriteResult: "success:Boolean! version:Int reason:String",
  Mutation: `create_board(board_name:String!,description:String):Board!
    update_board(board_id:ID!,board_attribute:BoardAttribute!,new_value:String!):Board!
    delete_board(board_id:ID!):Board!
    create_group(board_id:ID!,group_name:String!,group_color:String):Group!
    update_group(board_id:ID!,group_id:String!,group_attribute:GroupAttribute!,new_value:String!):Group!
    delete_group(board_id:ID!,group_id:String!):Group!
    create_column(board_id:ID!,title:String!,column_type:ColumnType!):Column!
    create_item(board_id:ID!,group_id:String,item_name:String!,column_values:String):Item!
    change_column_value(board_id:ID!,item_id:ID!,column_id:String!,value:String!):Item!
    change_simple_column_value(board_id:ID!,item_id:ID!,column_id:String!,value:String):Item!
    change_multiple_column_values(board_id:ID!,item_id:ID!,column_values:String!):Item!
    move_item_to_group(item_id:ID!,group_id:String!):Item!
    delete_item(item_id:ID!):Item!
    create_update(item_id:ID!,body:String!):Update!
    set_app_storage(install_id:ID!,segment:StorageSegment!,key:String!,value:String!,previous_version:Int):StorageWriteResult!
    delete_app_storage(install_id:ID!,segment:StorageSegment!,key:String!):StorageWriteResult!`,
};

/** Per-field extras: version gates, deprecations and descriptions. */
const EXTRAS = {
  "Board.items": {
    versions: { removedIn: "2026-01" },
    deprecationReason: "Use items_page.",
  },
  "Item.url": { versions: { addedIn: "2026-04" } },
  "Query.me": { description: "The calling user." },
  "Query.version": { description: "The API version of this request." },
  "Query.app_storage": { description: "App storage (app sessions only)." },
  "Board.items_page": { description: "Items in board order, by cursor." },
};

const FIELD_SPEC = /^(\w+)(?:\(([^)]*)\))?:(\S+)$/;
const ARG_SPEC = /^(\w+):([^=]+)(?:=(.+))?$/;

function parseArg(text) {
  const [, name, type, value] = ARG_SPEC.exec(text) ?? [];
  if (!name) throw new Error(`Invalid argument spec ${text}`);
  const defaults =
    value === undefined ? {} : { defaultValue: JSON.parse(value) };
  return [name, { type, ...defaults }];
}

function fieldsOf(typeName) {
  const resolvers = RESOLVERS[typeName] ?? {};
  const entries = TYPES[typeName].trim().split(/\s+/);
  return Object.fromEntries(
    entries.map((entry) => {
      const [, name, argList, type] = FIELD_SPEC.exec(entry) ?? [];
      if (!name) throw new Error(`Invalid field spec ${entry}`);
      const field = { type, ...EXTRAS[`${typeName}.${name}`] };
      if (argList)
        field.args = Object.fromEntries(argList.split(",").map(parseArg));
      if (resolvers[name]) field.resolve = resolvers[name];
      return [name, field];
    }),
  );
}

/**
 * Builds the mini-monday API schema: snake_case types as in monday.com's
 * API, scope-checked resolvers, cursor pagination, and the version-gated
 * `Board.items` (removed in 2026-01) and `Item.url` (added in 2026-04).
 */
export function createSchema() {
  const types = Object.fromEntries(
    Object.keys(TYPES).map((name) => [name, { fields: fieldsOf(name) }]),
  );
  return buildSchema({
    enums: {
      ColumnType: ["name", "text", "status", "people", "date", "numbers"],
      State: ["active", "archived", "deleted"],
      StorageSegment: ["global", "instance"],
      BoardAttribute: ["name", "description"],
      GroupAttribute: ["title", "color"],
    },
    types,
    query: "Query",
    mutation: "Mutation",
  });
}
