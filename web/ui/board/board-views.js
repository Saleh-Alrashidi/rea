/**
 * Board views (SPEC-5 §1.5, §3.1, SPEC-6 §1.1): the tabs a board's
 * `views` give, in the server's tab order (List, Main table, Kanban, then
 * apps); its default view (the first non-app view: List on every board);
 * and the views editors may still add. Items open in the task view from
 * every view (`pages/board.js`).
 */

/** Item views with their default names (the server's) and tab icons. */
export const ITEM_VIEWS = Object.freeze({
  list: Object.freeze({ label: "List", icon: "list" }),
  table: Object.freeze({ label: "Main table", icon: "table" }),
  kanban: Object.freeze({ label: "Kanban", icon: "kanban" }),
});
/** The server's limit on views per board (`create_board_view`). */
const MAX_VIEWS = 20;

const isItemView = (type) => Object.hasOwn(ITEM_VIEWS, type);

/**
 * The view `#/boards/<id>` opens: the type of the board's first non-app
 * view in `Board.views` (tab order, so List when the board has one), or
 * "list" when it has none or is not loaded yet, since every board has a
 * List view (SPEC-6 §1.1).
 * @param {{ views?: object[] } | null} board
 */
export function defaultView(board) {
  return (
    (board?.views ?? []).find((view) => isItemView(view.type))?.type ?? "list"
  );
}

/**
 * The board's view tabs before Activity and Forms, in `Board.views` order:
 * `{ view, installId, label, icon }` (app views need an install).
 */
export function viewTabsOf(board) {
  const tabs = [];
  const seen = new Set();
  for (const view of board.views ?? []) {
    if (view.type === "app" && view.app_install_id) {
      const installId = String(view.app_install_id);
      tabs.push({ view: "app", installId, label: view.name, icon: "app" });
    } else if (isItemView(view.type) && !seen.has(view.type)) {
      seen.add(view.type);
      const { label, icon } = ITEM_VIEWS[view.type];
      tabs.push({
        view: view.type,
        installId: null,
        label: view.name || label,
        icon,
      });
    }
  }
  return tabs;
}

/** Item view types the board does not have yet (none at MAX_VIEWS). */
export function missingViews(board) {
  const views = board.views ?? [];
  if (views.length >= MAX_VIEWS) return [];
  return Object.keys(ITEM_VIEWS).filter(
    (type) => !views.some((view) => view.type === type),
  );
}
