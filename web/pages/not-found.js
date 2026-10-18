/**
 * Not-found page: unknown routes, and the view pages show for records that
 * do not exist or that the user cannot access (both read the same, so a
 * page never reveals that an inaccessible record exists).
 */

import { h } from "../dom.js";
import { homeHash } from "../router.js";
import { emptyState } from "../ui/components/empty-state.js";
import { setDocumentTitle } from "../ui/components/page-header.js";

/**
 * The not-found view. `what` names the record ("board", "doc", …) or is
 * omitted for unknown pages.
 * @param {{ what?: string }} [options]
 * @returns {HTMLElement}
 */
export function notFoundView({ what } = {}) {
  return h(
    "div",
    { class: "page-container not-found" },
    emptyState({
      icon: "search",
      headingLevel: 1,
      title: what ? `This ${what} isn’t available` : "Page not found",
      text: what
        ? `It may have been deleted, or you don’t have access to it.`
        : "The link may be broken, or the page may have moved.",
      action: { label: "Go to Home", icon: "home", href: homeHash() },
      secondaryAction: {
        label: "Go back",
        onClick: () => globalThis.history.back(),
      },
    }),
  );
}

/** Page contract. */
export async function mount(container) {
  setDocumentTitle("Not found");
  container.append(notFoundView());
}
