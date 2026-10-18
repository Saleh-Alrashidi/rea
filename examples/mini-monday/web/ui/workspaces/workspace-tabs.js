/**
 * The workspace page's Boards / Docs / Forms tabs: each lists what the
 * user can open in the workspace and offers its create button. Creating
 * runs the shared flows (`ui/shell/create.js`); a disabled button explains
 * why (account role, workspace access, or no board to attach a form to).
 */

import { h } from "../../dom.js";
import { boardHash, docHash, formHash } from "../../router.js";
import { shareableFormLink } from "../board/forms-view.js";
import { formAccess } from "../components/labels.js";
import {
  accessBadge,
  badge,
  boardKindBadge,
  docVisibilityBadge,
} from "../components/badge.js";
import { button } from "../components/button.js";
import { emptyState } from "../components/empty-state.js";
import { plural, timeAgo } from "../components/format.js";
import { icon } from "../components/icon.js";
import { boardKind } from "../components/labels.js";
import { canCreateIn, hasRole } from "../components/permissions.js";

/** Create-button reasons for each tab (null when allowed). */
export function createReasons(me, workspace) {
  const base = canCreateIn(me, { my_access: workspace.myAccess });
  const reason = base.ok ? null : base.reason;
  const editable = workspace.boards.some((board) =>
    hasRole(board.my_access, "editor"),
  );
  return {
    boards: reason,
    docs: reason,
    forms:
      reason ??
      (editable ? null : "Add a board you can edit first; forms fill a board"),
  };
}

// Boards reuse the "Shared with me" card look; docs and forms the Home
// page's preview rows (styles/pages.css), so lists read the same app-wide.
function boardCard(board) {
  return h(
    "a",
    { class: ["panel", "shared-card"], href: boardHash(board.id) },
    h(
      "div",
      { class: "shared-card-top" },
      h(
        "span",
        { class: "shared-card-icon" },
        icon(boardKind(board.board_kind).icon, { size: 18 }),
      ),
      h("span", { class: "shared-card-kind" }, "Board"),
      boardKindBadge(board.board_kind),
    ),
    h("h2", { class: "shared-card-title" }, board.name),
    board.description
      ? h("p", { class: "shared-card-subtitle ws-clamp" }, board.description)
      : null,
    h(
      "div",
      { class: "shared-card-footer" },
      h("span", { class: "shared-card-by" }, plural(board.items_count, "item")),
      board.my_access === "viewer" ? accessBadge("viewer") : null,
    ),
  );
}

function boardsList(workspace) {
  return h("div", { class: "panel-grid" }, workspace.boards.map(boardCard));
}

function row({ iconName, title, href, meta, badges }) {
  return h(
    "li",
    { class: "preview-row" },
    h("span", { class: "preview-icon" }, icon(iconName, { size: 14 })),
    h(
      href ? "a" : "div",
      { class: "preview-main", href: href ?? null },
      h("span", { class: "preview-title" }, title),
      meta ? h("span", { class: "preview-subtitle" }, meta) : null,
    ),
    badges,
  );
}

function rows(items) {
  return h(
    "div",
    { class: "panel" },
    h("ul", { class: "panel-body preview-list ws-rows" }, items),
  );
}

function docsList(workspace) {
  return rows(
    workspace.docs.map((doc) =>
      row({
        iconName: "docs",
        title: doc.title,
        href: docHash(doc.id),
        meta: [
          doc.updated_at ? `Updated ${timeAgo(doc.updated_at)}` : null,
          doc.updated_by ? `by ${doc.updated_by.name}` : null,
        ]
          .filter(Boolean)
          .join(" "),
        badges: [
          docVisibilityBadge(doc.visibility),
          doc.my_access === "viewer" ? accessBadge("viewer") : null,
        ],
      }),
    ),
  );
}

function formsList(workspace) {
  return rows(
    workspace.forms.map((form) => {
      const access = formAccess(form.access);
      const editor = hasRole(form.board.myAccess, "editor");
      const link = shareableFormLink(form);
      return row({
        iconName: "forms",
        title: form.title,
        href: editor ? formHash(form.id) : null,
        meta: `${plural(form.response_count, "response")} · on ${form.board.name}`,
        badges: [
          badge(access.label, {
            tone: access.tone,
            icon: access.icon,
            title: access.description,
          }),
          link
            ? h(
                "a",
                {
                  class: "btn btn-ghost btn-sm",
                  href: link,
                  target: "_blank",
                  rel: "noopener noreferrer",
                  "aria-label": `Open the public form “${form.title}”`,
                },
                icon("open"),
              )
            : null,
        ],
      });
    }),
  );
}

const TAB_CONTENT = Object.freeze({
  boards: {
    list: boardsList,
    empty: {
      icon: "grid",
      title: "No boards here yet",
      text: "Boards track work as items in groups and columns.",
    },
    action: "New board",
  },
  docs: {
    list: docsList,
    empty: {
      icon: "docs",
      title: "No docs here yet",
      text: "Docs hold specs, briefs and meeting notes next to your boards.",
    },
    action: "New doc",
  },
  forms: {
    list: formsList,
    empty: {
      icon: "forms",
      title: "No forms here yet",
      text: "Forms collect requests from anyone you share them with; each response becomes an item.",
    },
    action: "New form",
  },
});

/**
 * The content of one tab.
 * @param {{ tab: "boards" | "docs" | "forms", workspace: object,
 *   reason: string | null, onCreate: () => void }} options
 */
export function tabContent({ tab, workspace, reason, onCreate }) {
  const content = TAB_CONTENT[tab];
  const items = workspace[tab];
  const create = button({
    label: content.action,
    icon: "plus",
    variant: items.length > 0 ? "secondary" : "primary",
    size: "sm",
    disabledReason: reason,
    onClick: onCreate,
  });
  if (items.length === 0) {
    return emptyState({
      ...content.empty,
      action: {
        label: content.action,
        icon: "plus",
        onClick: onCreate,
        disabledReason: reason,
      },
    });
  }
  return h(
    "div",
    { class: "ws-tab" },
    h(
      "div",
      { class: "ws-tab-toolbar" },
      h("p", { class: "ws-tab-count" }, plural(items.length, tab.slice(0, -1))),
      create,
    ),
    content.list(workspace),
  );
}
