/**
 * Dragging List view rows with the pointer (SPEC-6 §1.4). Mouse, pen and
 * touch come as pointer events: a drag starts after 4 px of movement, or
 * for touch after a 400 ms long-press (moving earlier scrolls instead),
 * and never from `IGNORED` controls, so the row's drag handle and its
 * plain surfaces start it. Editors only (`attachListDrag` does nothing
 * for others).
 *
 * While dragging, a ghost with the name (and a count for a selection)
 * follows the pointer, the dragged rows are dimmed and the drop the
 * pointer points at (`resolveDrop`) is painted: a 2 px accent line
 * before or after a row, indented to the landing level (`--drop-level`),
 * an accent outline for "inside", or the end of a group; invalid drops
 * paint red with the not-allowed cursor. Within 48 px of the scroll
 * container's top or bottom edge the list scrolls every 16 ms; holding
 * over a collapsed parent's middle band for 800 ms expands it. Escape or
 * a cancelled pointer ends the drag without a move; releasing over a
 * valid drop runs `view.moveRows`.
 *
 * One drag runs at a time, and it outlives rebuilds of the list: the
 * newest render re-attaches (`attachListDrag`), and rows are found again
 * by their `data-row-key` (`<group key>:<item ID>`).
 */

import { h } from "../../dom.js";
import { icon } from "../components/icon.js";
import { draggedIds, resolveDrop, zoneAt } from "./list-dnd-model.js";

const IGNORED =
  "input, textarea, select, button, a, [contenteditable], [data-no-drag]";
const THRESHOLD_PX = 4;
const LONG_PRESS_MS = 400;
/** A touch that moves this far before the long-press ends is a scroll. */
const TOUCH_SLOP_PX = 8;
const EDGE_PX = 48;
const SCROLL_TICK_MS = 16;
const MAX_STEP_PX = 18;
const EXPAND_MS = 800;
const MARKS = [
  "drop-before",
  "drop-after",
  "drop-inside",
  "drop-end",
  "drop-invalid",
];
const MARKED = MARKS.map((mark) => `.${mark}`).join(", ");

/** The newest rendered list: `{ root, view }`. */
let shown = null;
/** The drag in progress, or null. */
let drag = null;

const doc = () => globalThis.document;
const prevent = (event) => event.preventDefault();

function rowElement(root, key) {
  for (const row of root.querySelectorAll(".list-row")) {
    if (row.dataset.rowKey === key) return row;
  }
  return null;
}

function groupElement(root, key) {
  for (const group of root.querySelectorAll(".list-group")) {
    if (group.dataset.groupKey === key) return group;
  }
  return null;
}

/** The nearest ancestor of `element` that scrolls vertically. */
function scrollerOf(element) {
  for (let at = element?.parentElement; at; at = at.parentElement) {
    const { overflowY } = globalThis.getComputedStyle(at);
    const scrolls = overflowY === "auto" || overflowY === "scroll";
    if (scrolls && at.scrollHeight > at.clientHeight) return at;
  }
  return doc().scrollingElement;
}

/** What the pointer at (x, y) points at in `root`, or null. */
function targetAt(root, x, y) {
  const element = doc().elementFromPoint(x, y);
  if (!element || !root.contains(element)) return null;
  const row = element.closest(".list-row");
  if (row) {
    const box = row.getBoundingClientRect();
    const zone = zoneAt(y - box.top, box.height);
    return { type: "row", rowKey: row.dataset.rowKey, zone };
  }
  // A group's header, column headers, add row or empty row: its end.
  const group = element.closest(".list-group");
  return group ? { type: "group", groupKey: group.dataset.groupKey } : null;
}

function clearMarks(root) {
  for (const element of root.querySelectorAll(MARKED)) {
    element.classList.remove(...MARKS);
  }
}

/** Paints the drop `resolution` (null: none here) on `root`. */
function paint(root, resolution) {
  clearMarks(root);
  doc().documentElement.classList.toggle("drop-not-allowed", !resolution?.ok);
  const indicator = resolution?.indicator;
  if (!indicator) return;
  const element =
    indicator.type === "end"
      ? groupElement(root, indicator.groupKey)
      : rowElement(root, indicator.rowKey);
  if (!element) return;
  const marks = {
    line: `drop-${indicator.edge}`,
    inside: "drop-inside",
    end: "drop-end",
  };
  element.classList.add(marks[indicator.type]);
  if (!resolution.ok) element.classList.add("drop-invalid");
  if (indicator.type === "line") {
    element.style.setProperty("--drop-level", String(indicator.level));
  }
}

function markDragged(root) {
  const ids = new Set(drag.ids);
  for (const row of root.querySelectorAll(".list-row")) {
    row.classList.toggle("dragging", ids.has(row.dataset.itemId));
  }
}

/** Expands a collapsed parent held under the pointer for EXPAND_MS. */
function hoverExpand(resolution) {
  const indicator = resolution?.indicator;
  const key =
    indicator?.type === "inside" && indicator.expand ? indicator.rowKey : null;
  if (key === drag.expandKey) return;
  globalThis.clearTimeout(drag.expandTimer);
  drag.expandKey = key;
  if (!key) return;
  drag.expandTimer = globalThis.setTimeout(() => {
    const row = shown?.view.layout.byKey.get(key);
    if (row && drag?.active) shown.view.toggleItem(row.item.id, true);
  }, EXPAND_MS);
}

/** Follows the pointer: the ghost, the drop under it and its paint. */
function track() {
  const { root, view } = shown;
  const at = `translate(${drag.x + 14}px, ${drag.y + 10}px)`;
  drag.ghost.style.setProperty("transform", at);
  const target = targetAt(root, drag.x, drag.y);
  const ids = drag.ids;
  drag.resolution = target ? resolveDrop(view.layout, { ids, target }) : null;
  paint(root, drag.resolution);
  hoverExpand(drag.resolution);
}

function autoScroll() {
  const scroller = drag?.active ? drag.scroller : null;
  if (!scroller) return;
  const viewport = globalThis.innerHeight;
  const box =
    scroller === doc().scrollingElement
      ? { top: 0, bottom: viewport }
      : scroller.getBoundingClientRect();
  const top = Math.max(box.top, 0) + EDGE_PX;
  const bottom = Math.min(box.bottom, viewport) - EDGE_PX;
  let step = 0;
  if (drag.y < top) step = -Math.ceil(((top - drag.y) / EDGE_PX) * MAX_STEP_PX);
  else if (drag.y > bottom) {
    step = Math.ceil(((drag.y - bottom) / EDGE_PX) * MAX_STEP_PX);
  }
  if (step === 0) return;
  const before = scroller.scrollTop;
  scroller.scrollTop =
    before + Math.max(-MAX_STEP_PX, Math.min(MAX_STEP_PX, step));
  if (scroller.scrollTop !== before) track();
}

function ghostOf(view, ids) {
  const first = view.layout.byId.get(ids[0]);
  return h(
    "div",
    { class: "list-drag-ghost", "aria-hidden": "true" },
    icon("drag", { size: 14 }),
    h("span", { class: "list-drag-name", dir: "auto" }, first?.name ?? ""),
    ids.length > 1
      ? h("span", { class: "list-drag-count" }, String(ids.length))
      : null,
  );
}

/** Ends the drag (or the press that did not become one), moving nothing. */
function stop() {
  if (!drag) return;
  const document = doc();
  globalThis.clearTimeout(drag.timer);
  globalThis.clearTimeout(drag.expandTimer);
  globalThis.clearInterval(drag.ticker);
  document.removeEventListener("pointermove", onPointerMove);
  document.removeEventListener("pointerup", onPointerUp);
  document.removeEventListener("pointercancel", stop);
  document.removeEventListener("keydown", onKeydown, true);
  document.removeEventListener("selectstart", prevent);
  drag.ghost?.remove();
  if (drag.active) {
    const html = document.documentElement;
    html.classList.remove("list-dragging", "drop-not-allowed");
    clearMarks(shown.root);
    for (const row of shown.root.querySelectorAll(".list-row.dragging")) {
      row.classList.remove("dragging");
    }
  }
  drag = null;
}

function begin() {
  const { root, view } = shown;
  const selected = view.prefs.selected;
  const ids = draggedIds(view.layout, { rowKey: drag.rowKey, selected });
  if (ids.length === 0) {
    stop();
    return;
  }
  globalThis.clearTimeout(drag.timer);
  Object.assign(drag, { active: true, ids, scroller: scrollerOf(root) });
  globalThis.getSelection?.()?.removeAllRanges();
  drag.ghost = ghostOf(view, ids);
  doc().body.append(drag.ghost);
  doc().documentElement.classList.add("list-dragging");
  drag.ticker = globalThis.setInterval(autoScroll, SCROLL_TICK_MS);
  markDragged(root);
  track();
}

/** The click that ends a drag must not open the task under the pointer. */
function swallowNextClick() {
  const swallow = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  doc().addEventListener("click", swallow, true);
  globalThis.setTimeout(
    () => doc().removeEventListener("click", swallow, true),
    0,
  );
}

function onPointerMove(event) {
  if (event.pointerId !== drag.pointerId) return;
  drag.x = event.clientX;
  drag.y = event.clientY;
  if (drag.active) {
    event.preventDefault();
    track();
    return;
  }
  const moved = Math.hypot(drag.x - drag.x0, drag.y - drag.y0);
  if (drag.touch) {
    if (moved > TOUCH_SLOP_PX) stop();
  } else if (moved >= THRESHOLD_PX) begin();
}

function onPointerUp(event) {
  if (event.pointerId !== drag.pointerId) return;
  const { active } = drag;
  let resolution = null;
  try {
    if (active) {
      drag.x = event.clientX;
      drag.y = event.clientY;
      track();
      resolution = drag.resolution;
    }
  } finally {
    // Whatever happens, the drag ends here.
    stop();
  }
  if (!active) return;
  swallowNextClick();
  if (resolution?.ok) shown.view.moveRows(resolution);
}

function onKeydown(event) {
  if (event.key !== "Escape" || !drag?.active) return;
  event.preventDefault();
  event.stopPropagation();
  stop();
}

function onPointerDown(event) {
  if (drag || !event.isPrimary) return;
  if (event.pointerType === "mouse" && event.button !== 0) return;
  const start = event.target;
  if (typeof start?.closest !== "function" || start.closest(IGNORED)) return;
  const row = start.closest(".list-row");
  if (!row || !shown?.root.contains(row)) return;
  const [x, y] = [event.clientX, event.clientY];
  const touch = event.pointerType === "touch";
  drag = { pointerId: event.pointerId, touch, rowKey: row.dataset.rowKey };
  Object.assign(drag, { x0: x, y0: y, x, y, active: false });
  const document = doc();
  document.addEventListener("pointermove", onPointerMove);
  document.addEventListener("pointerup", onPointerUp);
  document.addEventListener("pointercancel", stop);
  document.addEventListener("keydown", onKeydown, true);
  document.addEventListener("selectstart", prevent);
  if (touch) drag.timer = globalThis.setTimeout(begin, LONG_PRESS_MS);
}

/**
 * Makes the rows of the rendered list `root` draggable for editors.
 * `view` is the list's context: `{ caps, prefs, layout (listLayout),
 * moveRows(resolution), toggleItem(itemId, expanded) }`. A drag in
 * progress carries on in the new rows.
 */
export function attachListDrag(root, view) {
  shown = { root, view };
  if (!view.caps.edit) return;
  root.addEventListener("pointerdown", onPointerDown);
  // A long-press must not open the context menu, nor a drag scroll the
  // page (a listener present before the touch starts can prevent that).
  root.addEventListener("contextmenu", (event) => drag && prevent(event));
  root.addEventListener(
    "touchmove",
    (event) => drag?.active && prevent(event),
    { passive: false },
  );
  if (drag?.active) {
    drag.scroller = scrollerOf(root);
    markDragged(root);
    track();
  }
}
