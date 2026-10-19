/**
 * The board page's session memory, per board and lost on reload: the
 * view the user last opened (the item route keeps showing it), the
 * collapsed groups of the table and the List view's toolbar choices
 * (SPEC-5 §3.2).
 */

import { defaultListPrefs } from "./list-model.js";

const lastViews = new Map();
const collapsedByBoard = new Map();
const listPrefsByBoard = new Map();

/**
 * The view last opened on board `boardId`: `{ view, installId }` where a
 * null `view` is the board's own link (its default view), or null when
 * none was opened yet.
 */
export const lastView = (boardId) => lastViews.get(boardId) ?? null;

/** Remembers the view the user opened (`{ view, installId }`). */
export function rememberView(boardId, { view, installId }) {
  lastViews.set(boardId, { view: view ?? null, installId: installId ?? null });
}

/** The table's collapsed group IDs of board `boardId` (a live Set). */
export function collapsedGroups(boardId) {
  if (!collapsedByBoard.has(boardId)) collapsedByBoard.set(boardId, new Set());
  return collapsedByBoard.get(boardId);
}

/** The List view's choices for board `boardId` (`defaultListPrefs`, live). */
export function listPrefs(boardId) {
  if (!listPrefsByBoard.has(boardId)) {
    listPrefsByBoard.set(boardId, defaultListPrefs());
  }
  return listPrefsByBoard.get(boardId);
}
