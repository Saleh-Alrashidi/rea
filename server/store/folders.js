/**
 * Folders (SPEC-6 §3.1): one level of grouping inside a Space
 * (workspace). Boards and docs of the Space may sit in one of its
 * folders (`folder_id`, absent at the Space's root); a form sits with its
 * board. Folders have no access rules of their own: everyone with a role
 * on the Space sees its folders, what the caller may open in them is
 * decided per board and doc (`server/access.js`), and the Space's
 * editors manage them. Folders are ordered within their Space
 * (`position`, `sidebar.js`); a new folder goes last and takes the
 * Space's color unless it gets one.
 *
 * A folder's name is visible to the whole Space, so a source folder that
 * imports recorded (`import.folder`) becomes a folder only when that
 * tells the Space nothing new (`showsSourceFolder`): no record says the
 * source folder is private, and one of its boards in the Space is a Main
 * (public) board, which everyone there can open anyway. The /6 → /7
 * upgrade (`upgradeFolders`) and the importer (`imports.js`) both follow
 * this; boards of other source folders stay at the Space's root.
 *
 * `deleteFolder` never deletes content: its boards and docs move to the
 * Space's root, after the root's own (in the folder's order). Deleting a
 * Space deletes its (then empty) folders (`workspaces.js`).
 *
 * The data file holds no `folder_id` that names a missing folder or a
 * folder of another Space (`folderProblem`, checked on load). The
 * /6 → /7 upgrade also gives every container its first positions.
 *
 * Events: `folder_created`, `folder_updated`, `folder_moved` and
 * `folder_deleted` (`resource_kind` "folder", `resource_id`,
 * `workspace_id`); deleting a folder adds one `board_moved` per board and
 * one `doc_moved` per doc it held.
 */
import { LIMITS } from "../input.js";
import {
  byId,
  commit,
  nextId,
  optional,
  push,
  readColor,
  readName,
  removeWhere,
  replace,
  withChanges,
} from "../store-state.js";
import {
  POSITION_SPACING,
  inSidebarOrder,
  positionAfter,
} from "./positions.js";
import {
  assignSidebarPositions,
  inContainer,
  moveEvent,
  readMove,
  readPosition,
  writePlace,
} from "./sidebar.js";

/**
 * Appends a folder to `workspace`, last in its order, in the Space's
 * color unless `color` is given.
 */
export function insertFolder(state, fields) {
  const { workspace, name, color = null, createdBy = null } = fields;
  const siblings = state.folders.filter((f) => f.workspace_id === workspace.id);
  return push(state.folders, {
    id: nextId(state),
    workspace_id: workspace.id,
    name,
    color: color ?? workspace.color,
    position: positionAfter(siblings),
    created_by: createdBy,
    created_at: fields.createdAt,
  });
}

/**
 * Why a `folder_id` of `state` breaks the folder rules (it names a
 * missing folder, or one of another Space than its record's), else null.
 */
export function folderProblem(state) {
  const folders = new Map(state.folders.map((f) => [f.id, f]));
  for (const name of ["boards", "docs"]) {
    for (const record of state[name]) {
      if (record.folder_id === undefined) continue;
      const folder = folders.get(record.folder_id);
      const where = `${name} ${record.id}`;
      if (!folder) return `${where} is in a missing folder ${record.folder_id}`;
      if (folder.workspace_id !== record.workspace_id) {
        return `${where} is in folder ${folder.id} of another Space`;
      }
    }
  }
  return null;
}

// ---------------------------------------------------- source folders

/**
 * Whether a source folder may be a folder of a Space (see the module
 * comment): `folders` are its `import.folder` records, `boards` its
 * boards in that Space (with `board_kind`).
 */
export const showsSourceFolder = ({ folders, boards }) =>
  folders.every((folder) => folder.private !== true) &&
  boards.some((board) => board.board_kind === "public");

/** The boards of Space `workspaceId` imported from source folder `folder`. */
export const sourceFolderBoards = (state, { workspaceId, source, folder }) =>
  state.boards.filter(
    (board) =>
      board.workspace_id === workspaceId &&
      board.import?.source === source &&
      board.import.folder?.source_id === folder.source_id,
  );

// How /6's ClickUp connector named a list in a folder: the raw ClickUp
// names as `${folder} / ${list}`, which the snapshot trimmed and cut to
// LIMITS.name as one name, while it trimmed and cut the folder's name
// (blank → BLANK_FOLDER) and the list's name alone (`import.folder.name`,
// `import.source_name`). So the raw names' outer whitespace survives
// around " / ", a blank folder name left "/ <list>", and the cut may fall
// anywhere. `\s` is the whitespace `trim` removes.
const BLANK_FOLDER = "Untitled folder";
// After the folder's name: its trailing whitespace and " /", then " ",
// the list's leading whitespace and what is left of its name (group 1).
const AFTER_FOLDER = String.raw`(?:\s*(?: \/(?: \s*([\s\S]*))?)?)?$`;
const AFTER_BLANK = String.raw`\/(?: \s*([\s\S]*))?$`;
const HIGH_SURROGATE = /^[\uD800-\uDBFF]$/;
const escaped = (text) => text.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");

/**
 * Whether `name` is a name /6 composed for a list stored as `listName` in
 * a folder stored as `folderName`: the whole composition, or its first
 * LIMITS.name characters (one fewer before a surrogate pair).
 */
function composedBy6(name, { folderName, listName }) {
  const max = LIMITS.name;
  // Cut inside a folder name that was itself cut before a surrogate pair.
  if (name === folderName && folderName.length === max - 1) return true;
  const patterns = [`^${escaped(folderName)}${AFTER_FOLDER}`];
  if (folderName === BLANK_FOLDER) patterns.push(`^${AFTER_BLANK}`);
  return patterns.some((pattern) => {
    const match = new RegExp(pattern).exec(name);
    if (!match) return false;
    const rest = match[1];
    if (rest === listName) return true;
    // Else the cut fell before the list's name ended.
    if (rest !== undefined && !listName.startsWith(rest)) return false;
    if (name.length === max) return true;
    const next = rest === undefined ? "" : listName.charAt(rest.length);
    return name.length === max - 1 && HIGH_SURROGATE.test(next);
  });
}

/**
 * Files `boards` (one Space's boards of one source folder) into a new
 * folder named like the source folder; a board gets its list's name back
 * only while its name is still one /6 composed (`composedBy6`), so a
 * rename is never overwritten.
 */
function fileSourceFolder(state, boards) {
  const [first] = boards;
  const {
    folder,
    imported_by: createdBy,
    imported_at: createdAt,
  } = first.import;
  const workspace = byId(state.workspaces, first.workspace_id);
  const fields = { workspace, name: folder.name, createdBy, createdAt };
  const { id } = insertFolder(state, fields);
  for (const board of boards) {
    const { folder: recorded, source_name: listName } = board.import;
    const names = { folderName: recorded.name, listName };
    const composed = listName !== undefined && composedBy6(board.name, names);
    const name = composed ? listName : board.name;
    replace(state.boards, board, { ...board, folder_id: id, name });
  }
}

/**
 * The /6 → /7 upgrade (SPEC-6 §3.1): the boards whose imports recorded
 * one source folder in one Space move into one folder, in the order of
 * their first boards, when `showsSourceFolder` allows; the others stay
 * at the root with their names. Then every container gets positions in
 * its current order.
 */
export function upgradeFolders(state) {
  const recorded = state.boards.filter((board) => board.import?.folder);
  const groups = Map.groupBy(recorded, (board) => {
    const { source, folder } = board.import;
    return [board.workspace_id, source, folder.source_id].join("\u0000");
  });
  for (const boards of groups.values()) {
    const folders = boards.map((board) => board.import.folder);
    if (showsSourceFolder({ folders, boards })) fileSourceFolder(state, boards);
  }
  assignSidebarPositions(state);
}

const folderEvent = (type, folder) => ({
  type,
  resource_kind: "folder",
  resource_id: folder.id,
  workspace_id: folder.workspace_id,
});

/**
 * Moves the boards and docs of `folder` to its Space's root (after the
 * root's own, in the folder's order); returns their events.
 */
function emptyFolder(state, folder) {
  const events = [];
  const workspaceId = folder.workspace_id;
  for (const [name, kind] of [
    ["boards", "board"],
    ["docs", "doc"],
  ]) {
    const list = state[name];
    const inside = list.filter((record) => record.folder_id === folder.id);
    let position = positionAfter(inContainer(list, { workspaceId }));
    for (const record of inSidebarOrder(inside)) {
      const { folder_id: _folder, ...rest } = record;
      const next = replace(list, record, { ...rest, position });
      events.push(moveEvent(kind, next));
      position += POSITION_SPACING;
    }
  }
  return events;
}

function moveFolder(ctx, id, request) {
  const { state } = ctx;
  const record = byId(state.folders, id);
  if (!record) return null;
  const move = readMove(request);
  const siblings = state.folders.filter(
    (folder) =>
      folder !== record && folder.workspace_id === record.workspace_id,
  );
  const label = "Folder";
  const slot = readPosition({ record, siblings, move, label, stays: true });
  if (slot.ok === false) return slot;
  if (slot.position === record.position) return record;
  const next = { ...record, position: slot.position };
  writePlace(state.folders, { record, next, order: slot.order });
  const event = {
    ...folderEvent("folder_moved", next),
    position: next.position,
  };
  return commit(ctx, event, next);
}

export function folderApi(ctx) {
  const { state } = ctx;
  return {
    /** Folders (of one Space when `workspaceId` is given), in order. */
    listFolders: ({ workspaceId } = {}) =>
      inSidebarOrder(
        workspaceId === undefined
          ? state.folders
          : state.folders.filter((f) => f.workspace_id === workspaceId),
      ),
    getFolder: (id) => byId(state.folders, id),
    /**
     * Creates a folder in Space `workspaceId`, last in its order; unknown
     * Space or creator → null.
     */
    createFolder({ workspaceId, name, color, creatorId = null } = {}) {
      const fields = {
        name: readName(name, "Folder name"),
        color: optional(color, (v) => readColor(v, "color")),
      };
      const workspace = byId(state.workspaces, workspaceId);
      if (!workspace || (creatorId !== null && !byId(state.users, creatorId)))
        return null;
      const folder = insertFolder(state, {
        ...fields,
        workspace,
        createdBy: creatorId,
        createdAt: ctx.now(),
      });
      return commit(ctx, folderEvent("folder_created", folder), folder);
    },
    /** Renames and/or recolors a folder. */
    updateFolder(id, { name, color } = {}) {
      const folder = byId(state.folders, id);
      if (!folder) return null;
      const next = withChanges(folder, {
        name: optional(name, (v) => readName(v, "Folder name")),
        color: optional(color, (v) => readColor(v, "color")),
      });
      replace(state.folders, folder, next);
      return commit(ctx, folderEvent("folder_updated", next), next);
    },
    /** Deletes a folder; its content moves to the Space's root. */
    deleteFolder(id) {
      const folder = byId(state.folders, id);
      if (!folder) return null;
      ctx.pending.push(...emptyFolder(state, folder));
      removeWhere(state.folders, (record) => record === folder);
      return commit(ctx, folderEvent("folder_deleted", folder), folder);
    },
    /** Reorders a folder within its Space (`{ afterId, beforeId }`). */
    moveFolder: (id, request = {}) => moveFolder(ctx, id, request),
  };
}
