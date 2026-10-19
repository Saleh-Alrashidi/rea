/**
 * A modal panel: a `<dialog>` that fills itself with content (it has no
 * padding) and keeps the route in step with what is shown. Escape (closing
 * an open popover first), a click on its backdrop and the browser's own
 * close dismiss it through `onClose`. Focus returns to the control that
 * opened it, found again by `data-focus-key` since closing usually
 * re-renders the view the opener was in (the task view, SPEC-5 §4.2).
 */

import { clear, h } from "../../dom.js";
import { findByFocusKey } from "./focus.js";
import { closePopover, isPopoverOpen } from "./popover.js";

/** The focus key of the focused element outside `dialog`, or null. */
function openerKey(dialog) {
  const active = globalThis.document.activeElement;
  if (!active || dialog.contains(active)) return null;
  return active.dataset?.focusKey ?? null;
}

/**
 * Focuses the element with `key` once the render that closed the panel has
 * rebuilt the view, unless focus has already moved somewhere else.
 */
function returnFocus(key) {
  if (!key) return;
  globalThis.setTimeout(() => {
    const doc = globalThis.document;
    const active = doc.activeElement;
    if (active && active !== doc.body) return;
    findByFocusKey(doc, key)?.focus({ preventScroll: false });
  }, 0);
}

/**
 * Creates a modal panel `<dialog class={className}>` named `label`.
 *
 * @param {{ className: string, label: string, onClose(): void }} options
 * @returns {{ element: HTMLDialogElement, show(): void, hide(): void,
 *   fill(content: Node, label: string): void }}
 */
export function createModalPanel({ className, label, onClose }) {
  const dialog = h("dialog", { class: className, "aria-label": label });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    if (isPopoverOpen()) closePopover();
    else onClose();
  });
  dialog.addEventListener("click", (event) => {
    // Only the backdrop area targets the dialog itself (it has no padding).
    if (event.target === dialog) onClose();
  });
  let shown = false;
  // The control that opened the panel (a task name, "Open", a kanban
  // title), by focus key: closing re-renders the view, so the element may
  // be gone.
  let returnKey = null;
  dialog.addEventListener("close", () => {
    // The browser may close a modal itself (for example on a repeated
    // Escape); keep the route in step with what is shown. The event is
    // asynchronous, so `hide()` clears `shown` before closing.
    if (!shown) return;
    shown = false;
    onClose();
  });

  return {
    element: dialog,
    /** Opens the panel (idempotent). */
    show() {
      if (!dialog.open) returnKey = openerKey(dialog);
      if (!dialog.isConnected) globalThis.document.body.append(dialog);
      if (!dialog.open) dialog.showModal();
      shown = true;
    },
    /** Closes and detaches the panel; focus returns to its opener. */
    hide() {
      const wasOpen = dialog.open;
      shown = false;
      if (dialog.open) dialog.close();
      dialog.remove();
      if (wasOpen) returnFocus(returnKey);
      returnKey = null;
    },
    /** Replaces the panel's content and accessible name. */
    fill(content, name) {
      dialog.setAttribute("aria-label", name);
      clear(dialog).append(content);
    },
  };
}
