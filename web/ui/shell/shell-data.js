/**
 * The shell's data: the signed-in user, the account, accessible
 * workspaces (Spaces) with their folders, boards (each with its default
 * view, whose icon the sidebar shows) and docs, accessible forms and the
 * unread notification count, in one request. Every list is already
 * filtered by the server, so the sidebar shows only what the user may
 * open, and comes in the server's sidebar order (SPEC-6 §3.1), which the
 * sidebar keeps. Where a board or doc sits is its `folderId` (null at
 * its Space's root); a form sits with its board (SPEC-6 §3.1).
 */

import { request } from "../../api.js";
import { defaultView } from "../board/board-views.js";

export const SHELL_QUERY = `query ShellData {
  me { id name email initials is_admin role title color status capabilities }
  account { id name user_count role_counts_json }
  workspaces {
    id name description kind color my_access can_manage can_delete
    folders { id name color }
    boards { id name board_kind my_access items_count folder { id } views { type } }
    docs { id title visibility my_access folder { id } }
  }
  forms { id title response_count board { id } }
  unread_notifications_count
}`;

const ids = (record) => ({ ...record, id: String(record.id) });

/**
 * @typedef {object} ShellData
 * @property {object} me
 * @property {object} account
 * @property {object[]} workspaces  each with `folders` (`{ id, name,
 *   color }`), `boards` (`{ id, name, board_kind, my_access, items_count,
 *   folderId, defaultView }`), `docs` (`{ id, title, visibility,
 *   my_access, folderId }`) and `forms` (`{ id, title, boardId,
 *   folderId, responseCount }`)
 * @property {number} unread
 */

/** `record` with string IDs and `folder` as `folderId` (null: none). */
function placed({ folder, ...record }) {
  return { ...ids(record), folderId: folder ? String(folder.id) : null };
}

/** A board of the sidebar: its record and its default view type. */
function shellBoard({ views, ...board }) {
  return { ...placed(board), defaultView: defaultView({ views }) };
}

/**
 * Groups forms under the workspace that holds their board; a form sits
 * in its board's folder.
 */
function attachForms(workspaces, forms) {
  const boards = new Map();
  for (const workspace of workspaces) {
    for (const board of workspace.boards)
      boards.set(board.id, { workspace, board });
  }
  for (const form of forms) {
    const found = boards.get(String(form.board?.id));
    found?.workspace.forms.push({
      id: String(form.id),
      title: form.title,
      boardId: found.board.id,
      folderId: found.board.folderId,
      responseCount: form.response_count,
    });
  }
}

/**
 * Loads the shell data.
 * @returns {Promise<ShellData>}
 */
export async function loadShellData() {
  const data = await request(SHELL_QUERY);
  const workspaces = data.workspaces.map((workspace) => ({
    ...ids(workspace),
    folders: workspace.folders.map(ids),
    boards: workspace.boards.map(shellBoard),
    docs: workspace.docs.map(placed),
    forms: [],
  }));
  attachForms(workspaces, data.forms);
  return {
    me: ids(data.me),
    account: data.account,
    workspaces,
    unread: data.unread_notifications_count,
  };
}
