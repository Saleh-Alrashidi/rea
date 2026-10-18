/**
 * Board header: the workspace link, the board name and description
 * (inline-editable for owners), kind and "View only" badges, the members'
 * avatars and the Share button (both open the share dialog), the board
 * settings menu, view tabs (Main table, Kanban, one per app view, Activity,
 * Forms) and, for item views, the toolbar with "New item" and the
 * item-name search.
 *
 * Owner-only settings stay visible to everyone else, disabled with the
 * reason, so users can tell what the board's owners can change.
 */

import { clear, h } from "../../dom.js";
import { viewHash, workspaceHash } from "../../router.js";
import { avatarStack } from "../components/avatar.js";
import { accessBadge, boardKindBadge } from "../components/badge.js";
import { button } from "../components/button.js";
import { icon } from "../components/icon.js";
import { inlineInput } from "../components/inline-edit.js";
import { BOARD_KINDS } from "../components/labels.js";
import { menuButton } from "../components/menu.js";
import { skeletonBlock, skeletonLine } from "../components/skeleton.js";

const MAX_DESCRIPTION = 1000;
const MAX_MEMBER_AVATARS = 4;

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
  const tab = (view, label, iconName) =>
    viewTab({ boardId: board.id, route, view, label, iconName });
  return h(
    "nav",
    { class: "view-tabs", "aria-label": "Board views" },
    tab({ view: "table" }, "Main table", "table"),
    tab({ view: "kanban" }, "Kanban", "kanban"),
    appViews.map((view) =>
      tab(
        { view: "app", installId: String(view.app_install_id) },
        view.name,
        "app",
      ),
    ),
    tab({ view: "activity" }, "Activity", "activity"),
    tab({ view: "forms" }, "Forms", "forms"),
  );
}

function toolbar({ caps, search, visibleCount, onNewItem, onSearch }) {
  return h(
    "div",
    { class: "toolbar", role: "toolbar", "aria-label": "Board tools" },
    caps.edit
      ? button({
          label: "New item",
          icon: "plus",
          variant: "primary",
          className: "new-item",
          onClick: onNewItem,
        })
      : null,
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

/** Views whose content is the item list (they get the toolbar). */
const ITEM_VIEWS = new Set(["table", "kanban", "app"]);

/** Focuses and selects the header input with `selector` (owners). */
function focusField(container, selector) {
  const input = container.querySelector(selector);
  input?.focus();
  input?.select?.();
}

/** The board settings menu (owner actions disabled for everyone else). */
function settingsItems(container, props) {
  const { board, caps } = props;
  const reason = caps.reasons.manage;
  return [
    {
      label: "Rename board",
      icon: "edit",
      disabledReason: reason,
      onSelect: () => focusField(container, ".board-name"),
    },
    {
      label: board.description ? "Edit description" : "Add description",
      icon: "edit",
      disabledReason: reason,
      onSelect: () => focusField(container, ".board-description"),
    },
    { type: "heading", label: "Board type" },
    Object.entries(BOARD_KINDS).map(([kind, info]) => ({
      label: info.label,
      hint: info.description,
      icon: info.icon,
      checked: board.kind === kind,
      disabledReason: reason,
      onSelect: () => props.onKind(kind),
    })),
    { type: "separator" },
    { label: "Copy board link", icon: "link", onSelect: props.onCopyLink },
    { type: "separator" },
    {
      label: "Delete board",
      icon: "trash",
      danger: true,
      disabledReason: reason,
      onSelect: props.onDelete,
    },
  ].flat();
}

function membersButton({ board, caps, onShare }) {
  if (board.members.length === 0) return null;
  const names = board.members.map((member) => member.name).join(", ");
  const action = caps.manage ? "Manage access" : "See who has access";
  return h(
    "button",
    {
      type: "button",
      class: "board-members",
      "aria-label": `Board members: ${names}. ${action}`,
      title: names,
      on: { click: onShare },
    },
    avatarStack(board.members, { max: MAX_MEMBER_AVATARS, size: "sm" }),
  );
}

function titleRow(container, props) {
  const { board, caps } = props;
  return h(
    "div",
    { class: "board-title-row" },
    h(
      "h1",
      { class: ["board-name-heading", !caps.manage && "plain"] },
      caps.manage
        ? inlineInput({
            value: board.name,
            label: "Board name",
            className: "board-name",
            required: true,
            focusKey: "board-name",
            onCommit: props.onRename,
          })
        : board.name,
    ),
    h(
      "div",
      { class: "board-badges" },
      board.kind ? boardKindBadge(board.kind) : null,
      caps.viewOnly ? accessBadge("viewer") : null,
    ),
    h(
      "div",
      { class: "board-actions" },
      membersButton(props),
      button({
        label: "Share",
        icon: "userPlus",
        size: "sm",
        className: "board-share",
        onClick: props.onShare,
      }),
      menuButton({
        icon: "settings",
        label: "Board settings",
        className: "board-settings",
        items: () => settingsItems(container, props),
      }),
    ),
  );
}

function description({ board, caps, onDescribe }) {
  if (caps.manage) {
    return inlineInput({
      value: board.description,
      label: "Board description",
      className: "board-description",
      placeholder: "Add a board description",
      maxLength: MAX_DESCRIPTION,
      focusKey: "board-description",
      onCommit: onDescribe,
    });
  }
  return board.description
    ? h("p", { class: "board-description plain" }, board.description)
    : null;
}

/** The workspace link, for users who can open the workspace. */
function workspaceLink(board) {
  if (!board.workspace || !board.workspaceAccessible) return null;
  return h(
    "a",
    { class: "board-eyebrow", href: workspaceHash(board.workspace.id) },
    icon("workspace", { size: 14 }),
    h("span", null, board.workspace.name),
  );
}

/**
 * Renders the board header into `container`.
 * @param {HTMLElement} container
 * @param {{ board: object, caps: object, route: object, search: string,
 *   visibleCount: string, onRename(name: string): void,
 *   onDescribe(text: string): void, onKind(kind: string): void,
 *   onDelete(): void, onShare(): void, onCopyLink(): void,
 *   onNewItem(): void, onSearch(term: string): void }} props
 */
export function renderBoardHeader(container, props) {
  const { board, route } = props;
  clear(container).append(
    h(
      "div",
      { class: "board-header" },
      workspaceLink(board),
      titleRow(container, props),
      description(props),
      viewTabs(board, route),
      ITEM_VIEWS.has(route.view) ? toolbar(props) : null,
    ),
  );
}

/**
 * Renders a minimal header for a board that is not ready: skeleton bars
 * while loading, otherwise `title`.
 * @param {HTMLElement} container
 * @param {{ title: string, loading?: boolean }} options
 */
export function renderPlainHeader(container, { title, loading = false }) {
  clear(container).append(
    h(
      "div",
      { class: "board-header" },
      loading
        ? skeletonBlock({
            label: "Loading board",
            className: "board-header-skeleton",
            children: [
              skeletonLine({ width: "120px" }),
              skeletonLine({ variant: "title", width: "min(320px, 60%)" }),
              skeletonLine({ width: "min(420px, 80%)" }),
            ],
          })
        : h(
            "div",
            { class: "board-title-row" },
            h("h1", { class: "board-name-heading plain" }, title),
          ),
    ),
  );
}
