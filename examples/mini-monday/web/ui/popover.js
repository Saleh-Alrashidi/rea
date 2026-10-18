/**
 * Anchored popovers and menus. Only one popover is open at a time; it closes
 * on Escape, on a pointer press outside it and on window resize, and returns
 * focus to its anchor (or to the element that replaced the anchor).
 */

import { h } from "../dom.js";

const MARGIN = 8;
const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

let current = null;
const closeListeners = new Set();

/** Returns true while a popover is open. */
export function isPopoverOpen() {
  return current !== null;
}

/** Registers `listener()` to run after any popover closes; returns unsubscribe. */
export function onPopoverClose(listener) {
  closeListeners.add(listener);
  return () => closeListeners.delete(listener);
}

/** Closes the open popover, if any. */
export function closePopover() {
  current?.close();
}

function position(element, anchor) {
  const doc = globalThis.document;
  const viewWidth = doc.documentElement.clientWidth;
  const viewHeight = doc.documentElement.clientHeight;
  const box = anchor.getBoundingClientRect();
  const width = element.offsetWidth;
  const height = element.offsetHeight;
  let top = box.bottom + 4;
  if (top + height > viewHeight - MARGIN && box.top - height - 4 > MARGIN) {
    top = box.top - height - 4;
  }
  const left = Math.min(
    Math.max(MARGIN, box.left),
    Math.max(MARGIN, viewWidth - width - MARGIN),
  );
  element.style.top = `${Math.max(MARGIN, top)}px`;
  element.style.left = `${left}px`;
}

function firstFocusable(element) {
  return (
    element.querySelector("[data-autofocus]") ??
    element.querySelector(FOCUSABLE)
  );
}

function restoreFocus(anchor, focusKey) {
  if (anchor.isConnected) {
    anchor.focus();
    return;
  }
  // The anchor was re-rendered; focus its replacement when there is one.
  if (!focusKey) return;
  for (const node of globalThis.document.querySelectorAll("[data-focus-key]")) {
    if (node.dataset.focusKey === focusKey) {
      node.focus();
      return;
    }
  }
}

/**
 * Opens a popover next to `anchor` with `content` (a node or a function
 * returning a node; `update()` re-runs it). `label` names the popover for
 * assistive technology; `role` defaults to "dialog".
 *
 * Opening it again from the same anchor closes it instead (and returns null).
 *
 * @returns {{ element: HTMLElement, close(): void, update(): void } | null}
 */
export function openPopover({
  anchor,
  content,
  label,
  role = "dialog",
  onClose,
}) {
  if (current?.anchor === anchor) {
    current.close();
    return null;
  }
  closePopover();
  const doc = globalThis.document;
  const render = typeof content === "function" ? content : () => content;
  const element = h("div", {
    class: "popover",
    role,
    "aria-label": label,
    tabindex: "-1",
  });
  element.append(render());
  // Inside a modal <dialog>, the rest of the page is inert.
  const host = anchor.closest("dialog[open]") ?? doc.body;
  host.append(element);
  position(element, anchor);
  const focusKey = anchor.dataset?.focusKey;
  anchor.setAttribute("aria-expanded", "true");

  function onKeydown(event) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    handle.close();
  }
  function onPointerDown(event) {
    if (!element.contains(event.target) && !anchor.contains(event.target)) {
      handle.close();
    }
  }
  function onResize() {
    handle.close();
  }

  const handle = {
    element,
    anchor,
    update() {
      element.replaceChildren(render());
      position(element, anchor);
    },
    close() {
      if (current !== handle) return;
      current = null;
      element.remove();
      anchor.setAttribute("aria-expanded", "false");
      doc.removeEventListener("keydown", onKeydown, true);
      doc.removeEventListener("pointerdown", onPointerDown, true);
      globalThis.removeEventListener("resize", onResize);
      if (
        element.contains(doc.activeElement) ||
        doc.activeElement === doc.body
      ) {
        restoreFocus(anchor, focusKey);
      }
      onClose?.();
      for (const listener of closeListeners) listener();
    },
  };
  current = handle;
  doc.addEventListener("keydown", onKeydown, true);
  doc.addEventListener("pointerdown", onPointerDown, true);
  globalThis.addEventListener("resize", onResize);
  (firstFocusable(element) ?? element).focus();
  return handle;
}

function moveFocus(menu, step) {
  const items = [...menu.querySelectorAll('[role="menuitem"]')];
  if (items.length === 0) return;
  const index = items.indexOf(globalThis.document.activeElement);
  const next = (index + step + items.length) % items.length;
  items[next].focus();
}

/**
 * Opens a menu of `items` (`{ label, onSelect, danger?, icon? }` or a node to
 * insert as-is, such as a color row) next to `anchor`. Arrow keys move
 * between items; selecting an item closes the menu first.
 */
export function openMenu({ anchor, label, items }) {
  const content = () =>
    h(
      "div",
      {
        class: "menu",
        on: {
          keydown(event) {
            if (event.key === "ArrowDown") moveFocus(event.currentTarget, 1);
            else if (event.key === "ArrowUp")
              moveFocus(event.currentTarget, -1);
            else return;
            event.preventDefault();
          },
        },
      },
      items.map((item) =>
        item.nodeType
          ? item
          : h(
              "button",
              {
                type: "button",
                role: "menuitem",
                class: ["menu-item", item.danger && "danger"],
                on: {
                  click() {
                    popover.close();
                    item.onSelect();
                  },
                },
              },
              item.icon ?? null,
              h("span", null, item.label),
            ),
      ),
    );
  const popover = openPopover({ anchor, content, label, role: "menu" });
  return popover;
}
