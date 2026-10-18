/**
 * GraphQL documents and loaders for the host UI. This module owns the shape
 * of every request the boards app sends; views receive decoded data only.
 */

import { graphql } from "../api.js";
import { decodeItem, prepareColumns } from "./values.js";

const BOARDS_PAGE_SIZE = 100;
const MAX_BOARD_PAGES = 10;
/** Stay well under the server's 5,000-field complexity budget per request. */
const FIELD_BUDGET = 3000;
const MAX_ITEMS_PAGE = 500;
const MAX_ITEMS = 5000;
const UPDATES_LIMIT = 100;

const ITEM_FIELDS = `fragment BoardItem on Item {
  id
  name
  group { id }
  column_values { id text value }
}`;

const SESSION_QUERY = `query HostSession {
  me { id name email is_admin initials }
  users(limit: 500) { id name email initials }
}`;

const BOARDS_QUERY = `query HostBoards($page: Int) {
  boards(limit: ${BOARDS_PAGE_SIZE}, page: $page) { id name items_count }
}`;

const BOARD_QUERY = `query HostBoard($ids: [ID!]) {
  boards(ids: $ids, limit: 1) {
    id name description items_count
    columns { id title type settings_str }
    groups { id title color position }
    views { id name type app_install_id app_url }
  }
}`;

const BOARD_ITEMS_QUERY = `query HostBoardItems($ids: [ID!], $limit: Int, $cursor: String) {
  boards(ids: $ids, limit: 1) {
    items_page(limit: $limit, cursor: $cursor) { cursor items { ...BoardItem } }
  }
}
${ITEM_FIELDS}`;

const ITEM_QUERY = `query HostItem($ids: [ID!]!) {
  items(ids: $ids) {
    id name created_at
    board { id }
    group { id title color }
    creator { id name initials }
    column_values { id text value }
    updates(limit: ${UPDATES_LIMIT}) {
      id body created_at
      creator { id name initials }
    }
  }
}`;

/**
 * Runs `query` and returns `data`. Any GraphQL error becomes a thrown Error
 * whose message is the first error's message.
 */
async function request(query, variables) {
  const response = await graphql(query, variables);
  if (Array.isArray(response.errors) && response.errors.length > 0) {
    const [first] = response.errors;
    const error = new Error(
      typeof first?.message === "string" ? first.message : "Request failed",
    );
    error.errors = response.errors;
    error.code = first?.extensions?.code;
    throw error;
  }
  if (!response.data) throw new Error("The server returned no data");
  return response.data;
}

/** Loads the signed-in user and the user directory. */
export async function loadSession() {
  const data = await request(SESSION_QUERY, {});
  return { me: data.me, users: data.users };
}

/** Loads every board's id, name and item count (paged, bounded). */
export async function loadBoards() {
  const boards = [];
  for (let page = 1; page <= MAX_BOARD_PAGES; page += 1) {
    const data = await request(BOARDS_QUERY, { page });
    boards.push(...data.boards);
    if (data.boards.length < BOARDS_PAGE_SIZE) break;
  }
  return boards;
}

/** Items per page for `columnCount` columns, within FIELD_BUDGET. */
function itemsPageLimit(columnCount) {
  // Each item resolves 5 fields plus 3 per column value.
  const perItem = 5 + 3 * Math.max(columnCount, 1);
  return Math.max(
    1,
    Math.min(MAX_ITEMS_PAGE, Math.floor(FIELD_BUDGET / perItem)),
  );
}

function sortGroups(groups) {
  return [...groups].sort((a, b) => a.position - b.position);
}

/**
 * Loads a board with columns, groups, views and all items (following
 * `items_page` cursors up to MAX_ITEMS). Returns null for unknown boards.
 * `truncated` is true when more items exist than were loaded.
 */
export async function loadBoard(boardId) {
  const data = await request(BOARD_QUERY, { ids: [boardId] });
  const raw = data.boards[0];
  if (!raw) return null;
  const columns = prepareColumns(raw.columns);
  // Items come after the columns, whose count sets how many fit in one
  // request: a fixed first page would exceed the budget on wide boards.
  const limit = itemsPageLimit(columns.length);
  const rawItems = [];
  let cursor = null;
  do {
    const page = await request(BOARD_ITEMS_QUERY, {
      ids: [boardId],
      limit,
      cursor,
    });
    const itemsPage = page.boards[0]?.items_page;
    if (!itemsPage) break;
    rawItems.push(...itemsPage.items);
    cursor = itemsPage.cursor;
  } while (cursor && rawItems.length < MAX_ITEMS);
  return {
    id: String(raw.id),
    name: raw.name,
    description: raw.description ?? "",
    itemsCount: raw.items_count,
    columns,
    groups: sortGroups(raw.groups),
    views: raw.views,
    items: rawItems.map((item) => decodeItem(item, columns)),
    truncated: Boolean(cursor),
  };
}

function newestFirst(a, b) {
  if (a.created_at !== b.created_at) {
    return a.created_at < b.created_at ? 1 : -1;
  }
  return Number(b.id) - Number(a.id);
}

/**
 * Loads one item with its group, creator and updates (newest first),
 * decoding its values with `columns`. Returns null for unknown items.
 */
export async function loadItem(itemId, columns) {
  const data = await request(ITEM_QUERY, { ids: [itemId] });
  const raw = data.items[0];
  if (!raw) return null;
  return {
    ...decodeItem(raw, columns),
    boardId: String(raw.board.id),
    group: raw.group,
    creator: raw.creator,
    updates: [...raw.updates].sort(newestFirst),
  };
}

/** Mutation documents keyed by name; every one selects only `id`. */
const MUTATIONS = Object.freeze({
  createBoard: `mutation HostCreateBoard($name: String!, $description: String) {
  create_board(board_name: $name, description: $description) { id }
}`,
  updateBoard: `mutation HostUpdateBoard($boardId: ID!, $attribute: BoardAttribute!, $value: String!) {
  update_board(board_id: $boardId, board_attribute: $attribute, new_value: $value) { id }
}`,
  deleteBoard: `mutation HostDeleteBoard($boardId: ID!) {
  delete_board(board_id: $boardId) { id }
}`,
  createGroup: `mutation HostCreateGroup($boardId: ID!, $name: String!, $color: String) {
  create_group(board_id: $boardId, group_name: $name, group_color: $color) { id }
}`,
  updateGroup: `mutation HostUpdateGroup($boardId: ID!, $groupId: String!, $attribute: GroupAttribute!, $value: String!) {
  update_group(board_id: $boardId, group_id: $groupId, group_attribute: $attribute, new_value: $value) { id }
}`,
  deleteGroup: `mutation HostDeleteGroup($boardId: ID!, $groupId: String!) {
  delete_group(board_id: $boardId, group_id: $groupId) { id }
}`,
  createColumn: `mutation HostCreateColumn($boardId: ID!, $title: String!, $type: ColumnType!) {
  create_column(board_id: $boardId, title: $title, column_type: $type) { id }
}`,
  createItem: `mutation HostCreateItem($boardId: ID!, $groupId: String, $name: String!, $values: String) {
  create_item(board_id: $boardId, group_id: $groupId, item_name: $name, column_values: $values) { id }
}`,
  changeValue: `mutation HostChangeValue($boardId: ID!, $itemId: ID!, $columnId: String!, $value: String!) {
  change_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) { id }
}`,
  renameItem: `mutation HostRenameItem($boardId: ID!, $itemId: ID!, $value: String) {
  change_simple_column_value(board_id: $boardId, item_id: $itemId, column_id: "name", value: $value) { id }
}`,
  moveItem: `mutation HostMoveItem($itemId: ID!, $groupId: String!) {
  move_item_to_group(item_id: $itemId, group_id: $groupId) { id }
}`,
  deleteItem: `mutation HostDeleteItem($itemId: ID!) {
  delete_item(item_id: $itemId) { id }
}`,
  createUpdate: `mutation HostCreateUpdate($itemId: ID!, $body: String!) {
  create_update(item_id: $itemId, body: $body) { id }
}`,
});

const MUTATION_FIELDS = Object.freeze({
  createBoard: "create_board",
  updateBoard: "update_board",
  deleteBoard: "delete_board",
  createGroup: "create_group",
  updateGroup: "update_group",
  deleteGroup: "delete_group",
  createColumn: "create_column",
  createItem: "create_item",
  changeValue: "change_column_value",
  renameItem: "change_simple_column_value",
  moveItem: "move_item_to_group",
  deleteItem: "delete_item",
  createUpdate: "create_update",
});

/**
 * Runs the named mutation with `variables` and returns the selected record
 * (`{ id }`). Throws on GraphQL or HTTP errors.
 * @param {keyof typeof MUTATIONS} name
 * @param {object} variables
 */
export async function mutate(name, variables) {
  if (!Object.hasOwn(MUTATIONS, name)) {
    throw new TypeError(`Unknown mutation ${name}`);
  }
  const data = await request(MUTATIONS[name], variables);
  return data[MUTATION_FIELDS[name]];
}
