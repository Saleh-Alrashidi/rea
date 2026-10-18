/**
 * The board header's import badge (SPEC-4 §6): "Imported from
 * monday.com" / "Imported from ClickUp" (or a CSV / Excel file) with who
 * imported it and when as its tooltip. When the board's `source_url` is
 * an http(s) URL the badge links to the board in its source, in a new tab
 * with `rel="noopener noreferrer"`; any other URL is not linked.
 *
 * `importBadgeInfo(meta)` is the pure part (`Board.import` → what to
 * show), `importBadge(meta)` builds the element (null for boards made in
 * Worklane).
 */

import { h } from "../../dom.js";
import { icon } from "../components/icon.js";

const SOURCES = Object.freeze({
  monday: "monday.com",
  clickup: "ClickUp",
  csv: "a CSV file",
  xlsx: "an Excel file",
});

/** The http(s) URL in `value`, normalized, or null. */
export function sourceHref(value) {
  if (typeof value !== "string" || value === "") return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return url.protocol === "https:" || url.protocol === "http:"
    ? url.href
    : null;
}

function dateText(iso) {
  const time = Date.parse(iso ?? "");
  if (Number.isNaN(time)) return "";
  return new Date(time).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * `{ label, href, title, name }` for `Board.import` (`{ source,
 * source_url, imported_at, imported_by }`), or null when there is none;
 * `name` is the linked badge's accessible name (what the link does).
 */
export function importBadgeInfo(meta) {
  if (!meta || typeof meta !== "object") return null;
  const from = Object.hasOwn(SOURCES, meta.source)
    ? SOURCES[meta.source]
    : "another tool";
  const label = `Imported from ${from}`;
  const when = dateText(meta.imported_at);
  const by = meta.imported_by?.name;
  const parts = [label, when && `on ${when}`, by && `by ${by}`].filter(Boolean);
  const href = sourceHref(meta.source_url);
  const title = href
    ? `${parts.join(" ")}. Opens the original.`
    : parts.join(" ");
  const name = href ? `${label}, open the original board (new tab)` : label;
  return { label, href, title, name };
}

/** The badge element, or null (see the module comment). */
export function importBadge(meta) {
  const info = importBadgeInfo(meta);
  if (!info) return null;
  const content = [
    icon("inbox", { size: 12 }),
    h("span", null, info.label),
    info.href ? icon("open", { size: 12 }) : null,
  ];
  if (!info.href) {
    return h(
      "span",
      { class: "badge badge-info import-badge", title: info.title },
      content,
    );
  }
  return h(
    "a",
    {
      class: "badge badge-info import-badge",
      href: info.href,
      target: "_blank",
      rel: "noopener noreferrer",
      title: info.title,
      "aria-label": info.name,
    },
    content,
  );
}
