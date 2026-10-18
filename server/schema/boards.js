/**
 * Boards, groups, columns and views: the part-1 board API plus SPEC-2
 * board kinds, workspaces and members. `boards` lists only accessible
 * boards; every board mutation checks the role SPEC-2 §1.2 requires
 * (groups → editor; name, description, kind, columns, delete → owner)
 * through `server/access.js`.
 */
import { boardAccess, requireBoard, requireCapability } from "../access.js";
import {
  allBoards,
  badInput,
  isPlainObject,
  memberRecords,
  notFound,
  read,
  readDescription,
  readIds,
  readLimit,
  readName,
  storeResult,
  viewerOf,
  wrapAll,
  write,
} from "./common.js";
import { targetWorkspace } from "./workspaces.js";

const DEFAULT_GROUP_COLOR = "#579bfc";
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const CURSOR_PATTERN = /^[\w-]{1,512}$/;

function readColor(value) {
  if (value === undefined || value === null) return DEFAULT_GROUP_COLOR;
  return COLOR_PATTERN.test(value)
    ? value
    : badInput("Group colors must look like #RRGGBB");
}

export const groupOf = (store, boardId, id) =>
  store.getGroup(boardId, id) ?? notFound("Group", id);
export const columnOf = (store, boardId, id) =>
  store.getColumn(boardId, id) ?? notFound("Column", id);
const userOf = (store, id) => (id ? store.getUser(id) : null);
const actor = (ctx) => ({ actorId: viewerOf(ctx).id });

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

// -------------------------------------------------------------- resolvers

const pickBy = (records, ids, key = "id") => {
  const wanted = readIds(ids);
  if (wanted === null) return records;
  const set = new Set(wanted);
  return records.filter((record) => set.has(record[key]));
};

const Query = wrapAll(read, {
  boards(_p, { ids, limit, page }, ctx) {
    if (page < 1) badInput("page must be a positive integer");
    const size = readLimit(limit);
    const viewer = viewerOf(ctx);
    const visible = pickBy(allBoards(ctx.store), ids).filter(
      (board) => boardAccess(ctx.store, viewer, board) !== null,
    );
    return visible.slice((page - 1) * size, page * size);
  },
});

function updateBoard(_p, args, ctx) {
  const board = requireBoard(ctx, args.board_id, "owner");
  const value = args.new_value;
  const changes =
    args.board_attribute === "name"
      ? { name: readName(value, "Board name") }
      : { description: readDescription(value) };
  return ctx.store.updateBoard(board.id, changes);
}

function updateGroup(_p, args, ctx) {
  const board = requireBoard(ctx, args.board_id, "editor");
  const group = groupOf(ctx.store, board.id, args.group_id);
  const value = args.new_value;
  const changes =
    args.group_attribute === "title"
      ? { title: readName(value, "Group name") }
      : { color: readColor(value) };
  return ctx.store.updateGroup(board.id, group.id, changes, actor(ctx));
}

const Mutation = wrapAll(write, {
  create_board(_p, args, ctx) {
    const creator = requireCapability(ctx, "create_content");
    const workspace = targetWorkspace(ctx, args.workspace_id ?? null);
    const board = ctx.store.createBoard({
      name: readName(args.board_name, "Board name"),
      description: readDescription(args.description) ?? null,
      creatorId: creator.id,
      workspaceId: workspace.id,
      boardKind: args.board_kind,
    });
    return storeResult(board, () => notFound("Workspace", workspace.id));
  },
  update_board: updateBoard,
  delete_board: (_p, { board_id }, ctx) =>
    ctx.store.deleteBoard(requireBoard(ctx, board_id, "owner").id),
  set_board_kind(_p, args, ctx) {
    const board = requireBoard(ctx, args.board_id, "owner");
    const result = ctx.store.setBoardKind(
      board.id,
      args.board_kind,
      actor(ctx),
    );
    return storeResult(result, () => notFound("Board", board.id));
  },
  create_group(_p, args, ctx) {
    const board = requireBoard(ctx, args.board_id, "editor");
    const title = readName(args.group_name, "Group name");
    const color = readColor(args.group_color);
    return ctx.store.createGroup(board.id, { title, color }, actor(ctx));
  },
  update_group: updateGroup,
  delete_group(_p, args, ctx) {
    const board = requireBoard(ctx, args.board_id, "editor");
    const group = groupOf(ctx.store, board.id, args.group_id);
    return ctx.store.deleteGroup(board.id, group.id, actor(ctx));
  },
  create_column(_p, args, ctx) {
    const board = requireBoard(ctx, args.board_id, "owner");
    const title = readName(args.title, "Column title");
    const type = args.column_type;
    if (type === "name") badInput("A board has exactly one name column");
    return ctx.store.createColumn(board.id, { title, type }, actor(ctx));
  },
});

function appUrl(view, _args, { store, appsOrigin }) {
  if (view.type !== "app" || !view.app_install_id) return null;
  const install = store.getInstall(view.app_install_id);
  const app = install ? store.getApp(install.app_id) : null;
  if (!app) return null;
  return `${appsOrigin}${app.path}?install_id=${encodeURIComponent(install.id)}`;
}

const Board = {
  url: (board, _a, { hostOrigin }) => `${hostOrigin}/#/boards/${board.id}`,
  creator: (board, _a, { store }) => userOf(store, board.creator_id),
  columns: (board, a, { store }) => pickBy(store.listColumns(board.id), a.ids),
  groups: (board, a, { store }) => pickBy(store.listGroups(board.id), a.ids),
  items_page: (board, args, { store }) =>
    itemsPage(store, { boardId: board.id, groupId: null, args }),
  items: (board, { limit }, { store }) =>
    store.listItems({ boardId: board.id, limit: readLimit(limit) }).items,
  items_count: (board, _a, { store }) => store.countItems(board.id),
  views: (board, _a, { store }) => store.listViews(board.id),
  workspace: (board, _a, { store }) => store.getWorkspace(board.workspace_id),
  members: (board, _a, { store }) => memberRecords(store, "board", board),
  my_access: (board, _a, ctx) => boardAccess(ctx.store, viewerOf(ctx), board),
};

const Group = {
  items_page: (group, args, { store }) =>
    itemsPage(store, { boardId: group.board_id, groupId: group.id, args }),
};

export const definition = {
  types: {
    Query: "boards(ids:[ID!],limit:Int=25,page:Int=1):[Board!]!",
    Board: `id:ID! name:String! description:String state:State! url:String!
      creator:User columns(ids:[String!]):[Column!]!
      groups(ids:[String!]):[Group!]!
      items_page(limit:Int=25,cursor:String):ItemsPage!
      items(limit:Int=25):[Item!]! items_count:Int! views:[BoardView!]!
      workspace:Workspace! board_kind:BoardKind! members:[Member!]!
      my_access:AccessRole!`,
    Group: `id:String! title:String! color:String! position:Int!
      items_page(limit:Int=25,cursor:String):ItemsPage!`,
    ItemsPage: "cursor:String items:[Item!]!",
    Column: "id:String! title:String! type:ColumnType! settings_str:String!",
    BoardView:
      "id:ID! name:String! type:String! app_install_id:ID app_url:String",
    Mutation: `create_board(board_name:String!,description:String,board_kind:BoardKind="public",workspace_id:ID):Board!
      update_board(board_id:ID!,board_attribute:BoardAttribute!,new_value:String!):Board!
      delete_board(board_id:ID!):Board!
      set_board_kind(board_id:ID!,board_kind:BoardKind!):Board!
      create_group(board_id:ID!,group_name:String!,group_color:String):Group!
      update_group(board_id:ID!,group_id:String!,group_attribute:GroupAttribute!,new_value:String!):Group!
      delete_group(board_id:ID!,group_id:String!):Group!
      create_column(board_id:ID!,title:String!,column_type:ColumnType!):Column!`,
  },
  resolvers: { Query, Mutation, Board, Group, BoardView: { app_url: appUrl } },
  extras: {
    "Board.items": {
      versions: { removedIn: "2026-01" },
      deprecationReason: "Use items_page.",
    },
    "Board.items_page": { description: "Items in board order, by cursor." },
    "Query.boards": { description: "Boards the caller can access." },
  },
};
