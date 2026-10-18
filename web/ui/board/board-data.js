/**
 * GraphQL documents and loaders for the board page. This module owns the
 * shape of every board, item, column, activity and board-forms request;
 * views receive decoded data only. The shell creates boards through
 * `mutate("createBoard")`. Changing the board kind reuses the share
 * dialog's `set_board_kind` document (`share-model.js`).
 *
 * Inaccessible boards are filtered out of `boards(ids:)` by the server, so
 * every loader returns null for them exactly as for deleted boards.
 */

import { request } from "../../api.js";
import { SHARE_MUTATIONS, normalizeMember } from "../components/share-model.js";
import { decodeItem, prepareColumns } from "./values.js";

/** Stay well under the server's 5,000-field complexity budget per request. */
const FIELD_BUDGET = 3000;
const MAX_ITEMS_PAGE = 500;
const MAX_ITEMS = 5000;
const UPDATES_LIMIT = 100;
/** `activity_logs(limit:)` accepts 1–500 (the API's list limit). */
export const MAX_ACTIVITY = 500;

const ITEM_FIELDS = `fragment BoardItem on Item {
  id
  name
  group { id }
  column_values { id text value }
}`;

// A board can be shared with someone outside its workspace: the server's
// `can_open` says whether its link is shown. `assignable_users` is the
// server's verdict on who people columns may name (SPEC-2 §6).
const BOARD_QUERY = `query HostBoard($ids: [ID!]) {
  boards(ids: $ids, limit: 1) {
    id name description items_count board_kind my_access
    workspace { id name can_open }
    assignable_users { id name initials color title }
    members {
      kind id name role
      user { id name initials color role }
      team { id name member_count }
    }
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
    kind: raw.board_kind ?? null,
    myAccess: raw.my_access ?? null,
    workspace: raw.workspace
      ? { id: String(raw.workspace.id), name: raw.workspace.name }
      : null,
    workspaceAccessible: raw.workspace?.can_open === true,
    members: (raw.members ?? []).map(normalizeMember),
    assignableUsers: (raw.assignable_users ?? []).map((user) => ({
      ...user,
      id: String(user.id),
    })),
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

const ACTIVITY_QUERY = `query BoardActivity($ids: [ID!], $limit: Int) {
  boards(ids: $ids, limit: 1) {
    activity_logs(limit: $limit) {
      id kind actor_label item_id item_name column_id from_text to_text
      created_at
      actor { id name initials color }
    }
  }
}`;

/**
 * Loads the newest `limit` (1–500) activity entries of a board, newest
 * first, or null when the board is not available.
 */
export async function loadActivity(boardId, { limit = 100 } = {}) {
  const data = await request(ACTIVITY_QUERY, { ids: [boardId], limit });
  const board = data.boards[0];
  if (!board) return null;
  return board.activity_logs.map((entry) => ({
    ...entry,
    id: String(entry.id),
    item_id: entry.item_id === null ? null : String(entry.item_id),
  }));
}

const BOARD_FORMS_QUERY = `query BoardForms($ids: [ID!]) {
  boards(ids: $ids, limit: 1) {
    id
    forms {
      id title description accent_color access public_url response_count
      created_at updated_at
    }
  }
}`;

/** Loads the forms of a board, or null when the board is not available. */
export async function loadBoardForms(boardId) {
  const data = await request(BOARD_FORMS_QUERY, { ids: [boardId] });
  const board = data.boards[0];
  if (!board) return null;
  return board.forms.map((form) => ({ ...form, id: String(form.id) }));
}

/** GraphQL documents of this module (for schema validation in tests). */
export const BOARD_QUERIES = Object.freeze({
  BOARD_QUERY,
  BOARD_ITEMS_QUERY,
  ITEM_QUERY,
  ACTIVITY_QUERY,
  BOARD_FORMS_QUERY,
});

/** Mutation documents keyed by name; every one selects only `id`. */
const MUTATIONS = Object.freeze({
  createBoard: `mutation HostCreateBoard($name: String!, $description: String, $workspaceId: ID, $kind: BoardKind) {
  create_board(board_name: $name, description: $description, workspace_id: $workspaceId, board_kind: $kind) { id }
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
  // Variables `{ id, kind }`.
  setBoardKind: SHARE_MUTATIONS.boardKind,
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
  setBoardKind: "set_board_kind",
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
