/**
 * A polite live region for short status announcements that have no
 * visible text of their own (where a moved task went, SPEC-6 §1.4). The
 * region is one visually hidden element at the end of the body, created
 * on first use, so it survives the rebuilds of the views that announce.
 */

import { h } from "../../dom.js";

let region = null;

function liveRegion() {
  const doc = globalThis.document;
  if (region?.isConnected) return region;
  region = h("div", {
    class: "visually-hidden",
    role: "status",
    "aria-live": "polite",
    "aria-atomic": "true",
    id: "announcer",
  });
  doc.body.append(region);
  return region;
}

/**
 * Announces `message`. The same text twice in a row is announced again:
 * the region is emptied first and filled on the next frame.
 */
export function announce(message) {
  const element = liveRegion();
  element.textContent = "";
  globalThis.setTimeout(() => {
    element.textContent = String(message);
  }, 50);
}
