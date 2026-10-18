/**
 * Anchored popovers. Only one popover is open at a time; it closes on
 * Escape, on a pointer press outside it, when Tab leaves it (past its first
 * or last control, or any Tab in a `menu`), on window resize and on
 * navigation, and returns focus to its anchor (or to the element that
 * replaced the anchor after a re-render, found by `data-focus-key`).
 * In the tab order it sits right after its anchor. `update()` keeps focus
 * on the control with the same `data-focus-key`, else the first control.
 * `reposition()` places it again after its content changed size (it stays
 * on the same side of the anchor while that side fits).
 *
 * ```js
 * const popover = openPopover({ anchor, label: "Choose status",
 *   content: () => list, placement: "bottom-end" });
 * popover.update();   // re-runs content()
 * popover.reposition(); // after the content changed size
 * popover.close();
 * ```
 */

import { h } from "../../dom.js";
import { findByFocusKey } from "./focus.js";

const MARGIN = 8;
const GAP = 4;
const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

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

/**
 * Places `element` below `anchor`, or above it when only that fits, and
 * returns the side used. `side` (from the last placement) is kept while it
 * still fits, so content that shrinks or grows (a filtered list) stays
 * against its anchor instead of jumping across it.
 */
function position(element, anchor, { placement, side = null }) {
  const doc = globalThis.document;
  const viewWidth = doc.documentElement.clientWidth;
  const viewHeight = doc.documentElement.clientHeight;
  const box = anchor.getBoundingClientRect();
  const width = element.offsetWidth;
  const height = element.offsetHeight;
  const below = box.bottom + GAP;
  const above = box.top - height - GAP;
  const fitsBelow = below + height <= viewHeight - MARGIN;
  const fitsAbove = above > MARGIN;
  let chosen = side;
  if ((chosen === "above" && !fitsAbove) || (chosen === "below" && !fitsBelow))
    chosen = null;
  chosen ??= !fitsBelow && fitsAbove ? "above" : "below";
  const top = chosen === "above" ? above : below;
  const preferred = placement === "bottom-end" ? box.right - width : box.left;
  const left = Math.min(
    Math.max(MARGIN, preferred),
    Math.max(MARGIN, viewWidth - width - MARGIN),
  );
  element.style.top = `${Math.max(MARGIN, top)}px`;
  element.style.left = `${left}px`;
  return chosen;
}

function firstFocusable(element) {
  return (
    element.querySelector("[data-autofocus]") ??
    element.querySelector(FOCUSABLE)
  );
}

const focusables = (element) =>
  [...element.querySelectorAll(FOCUSABLE)].filter((node) => !node.inert);

/** Re-renders `element`, keeping focus inside it when it was there. */
function rerender(element, render) {
  const doc = globalThis.document;
  const active = doc.activeElement;
  const hadFocus = element.contains(active);
  const key = hadFocus ? active.dataset?.focusKey : undefined;
  element.replaceChildren(render());
  if (!hadFocus) return;
  const same = key ? findByFocusKey(element, key) : null;
  const usable = same && !same.disabled ? same : null;
  (usable ?? focusables(element)[0] ?? element).focus();
}

/**
 * Whether Tab leaves the popover: always in a menu (arrow keys move inside
 * it), otherwise past the first (Shift+Tab) or last control.
 */
function tabLeaves(element, role, event) {
  if (role === "menu") return true;
  const items = focusables(element);
  const active = globalThis.document.activeElement;
  if (items.length === 0 || active === element) return true;
  return event.shiftKey ? active === items[0] : active === items.at(-1);
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
 * assistive technology; `role` defaults to "dialog". `placement` aligns it
 * to the anchor's start (default) or end edge.
 *
 * Opening it again from the same anchor closes it instead (and returns null).
 *
 * @param {{ anchor: HTMLElement, content: Node | (() => Node), label: string,
 *   role?: string, placement?: "bottom-start" | "bottom-end",
 *   className?: string, onClose?: () => void }} options
 * @returns {{ element: HTMLElement, anchor: HTMLElement, close(): void,
 *   update(): void, reposition(): void } | null}
 */
export function openPopover(options) {
  const {
    anchor,
    content,
    label,
    role = "dialog",
    placement,
    onClose,
  } = options;
  if (current?.anchor === anchor) {
    current.close();
    return null;
  }
  closePopover();
  const doc = globalThis.document;
  const render = typeof content === "function" ? content : () => content;
  const element = h("div", {
    class: ["popover", options.className],
    role,
    "aria-label": label,
    tabindex: "-1",
  });
  element.append(render());
  // Inside a modal <dialog>, the rest of the page is inert.
  const host = anchor.closest("dialog[open]") ?? doc.body;
  host.append(element);
  let side = position(element, anchor, { placement });
  const focusKey = anchor.dataset?.focusKey;
  anchor.setAttribute("aria-expanded", "true");

  function onKeydown(event) {
    if (event.key === "Tab") {
      if (!element.contains(doc.activeElement)) return;
      if (!tabLeaves(element, role, event)) return;
      // Closing focuses the anchor; Tab then moves on from there, and
      // Shift+Tab stops on the anchor itself.
      handle.close();
      if (event.shiftKey) event.preventDefault();
      return;
    }
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
      rerender(element, render);
      side = position(element, anchor, { placement, side });
    },
    reposition() {
      if (current === handle)
        side = position(element, anchor, { placement, side });
    },
    close() {
      if (current !== handle) return;
      current = null;
      element.remove();
      anchor.setAttribute("aria-expanded", "false");
      doc.removeEventListener("keydown", onKeydown, true);
      doc.removeEventListener("pointerdown", onPointerDown, true);
      globalThis.removeEventListener("resize", onResize);
      globalThis.removeEventListener("hashchange", onResize);
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
  globalThis.addEventListener("hashchange", onResize);
  (firstFocusable(element) ?? element).focus();
  return handle;
}
