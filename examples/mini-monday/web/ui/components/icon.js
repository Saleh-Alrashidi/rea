/**
 * Worklane icon set: 24×24 stroke icons built from constant path data with
 * `createElementNS` (no markup parsing), plus the brand mark.
 *
 * Icons are decorative by default (`aria-hidden`); pass `label` for an icon
 * that carries meaning on its own. Controls should carry their own
 * accessible names instead.
 *
 * ```js
 * icon("bell")                       // 16 px, decorative
 * icon("lock", { size: 14, label: "Private board" })
 * brandMark({ size: 28 })
 * ```
 */

import { svg } from "../../dom.js";

/** Path data for a circle at (cx, cy) with radius r. */
function circle(cx, cy, r) {
  return `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
}

const SQUARE =
  "M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z";
const DOT_ICONS = new Set(["more", "drag"]);

const PATHS = Object.freeze({
  // navigation and features
  home: [
    "M3 10.5 12 3l9 7.5",
    "M5 9v11a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9",
  ],
  myWork: [circle(12, 12, 9), "M8 12.5l2.5 2.5 5.5-6"],
  shared: [
    circle(18, 5, 2.5),
    circle(6, 12, 2.5),
    circle(18, 19, 2.5),
    "M8.3 13.3l7.4 4.4",
    "M15.7 6.3l-7.4 4.4",
  ],
  notes: [
    "M5 3h14a2 2 0 0 1 2 2v9l-7 7H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z",
    "M14 21v-5a2 2 0 0 1 2-2h5",
  ],
  docs: [
    "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z",
    "M14 3v5h5",
    "M9 13h6",
    "M9 17h6",
  ],
  forms: [
    "M9 3h6v4H9z",
    "M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2",
    "M9 12h6",
    "M9 16h4",
  ],
  board: [SQUARE, "M8 9h8", "M8 13h8", "M8 17h5"],
  grid: [SQUARE, "M4 10h16", "M4 15h16", "M10 4v16"],
  table: ["M4 5h16v14H4z", "M4 10h16", "M10 10v9"],
  kanban: ["M4 4h4v16H4z", "M10 4h4v10h-4z", "M16 4h4v13h-4z"],
  list: [
    "M9 6h11",
    "M9 12h11",
    "M9 18h11",
    circle(4.5, 6, 0.6),
    circle(4.5, 12, 0.6),
    circle(4.5, 18, 0.6),
  ],
  columns: ["M4 5h16v14H4z", "M10 5v14", "M15 5v14"],
  layers: ["M12 3l9 5-9 5-9-5z", "M3 13l9 5 9-5"],
  app: ["M4 4h7v7H4z", "M13 4h7v7h-7z", "M4 13h7v7H4z", "M13 13h7v7h-7z"],
  item: [SQUARE, "M8 12l3 3 5-6"],
  activity: ["M3 12h4l3-8 4 16 3-8h4"],
  workspace: ["M12 3l9 5-9 5-9-5z", "M3 13l9 5 9-5"],
  globe: [
    circle(12, 12, 9),
    "M3 12h18",
    "M12 3a14 14 0 0 1 0 18",
    "M12 3a14 14 0 0 0 0 18",
  ],
  lock: [
    "M6 11h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z",
    "M8 11V8a4 4 0 0 1 8 0v3",
  ],
  users: [
    circle(9, 8, 3.5),
    "M2.5 20a6.5 6.5 0 0 1 13 0",
    "M16 4.6a3.5 3.5 0 0 1 0 6.8",
    "M18.5 14.5a6.5 6.5 0 0 1 3 5.5",
  ],
  team: [
    circle(12, 7, 3),
    circle(5.5, 10, 2),
    circle(18.5, 10, 2),
    "M7 20a5 5 0 0 1 10 0",
    "M2 19a3.5 3.5 0 0 1 4.5-3.4",
    "M22 19a3.5 3.5 0 0 0-4.5-3.4",
  ],
  person: [circle(12, 8, 4), "M4 21a8 8 0 0 1 16 0"],
  userPlus: [circle(10, 8, 4), "M3 21a7 7 0 0 1 14 0", "M19 8v6", "M16 11h6"],
  admin: ["M12 3l8 3v6c0 4.5-3.4 8-8 9c-4.6-1-8-4.5-8-9V6z", "M9 12l2 2 4-4"],
  bell: ["M6 16v-5a6 6 0 0 1 12 0v5l2 2H4z", "M10 20a2 2 0 0 0 4 0"],
  inbox: [
    "M3 13h5l1 3h6l1-3h5",
    "M5 5h14l2 8v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z",
  ],
  mail: ["M4 6h16v12H4z", "M4 7l8 6 8-6"],
  // actions
  search: [circle(10.5, 10.5, 6.5), "M20 20l-4.8-4.8"],
  plus: ["M12 5v14", "M5 12h14"],
  more: ["M5 12h.01", "M12 12h.01", "M19 12h.01"],
  drag: [
    "M9 6h.01",
    "M9 12h.01",
    "M9 18h.01",
    "M15 6h.01",
    "M15 12h.01",
    "M15 18h.01",
  ],
  check: ["M5 12l5 5 9-10"],
  close: ["M6 6l12 12", "M18 6L6 18"],
  trash: ["M4 7h16", "M9 7V4h6v3", "M6 7l1 13h10l1-13", "M10 11v6", "M14 11v6"],
  edit: ["M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z", "M13.5 6.5l4 4"],
  link: [
    "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1",
    "M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  ],
  copy: [
    "M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1z",
    "M16 9V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3",
  ],
  eye: ["M2 12s3.5-7 10-7s10 7 10 7s-3.5 7-10 7S2 12 2 12z", circle(12, 12, 3)],
  open: [
    "M14 4h6v6",
    "M20 4l-8 8",
    "M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  ],
  filter: ["M4 5h16l-6 8v5l-4 2v-7z"],
  // work items
  subtask: [
    "M6 3v11a3 3 0 0 0 3 3h6",
    "M6 8h9",
    circle(18, 8, 2.5),
    circle(18, 17, 2.5),
  ],
  flag: ["M5 21V4", "M5 4h12l-2.5 4.5L17 13H5"],
  text: ["M4 6h16", "M4 11h16", "M4 16h10"],
  calendar: [
    "M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z",
    "M4 10h16",
    "M8 3v4",
    "M16 3v4",
  ],
  clock: [circle(12, 12, 9), "M12 7v5l3 2"],
  pin: ["M9 4h6l-1 5 4 4H6l4-4z", "M12 13v7"],
  settings: [
    "M4 7h9",
    "M17 7h3",
    circle(15, 7, 2),
    "M4 17h3",
    "M11 17h9",
    circle(9, 17, 2),
  ],
  refresh: ["M20 11a8 8 0 1 0-2.3 5.7", "M20 5v6h-6"],
  bolt: ["M13 3L5 13h6l-1 8 8-10h-6z"],
  arrowRight: ["M5 12h14", "M13 6l6 6-6 6"],
  logout: [
    "M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3",
    "M16 8l4 4-4 4",
    "M20 12H10",
  ],
  switch: ["M7 4L3 8l4 4", "M3 8h14", "M17 12l4 4-4 4", "M21 16H7"],
  // chevrons and chrome
  chevronDown: ["M6 9l6 6 6-6"],
  chevronUp: ["M6 15l6-6 6 6"],
  chevronLeft: ["M15 6l-6 6 6 6"],
  chevronRight: ["M9 6l6 6-6 6"],
  menu: ["M4 7h16", "M4 12h16", "M4 17h16"],
  sidebar: [
    "M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z",
    "M9 4v16",
  ],
  // status and theme
  alert: ["M12 4l9 16H3z", "M12 10v4", "M12 17h.01"],
  info: [circle(12, 12, 9), "M12 11v5", "M12 8h.01"],
  chat: ["M4 5h16v11H9l-5 4z"],
  sun: [
    circle(12, 12, 4),
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
  monitor: [
    "M4 4h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z",
    "M8 20h8",
    "M12 16v4",
  ],
});

/** Every icon name, for documentation and tests. */
export const ICON_NAMES = Object.freeze(Object.keys(PATHS));

/**
 * Returns a 24×24 stroke icon scaled to `size` pixels. Unknown names render
 * the "more" glyph rather than failing.
 *
 * @param {keyof typeof PATHS} name
 * @param {{ size?: number, label?: string, className?: string }} [options]
 * @returns {SVGSVGElement}
 */
export function icon(name, { size = 16, label, className } = {}) {
  const known = Object.hasOwn(PATHS, name);
  const paths = known ? PATHS[name] : PATHS.more;
  const dots = !known || DOT_ICONS.has(name);
  return svg(
    "svg",
    {
      class: ["icon", className],
      viewBox: "0 0 24 24",
      width: size,
      height: size,
      fill: "none",
      stroke: "currentColor",
      "stroke-width": dots ? 3 : 1.85,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      role: label ? "img" : null,
      "aria-label": label ?? null,
      "aria-hidden": label ? null : "true",
      focusable: "false",
    },
    label ? svg("title", null, label) : null,
    paths.map((d) => svg("path", { d })),
  );
}

/**
 * The Worklane mark: an indigo tile with a "W" drawn as one lane line.
 * Colors come from CSS (`.brand-mark-tile`, `.brand-mark-line`).
 *
 * @param {{ size?: number }} [options]
 * @returns {SVGSVGElement}
 */
export function brandMark({ size = 28 } = {}) {
  return svg(
    "svg",
    {
      class: "brand-mark",
      viewBox: "0 0 32 32",
      width: size,
      height: size,
      "aria-hidden": "true",
      focusable: "false",
    },
    svg("rect", {
      class: "brand-mark-tile",
      x: 1,
      y: 1,
      width: 30,
      height: 30,
      rx: 8,
    }),
    svg("path", {
      class: "brand-mark-line",
      d: "M7.5 10.5l4 11 4.5-8.5 4.5 8.5 4-11",
      fill: "none",
      "stroke-width": 3,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    }),
  );
}
