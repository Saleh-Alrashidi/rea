/**
 * The compact status menu (SPEC-6 §1.1, ClickUp style) of List rows, the
 * task view, Kanban cards and My work: a search box over one row per
 * label (a dot in the label color and the label as written, a check on
 * the current one), then "Clear". The Main table keeps its full-bleed
 * label picker (`cells.js`).
 *
 * Keyboard: focus stays in the search box, a combobox over the listbox of
 * rows (`aria-activedescendant`). ↑/↓ move the active row (wrapping),
 * Enter picks it, typing filters the labels (the first match becomes
 * active) and Escape closes the menu (the popover's own rule), returning
 * focus to the control that opened it. The mouse picks a row too.
 * `onChange(index | null)` runs only for a different value.
 */

import { h } from "../../dom.js";
import { icon } from "../components/icon.js";
import { openPopover } from "../components/popover.js";

const CLEAR_KEY = "clear";
let menus = 0;

/**
 * The rows of `column`'s menu for the search `term`: each label whose text
 * contains it (any case), in label order, then "Clear", which always
 * shows. A row is `{ key, index, label, color, current }`; Clear has the
 * index null and no color.
 * @param {object} column a prepared status column (`column.status`)
 * @param {{ value: number | null, term?: string }} options
 */
export function statusMenuRows(column, { value, term = "" }) {
  const folded = term.trim().toLocaleLowerCase();
  const labels = (column.status?.options ?? [])
    .filter((option) => option.label.toLocaleLowerCase().includes(folded))
    .map((option) => ({
      key: String(option.index),
      index: option.index,
      label: option.label,
      color: option.color,
      current: option.index === value,
    }));
  const clear = {
    key: CLEAR_KEY,
    index: null,
    label: "Clear",
    color: null,
    current: false,
  };
  return [...labels, clear];
}

/**
 * The row active when the rows change: the current label while nothing
 * is typed, else the first match, else Clear.
 */
function firstActive(rows, term) {
  const current = rows.find((row) => row.current);
  if (term.trim() === "" && current) return current.key;
  return rows[0].key;
}

function optionElement(menu, row) {
  const element = h(
    "li",
    {
      id: `${menu.listId}-${row.key}`,
      role: "option",
      class: [
        "status-menu-option",
        row.key === CLEAR_KEY && "status-menu-clear",
        row.current && "current",
      ],
      "aria-selected": "false",
      "aria-checked": row.key === CLEAR_KEY ? null : String(row.current),
      on: {
        // Focus stays in the search box.
        mousedown: (event) => event.preventDefault(),
        pointermove: () => menu.activate(row.key),
        click: () => menu.pick(row),
      },
    },
    row.key === CLEAR_KEY
      ? icon("close", { size: 14, className: "status-menu-icon" })
      : h("span", { class: "status-menu-dot", "aria-hidden": "true" }),
    h("span", { class: "status-menu-label", dir: "auto" }, row.label),
    row.current
      ? icon("check", { size: 14, className: "status-menu-check" })
      : null,
  );
  if (row.color) element.style.setProperty("--dot-color", row.color);
  return element;
}

/**
 * Marks the active row (`aria-selected`, the style hook too) and points
 * the search box at it, without rebuilding the rows: a row replaced
 * under the pointer would lose its click.
 */
function markActive(menu) {
  for (const [key, node] of menu.nodes) {
    node.setAttribute("aria-selected", String(key === menu.active));
  }
  const id = `${menu.listId}-${menu.active}`;
  menu.input.setAttribute("aria-activedescendant", id);
  menu.nodes.get(menu.active)?.scrollIntoView?.({ block: "nearest" });
}

/** Shows `menu.rows` in the listbox, with the active one marked. */
function drawRows(menu) {
  const labels = menu.rows.filter((row) => row.key !== CLEAR_KEY);
  menu.empty.hidden = labels.length > 0;
  menu.nodes = new Map(
    menu.rows.map((row) => [row.key, optionElement(menu, row)]),
  );
  menu.list.replaceChildren(...menu.nodes.values());
  markActive(menu);
}

/** Moves the active row by `delta` (wrapping). */
function step(menu, delta) {
  const keys = menu.rows.map((row) => row.key);
  const at = keys.indexOf(menu.active);
  menu.active = keys[(at + delta + keys.length) % keys.length];
  markActive(menu);
}

function onSearchKeydown(menu, event) {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    step(menu, event.key === "ArrowDown" ? 1 : -1);
  } else if (event.key === "Enter") {
    event.preventDefault();
    const row = menu.rows.find((entry) => entry.key === menu.active);
    if (row) menu.pick(row);
  }
}

function searchBox(menu, column) {
  const input = h("input", {
    class: "status-menu-input",
    type: "text",
    role: "combobox",
    placeholder: "Search…",
    autocomplete: "off",
    spellcheck: "false",
    "aria-label": `Search ${column.title} labels`,
    "aria-autocomplete": "list",
    "aria-expanded": "true",
    "aria-controls": menu.listId,
    "data-autofocus": true,
    on: {
      keydown: (event) => onSearchKeydown(menu, event),
      input: (event) => menu.filter(event.currentTarget.value),
    },
  });
  return input;
}

/**
 * Opens the compact status menu of `column` next to `anchor`, focused on
 * its search box with the current label active. Returns the popover, or
 * null when the menu was open from `anchor` (that closes it).
 * @param {{ anchor: HTMLElement, column: object, value: number | null,
 *   onChange(index: number | null): void }} options
 */
export function openStatusMenu({ anchor, column, value, onChange }) {
  menus += 1;
  const menu = {
    listId: `status-menu-${menus}`,
    rows: statusMenuRows(column, { value }),
    active: null,
    nodes: new Map(),
    popover: null,
  };
  menu.active = firstActive(menu.rows, "");
  menu.activate = (key) => {
    if (menu.active === key) return;
    menu.active = key;
    markActive(menu);
  };
  menu.pick = (row) => {
    menu.popover?.close();
    if (row.index !== value) onChange(row.index);
  };
  menu.filter = (term) => {
    menu.rows = statusMenuRows(column, { value, term });
    menu.active = firstActive(menu.rows, term);
    drawRows(menu);
    menu.popover?.reposition();
  };
  menu.input = searchBox(menu, column);
  menu.list = h("ul", {
    id: menu.listId,
    role: "listbox",
    class: "status-menu-list",
    "aria-label": column.title,
  });
  menu.empty = h(
    "p",
    { class: "status-menu-empty", role: "status" },
    "No matching labels",
  );
  drawRows(menu);
  menu.popover = openPopover({
    anchor,
    label: `Choose ${column.title}`,
    className: "status-menu-popover",
    content: h(
      "div",
      { class: "status-menu" },
      h(
        "div",
        { class: "status-menu-search" },
        icon("search", { size: 14 }),
        menu.input,
      ),
      menu.empty,
      menu.list,
    ),
  });
  return menu.popover;
}
