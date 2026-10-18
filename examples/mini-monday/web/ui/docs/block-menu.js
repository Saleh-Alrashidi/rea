/**
 * Block menus: the "/" menu that turns an empty block into another type,
 * and the side handle's menu (move up/down, turn into, delete).
 *
 * The "/" menu is a combobox: typing filters the block types
 * (`matchBlockTypes`), arrow keys move the active option
 * (`aria-activedescendant`, focus stays in the filter), Enter or a click
 * picks it. Escape, Tab or a click outside close it and give the block
 * back what was typed ("/" and the filter) with the caret after it (Tab
 * stays in the block rather than moving on); Backspace in an empty filter
 * closes it without the "/". A typed shortcut ("#", "1.", ">") finds its
 * type first, a status line announces how many types match, and the menu
 * stays against its block as the list shrinks.
 *
 * The side handle's menu is a `components/menu.js` menu, so it shares its
 * keyboard navigation (arrows, Home/End, typeahead) and closes on Escape.
 */

import { h } from "../../dom.js";
import { icon } from "../components/icon.js";
import { openMenu } from "../components/menu.js";
import {
  closePopover,
  onPopoverClose,
  openPopover,
} from "../components/popover.js";
import { BLOCK_TYPES, matchBlockTypes } from "./blocks.js";

/** Longest filter the "/" menu accepts (block type names are short). */
const MAX_FILTER = 40;
let nextMenuId = 0;

/** The glyph tile, label and shortcut of a block type row. */
function typeParts(entry) {
  return [
    h(
      "span",
      { class: "block-type-glyph", "aria-hidden": "true" },
      entry.glyph,
    ),
    h(
      "span",
      { class: "menu-text" },
      h("span", { class: "menu-label" }, entry.label),
    ),
    entry.shortcut
      ? h(
          "span",
          { class: "kbd block-type-shortcut", "aria-hidden": "true" },
          entry.shortcut,
        )
      : null,
  ];
}

/** A row of the side handle's "Turn into" list. */
function typeItem(entry, { current, onSelect }) {
  const isCurrent = entry.type === current;
  return h(
    "button",
    {
      type: "button",
      class: ["menu-item", "block-type-item", isCurrent && "is-current"],
      role: "menuitem",
      tabindex: "-1",
      "aria-current": isCurrent ? "true" : null,
      dataset: { blockType: entry.type },
      on: {
        click() {
          closePopover();
          onSelect(entry.type);
        },
      },
    },
    ...typeParts(entry),
    isCurrent ? icon("check", { className: "menu-check" }) : null,
  );
}

// ------------------------------------------------------------ "/" menu

function renderOptions(menu) {
  menu.active = Math.min(menu.active, Math.max(0, menu.matches.length - 1));
  menu.list.replaceChildren(
    ...menu.matches.map((entry, index) =>
      h(
        "div",
        {
          id: `${menu.id}-${entry.type}`,
          role: "option",
          class: [
            "menu-item",
            "block-type-item",
            "slash-option",
            index === menu.active && "active",
            entry.type === menu.current && "is-current",
          ],
          "aria-selected": index === menu.active ? "true" : "false",
          dataset: { blockType: entry.type },
          on: {
            // Keep focus in the filter while picking with the pointer.
            mousedown: (event) => event.preventDefault(),
            click: () => pick(menu, entry),
          },
        },
        ...typeParts(entry),
      ),
    ),
  );
  const count = menu.matches.length;
  // One polite live region: the count as the filter changes (for screen
  // readers only), or "No blocks match" for everyone.
  menu.status.className = count === 0 ? "slash-empty" : "visually-hidden";
  menu.status.textContent =
    count === 0
      ? "No blocks match"
      : `${count} block ${count === 1 ? "type" : "types"}`;
  const active = menu.matches[menu.active];
  if (active) {
    menu.input.setAttribute(
      "aria-activedescendant",
      `${menu.id}-${active.type}`,
    );
  } else {
    menu.input.removeAttribute("aria-activedescendant");
  }
  menu.list
    .querySelector(".slash-option.active")
    ?.scrollIntoView?.({ block: "nearest" });
}

function pick(menu, entry) {
  menu.outcome = { type: entry.type };
  closePopover();
}

function onFilterKey(menu, event) {
  const count = menu.matches.length;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (count === 0) return;
    const step = event.key === "ArrowDown" ? 1 : -1;
    menu.active = (menu.active + step + count) % count;
    renderOptions(menu);
  } else if (event.key === "Enter") {
    event.preventDefault();
    const entry = menu.matches[menu.active];
    if (entry) pick(menu, entry);
  } else if (event.key === "Tab") {
    // The popover closes on Tab and focuses the block; moving on from
    // there would drop the caret that onDismiss puts after the text.
    event.preventDefault();
    closePopover();
  } else if (event.key === "Backspace" && menu.input.value === "") {
    // Deleting past the filter deletes the "/" too.
    event.preventDefault();
    menu.outcome = { text: null };
    closePopover();
  }
}

function slashContent(menu) {
  menu.input = h("input", {
    class: "slash-input",
    type: "text",
    role: "combobox",
    "aria-label": "Filter block types",
    "aria-expanded": "true",
    "aria-controls": `${menu.id}-list`,
    "aria-autocomplete": "list",
    autocomplete: "off",
    spellcheck: "false",
    maxlength: String(MAX_FILTER),
    placeholder: "Filter blocks",
    "data-autofocus": true,
    on: {
      input(event) {
        menu.matches = matchBlockTypes(event.currentTarget.value);
        menu.active = 0;
        renderOptions(menu);
        menu.popover?.reposition();
      },
      keydown: (event) => onFilterKey(menu, event),
    },
  });
  menu.list = h("div", {
    id: `${menu.id}-list`,
    role: "listbox",
    class: "slash-list",
    "aria-label": "Block types",
    // Options are reached through aria-activedescendant; a scrollable list
    // would otherwise be a Tab stop of its own in Chromium.
    tabindex: "-1",
  });
  menu.status = h("p", { role: "status", "aria-live": "polite" });
  renderOptions(menu);
  return h(
    "div",
    { class: "slash-menu-body" },
    h(
      "div",
      { class: "slash-filter" },
      h("span", { class: "slash-prefix", "aria-hidden": "true" }, "/"),
      menu.input,
    ),
    menu.list,
    menu.status,
  );
}

/**
 * Opens the "/" menu at `anchor`. After it closes, `onSelect(type)` runs
 * for a picked type, else `onDismiss(text)` with the filter text to give
 * back to the block ("" when nothing was typed), or null when Backspace
 * removed the "/" as well.
 * @param {{ anchor: HTMLElement, current: string,
 *   onSelect(type: string): void, onDismiss(text: string | null): void }} options
 */
export function openSlashMenu({ anchor, current, onSelect, onDismiss }) {
  const menu = {
    id: `slash-menu-${(nextMenuId += 1)}`,
    current,
    matches: matchBlockTypes(""),
    active: 0,
    outcome: null,
  };
  const content = slashContent(menu);
  const index = menu.matches.findIndex((entry) => entry.type === current);
  menu.active = Math.max(0, index);
  renderOptions(menu);
  menu.popover = openPopover({
    anchor,
    label: "Turn into",
    className: "block-menu slash-menu",
    content,
    onClose() {
      const outcome = menu.outcome ?? { text: menu.input.value };
      if (outcome.type) onSelect(outcome.type);
      else onDismiss?.(outcome.text);
    },
  });
  if (!menu.popover) onDismiss?.("");
}

// --------------------------------------------------- side handle menu

const typeItems = (options) =>
  BLOCK_TYPES.map((entry) => typeItem(entry, options));

/**
 * Opens the side handle's menu for a block. Focus starts on "Move up";
 * `onClose()` runs after the menu closes (and after any action).
 * @param {{ anchor: HTMLElement, current: string, canMoveUp: boolean,
 *   canMoveDown: boolean, onMove(delta: number): void,
 *   onType(type: string): void, onDelete(): void, onClose?(): void }} options
 */
export function openBlockActions(options) {
  const popover = openMenu({
    anchor: options.anchor,
    label: "Block actions",
    className: "block-menu",
    items: [
      {
        label: "Move up",
        icon: "chevronUp",
        hint: "Alt+Shift+↑",
        disabled: !options.canMoveUp,
        onSelect: () => options.onMove(-1),
      },
      {
        label: "Move down",
        icon: "chevronDown",
        hint: "Alt+Shift+↓",
        disabled: !options.canMoveDown,
        onSelect: () => options.onMove(1),
      },
      { type: "separator" },
      { type: "heading", label: "Turn into" },
      ...typeItems({ current: options.current, onSelect: options.onType }),
      { type: "separator" },
      {
        label: "Delete block",
        icon: "trash",
        danger: true,
        onSelect: options.onDelete,
      },
    ],
  });
  if (!popover) return;
  const off = onPopoverClose(() => {
    off();
    options.onClose?.();
  });
}
