/**
 * The sidebar's requests (SPEC-6 §3.2, §3.3): folders, moves of boards,
 * docs, folders and Spaces, renames, colors and deletions of tree nodes
 * (`sidebar-model.js`). Each runs one request (a doc rename reads the
 * doc's version first) and rejects with the API's error; callers refresh
 * the shell afterwards. Documents other modules own (board, doc, form and
 * workspace mutations) are reused, not copied.
 */

import { request } from "../../api.js";
import { mutate } from "../board/board-data.js";
import { DELETE_DOC_MUTATION, UPDATE_DOC_MUTATION } from "../docs/doc-data.js";
import { FORM_MUTATIONS } from "../forms/builder-data.js";
import { WORKSPACE_MUTATIONS } from "../workspaces/workspace-data.js";
import { moveVariables } from "./sidebar-drop-model.js";

const PLACE_VARIABLES =
  "$workspaceId: ID, $folderId: ID, $toRoot: Boolean, $afterId: ID, $beforeId: ID";
const PLACE_ARGS =
  "workspace_id: $workspaceId, folder_id: $folderId, to_root: $toRoot, after_id: $afterId, before_id: $beforeId";

export const SIDEBAR_MUTATIONS = Object.freeze({
  createFolder: `mutation SidebarCreateFolder($workspaceId: ID!, $name: String!, $color: String) {
  create_folder(workspace_id: $workspaceId, name: $name, color: $color) { id }
}`,
  updateFolder: `mutation SidebarUpdateFolder($id: ID!, $name: String, $color: String) {
  update_folder(folder_id: $id, name: $name, color: $color) { id }
}`,
  deleteFolder: `mutation SidebarDeleteFolder($id: ID!) {
  delete_folder(folder_id: $id) { id }
}`,
  moveBoard: `mutation SidebarMoveBoard($id: ID!, ${PLACE_VARIABLES}) {
  move_board(board_id: $id, ${PLACE_ARGS}) { id }
}`,
  moveDoc: `mutation SidebarMoveDoc($id: ID!, ${PLACE_VARIABLES}) {
  move_doc(doc_id: $id, ${PLACE_ARGS}) { id }
}`,
  moveFolder: `mutation SidebarMoveFolder($id: ID!, $afterId: ID, $beforeId: ID) {
  move_folder(folder_id: $id, after_id: $afterId, before_id: $beforeId) { id }
}`,
  moveSpace: `mutation SidebarMoveSpace($id: ID!, $afterId: ID, $beforeId: ID) {
  move_workspace(workspace_id: $id, after_id: $afterId, before_id: $beforeId) { id }
}`,
});

export const DOC_VERSION_QUERY = `query SidebarDocVersion($id: ID!) {
  docs(ids: [$id]) { id version }
}`;

const MOVES = Object.freeze({
  board: SIDEBAR_MUTATIONS.moveBoard,
  doc: SIDEBAR_MUTATIONS.moveDoc,
  folder: SIDEBAR_MUTATIONS.moveFolder,
  space: SIDEBAR_MUTATIONS.moveSpace,
});

/** Runs a sidebar move (`{ node, place }`, `sidebar-drop-model.js`). */
export function runMove(move) {
  return request(MOVES[move.node.kind], moveVariables(move));
}

/** Moves the new board or doc `id` (`kind`) into folder `folderId`. */
export function moveIntoFolder(kind, id, folderId) {
  return request(MOVES[kind], { id, folderId, toRoot: false });
}

/** Creates a folder in Space `spaceId`; resolves with its ID. */
export async function createFolder(spaceId, name) {
  const variables = { workspaceId: spaceId, name };
  const data = await request(SIDEBAR_MUTATIONS.createFolder, variables);
  return String(data.create_folder.id);
}

async function renameDoc(id, title) {
  const data = await request(DOC_VERSION_QUERY, { id });
  const doc = data.docs[0];
  if (!doc) throw new Error("This doc is no longer available");
  const variables = { id, expectedVersion: doc.version, title };
  return request(UPDATE_DOC_MUTATION, variables);
}

const RENAMES = Object.freeze({
  space: (id, name) => request(WORKSPACE_MUTATIONS.update, { id, name }),
  folder: (id, name) => request(SIDEBAR_MUTATIONS.updateFolder, { id, name }),
  board: (id, name) =>
    mutate("updateBoard", { boardId: id, attribute: "name", value: name }),
  doc: renameDoc,
  form: (id, title) => request(FORM_MUTATIONS.update, { formId: id, title }),
});

/** Renames tree node `node` to `name`. */
export const renameNode = (node, name) => RENAMES[node.kind](node.id, name);

/** Gives a Space or folder `node` the color `color` (`#rrggbb`). */
export function recolorNode(node, color) {
  if (node.kind === "space") {
    return request(WORKSPACE_MUTATIONS.update, { id: node.id, color });
  }
  return request(SIDEBAR_MUTATIONS.updateFolder, { id: node.id, color });
}

const DELETES = Object.freeze({
  space: (id) => request(WORKSPACE_MUTATIONS.remove, { id }),
  folder: (id) => request(SIDEBAR_MUTATIONS.deleteFolder, { id }),
  board: (id) => mutate("deleteBoard", { boardId: id }),
  doc: (id) => request(DELETE_DOC_MUTATION, { id }),
  form: (id) => request(FORM_MUTATIONS.remove, { formId: id }),
});

/** Deletes tree node `node` (a folder's content moves to its Space). */
export const deleteNode = (node) => DELETES[node.kind](node.id);
