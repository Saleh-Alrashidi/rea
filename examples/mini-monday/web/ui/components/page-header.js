/**
 * Page header: optional eyebrow and icon, the page title (the page's only
 * `<h1>`), a subtitle, badges and right-aligned actions. Stacks on narrow
 * screens. `setDocumentTitle` keeps the browser tab title consistent.
 *
 * ```js
 * pageHeader({ title: "My work", icon: "myWork",
 *   subtitle: "Items assigned to you", actions: [button(...)] })
 * setDocumentTitle("My work");          // "My work · Worklane"
 * ```
 */

import { h } from "../../dom.js";
import { icon as iconElement } from "./icon.js";

const PRODUCT = "Worklane";

/** Sets the tab title to "<title> · Worklane" (or "Worklane"). */
export function setDocumentTitle(title) {
  globalThis.document.title = title ? `${title} · ${PRODUCT}` : PRODUCT;
}

/**
 * @param {{ title: string | Node, eyebrow?: string, icon?: string,
 *   iconColor?: string, subtitle?: string | Node, badges?: Node[],
 *   actions?: Node[], className?: string }} options
 * @returns {HTMLElement}
 */
export function pageHeader(options) {
  const { title, eyebrow, subtitle, badges = [], actions = [] } = options;
  let mark = null;
  if (options.icon) {
    mark = h(
      "span",
      { class: "page-icon" },
      iconElement(options.icon, { size: 20 }),
    );
    if (options.iconColor)
      mark.style.setProperty("--page-icon-color", options.iconColor);
  }
  return h(
    "header",
    { class: ["page-header", options.className] },
    h(
      "div",
      { class: "page-heading" },
      mark,
      h(
        "div",
        { class: "page-heading-text" },
        eyebrow ? h("p", { class: "page-eyebrow" }, eyebrow) : null,
        h(
          "div",
          { class: "page-title-row" },
          h("h1", { class: "page-title" }, title),
          badges.filter(Boolean),
        ),
        subtitle ? h("p", { class: "page-subtitle" }, subtitle) : null,
      ),
    ),
    actions.filter(Boolean).length > 0
      ? h("div", { class: "page-actions" }, actions.filter(Boolean))
      : null,
  );
}
