/**
 * Menus: a popover with `role="menu"` and keyboard navigation (arrow keys,
 * Home/End, typeahead by first letter). Selecting an item closes the menu
 * first, then runs `onSelect`.
 *
 * Items:
 *   { label, onSelect, icon?, hint?, badge?: Node, danger?, checked?,
 *     disabled?, disabledReason?, href? }    an action (href navigates)
 *   { type: "separator" }
 *   { type: "heading", label }
 *   a Node                                    inserted as-is (e.g. a color row)
 *   null / false                              skipped (for conditional items)
 *
 * ```js
 * openMenu({ anchor: button, label: "Board actions", items: [
 *   { label: "Rename", icon: "edit", onSelect: rename },
 *   { type: "separator" },
 *   { label: "Delete board", icon: "trash", danger: true, onSelect: remove },
 * ]});
 * menuButton({ icon: "more", label: "Board actions", items: () => [...] })
 * ```
 */

import { h } from "../../dom.js";
import { iconButton } from "./button.js";
import { icon as iconElement } from "./icon.js";
import { openPopover } from "./popover.js";

const ITEM_SELECTOR = '[role^="menuitem"]:not([aria-disabled="true"])';

function moveFocus(menu, target) {
  const items = [...menu.querySelectorAll(ITEM_SELECTOR)];
  if (items.length === 0) return;
  const index = items.indexOf(globalThis.document.activeElement);
  let next;
  if (target === "first") next = 0;
  else if (target === "last") next = items.length - 1;
  else next = (index + target + items.length) % items.length;
  items[next].focus();
}

function typeahead(menu, key) {
  const letter = key.toLowerCase();
  const items = [...menu.querySelectorAll(ITEM_SELECTOR)];
  const index = items.indexOf(globalThis.document.activeElement);
  const ordered = [...items.slice(index + 1), ...items.slice(0, index + 1)];
  const match = ordered.find((item) =>
    item.textContent.trim().toLowerCase().startsWith(letter),
  );
  match?.focus();
}

function onMenuKeydown(event) {
  const menu = event.currentTarget;
  const keys = { ArrowDown: 1, ArrowUp: -1, Home: "first", End: "last" };
  if (Object.hasOwn(keys, event.key)) {
    event.preventDefault();
    moveFocus(menu, keys[event.key]);
  } else if (event.key.length === 1 && /\S/.test(event.key)) {
    typeahead(menu, event.key);
  }
}

function itemRole(item) {
  return item.checked === undefined ? "menuitem" : "menuitemradio";
}

function actionItem(item, close) {
  const disabled = Boolean(item.disabled || item.disabledReason);
  const tag = item.href && !disabled ? "a" : "button";
  return h(
    tag,
    {
      type: tag === "button" ? "button" : null,
      href: tag === "a" ? item.href : null,
      role: itemRole(item),
      class: ["menu-item", item.danger && "danger"],
      tabindex: "-1",
      "aria-checked":
        item.checked === undefined ? null : item.checked ? "true" : "false",
      "aria-disabled": disabled ? "true" : null,
      title: item.disabledReason ?? null,
      on: {
        click(event) {
          if (disabled) {
            event.preventDefault();
            return;
          }
          close();
          item.onSelect?.(event);
        },
      },
    },
    item.icon
      ? iconElement(item.icon)
      : h("span", { class: "menu-icon-space", "aria-hidden": "true" }),
    h(
      "span",
      { class: "menu-text" },
      h("span", { class: "menu-label" }, item.label),
      item.hint ? h("span", { class: "menu-hint" }, item.hint) : null,
    ),
    item.badge ?? null,
    item.checked ? iconElement("check", { className: "menu-check" }) : null,
  );
}

function menuEntry(item, close) {
  if (!item) return null;
  if (item.nodeType) return item;
  if (item.type === "separator") {
    return h("div", { class: "menu-separator", role: "separator" });
  }
  if (item.type === "heading") {
    return h(
      "div",
      { class: "menu-heading", role: "presentation" },
      item.label,
    );
  }
  return actionItem(item, close);
}

/**
 * Opens a menu of `items` next to `anchor`; focus moves to the first item
 * (or the checked one). Returns the popover handle, or null when the same
 * anchor's menu was open (the second click closes it).
 *
 * @param {{ anchor: HTMLElement, label: string, items: unknown[],
 *   placement?: "bottom-start" | "bottom-end", className?: string }} options
 */
export function openMenu({ anchor, label, items, placement, className }) {
  let popover = null;
  const close = () => popover?.close();
  const content = () =>
    h(
      "div",
      { class: "menu", on: { keydown: onMenuKeydown } },
      items.map((item) => menuEntry(item, close)),
    );
  popover = openPopover({
    anchor,
    content,
    label,
    role: "menu",
    placement,
    className: ["popover-menu", className].filter(Boolean).join(" "),
  });
  if (popover) {
    const checked = popover.element.querySelector('[aria-checked="true"]');
    const first = popover.element.querySelector(ITEM_SELECTOR);
    (checked ?? first)?.focus();
  }
  return popover;
}

/**
 * An icon button that opens a menu. `items` may be a function, evaluated on
 * every opening so the menu reflects current state.
 *
 * @param {{ icon?: string, label: string, items: unknown[] | (() => unknown[]),
 *   placement?: "bottom-start" | "bottom-end", size?: "sm" | "md",
 *   className?: string, dataset?: object }} options
 */
export function menuButton(options) {
  const { label, items, placement = "bottom-end" } = options;
  const trigger = iconButton({
    icon: options.icon ?? "more",
    label,
    size: options.size,
    className: options.className,
    dataset: options.dataset,
    attributes: { "aria-haspopup": "menu", "aria-expanded": "false" },
    onClick: () =>
      openMenu({
        anchor: trigger,
        label,
        placement,
        items: typeof items === "function" ? items() : items,
      }),
  });
  return trigger;
}
