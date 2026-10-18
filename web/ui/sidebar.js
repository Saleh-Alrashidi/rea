/**
 * Left sidebar: workspace, board list, "New board", the signed-in user and
 * the theme toggle. On narrow screens it is an off-canvas drawer.
 */

import { clear, h } from "../dom.js";
import { avatar } from "./cells.js";
import { icon } from "./icons.js";
import { boardHash } from "./router.js";

const WORKSPACE_NAME = "Main workspace";

function boardLink(board, activeBoardId) {
  const active = board.id === activeBoardId;
  return h(
    "li",
    null,
    h(
      "a",
      {
        class: ["board-link", active && "active"],
        href: boardHash(board.id),
        "aria-current": active ? "page" : null,
        title: board.name,
      },
      icon("board"),
      h("span", { class: "board-link-name" }, board.name),
    ),
  );
}

function themeButton(theme, onToggleTheme) {
  const dark = theme === "dark";
  return h(
    "button",
    {
      type: "button",
      class: "icon-btn",
      "aria-label": dark ? "Switch to light theme" : "Switch to dark theme",
      title: dark ? "Light theme" : "Dark theme",
      on: { click: onToggleTheme },
    },
    icon(dark ? "sun" : "moon"),
  );
}

/**
 * Renders the sidebar into `container`.
 * @param {HTMLElement} container
 * @param {{ boards: object[], activeBoardId: string | null, me: object | null,
 *   theme: "light" | "dark", onNewBoard(): void, onToggleTheme(): void,
 *   onClose(): void }} props
 */
export function renderSidebar(container, props) {
  const { boards, activeBoardId, me, theme, onNewBoard, onToggleTheme } = props;
  clear(container).append(
    h(
      "div",
      { class: "sidebar-inner" },
      h(
        "div",
        { class: "sidebar-top" },
        h(
          "div",
          { class: "brand" },
          h("span", { class: "brand-mark", "aria-hidden": "true" }, "mm"),
          h("span", { class: "brand-name" }, "mini-monday"),
        ),
        h(
          "button",
          {
            type: "button",
            class: "icon-btn sidebar-close",
            "aria-label": "Hide boards",
            on: { click: props.onClose },
          },
          icon("close"),
        ),
      ),
      h(
        "div",
        { class: "workspace" },
        h("span", { class: "workspace-icon", "aria-hidden": "true" }, "M"),
        h(
          "div",
          { class: "workspace-text" },
          h("span", { class: "workspace-label" }, "Workspace"),
          h("span", { class: "workspace-name" }, WORKSPACE_NAME),
        ),
      ),
      h(
        "button",
        {
          type: "button",
          class: "btn btn-primary btn-block",
          on: { click: onNewBoard },
        },
        icon("plus"),
        h("span", null, "New board"),
      ),
      h(
        "nav",
        { class: "board-nav", "aria-labelledby": "sidebar-boards-heading" },
        h(
          "h2",
          { class: "sidebar-heading", id: "sidebar-boards-heading" },
          "Boards",
        ),
        boards.length > 0
          ? h(
              "ul",
              { class: "board-list" },
              boards.map((board) => boardLink(board, activeBoardId)),
            )
          : h(
              "p",
              { class: "sidebar-empty" },
              me ? "No boards yet" : "Loading boards…",
            ),
      ),
      h(
        "div",
        { class: "sidebar-footer" },
        me ? avatar(me) : null,
        h(
          "div",
          { class: "sidebar-user" },
          h("span", { class: "sidebar-user-name" }, me?.name ?? ""),
          h("span", { class: "sidebar-user-email" }, me?.email ?? ""),
        ),
        themeButton(theme, onToggleTheme),
      ),
    ),
  );
}
