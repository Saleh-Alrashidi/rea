/**
 * Folders and the sidebar (SPEC-6 §3.1, §3.2): the Folder type,
 * `Workspace.folders`, `Board.folder`, `Doc.folder`, the sidebar
 * `position` of Spaces, boards and docs, and the mutations that manage
 * folders and move boards, docs, folders and Spaces
 * (`store/folders.js`, `store/sidebar.js`). Lists for the sidebar come
 * in sidebar order (position, then ID).
 *
 * Permissions, all decided by `server/access.js`:
 * - creating, editing, deleting and reordering folders: editor on their
 *   Space (`workspaceAccess`);
 * - moving a board or doc within its Space (into a folder, to the root
 *   or to another place in the order): editor on the Space;
 * - moving it to another Space: its owner, and editor on the target
 *   Space;
 * - reordering Spaces: admins.
 *
 * The caller must be able to open what a call names (the board or doc,
 * a target folder or Space, neighbors), else it reads NOT_FOUND exactly
 * like an unknown ID; a folder is visible with its Space. Folders show
 * only what the caller can open: `Folder.boards` and `Folder.docs` list
 * those, and a Space reached only as the container of shared content
 * shows only the folders that hold some of it.
 */
import {
  accessOutcome,
  boardAccess,
  docAccess,
  forbiddenError,
  hasRole,
  isAdmin,
  notFoundError,
  requireBoard,
  requireDoc,
  requireWorkspace,
  workspaceAccess,
} from "../access.js";
import { inSidebarOrder } from "../store/positions.js";
import {
  accessibleBoards,
  fail,
  notFound,
  readName,
  storeResult,
  viewerOf,
  wrapAll,
  write,
} from "./common.js";

const roleIn = (ctx, workspace) =>
  workspaceAccess(ctx.store, viewerOf(ctx), workspace);

/**
 * Folder `id` when the caller has `minRole` on its Space: NOT_FOUND
 * without access (or for an unknown ID), FORBIDDEN below `minRole`.
 */
function requireFolder(ctx, id, minRole) {
  const folder = ctx.store.getFolder(id);
  const workspace = folder && ctx.store.getWorkspace(folder.workspace_id);
  const outcome = accessOutcome(roleIn(ctx, workspace), minRole);
  if (outcome === "not_found") throw notFoundError("Folder", id);
  if (outcome === "forbidden") throw forbiddenError("workspace", minRole);
  return folder;
}

/** Editor access to a Space the caller knows of (FORBIDDEN otherwise). */
function requireSpaceEditor(ctx, workspaceId) {
  const workspace = ctx.store.getWorkspace(workspaceId);
  if (hasRole(roleIn(ctx, workspace), "editor")) return workspace;
  throw forbiddenError("workspace", "editor");
}

/** Docs of Space `workspaceId` the caller can open, in store order. */
function openDocs(ctx, workspaceId) {
  const viewer = viewerOf(ctx);
  return ctx.store
    .listDocs({ workspaceId })
    .filter((doc) => docAccess(ctx.store, viewer, doc) !== null);
}

const inFolder = (records, folder) =>
  inSidebarOrder(records.filter((record) => record.folder_id === folder.id));

/** The folder a record sits in, or null at its Space's root. */
const folderOf = (record, _a, { store }) =>
  record.folder_id === undefined ? null : store.getFolder(record.folder_id);

const Folder = {
  workspace: (folder, _a, { store }) => store.getWorkspace(folder.workspace_id),
  boards: (folder, _a, ctx) => inFolder(accessibleBoards(ctx), folder),
  docs: (folder, _a, ctx) =>
    inFolder(openDocs(ctx, folder.workspace_id), folder),
};

function workspaceFolders(workspace, _a, ctx) {
  const folders = ctx.store.listFolders({ workspaceId: workspace.id });
  if (roleIn(ctx, workspace) !== null) return folders;
  const open = [...accessibleBoards(ctx), ...openDocs(ctx, workspace.id)];
  const used = new Set(open.map((record) => record.folder_id));
  return folders.filter((folder) => used.has(folder.id));
}

// ---------------------------------------------------------------- moves

const CONTENT = Object.freeze({
  board: {
    id: "board_id",
    require: requireBoard,
    access: boardAccess,
    move: "moveBoard",
  },
  doc: {
    id: "doc_id",
    require: requireDoc,
    access: docAccess,
    move: "moveDoc",
  },
});

/** The store request of a move mutation (`move_board`, `move_doc`, …). */
const moveRequest = (args) => ({
  workspaceId: args.workspace_id ?? null,
  folderId: args.folder_id ?? null,
  toRoot: args.to_root === true,
  afterId: args.after_id ?? null,
  beforeId: args.before_id ?? null,
});

/** Requires the neighbors of a move to be visible (`find(ctx, id)`). */
function requireNeighbors(ctx, args, find) {
  for (const id of [args.after_id, args.before_id]) {
    if (id !== undefined && id !== null) find(ctx, id);
  }
}

/**
 * Checks who may move `record` (a board or doc) to `target` (from
 * `store.moveTarget`): Space editor within its Space; owner of the
 * record and editor on the target Space across Spaces.
 */
function checkMove(ctx, { kind, record, target }) {
  if (target.workspace.id === record.workspace_id) {
    requireSpaceEditor(ctx, record.workspace_id);
    return;
  }
  const role = CONTENT[kind].access(ctx.store, viewerOf(ctx), record);
  if (role !== "owner") throw forbiddenError(kind, "owner");
  requireWorkspace(ctx, target.workspace.id, "editor");
}

/** move_board / move_doc. */
const moveContent = (kind) => (_p, args, ctx) => {
  const spec = CONTENT[kind];
  const record = spec.require(ctx, args[spec.id], "viewer");
  const missing = () => notFound(kind, record.id);
  if (args.folder_id != null) requireFolder(ctx, args.folder_id, "viewer");
  if (args.workspace_id != null) {
    requireWorkspace(ctx, args.workspace_id, "viewer");
  }
  requireNeighbors(ctx, args, (c, id) => spec.require(c, id, "viewer"));
  const request = moveRequest(args);
  const target = ctx.store.moveTarget(kind, record.id, request);
  checkMove(ctx, { kind, record, target: storeResult(target, missing) });
  return storeResult(ctx.store[spec.move](record.id, request), missing);
};

function moveFolder(_p, args, ctx) {
  const folder = requireFolder(ctx, args.folder_id, "editor");
  requireNeighbors(ctx, args, (c, id) => requireFolder(c, id, "viewer"));
  const result = ctx.store.moveFolder(folder.id, moveRequest(args));
  return storeResult(result, () => notFound("Folder", folder.id));
}

function moveWorkspace(_p, args, ctx) {
  const workspace = requireWorkspace(ctx, args.workspace_id, "viewer");
  if (!isAdmin(viewerOf(ctx))) fail("FORBIDDEN", "Only admins reorder Spaces");
  requireNeighbors(ctx, args, (c, id) => requireWorkspace(c, id, "viewer"));
  const result = ctx.store.moveWorkspace(workspace.id, moveRequest(args));
  return storeResult(result, () => notFound("workspace", workspace.id));
}

// ------------------------------------------------------------- mutations

const optionalName = (value) =>
  value === undefined || value === null
    ? undefined
    : readName(value, "Folder name");

const Mutation = wrapAll(write, {
  create_folder(_p, args, ctx) {
    const workspace = requireWorkspace(ctx, args.workspace_id, "editor");
    const result = ctx.store.createFolder({
      workspaceId: workspace.id,
      name: readName(args.name, "Folder name"),
      color: args.color ?? undefined,
      creatorId: viewerOf(ctx).id,
    });
    return storeResult(result, () => notFound("workspace", workspace.id));
  },
  update_folder(_p, args, ctx) {
    const folder = requireFolder(ctx, args.folder_id, "editor");
    const changes = {
      name: optionalName(args.name),
      color: args.color ?? undefined,
    };
    const result = ctx.store.updateFolder(folder.id, changes);
    return storeResult(result, () => notFound("Folder", folder.id));
  },
  delete_folder(_p, args, ctx) {
    const folder = requireFolder(ctx, args.folder_id, "editor");
    const result = ctx.store.deleteFolder(folder.id);
    return storeResult(result, () => notFound("Folder", folder.id));
  },
  move_board: moveContent("board"),
  move_doc: moveContent("doc"),
  move_folder: moveFolder,
  move_workspace: moveWorkspace,
});

const PLACE_ARGS =
  "workspace_id:ID,folder_id:ID,to_root:Boolean,before_id:ID,after_id:ID";

export const definition = {
  types: {
    Folder: `id:ID! name:String! color:String! workspace:Workspace!
      boards:[Board!]! docs:[Doc!]! position:Float!`,
    Workspace: "folders:[Folder!]! position:Float",
    Board: "folder:Folder position:Float",
    Doc: "folder:Folder position:Float",
    Mutation: `create_folder(workspace_id:ID!,name:String!,color:String):Folder!
      update_folder(folder_id:ID!,name:String,color:String):Folder!
      delete_folder(folder_id:ID!):Folder!
      move_board(board_id:ID!,${PLACE_ARGS}):Board!
      move_doc(doc_id:ID!,${PLACE_ARGS}):Doc!
      move_folder(folder_id:ID!,before_id:ID,after_id:ID):Folder!
      move_workspace(workspace_id:ID!,before_id:ID,after_id:ID):Workspace!`,
  },
  resolvers: {
    Mutation,
    Folder,
    Workspace: { folders: workspaceFolders },
    Board: { folder: folderOf },
    Doc: { folder: folderOf },
  },
  extras: {
    "Workspace.folders": {
      description:
        "The Space's folders in sidebar order (only those holding something you can open, when you reach the Space only through shared content).",
    },
    "Folder.boards": { description: "Boards in the folder you can open." },
    "Folder.docs": { description: "Docs in the folder you can open." },
    "Board.position": {
      description:
        "The board's place in its folder or Space root (sidebar order: position, then id; null sorts last).",
    },
    "Mutation.delete_folder": {
      description:
        "Deletes the folder; its boards and docs move to the Space's root (nothing is deleted).",
    },
    "Mutation.move_board": {
      description:
        "Moves a board: into folder_id, to_root (the Space's top level) or to workspace_id (another Space: board owner and Space editor there), right after after_id and/or before before_id (boards of the same place). Without neighbors it keeps its place, or goes last in a new place.",
    },
    "Mutation.move_workspace": { description: "Reorders Spaces (admins)." },
  },
};
