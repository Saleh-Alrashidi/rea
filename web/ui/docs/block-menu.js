/**
 * Block menus: the "/" menu that turns an empty block into another type,
 * and the side handle's menu (move up/down, turn into, delete). Both are
 * `components/menu.js` menus, so they share its keyboard navigation
 * (arrows, Home/End, typeahead) and close on Escape.
 */

import { h } from "../../dom.js";
import { icon } from "../components/icon.js";
import { openMenu } from "../components/menu.js";
import { closePopover, onPopoverClose } from "../components/popover.js";
import { BLOCK_TYPES } from "./blocks.js";

/** A menu row for one block type: a glyph tile, the label and its shortcut. */
function typeItem(entry, { current, onSelect, radio, onPick }) {
  const isCurrent = entry.type === current;
  return h(
    "button",
    {
      type: "button",
      class: ["menu-item", "block-type-item", isCurrent && "is-current"],
      role: radio ? "menuitemradio" : "menuitem",
      tabindex: "-1",
      "aria-checked": radio ? String(isCurrent) : null,
      "aria-current": !radio && isCurrent ? "true" : null,
      dataset: { blockType: entry.type },
      on: {
        click() {
          // Close listeners run before onSelect, so mark the choice first.
          onPick?.();
          closePopover();
          onSelect(entry.type);
        },
      },
    },
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
    !radio && isCurrent ? icon("check", { className: "menu-check" }) : null,
  );
}

const typeItems = (options) =>
  BLOCK_TYPES.map((entry) => typeItem(entry, options));

/**
 * Opens the "/" menu at `anchor`. `onSelect(type)` runs after the menu
 * closes; `onDismiss()` runs when it closes without a choice.
 */
export function openSlashMenu({ anchor, current, onSelect, onDismiss }) {
  let chosen = false;
  const popover = openMenu({
    anchor,
    label: "Turn into",
    className: "block-menu",
    items: [
      { type: "heading", label: "Basic blocks" },
      ...typeItems({
        current,
        radio: true,
        onPick: () => (chosen = true),
        onSelect,
      }),
    ],
  });
  if (!popover) return;
  const off = onPopoverClose(() => {
    off();
    if (!chosen) onDismiss?.();
  });
}

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
      ...typeItems({
        current: options.current,
        radio: false,
        onSelect: options.onType,
      }),
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
