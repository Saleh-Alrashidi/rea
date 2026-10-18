/**
 * Region rendering for the board page. Each region (header, view, card) is
 * rebuilt from state with focus and unsaved text carried over. A region is
 * deferred while a popover is open or while an editor without a focus key
 * has focus, and rendered by `flushPending()` afterwards.
 */

import {
  RENDERING,
  findByFocusKey,
  restoreFocus,
  snapshotFocus,
} from "../components/focus.js";
import { isPopoverOpen } from "../components/popover.js";

const FOCUS_TTL_MS = 5000;

/**
 * @param {Record<string, { element(): HTMLElement, draw(): void }>} regions
 * @returns {{ render(parts?: string[]): void, flushPending(): void,
 *   focusAfterRender(focusKey: string): void }}
 */
export function createRegions(regions) {
  const pending = new Set();
  const requested = new Set();
  let depth = 0;
  let pendingFocus = null;

  function applyPendingFocus(root) {
    if (!pendingFocus) return;
    if (Date.now() > pendingFocus.until) {
      pendingFocus = null;
      return;
    }
    const target = findByFocusKey(root, pendingFocus.key);
    if (!target) return;
    pendingFocus = null;
    target.focus();
    target.select?.();
  }

  function renderRegion(part) {
    const region = regions[part];
    const element = region.element();
    const snapshot = snapshotFocus(element);
    if (snapshot?.blocked || isPopoverOpen()) {
      pending.add(part);
      return;
    }
    pending.delete(part);
    // Editors ignore the blur caused by their own removal (see RENDERING).
    element.setAttribute(RENDERING, "");
    try {
      region.draw();
    } finally {
      element.removeAttribute(RENDERING);
    }
    restoreFocus(element, snapshot);
    applyPendingFocus(element);
  }

  function render(parts = Object.keys(regions)) {
    // A handler that runs while a region is rebuilt (for example a blur)
    // must not rebuild regions re-entrantly; queue it for afterwards.
    if (depth > 0) {
      for (const part of parts) requested.add(part);
      return;
    }
    depth += 1;
    try {
      for (const part of parts) renderRegion(part);
    } finally {
      depth -= 1;
    }
    if (requested.size > 0) {
      const again = [...requested];
      requested.clear();
      render(again);
    }
  }

  return {
    render,
    flushPending() {
      if (pending.size > 0) render([...pending]);
    },
    /** Focuses the element with `focusKey` once a render produces it. */
    focusAfterRender(focusKey) {
      pendingFocus = { key: focusKey, until: Date.now() + FOCUS_TTL_MS };
    },
  };
}
