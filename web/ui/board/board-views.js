/**
 * Board views (SPEC-5 §1.5, §3.1, §4.1): the tabs a board's `views`
 * records give, in record order; its default view (the first non-app
 * view); the views editors may still add; and whether an item opens as the
 * ClickUp-style task view or the item card.
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
 * view in record order, or "table" when it has none (or is not loaded).
 * @param {{ views?: object[] } | null} board
 */
export function defaultView(board) {
  return (
    (board?.views ?? []).find((view) => isItemView(view.type))?.type ?? "table"
  );
}

/**
 * The board's view tabs before Activity and Forms, in record order:
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

/**
 * How the item route shows an item (SPEC-5 §4.1): "task" (the task view)
 * when the view the user came from is List, or, on a direct link
 * (`lastView` null or without a view), when the board's default view is
 * List; otherwise "card" (the item card).
 * @param {{ board: object | null,
 *   lastView?: { view: string | null } | null }} options
 * @returns {"task" | "card"}
 */
export function itemViewKind({ board, lastView = null }) {
  const view = lastView?.view ?? defaultView(board);
  return view === "list" ? "task" : "card";
}
