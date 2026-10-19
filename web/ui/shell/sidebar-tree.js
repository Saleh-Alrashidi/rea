/**
 * The Spaces tree of the sidebar (SPEC-6 §3.3): a `role="tree"` list of
 * Spaces (a colored letter tile), their folders (a folder icon in the
 * folder's color) and their Lists (the icon of the board's default
 * view), docs and forms, as `sidebar-model.js` orders them.
 *
 * Each node is an `li[role=treeitem]` labelled by its name. A row holds
 * the expand toggle of a Space or folder (the tile or folder icon turns
 * into a chevron on hover), the name (a link to the page; a folder's
 * name toggles it) truncated with the full name as its tooltip, and on
 * hover or focus "+" (Spaces and folders) and "…" (`sidebar-menus.js`).
 * The current item is highlighted (`aria-current`).
 *
 * Keyboard (roving focus, one tab stop): ↑/↓ move, Home/End jump, →
 * expands or enters, ← collapses or goes to the parent, Enter opens,
 * F2 renames, Shift+F10 or the context-menu key opens "…". The focused
 * row's "+" and "…" are in the tab order after it.
 *
 * Rows carry what drags need: `data-key`; a board's `data-drop-board`
 * and `data-drop-allowed` (task rows dragged from the List view,
 * `list-dnd.js`); a collapsed container's `data-drop-expand`.
 */

import { h } from "../../dom.js";
import { boardHash, docHash, formHash, workspaceHash } from "../../router.js";
import { iconButton } from "../components/button.js";
import { icon } from "../components/icon.js";
import { hasRole } from "../components/permissions.js";
import { textColorOn } from "../board/values.js";
import { commitRename } from "./sidebar-actions.js";
import {
  canRename,
  openMoreMenu,
  openPlusMenu,
  plusItems,
} from "./sidebar-menus.js";

const HASHES = Object.freeze({
  space: workspaceHash,
  board: boardHash,
  doc: docHash,
  form: formHash,
});
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const ACTION_KEYS = new Set([
  "ArrowDown",
  "ArrowUp",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "Enter",
  "F2",
  "F10",
  "ContextMenu",
]);

const labelId = (key) => `tree-label-${key.replace(":", "-")}`;
const safeColor = (color) =>
  COLOR_PATTERN.test(color ?? "") ? color : "var(--color-primary)";

/** A Space's colored tile with its first letter, readable on its color. */
export function spaceTile(space, { size = "md" } = {}) {
  const letter = [...(space.name?.trim() || "?")][0].toUpperCase();
  const known = COLOR_PATTERN.test(space.color ?? "");
  return h(
    "span",
    {
      class: ["space-tile", `space-tile-${size}`],
      "aria-hidden": "true",
      style: {
        "background-color": safeColor(space.color),
        color: known ? textColorOn(space.color) : null,
      },
    },
    letter,
  );
}

const folderIcon = (node) =>
  h(
    "span",
    {
      class: "tree-folder-icon",
      style: { color: safeColor(node.color) },
    },
    icon("folder", { size: 16 }),
  );

/** The glyph of a node: its tile, folder icon or view icon. */
function glyph(node) {
  if (node.kind === "space") return spaceTile(node, { size: "sm" });
  if (node.kind === "folder") return folderIcon(node);
  return icon(node.icon, { className: "tree-icon" });
}

/**
 * The link of `node` (a folder, which has no page, is a button that
 * shows it in the tree). In the tree (`favorite` false) it carries no
 * glyph for Spaces and folders (their toggle shows it) and is not a tab
 * stop of its own.
 */
export function nodeLink(s, node, { favorite = false } = {}) {
  const active = s.currentKey === node.key;
  const inTree = !favorite;
  const own = inTree && (node.kind === "space" || node.kind === "folder");
  const props = {
    class: ["nav-link", "tree-link", active && "active"],
    id: inTree ? labelId(node.key) : null,
    title: node.name,
    tabindex: inTree ? "-1" : null,
    draggable: "false",
    "aria-current": active ? "page" : null,
  };
  const content = [
    own ? null : glyph(node),
    h("span", { class: "nav-label", dir: "auto" }, node.name),
  ];
  if (node.kind !== "folder") {
    return h("a", { ...props, href: HASHES[node.kind](node.id) }, content);
  }
  const reveal = () =>
    inTree ? s.setExpanded(node.key, !s.isOpen(node)) : s.revealNode(node.key);
  return h(
    inTree ? "span" : "button",
    { ...props, type: inTree ? null : "button", on: { click: reveal } },
    content,
  );
}

function toggleButton(s, row) {
  const { node, expanded } = row;
  return h(
    "button",
    {
      type: "button",
      class: "tree-toggle",
      tabindex: "-1",
      "aria-label": `${expanded ? "Collapse" : "Expand"} ${node.name}`,
      on: { click: () => s.setExpanded(node.key, !expanded) },
    },
    h("span", { class: "tree-toggle-glyph" }, glyph(node)),
    icon(expanded ? "chevronDown" : "chevronRight", {
      size: 14,
      className: "tree-chevron",
    }),
  );
}

function renameField(s, node) {
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    commitRename(s, node, save ? input.value.trim() : null);
  };
  const input = h("input", {
    class: "tree-rename",
    type: "text",
    value: node.name,
    maxlength: 255,
    dir: "auto",
    "aria-label": `Rename ${node.name}`,
    autocomplete: "off",
    on: {
      keydown(event) {
        event.stopPropagation();
        if (event.key === "Enter") finish(true);
        else if (event.key === "Escape") finish(false);
      },
      blur: () => finish(true),
      pointerdown: (event) => event.stopPropagation(),
    },
  });
  return input;
}

/** Whether a menu item can be used (not a heading, separator or disabled). */
const usable = (item) =>
  Boolean(item?.label) && !item.disabled && !item.disabledReason;

function rowActions(s, node) {
  // Only the tab stop's row has its buttons in the tab order (`rove`).
  const attributes = {
    "aria-haspopup": "menu",
    "aria-expanded": "false",
    tabindex: s.tabKey === node.key ? "0" : "-1",
  };
  const plus = plusItems(s, node).some(usable)
    ? iconButton({
        icon: "plus",
        label: `Add to ${node.name}`,
        size: "sm",
        className: "tree-action tree-add",
        attributes,
        dataset: { focusKey: `tree-add:${node.key}` },
        onClick: (event) => openPlusMenu(s, node, event.currentTarget),
      })
    : null;
  const more = iconButton({
    icon: "more",
    label: `${node.name} actions`,
    size: "sm",
    className: "tree-action tree-more",
    attributes,
    dataset: { focusKey: `tree-more:${node.key}` },
    onClick: (event) => openMoreMenu(s, node, event.currentTarget),
  });
  return h("span", { class: "tree-actions" }, plus, more);
}

function dropData(node, expanded) {
  if (node.kind === "board") {
    const allowed = hasRole(node.record.my_access, "editor");
    return { dropBoard: node.id, dropAllowed: String(allowed) };
  }
  return expanded === false ? { dropExpand: node.key } : {};
}

function treeRow(s, row) {
  const { node, level, expanded } = row;
  const active = s.currentKey === node.key;
  const renaming = s.renaming === node.key;
  return h(
    "div",
    {
      class: [
        "tree-row",
        `tree-level-${Math.min(level, 3)}`,
        `tree-row-${node.kind}`,
        active && "active",
      ],
      dataset: { key: node.key, ...dropData(node, expanded) },
    },
    expanded === null ? null : toggleButton(s, row),
    renaming ? renameField(s, node) : nodeLink(s, node),
    renaming ? null : rowActions(s, node),
  );
}

function treeItem(s, row, children) {
  const { node, level, expanded } = row;
  const active = s.currentKey === node.key;
  return h(
    "li",
    {
      role: "treeitem",
      class: ["tree-node", `tree-node-${node.kind}`],
      "aria-level": String(level),
      "aria-setsize": String(row.setSize),
      "aria-posinset": String(row.posInSet),
      "aria-expanded": expanded === null ? null : String(expanded),
      "aria-selected": active ? "true" : "false",
      "aria-labelledby": labelId(node.key),
      tabindex: s.tabKey === node.key ? "0" : "-1",
      dataset: { key: node.key },
    },
    treeRow(s, row),
    children.length > 0
      ? h("ul", { role: "group", class: "tree-group" }, children)
      : null,
  );
}

/** The tree items of `rows` (visible rows, in order) as nested lists. */
function nest(s, rows) {
  let index = 0;
  const take = (level) => {
    const out = [];
    while (index < rows.length && rows[index].level === level) {
      const row = rows[index];
      index += 1;
      const children = row.expanded ? take(level + 1) : [];
      out.push(treeItem(s, row, children));
    }
    return out;
  };
  return take(1);
}

// ------------------------------------------------------------- keyboard

const treeItems = (tree) => [...tree.querySelectorAll("[role=treeitem]")];

/** Focuses the tree item of `key` (when shown); true when it did. */
export function focusTreeItem(s, key) {
  const item = s.container.querySelector(
    `[role=treeitem][data-key="${CSS.escape(key)}"]`,
  );
  item?.focus();
  return Boolean(item);
}

/** Makes `item` the tree's tab stop, with its row's "+" and "…" after it. */
function rove(tree, item) {
  for (const each of treeItems(tree)) {
    each.tabIndex = each === item ? 0 : -1;
  }
  for (const action of tree.querySelectorAll(".tree-action")) {
    const own = action.closest("[role=treeitem]") === item;
    action.tabIndex = own ? 0 : -1;
  }
}

function activate(s, item) {
  const key = item.dataset.key;
  const node = s.byKey.get(key);
  if (node?.kind === "folder") s.setExpanded(key, !s.isOpen(node));
  else item.querySelector(":scope > .tree-row .tree-link")?.click();
}

function horizontal(s, item, key) {
  const expanded = item.getAttribute("aria-expanded");
  const right = key === "ArrowRight";
  if (expanded === (right ? "false" : "true")) {
    s.setExpanded(item.dataset.key, right);
    return;
  }
  if (right && expanded === "true") {
    item.querySelector("[role=treeitem]")?.focus();
  } else if (!right) {
    item.parentElement?.closest("[role=treeitem]")?.focus();
  }
}

function onKeydown(s, event) {
  const tree = event.currentTarget;
  const item = event.target.closest?.("[role=treeitem]");
  if (!item || !ACTION_KEYS.has(event.key) || event.altKey) return;
  if (event.target !== item && !event.target.matches(".tree-link")) return;
  if (event.key === "F10" && !event.shiftKey) return;
  const menuKey = event.key === "ContextMenu" || event.key === "F10";
  event.preventDefault();
  const items = treeItems(tree);
  const index = items.indexOf(item);
  const node = s.byKey.get(item.dataset.key);
  const moves = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0 };
  moves.End = items.length - 1;
  if (Object.hasOwn(moves, event.key)) items[moves[event.key]]?.focus();
  else if (event.key === "Enter") activate(s, item);
  else if (event.key === "F2" && node && canRename(s, node).ok) {
    s.startRename(node.key);
  } else if (menuKey) {
    const more = item.querySelector(":scope > .tree-row .tree-more");
    if (more && node) openMoreMenu(s, node, more);
  } else horizontal(s, item, event.key);
}

/** The tab stop: the focused, else the current, else the first row. */
function tabKey(s) {
  const shown = new Set(s.rows.map((row) => row.key));
  if (shown.has(s.focusKey)) return s.focusKey;
  if (shown.has(s.currentKey)) return s.currentKey;
  return s.rows[0]?.key ?? null;
}

/** The tree element for the sidebar state `s`. */
export function spaceTree(s) {
  s.tabKey = tabKey(s);
  const tree = h(
    "ul",
    {
      role: "tree",
      class: "space-tree",
      "aria-labelledby": "sidebar-spaces-heading",
      on: {
        keydown: (event) => onKeydown(s, event),
        focusin(event) {
          const item = event.target.closest?.("[role=treeitem]");
          if (!item) return;
          s.focusKey = item.dataset.key;
          if (event.target === item) rove(tree, item);
        },
        "tree-expand"(event) {
          const key =
            event.target.closest?.("[data-drop-expand]")?.dataset.dropExpand;
          if (key) s.setExpanded(key, true);
        },
      },
    },
    nest(s, s.rows),
  );
  return tree;
}
