/**
 * Sidebar: primary navigation (Home, My work, Shared with me, Notes), the
 * workspace switcher, the current workspace's boards (icon per kind), docs
 * and forms, the "+ Add" menu (Board / Doc / Form, only when the user can
 * create there) and, at the bottom, Teams and Admin (admins only). Under
 * 900 px it is an off-canvas drawer.
 */

import { clear, h } from "../../dom.js";
import {
  adminHash,
  boardHash,
  docHash,
  docsHash,
  formHash,
  homeHash,
  myWorkHash,
  notesHash,
  sharedHash,
  teamsHash,
} from "../../router.js";
import { brandMark, icon } from "../components/icon.js";
import { iconButton } from "../components/button.js";
import { boardKind } from "../components/labels.js";
import { openMenu } from "../components/menu.js";
import { can, canCreateIn } from "../components/permissions.js";
import { workspaceSwitcher } from "./workspace-switcher.js";

const PRIMARY = [
  { label: "Home", icon: "home", hash: homeHash(), routes: ["home"] },
  { label: "My work", icon: "myWork", hash: myWorkHash(), routes: ["my-work"] },
  {
    label: "Shared with me",
    icon: "shared",
    hash: sharedHash(),
    routes: ["shared"],
  },
  { label: "Notes", icon: "notes", hash: notesHash(), routes: ["notes"] },
];

function navLink({ label, iconName, hash, active, title }) {
  return h(
    "li",
    null,
    h(
      "a",
      {
        class: ["nav-link", active && "active"],
        href: hash,
        "aria-current": active ? "page" : null,
        title: title ?? label,
      },
      icon(iconName),
      h("span", { class: "nav-label" }, label),
    ),
  );
}

function isActive(route, names, param, id) {
  if (!route || !names.includes(route.name)) return false;
  return param ? route.params[param] === id : true;
}

function section({ title, id, items, empty, more }) {
  const headingId = `sidebar-${id}-heading`;
  return h(
    "section",
    { class: "sidebar-section", "aria-labelledby": headingId },
    h(
      "div",
      { class: "sidebar-section-header" },
      h("h2", { class: "sidebar-heading", id: headingId }, title),
      more ?? null,
    ),
    items.length > 0
      ? h("ul", { class: "nav-list" }, items)
      : h("p", { class: "sidebar-empty" }, empty),
  );
}

function addMenu(props, workspace) {
  const allowed = canCreateIn(props.me, workspace);
  if (!allowed.ok) return null;
  const trigger = iconButton({
    icon: "plus",
    label: "Add to workspace",
    size: "sm",
    className: "sidebar-add",
    attributes: { "aria-haspopup": "menu", "aria-expanded": "false" },
    onClick: () =>
      openMenu({
        anchor: trigger,
        label: "Add to workspace",
        items: [
          {
            label: "Board",
            icon: "grid",
            hint: "Items, columns and views",
            onSelect: () => props.onCreate("board"),
          },
          {
            label: "Doc",
            icon: "docs",
            hint: "Specs, briefs and notes",
            onSelect: () => props.onCreate("doc"),
          },
          {
            label: "Form",
            icon: "forms",
            hint: "Collect responses into a board",
            onSelect: () => props.onCreate("form"),
          },
        ],
      }),
  });
  return trigger;
}

function workspaceContent(props, workspace) {
  const { route } = props;
  const boards = workspace.boards.map((board) =>
    navLink({
      label: board.name,
      iconName: boardKind(board.board_kind).icon,
      hash: boardHash(board.id),
      active: isActive(route, ["board"], "boardId", board.id),
      title: `${board.name} (${boardKind(board.board_kind).label})`,
    }),
  );
  const docs = workspace.docs.map((doc) =>
    navLink({
      label: doc.title,
      iconName: doc.visibility === "private" ? "lock" : "docs",
      hash: docHash(doc.id),
      active: isActive(route, ["doc-editor"], "docId", doc.id),
    }),
  );
  const forms = workspace.forms.map((form) =>
    navLink({
      label: form.title,
      iconName: "forms",
      hash: formHash(form.id),
      active: isActive(route, ["form-builder"], "formId", form.id),
    }),
  );
  const allDocs = h(
    "a",
    { class: "sidebar-more", href: docsHash() },
    "All docs",
  );
  return h(
    "nav",
    {
      class: "sidebar-workspace-nav",
      "aria-label": `${workspace.name} content`,
    },
    section({
      title: "Boards",
      id: "boards",
      items: boards,
      empty: "No boards yet",
    }),
    section({
      title: "Docs",
      id: "docs",
      items: docs,
      empty: "No docs yet",
      more: allDocs,
    }),
    section({
      title: "Forms",
      id: "forms",
      items: forms,
      empty: "No forms yet",
    }),
  );
}

function workspaceBlock(props) {
  const { workspaces, currentWorkspace } = props;
  return h(
    "div",
    { class: "sidebar-workspace" },
    h(
      "div",
      { class: "sidebar-workspace-header" },
      workspaceSwitcher({
        workspaces,
        current: currentWorkspace,
        canCreate: can(props.me, "create_workspace"),
        onSelect: props.onSelectWorkspace,
        onCreate: props.onNewWorkspace,
      }),
      currentWorkspace ? addMenu(props, currentWorkspace) : null,
    ),
    currentWorkspace
      ? workspaceContent(props, currentWorkspace)
      : h(
          "p",
          { class: "sidebar-empty" },
          workspaces.length === 0
            ? "You aren’t in any workspace yet."
            : "Choose a workspace.",
        ),
  );
}

function bottomLinks(props) {
  const { route, me } = props;
  return h(
    "nav",
    { class: "sidebar-bottom", "aria-label": "Account" },
    h(
      "ul",
      { class: "nav-list" },
      navLink({
        label: "Teams",
        iconName: "team",
        hash: teamsHash(),
        active: isActive(route, ["teams", "team"]),
      }),
      can(me, "manage_users")
        ? navLink({
            label: "Admin",
            iconName: "admin",
            hash: adminHash(),
            active: isActive(route, ["admin"]),
          })
        : null,
    ),
  );
}

/**
 * Renders the sidebar into `container`.
 * @param {HTMLElement} container
 * @param {{ me: object, workspaces: object[], currentWorkspace: object | null,
 *   route: object | null, onSelectWorkspace(id: string): void,
 *   onNewWorkspace(): void, onCreate(kind: "board" | "doc" | "form"): void,
 *   onClose(): void }} props
 */
export function renderSidebar(container, props) {
  const { route } = props;
  clear(container).append(
    h(
      "div",
      { class: "sidebar-inner" },
      h(
        "div",
        { class: "sidebar-drawer-top" },
        h(
          "a",
          { class: "brand", href: homeHash(), "aria-label": "Worklane home" },
          brandMark({ size: 26 }),
          h("span", { class: "brand-word" }, "Worklane"),
        ),
        iconButton({
          icon: "close",
          label: "Close navigation",
          className: "sidebar-close",
          onClick: props.onClose,
        }),
      ),
      h(
        "nav",
        { class: "sidebar-primary", "aria-label": "Main" },
        h(
          "ul",
          { class: "nav-list" },
          PRIMARY.map((entry) =>
            navLink({
              label: entry.label,
              iconName: entry.icon,
              hash: entry.hash,
              active: isActive(route, entry.routes),
            }),
          ),
        ),
      ),
      workspaceBlock(props),
      bottomLinks(props),
    ),
  );
}
