/**
 * Inline SVG icons built from constant path data (no markup parsing).
 * Icons are decorative: controls carry their own accessible names.
 */

import { svg } from "../dom.js";

const PATHS = Object.freeze({
  plus: ["M12 5v14", "M5 12h14"],
  search: ["M10.5 4a6.5 6.5 0 1 1 0 13a6.5 6.5 0 0 1 0-13z", "M20 20l-4.8-4.8"],
  chevronDown: ["M6 9l6 6 6-6"],
  chevronRight: ["M9 6l6 6-6 6"],
  dots: ["M5 12h.01", "M12 12h.01", "M19 12h.01"],
  close: ["M6 6l12 12", "M18 6L6 18"],
  trash: ["M4 7h16", "M9 7V4h6v3", "M6 7l1 13h10l1-13", "M10 11v6", "M14 11v6"],
  open: [
    "M14 4h6v6",
    "M20 4l-8 8",
    "M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  ],
  table: ["M4 5h16v14H4z", "M4 10h16", "M10 10v9"],
  kanban: ["M4 4h4v16H4z", "M10 4h4v10h-4z", "M16 4h4v13h-4z"],
  app: ["M4 4h7v7H4z", "M13 4h7v7h-7z", "M4 13h7v7H4z", "M13 13h7v7h-7z"],
  menu: ["M4 7h16", "M4 12h16", "M4 17h16"],
  board: [
    "M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z",
    "M8 9h8",
    "M8 13h8",
    "M8 17h5",
  ],
  sun: [
    "M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8z",
    "M12 2v2",
    "M12 20v2",
    "M2 12h2",
    "M20 12h2",
    "M4.9 4.9l1.4 1.4",
    "M17.7 17.7l1.4 1.4",
    "M4.9 19.1l1.4-1.4",
    "M17.7 6.3l1.4-1.4",
  ],
  moon: ["M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"],
  check: ["M5 12l5 5 9-10"],
  alert: ["M12 4l9 16H3z", "M12 10v4", "M12 17h.01"],
  chat: ["M4 5h16v11H9l-5 4z"],
  person: ["M12 4a4 4 0 1 1 0 8a4 4 0 0 1 0-8z", "M4 21a8 8 0 0 1 16 0"],
});

/**
 * Returns a decorative 24×24 stroke icon.
 * @param {keyof typeof PATHS} name
 */
export function icon(name, { size = 16 } = {}) {
  const paths = PATHS[name] ?? PATHS.dots;
  return svg(
    "svg",
    {
      class: "icon",
      viewBox: "0 0 24 24",
      width: size,
      height: size,
      fill: "none",
      stroke: "currentColor",
      "stroke-width": name === "dots" ? 3 : 2,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true",
      focusable: "false",
    },
    paths.map((d) => svg("path", { d })),
  );
}
