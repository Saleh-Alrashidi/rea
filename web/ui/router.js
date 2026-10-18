/**
 * Hash routes of the host app:
 *
 *   #/boards/<id>                       main table
 *   #/boards/<id>/views/kanban          kanban
 *   #/boards/<id>/views/app-<installId> app board view
 *   #/boards/<id>/items/<itemId>        item card over the last view
 *
 * Anything else parses as `{ boardId: null }`.
 */

const ROUTE_PATTERN =
  /^#\/boards\/(\d{1,20})(?:\/views\/(kanban|app-(\d{1,20}))|\/items\/(\d{1,20}))?\/?$/;

/**
 * Parses a location hash.
 * @returns {{ boardId: string | null, view: "table" | "kanban" | "app" | null,
 *   installId: string | null, itemId: string | null }}
 */
export function parseRoute(hash) {
  const match = ROUTE_PATTERN.exec(String(hash ?? ""));
  if (!match)
    return { boardId: null, view: null, installId: null, itemId: null };
  const [, boardId, viewName, installId, itemId] = match;
  let view = null;
  if (viewName === "kanban") view = "kanban";
  else if (installId) view = "app";
  else if (!itemId) view = "table";
  return {
    boardId,
    view,
    installId: installId ?? null,
    itemId: itemId ?? null,
  };
}

/** `#/boards/<id>` */
export function boardHash(boardId) {
  return `#/boards/${boardId}`;
}

/** Hash of a board view (`{ view, installId }`). */
export function viewHash(boardId, { view, installId } = {}) {
  if (view === "kanban") return `${boardHash(boardId)}/views/kanban`;
  if (view === "app" && installId) {
    return `${boardHash(boardId)}/views/app-${installId}`;
  }
  return boardHash(boardId);
}

/** `#/boards/<id>/items/<itemId>` */
export function itemHash(boardId, itemId) {
  return `${boardHash(boardId)}/items/${itemId}`;
}
