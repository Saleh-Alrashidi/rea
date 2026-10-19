/**
 * Sidebar (SPEC-6 §3.3, ClickUp style), top to bottom: Home, Inbox (the
 * notifications, with the bell's unread count), My Work, Shared with me,
 * Docs and Notes; Favorites (hidden while empty); the Spaces tree of
 * every Space the user can open (`sidebar-tree.js`, with its "+" and
 * "…" menus, `sidebar-menus.js`, and drag and drop, `sidebar-dnd.js`)
 * and "+ New Space" for those who may create one; Teams and Admin at the
 * bottom (Admin for admins; it stays selected on the importer page).
 * Under 900 px it is the shell's off-canvas drawer.
 *
 * `createSidebar(options)` returns `{ update({ data, route }), reveal(
 * spaceId) }`: the shell hands it fresh shell data and every route. The
 * current item is highlighted, and the Space and folder holding it are
 * expanded once when it is opened. Expanded nodes and Favorites are
 * per-user browser conveniences (`sidebar-prefs.js`). A redraw waits
 * while a node is being renamed or dragged, so neither is cut short.
 */

import { clear, h } from "../../dom.js";
import {
  adminHash,
  docsHash,
  homeHash,
  myWorkHash,
  notesHash,
  sharedHash,
  teamsHash,
} from "../../router.js";
import { iconButton } from "../components/button.js";
import { brandMark, icon } from "../components/icon.js";
import { can } from "../components/permissions.js";
import { attachTreeDrag } from "./sidebar-dnd.js";
import {
  allNodes,
  ancestorKeys,
  buildSpaces,
  isExpanded,
  routeKey,
  visibleRows,
} from "./sidebar-model.js";
import {
  favoriteNodes,
  sidebarPrefs,
  toggleFavorite,
} from "./sidebar-prefs.js";
import { focusTreeItem, nodeLink, spaceTree } from "./sidebar-tree.js";

const PRIMARY = [
  { label: "Home", icon: "home", hash: homeHash(), routes: ["home"] },
  { label: "Inbox", icon: "inbox", inbox: true },
  { label: "My Work", icon: "myWork", hash: myWorkHash(), routes: ["my-work"] },
  {
    label: "Shared with me",
    icon: "shared",
    hash: sharedHash(),
    routes: ["shared"],
  },
  { label: "Docs", icon: "docs", hash: docsHash(), routes: ["docs"] },
  { label: "Notes", icon: "notes", hash: notesHash(), routes: ["notes"] },
];

function isActive(route, names) {
  return Boolean(route && names.includes(route.name));
}

function navLink({ label, iconName, hash, active, extra = null }) {
  return h(
    "li",
    null,
    h(
      "a",
      {
        class: ["nav-link", active && "active"],
        href: hash,
        "aria-current": active ? "page" : null,
        title: label,
      },
      icon(iconName),
      h("span", { class: "nav-label" }, label),
      extra,
    ),
  );
}

function inboxButton(s) {
  return h(
    "li",
    null,
    h(
      "button",
      {
        type: "button",
        class: "nav-link sidebar-inbox",
        "aria-haspopup": "dialog",
        title: "Inbox: your notifications",
        on: { click: () => s.onInbox() },
      },
      icon("inbox"),
      h("span", { class: "nav-label" }, "Inbox"),
      s.inboxBadge,
    ),
  );
}

function primaryNav(s) {
  return h(
    "nav",
    { class: "sidebar-primary", "aria-label": "Main" },
    h(
      "ul",
      { class: "nav-list" },
      PRIMARY.map((entry) =>
        entry.inbox
          ? inboxButton(s)
          : navLink({
              label: entry.label,
              iconName: entry.icon,
              hash: entry.hash,
              active: isActive(s.route, entry.routes),
            }),
      ),
    ),
  );
}

function sectionHeader(id, title, extra = null) {
  return h(
    "div",
    { class: "sidebar-section-header" },
    h("h2", { class: "sidebar-heading", id }, title),
    extra,
  );
}

/** Favorites: the starred nodes the tree shows, hidden while there are none. */
function favoritesSection(s) {
  const nodes = favoriteNodes(s.prefs.favorites, s.byKey);
  if (nodes.length === 0) return null;
  return h(
    "section",
    {
      class: "sidebar-section sidebar-favorites",
      "aria-labelledby": "sidebar-favorites-heading",
    },
    sectionHeader("sidebar-favorites-heading", "Favorites"),
    h(
      "ul",
      { class: "nav-list" },
      nodes.map((node) =>
        h(
          "li",
          { class: "favorite-row" },
          nodeLink(s, node, { favorite: true }),
          iconButton({
            icon: "star",
            label: `Remove “${node.name}” from favorites`,
            size: "sm",
            className: "favorite-remove",
            onClick: () => s.toggleFavorite(node.key),
          }),
        ),
      ),
    ),
  );
}

function newSpaceButton(s) {
  if (!can(s.ctx.me, "create_workspace")) return null;
  return h(
    "button",
    {
      type: "button",
      class: "sidebar-new-space",
      on: { click: () => s.flows.workspace() },
    },
    icon("plus", { size: 14 }),
    h("span", null, "New Space"),
  );
}

function spacesSection(s) {
  return h(
    "section",
    {
      class: "sidebar-section sidebar-spaces",
      "aria-labelledby": "sidebar-spaces-heading",
    },
    sectionHeader("sidebar-spaces-heading", "Spaces"),
    s.spaces.length > 0
      ? spaceTree(s)
      : h("p", { class: "sidebar-empty" }, "You aren’t in any Space yet."),
    newSpaceButton(s),
  );
}

function bottomLinks(s) {
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
        active: isActive(s.route, ["teams", "team"]),
      }),
      can(s.ctx.me, "manage_users")
        ? navLink({
            label: "Admin",
            iconName: "admin",
            hash: adminHash(),
            active: isActive(s.route, ["admin", "import"]),
          })
        : null,
    ),
  );
}

function drawerTop(s) {
  return h(
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
      onClick: s.onClose,
    }),
  );
}

/** Expands the Space and folder of the current item once per opening. */
function revealCurrent(s) {
  if (!s.currentKey || s.revealed === s.currentKey) return;
  if (!s.byKey.has(s.currentKey)) return;
  s.revealed = s.currentKey;
  for (const key of ancestorKeys(s.spaces, s.currentKey)) {
    if (!isExpanded(s.prefs.expanded, s.byKey.get(key))) {
      s.prefs.setExpanded(key, true);
    }
  }
}

/** The key of the tree item holding focus, or null. */
function focusedKey(s) {
  const active = globalThis.document?.activeElement;
  if (!active || !s.container.contains(active)) return null;
  return active.closest?.("[role=treeitem]")?.dataset.key ?? null;
}

/** Draws the sidebar now (see `render` for the polite version). */
function draw(s) {
  s.pending = false;
  const focus = focusedKey(s);
  s.spaces = buildSpaces(s.data.workspaces);
  s.byKey = new Map(allNodes(s.spaces).map((node) => [node.key, node]));
  s.currentKey = routeKey(s.route);
  revealCurrent(s);
  s.rows = visibleRows(s.spaces, s.prefs.expanded);
  clear(s.container).append(
    h(
      "div",
      { class: "sidebar-inner" },
      drawerTop(s),
      primaryNav(s),
      h(
        "div",
        { class: "sidebar-scroll" },
        favoritesSection(s),
        spacesSection(s),
      ),
      bottomLinks(s),
    ),
  );
  attachTreeDrag(s);
  const field = s.container.querySelector(".tree-rename");
  if (field) {
    field.focus();
    field.select();
  } else if (focus) focusTreeItem(s, focus);
}

/** Draws the sidebar, or once the rename or drag in progress ends. */
function render(s) {
  if (s.busy()) s.pending = true;
  else draw(s);
}

/**
 * Creates the sidebar in `container`.
 * @param {{ container: HTMLElement, ctx: object, flows: object,
 *   inboxBadge: HTMLElement, onInbox(): void, onClose(): void }} options
 */
export function createSidebar(options) {
  const s = {
    ...options,
    data: { workspaces: [] },
    route: null,
    prefs: sidebarPrefs(options.ctx.me.id),
    spaces: [],
    byKey: new Map(),
    rows: [],
    currentKey: null,
    revealed: null,
    focusKey: null,
    renaming: null,
    dragging: false,
    pending: false,
  };
  s.busy = () => Boolean(s.renaming || s.dragging);
  s.render = () => render(s);
  s.draw = () => draw(s);
  s.isOpen = (node) => isExpanded(s.prefs.expanded, node);
  /** Shows the node `key` in the tree (expanding its containers). */
  s.revealNode = (key) => {
    for (const each of [...ancestorKeys(s.spaces, key), key]) {
      s.prefs.setExpanded(each, true);
    }
    draw(s);
    focusTreeItem(s, key);
  };
  s.startRename = (key) => {
    s.renaming = key;
    draw(s);
  };
  /** Redraws now, or once the rename or drag in progress ends. */
  s.settle = () => {
    if (s.pending && !s.busy()) render(s);
  };
  s.refresh = () => s.ctx.refreshShell();
  s.setExpanded = (key, open) => {
    s.prefs.setExpanded(key, open);
    render(s);
  };
  s.toggleFavorite = (key) => {
    s.prefs.setFavorites(toggleFavorite(s.prefs.favorites, key));
    render(s);
  };
  return {
    update({ data, route } = {}) {
      if (data) s.data = data;
      if (route !== undefined) s.route = route;
      render(s);
    },
    /** Expands Space `spaceId` (the page shows something of it). */
    reveal(spaceId) {
      const key = `space:${spaceId}`;
      if (s.prefs.expanded[key] !== false) return;
      s.setExpanded(key, true);
    },
  };
}
