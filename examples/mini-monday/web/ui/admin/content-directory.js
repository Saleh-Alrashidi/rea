/**
 * The admin content directory (`#/admin/content`): every board and doc in
 * the account with its privacy, owner and workspace — metadata only, as
 * `admin_content_directory` returns it. Titles link to the record only
 * when the admin can already open it; otherwise "Take ownership" (with a
 * confirmation, run by the page through `onTakeOwnership(row)`) adds the
 * admin as an owner, which the server records instead of granting silent
 * access.
 */

import { h } from "../../dom.js";
import { boardHash, docHash, workspaceHash } from "../../router.js";
import { avatar } from "../components/avatar.js";
import {
  badge,
  boardKindBadge,
  docVisibilityBadge,
} from "../components/badge.js";
import { button } from "../components/button.js";
import { emptyState } from "../components/empty-state.js";
import { icon } from "../components/icon.js";
import { boardKind, resourceKind } from "../components/labels.js";
import { tabs } from "../components/tabs.js";
import { filterContent } from "./admin-data.js";

const KINDS = [
  { id: "all", label: "All" },
  { id: "board", label: "Boards" },
  { id: "doc", label: "Docs" },
];

function titleCell(row) {
  const kindIcon =
    row.kind === "board"
      ? boardKind(row.privacy).icon
      : resourceKind(row.kind).icon;
  const href = row.kind === "board" ? boardHash(row.id) : docHash(row.id);
  const title = row.myAccess
    ? h("a", { class: "admin-content-title", href }, row.title)
    : h("span", { class: "admin-content-title" }, row.title);
  return h(
    "th",
    { scope: "row", class: "admin-sticky" },
    h(
      "div",
      { class: "admin-content-name" },
      h("span", { class: "admin-content-icon" }, icon(kindIcon, { size: 16 })),
      title,
    ),
  );
}

function ownerCell(row) {
  if (!row.owner) return h("td", { class: "admin-muted" }, "No owner");
  return h(
    "td",
    null,
    h(
      "span",
      { class: "admin-person compact" },
      avatar(row.owner, { size: "xs", title: null }),
      h("span", null, row.owner.name),
    ),
  );
}

function workspaceCell(row) {
  if (!row.workspace) return h("td", { class: "admin-muted" }, "—");
  return h(
    "td",
    null,
    h("a", { href: workspaceHash(row.workspace.id) }, row.workspace.name),
  );
}

function actionCell(d, row) {
  if (row.myAccess === "owner") {
    return h(
      "td",
      { class: "admin-actions" },
      badge("You’re an owner", { tone: "success", icon: "check" }),
    );
  }
  return h(
    "td",
    { class: "admin-actions" },
    button({
      label: "Take ownership",
      icon: "admin",
      size: "sm",
      variant: "secondary",
      ariaLabel: `Take ownership of ${row.title}`,
      onClick: () => d.onTakeOwnership(row),
    }),
  );
}

function contentRow(d, row) {
  return h(
    "tr",
    { class: "admin-row" },
    titleCell(row),
    h("td", null, resourceKind(row.kind).label),
    h(
      "td",
      null,
      row.kind === "board"
        ? boardKindBadge(row.privacy)
        : docVisibilityBadge(row.privacy),
    ),
    ownerCell(row),
    workspaceCell(row),
    actionCell(d, row),
  );
}

function table(d, rows) {
  return h(
    "div",
    { class: "admin-table-scroll" },
    h(
      "table",
      { class: "admin-table" },
      h("caption", { class: "visually-hidden" }, "Boards and docs"),
      h(
        "thead",
        null,
        h(
          "tr",
          null,
          ["Title", "Type", "Privacy", "Owner", "Workspace"].map(
            (label, index) =>
              h(
                "th",
                { scope: "col", class: index === 0 ? "admin-sticky" : null },
                label,
              ),
          ),
          h(
            "th",
            { scope: "col" },
            h("span", { class: "visually-hidden" }, "Actions"),
          ),
        ),
      ),
      h(
        "tbody",
        null,
        rows.map((row) => contentRow(d, row)),
      ),
    ),
  );
}

function render(d) {
  const counts = Object.fromEntries(
    KINDS.map((entry) => [
      entry.id,
      filterContent(d.rows, { kind: entry.id }).length,
    ]),
  );
  const hadFocus = d.filters.contains(globalThis.document.activeElement);
  d.filters.replaceChildren(
    tabs({
      label: "Filter content",
      items: KINDS.map((entry) => ({ ...entry, count: counts[entry.id] })),
      active: d.kind,
      onSelect(id) {
        d.kind = id;
        render(d);
      },
    }),
  );
  if (hadFocus) d.filters.querySelector('[aria-selected="true"]')?.focus();
  const shown = filterContent(d.rows, { kind: d.kind, query: d.query });
  d.results.replaceChildren(
    shown.length > 0
      ? table(d, shown)
      : emptyState({
          icon: "search",
          compact: true,
          title: d.query.trim() ? "Nothing matches" : "No content yet",
          text: d.query.trim()
            ? "Try another title, owner or workspace."
            : "Boards and docs appear here as people create them.",
        }),
  );
}

/**
 * @param {{ rows: object[], onTakeOwnership: (row: object) => void }} options
 * @returns {{ element: HTMLElement, update(rows: object[]): void }}
 */
export function contentDirectory(options) {
  const d = {
    ...options,
    kind: "all",
    query: "",
    filters: h("div", { class: "admin-filters" }),
    results: h("div", { class: "admin-results" }),
  };
  const search = h(
    "label",
    { class: "admin-search" },
    icon("search", { size: 14 }),
    h("input", {
      class: "input input-small",
      type: "search",
      placeholder: "Search content",
      "aria-label": "Search boards and docs by title, owner or workspace",
      on: {
        input: (event) => {
          d.query = event.currentTarget.value;
          render(d);
        },
      },
    }),
  );
  const element = h(
    "section",
    { class: "panel admin-content", "aria-labelledby": "admin-content-title" },
    h(
      "div",
      { class: "panel-header admin-toolbar" },
      h(
        "h2",
        { class: "panel-title", id: "admin-content-title" },
        icon("grid"),
        "Boards and docs",
      ),
      search,
    ),
    h(
      "p",
      { class: "admin-note admin-content-note" },
      icon("lock", { size: 14 }),
      "You see titles and owners only. Open a private board or doc by taking ownership; its owners will see you in the members list.",
    ),
    d.filters,
    d.results,
  );
  render(d);
  return {
    element,
    update(rows) {
      d.rows = rows;
      render(d);
    },
  };
}
