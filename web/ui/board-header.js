/**
 * Board header: inline-editable name and description, the board menu, view
 * tabs (Main table, Kanban, one per app view) and the toolbar with
 * "New item" and the item-name search.
 */

import { clear, h } from "../dom.js";
import { icon } from "./icons.js";
import { inlineInput } from "./inline-edit.js";
import { openMenu } from "./popover.js";
import { viewHash } from "./router.js";

const MAX_DESCRIPTION = 1000;

function viewTab({ boardId, route, view, label, iconName }) {
  const active =
    route.view === view.view &&
    (view.view !== "app" || route.installId === view.installId);
  return h(
    "a",
    {
      class: ["view-tab", active && "active"],
      href: viewHash(boardId, view),
      "aria-current": active ? "page" : null,
    },
    icon(iconName),
    h("span", null, label),
  );
}

function viewTabs(board, route) {
  const appViews = board.views.filter(
    (view) => view.type === "app" && view.app_install_id,
  );
  return h(
    "nav",
    { class: "view-tabs", "aria-label": "Board views" },
    viewTab({
      boardId: board.id,
      route,
      view: { view: "table" },
      label: "Main table",
      iconName: "table",
    }),
    viewTab({
      boardId: board.id,
      route,
      view: { view: "kanban" },
      label: "Kanban",
      iconName: "kanban",
    }),
    appViews.map((view) =>
      viewTab({
        boardId: board.id,
        route,
        view: { view: "app", installId: String(view.app_install_id) },
        label: view.name,
        iconName: "app",
      }),
    ),
  );
}

function boardMenuButton(onDelete) {
  const button = h(
    "button",
    {
      type: "button",
      class: "icon-btn",
      "aria-label": "Board actions",
      "aria-haspopup": "menu",
      "aria-expanded": "false",
      on: {
        click: () =>
          openMenu({
            anchor: button,
            label: "Board actions",
            items: [
              {
                label: "Delete board",
                danger: true,
                icon: icon("trash"),
                onSelect: onDelete,
              },
            ],
          }),
      },
    },
    icon("dots"),
  );
  return button;
}

function toolbar({ search, visibleCount, onNewItem, onSearch }) {
  return h(
    "div",
    { class: "toolbar", role: "toolbar", "aria-label": "Board tools" },
    h(
      "button",
      { type: "button", class: "btn btn-primary", on: { click: onNewItem } },
      icon("plus"),
      h("span", null, "New item"),
    ),
    h(
      "label",
      { class: "search" },
      icon("search"),
      h("input", {
        class: "search-input",
        type: "search",
        placeholder: "Search items",
        "aria-label": "Search items by name",
        autocomplete: "off",
        dataset: { focusKey: "search", live: "" },
        value: search,
        on: { input: (event) => onSearch(event.currentTarget.value) },
      }),
    ),
    h(
      "span",
      { class: "toolbar-count", "aria-live": "polite", id: "toolbar-count" },
      visibleCount,
    ),
  );
}

/** Text for the toolbar's live item count. */
export function itemCountText(count, search) {
  const noun = count === 1 ? "item" : "items";
  return search.trim() ? `${count} matching ${noun}` : `${count} ${noun}`;
}

/**
 * Renders the board header into `container`.
 * @param {HTMLElement} container
 * @param {{ board: object, route: object, search: string, visibleCount: string,
 *   sidebarOpen: boolean, onRename(name: string): void,
 *   onDescribe(text: string): void, onDelete(): void, onNewItem(): void,
 *   onSearch(term: string): void, onToggleSidebar(): void }} props
 */
export function renderBoardHeader(container, props) {
  const { board, route } = props;
  clear(container).append(
    h(
      "div",
      { class: "board-header" },
      h(
        "div",
        { class: "board-title-row" },
        h(
          "button",
          {
            type: "button",
            class: "icon-btn sidebar-toggle",
            "aria-label": "Show boards",
            "aria-controls": "sidebar",
            "aria-expanded": props.sidebarOpen ? "true" : "false",
            on: { click: props.onToggleSidebar },
          },
          icon("menu"),
        ),
        h(
          "h1",
          { class: "board-name-heading" },
          inlineInput({
            value: board.name,
            label: "Board name",
            className: "board-name",
            required: true,
            focusKey: "board-name",
            onCommit: props.onRename,
          }),
        ),
        boardMenuButton(props.onDelete),
      ),
      inlineInput({
        value: board.description,
        label: "Board description",
        className: "board-description",
        placeholder: "Add a board description",
        maxLength: MAX_DESCRIPTION,
        focusKey: "board-description",
        onCommit: props.onDescribe,
      }),
      viewTabs(board, route),
      toolbar(props),
    ),
  );
}

/** Renders a minimal header (for loading or missing boards). */
export function renderPlainHeader(container, { title, onToggleSidebar }) {
  clear(container).append(
    h(
      "div",
      { class: "board-header" },
      h(
        "div",
        { class: "board-title-row" },
        h(
          "button",
          {
            type: "button",
            class: "icon-btn sidebar-toggle",
            "aria-label": "Show boards",
            "aria-controls": "sidebar",
            on: { click: onToggleSidebar },
          },
          icon("menu"),
        ),
        h("h1", { class: "board-name-heading plain" }, title),
      ),
    ),
  );
}
