/**
 * The shell's data: the signed-in user, the account, accessible workspaces
 * with their boards (each with its default view, whose icon the sidebar
 * shows) and docs, accessible forms and the unread notification count, in
 * one request. Every list is already filtered by the server, so the
 * sidebar shows only what the user may open.
 */

import { request } from "../../api.js";
import { defaultView } from "../board/board-views.js";

export const SHELL_QUERY = `query ShellData {
  me { id name email initials is_admin role title color status capabilities }
  account { id name user_count role_counts_json }
  workspaces {
    id name description kind color my_access can_manage
    boards { id name board_kind my_access views { type } }
    docs { id title visibility }
  }
  forms { id title board { id } }
  unread_notifications_count
}`;

const ids = (record) => ({ ...record, id: String(record.id) });

/**
 * @typedef {object} ShellData
 * @property {object} me
 * @property {object} account
 * @property {object[]} workspaces  each with `boards` (`{ id, name,
 *   board_kind, my_access, defaultView }`), `docs` and `forms`
 * @property {number} unread
 */

/** A board of the sidebar: its record and its default view type. */
function shellBoard({ views, ...board }) {
  return { ...ids(board), defaultView: defaultView({ views }) };
}

/** Groups forms under the workspace that holds their board. */
function attachForms(workspaces, forms) {
  const workspaceOfBoard = new Map();
  for (const workspace of workspaces) {
    for (const board of workspace.boards)
      workspaceOfBoard.set(board.id, workspace);
  }
  for (const form of forms) {
    workspaceOfBoard.get(String(form.board?.id))?.forms.push({
      id: String(form.id),
      title: form.title,
      boardId: String(form.board.id),
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
    boards: workspace.boards.map(shellBoard),
    docs: workspace.docs.map(ids),
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
