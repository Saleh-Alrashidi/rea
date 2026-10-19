/**
 * Boards, groups, columns and views: record constructors (shared with the
 * seed and imports) and the part-1 board API, extended with workspaces,
 * board kinds and members (SPEC-2 §2), activity entries for group and
 * column changes, column roles and the views users add (SPEC-5 §1.2,
 * §1.5).
 *
 * Part-1 methods keep their names and behavior; mutators that record
 * activity take a trailing `{ actorId }` option.
 */
import { DEFAULT_STATUS_SETTINGS } from "../column-values.js";
import {
  BOARD_KINDS,
  COLUMN_ROLES,
  COLUMN_TYPES,
  GROUP_COLOR,
  byId,
  commit,
  deepFreeze,
  failure,
  forBoard,
  nextId,
  nextPosition,
  onBoard,
  push,
  readChoice,
  readName,
  removeWhere,
  replace,
  requireText,
  slugify,
  uniqueId,
  withChanges,
} from "../store-state.js";
import { recordActivity } from "./activity.js";
import { withDescendants } from "./subitems.js";
import { targetWorkspace } from "./workspaces.js";

/** Groups and columns of a board made by `createBoard`. */
export const DEFAULT_CONTENT = Object.freeze({
  groups: [`topics|Topics|${GROUP_COLOR}`],
  columns: [
    "name|Name|name",
    "status|Status|status",
    "person|Person|people",
    "date|Date|date",
  ],
});

/** The views users can add (SPEC-5 §1.5), with their default names. */
export const VIEW_NAMES = Object.freeze({
  list: "List",
  table: "Main table",
  kanban: "Kanban",
});
export const MAX_VIEWS = 20;
const viewList = (...types) =>
  Object.freeze(
    types.map((type) => Object.freeze({ type, name: VIEW_NAMES[type] })),
  );
/**
 * The views a board starts with, in record order (its default view is the
 * first non-app one): new boards and imports from most sources get
 * DEFAULT_VIEWS, ClickUp imports CLICKUP_VIEWS.
 */
export const DEFAULT_VIEWS = viewList("table", "kanban");
export const CLICKUP_VIEWS = viewList("list", "table", "kanban");

/**
 * Column record; `settings_str` is derived for GraphQL and not persisted.
 * `role` (SPEC-5 §1.2) is absent unless the column has one.
 */
export function makeColumn({ id, board_id, title, type, settings, role }) {
  const copy = deepFreeze(structuredClone(settings));
  const settings_str = JSON.stringify(copy);
  const column = { id, board_id, title, type, settings: copy, settings_str };
  return role === undefined ? column : { ...column, role };
}

/**
 * Why the roles of one board's `columns` break the role rules (a known
 * role on a column of the type it needs, at most one column per role),
 * else null.
 */
export function columnRoleProblem(columns) {
  const seen = new Set();
  for (const { id, board_id, type, role } of columns) {
    if (role === undefined) continue;
    const where = `column ${id} of board ${board_id}`;
    if (!Object.hasOwn(COLUMN_ROLES, role)) {
      return `${where} has an unknown role ${role}`;
    }
    if (COLUMN_ROLES[role] !== type) {
      return `${where} has role ${role}, which needs a ${COLUMN_ROLES[role]} column`;
    }
    if (seen.has(role)) return `${where} repeats the role ${role}`;
    seen.add(role);
  }
  return null;
}

/** A board whose creator (when known) is its first owner. */
export function insertBoard(ctx, fields) {
  const { name, description, creatorId, workspaceId } = fields;
  const members = creatorId
    ? [{ kind: "user", id: creatorId, role: "owner" }]
    : [];
  return push(ctx.state.boards, {
    id: nextId(ctx.state),
    name,
    description,
    state: "active",
    creator_id: creatorId,
    workspace_id: workspaceId,
    board_kind: fields.boardKind ?? "public",
    members,
  });
}

/** Group IDs are title slugs made unique per board ("topics", "group_2"). */
export function insertGroup(ctx, boardId, { id, title, color }) {
  const groups = forBoard(ctx.state.groups, boardId);
  const groupId = id ?? uniqueId(slugify(title), groups);
  const position = nextPosition(groups);
  const group = { id: groupId, board_id: boardId, title, color, position };
  return push(ctx.state.groups, group);
}

/** Column IDs are `<type>`, then `<type>_2`, `<type>_3`… per board. */
export function insertColumn(ctx, boardId, { id, title, type }) {
  const columns = forBoard(ctx.state.columns, boardId);
  const settings = type === "status" ? DEFAULT_STATUS_SETTINGS : {};
  const columnId = id ?? uniqueId(type, columns);
  const fields = { id: columnId, board_id: boardId, title, type, settings };
  return push(ctx.state.columns, makeColumn(fields));
}

export function insertView(ctx, boardId, { name, type, installId = null }) {
  const view = { id: nextId(ctx.state), board_id: boardId, name, type };
  return push(ctx.state.views, { ...view, app_install_id: installId });
}

/** Adds groups and columns from `|` rows plus `views` (`[{ type, name }]`). */
export function insertContent(
  ctx,
  boardId,
  { groups, columns, views = DEFAULT_VIEWS },
) {
  for (const [id, title, color] of groups.map((row) => row.split("|"))) {
    insertGroup(ctx, boardId, { id, title, color });
  }
  for (const [id, title, type] of columns.map((row) => row.split("|"))) {
    insertColumn(ctx, boardId, { id, title, type });
  }
  for (const view of views) insertView(ctx, boardId, view);
}

export function sortedGroups(state, boardId) {
  const groups = forBoard(state.groups, boardId);
  return groups.sort((a, b) => a.position - b.position);
}

/**
 * The one way items leave the store: removes the items matching
 * `predicate` with all their descendants, whatever their group (SPEC-5
 * §1.1), and the updates of all of them. Returns the removed items in
 * store order.
 */
export function removeItems(state, predicate) {
  const matched = state.items.filter(predicate).map((item) => item.id);
  const ids = withDescendants(state.items, new Set(matched));
  const removed = state.items.filter((item) => ids.has(item.id));
  removeWhere(state.items, (item) => ids.has(item.id));
  removeWhere(state.updates, (update) => ids.has(update.item_id));
  return removed;
}

function boardReads(state) {
  return {
    listBoards({ ids = null, limit = 25, page = 1 } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new TypeError("limit must be an integer >= 1");
      }
      if (!Number.isSafeInteger(page) || page < 1) {
        throw new TypeError("page must be an integer >= 1");
      }
      const wanted = ids === null ? null : new Set(ids);
      const boards = state.boards.filter((b) => !wanted || wanted.has(b.id));
      return boards.slice((page - 1) * limit, page * limit);
    },
    getBoard: (id) => byId(state.boards, id),
    listGroups: (boardId) => sortedGroups(state, boardId),
    getGroup: (boardId, id) => onBoard(state.groups, boardId, id),
    listColumns: (boardId) => forBoard(state.columns, boardId),
    getColumn: (boardId, id) => onBoard(state.columns, boardId, id),
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

/** Deletes a board with everything that belongs to it. */
function deleteBoardRecords(state, board) {
  const id = board.id;
  const installs = forBoard(state.installs, id);
  const scopes = new Set(installs.map((i) => `install:${i.id}`));
  removeWhere(state.storage, (entry) => scopes.has(entry.scope));
  removeItems(state, (item) => item.board_id === id);
  for (const name of ["groups", "columns", "views", "installs", "forms"]) {
    removeWhere(state[name], (record) => record.board_id === id);
  }
  removeWhere(state.activity, (record) => record.board_id === id);
  removeWhere(state.boards, (record) => record === board);
}

function boardMutators(ctx) {
  const { state } = ctx;
  return {
    /**
     * Creates a board in `workspaceId` (null: the first workspace) of
     * `boardKind` (default "public"); the creator becomes its owner.
     * Unknown creator or workspace → null.
     */
    createBoard({
      name,
      description = null,
      creatorId = null,
      workspaceId = null,
      boardKind = "public",
    } = {}) {
      requireText(name, "name");
      requireText(description, "description", true);
      readChoice(boardKind, BOARD_KINDS, "board_kind");
      const known = creatorId === null || byId(state.users, creatorId);
      const workspace = targetWorkspace(state, workspaceId);
      if (!known || !workspace) return null;
      const fields = {
        name,
        description,
        creatorId,
        workspaceId: workspace.id,
        boardKind,
      };
      const board = insertBoard(ctx, fields);
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
    /** Deletes the board with its groups, items, views, installs and forms. */
    deleteBoard(id) {
      const board = byId(state.boards, id);
      if (!board) return null;
      deleteBoardRecords(state, board);
      const deleted = Object.freeze({ ...board, state: "deleted" });
      return commit(ctx, { type: "board_deleted", board_id: id }, deleted);
    },
    /**
     * Adds a `list`, `table` or `kanban` view (each at most once, at most
     * MAX_VIEWS views per board) named `name` or the type's default name.
     */
    createView(boardId, { type, name } = {}) {
      if (!byId(state.boards, boardId)) return null;
      readChoice(type, Object.keys(VIEW_NAMES), "View type");
      const title =
        name === undefined ? VIEW_NAMES[type] : readName(name, "View name");
      const views = forBoard(state.views, boardId);
      if (views.some((view) => view.type === type)) {
        const message = `The board already has a ${VIEW_NAMES[type]} view`;
        return failure("view_exists", { message });
      }
      if (views.length >= MAX_VIEWS) {
        const message = `A board has at most ${MAX_VIEWS} views`;
        return failure("too_many_views", { message });
      }
      const view = insertView(ctx, boardId, { name: title, type });
      return commit(ctx, { type: "view_created", board_id: boardId }, view);
    },
  };
}

function groupMutators(ctx) {
  const { state } = ctx;
  const groupEvent = (type, group) => {
    const { board_id, id: group_id } = group;
    return { type, board_id, group_id };
  };
  const log = (group, kind, { actorId, fromText, toText }) =>
    recordActivity(ctx, {
      boardId: group.board_id,
      actorId,
      kind,
      fromText,
      toText,
    });
  return {
    createGroup(boardId, { title, color = GROUP_COLOR } = {}, opts = {}) {
      if (!byId(state.boards, boardId)) return null;
      requireText(title, "title");
      requireText(color, "color");
      const group = insertGroup(ctx, boardId, { title, color });
      log(group, "group_created", { actorId: opts.actorId, toText: title });
      return commit(ctx, groupEvent("group_created", group), group);
    },
    updateGroup(boardId, groupId, { title, color } = {}, opts = {}) {
      const group = onBoard(state.groups, boardId, groupId);
      if (!group) return null;
      if (title !== undefined) requireText(title, "title");
      if (color !== undefined) requireText(color, "color");
      const next = withChanges(group, { title, color });
      replace(state.groups, group, next);
      if (next.title !== group.title) {
        const texts = { fromText: group.title, toText: next.title };
        log(next, "group_renamed", { actorId: opts.actorId, ...texts });
      }
      return commit(ctx, groupEvent("group_updated", next), next);
    },
    /**
     * Deletes the group and its items (with their subitems, wherever they
     * sit); forms aimed at it fall back. A board keeps at least one group
     * (`last_group`), so new items and form responses always have
     * somewhere to go.
     */
    deleteGroup(boardId, groupId, opts = {}) {
      const group = onBoard(state.groups, boardId, groupId);
      if (!group) return null;
      if (forBoard(state.groups, boardId).length === 1) {
        return failure("last_group", {
          message: "A board keeps at least one group",
        });
      }
      const inGroup = (r) => r.board_id === boardId && r.group_id === groupId;
      removeItems(state, inGroup);
      removeWhere(state.groups, (record) => record === group);
      for (const form of state.forms.filter((f) => f.board_id === boardId)) {
        if (form.target_group_id !== groupId) continue;
        replace(state.forms, form, { ...form, target_group_id: null });
      }
      const texts = { actorId: opts.actorId, fromText: group.title };
      log(group, "group_deleted", texts);
      return commit(ctx, groupEvent("group_deleted", group), group);
    },
    createColumn(boardId, { title, type } = {}, opts = {}) {
      if (!byId(state.boards, boardId)) return null;
      requireText(title, "title");
      if (!COLUMN_TYPES.includes(type)) {
        throw new TypeError(`Unsupported column type ${String(type)}`);
      }
      const column = insertColumn(ctx, boardId, { title, type });
      recordActivity(ctx, {
        boardId,
        actorId: opts.actorId,
        kind: "column_created",
        columnId: column.id,
        toText: title,
      });
      const event = { board_id: boardId, column_id: column.id };
      return commit(ctx, { type: "column_created", ...event }, column);
    },
  };
}

export function boardApi(ctx) {
  return {
    ...boardReads(ctx.state),
    ...boardMutators(ctx),
    ...groupMutators(ctx),
  };
}
