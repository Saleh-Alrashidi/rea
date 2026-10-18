/**
 * Skeleton loaders: shimmering placeholders shown while data loads. Each
 * group is one `role="status"` region labelled "Loading…" so assistive
 * technology announces it once, not per bar.
 *
 * ```js
 * skeletonBlock({ label: "Loading boards", children: [
 *   skeletonLine({ width: "40%" }), skeletonLine() ] })
 * skeletonList({ rows: 5 })
 * skeletonCards({ count: 6 })
 * skeletonPage()          // page header + cards, used by the router
 * ```
 */

import { h } from "../../dom.js";

/**
 * One bar. `width` is a CSS length; `variant` "title" is taller.
 * @param {{ width?: string, variant?: "text" | "title" | "avatar" | "pill" }} [options]
 */
export function skeletonLine({ width, variant = "text" } = {}) {
  const element = h("span", {
    class: ["skeleton", `skeleton-${variant}`],
    "aria-hidden": "true",
  });
  if (width) element.style.width = width;
  return element;
}

/**
 * A loading region around `children`.
 * @param {{ label?: string, children: Node[], className?: string }} options
 */
export function skeletonBlock({ label = "Loading…", children, className }) {
  return h(
    "div",
    {
      class: ["skeleton-block", className],
      role: "status",
      "aria-busy": "true",
      "aria-label": label,
    },
    children,
  );
}

/** Rows of avatar + two lines (lists, tables, notifications). */
export function skeletonList({ rows = 4, label } = {}) {
  const widths = ["62%", "48%", "71%", "55%", "66%", "44%"];
  return skeletonBlock({
    label,
    className: "skeleton-list",
    children: Array.from({ length: rows }, (_, index) =>
      h(
        "div",
        { class: "skeleton-row" },
        skeletonLine({ variant: "avatar" }),
        h(
          "div",
          { class: "skeleton-stack" },
          skeletonLine({ width: widths[index % widths.length] }),
          skeletonLine({ width: "30%" }),
        ),
      ),
    ),
  });
}

/** A grid of card placeholders. */
export function skeletonCards({ count = 6, label } = {}) {
  return skeletonBlock({
    label,
    className: "skeleton-cards",
    children: Array.from({ length: count }, () =>
      h(
        "div",
        { class: "skeleton-card" },
        skeletonLine({ variant: "title", width: "60%" }),
        skeletonLine({ width: "90%" }),
        skeletonLine({ width: "40%" }),
      ),
    ),
  });
}

/** A page placeholder: header bars and a card grid. */
export function skeletonPage({ label = "Loading page" } = {}) {
  return skeletonBlock({
    label,
    className: "skeleton-page",
    children: [
      skeletonLine({ variant: "title", width: "min(320px, 60%)" }),
      skeletonLine({ width: "min(480px, 80%)" }),
      h(
        "div",
        { class: "skeleton-cards" },
        Array.from({ length: 3 }, () =>
          h(
            "div",
            { class: "skeleton-card" },
            skeletonLine({ variant: "title", width: "50%" }),
            skeletonLine({ width: "85%" }),
            skeletonLine({ width: "65%" }),
          ),
        ),
      ),
    ],
  });
}
