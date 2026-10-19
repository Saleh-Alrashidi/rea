/**
 * Dragging rows of the sidebar's Spaces tree (SPEC-6 §3.3) with the
 * pointer: Lists and docs reorder inside a folder or a Space's root and
 * move between folders and Spaces, folders reorder within their Space,
 * and admins reorder Spaces. What a drop does is `resolveDrop`
 * (`sidebar-drop-model.js`); `performMove` runs it with its undo toast.
 *
 * Pointer events cover mouse, pen and touch: a drag starts after 4 px of
 * movement (touch: after a 400 ms long-press; moving earlier scrolls),
 * never from a row's "+" / "…" or the rename field, and only for nodes
 * the user may move (`canDrag`). While dragging, a ghost with the name
 * follows the pointer and the drop is painted: a line before or after a
 * node, or the target folder or Space highlighted; a refused drop is red
 * with the not-allowed cursor. Holding over a collapsed folder or Space
 * for 1000 ms expands it. Escape or a cancelled pointer ends the drag
 * without a move.
 *
 * The tree redraws while a drag runs only when it expands a node; other
 * redraws wait for its end (`s.dragging`, `s.settle()`).
 */

import { h } from "../../dom.js";
import { icon } from "../components/icon.js";
import { performMove } from "./sidebar-actions.js";
import { canDrag, resolveDrop, zoneAt } from "./sidebar-drop-model.js";
import { isExpanded } from "./sidebar-model.js";

const IGNORED = "input, textarea, select, .tree-action, [data-no-drag]";
const THRESHOLD_PX = 4;
const LONG_PRESS_MS = 400;
const TOUCH_SLOP_PX = 8;
const EXPAND_MS = 1000;
const MARKS = [
  "tree-drop-before",
  "tree-drop-after",
  "tree-drop-inside",
  "tree-drop-invalid",
];
const MARKED = MARKS.map((mark) => `.${mark}`).join(", ");

const doc = () => globalThis.document;
const prevent = (event) => event.preventDefault();

/** The sidebar whose drag runs (one at a time). */
let current = null;

function clearMarks(s) {
  for (const element of s.container.querySelectorAll(MARKED)) {
    element.classList.remove(...MARKS);
  }
}

function itemOf(s, key) {
  return s.container.querySelector(
    `[role=treeitem][data-key="${CSS.escape(key)}"]`,
  );
}

/** Paints `result` (`resolveDrop`; null: nowhere to drop here). */
function paint(s, result) {
  clearMarks(s);
  doc().documentElement.classList.toggle("drop-not-allowed", !result?.ok);
  const indicator = result?.indicator;
  const item = indicator && itemOf(s, indicator.key);
  if (!item) return;
  const element =
    indicator.type === "inside" ? item.querySelector(".tree-row") : item;
  element.classList.add(`tree-drop-${indicator.type}`);
  if (!result.ok) element.classList.add("tree-drop-invalid");
}

/** The row under (x, y) and the band of it: `{ key, zone }`, or null. */
function targetAt(s, x, y) {
  const tree = s.container.querySelector(".space-tree");
  const under = doc().elementFromPoint(x, y);
  if (!tree || !under || !tree.contains(under)) return null;
  const item = under.closest("[role=treeitem]");
  const row = item?.querySelector(":scope > .tree-row");
  const node = row && s.byKey.get(row.dataset.key);
  if (!node) return null;
  const box = row.getBoundingClientRect();
  const zone = zoneAt({
    dragKind: s.drag.node.kind,
    targetKind: node.kind,
    offset: y - box.top,
    height: box.height,
  });
  return { key: node.key, zone };
}

/** Expands a collapsed folder or Space held under the pointer. */
function hoverExpand(s, target) {
  const node = target && s.byKey.get(target.key);
  const closed =
    node && node.children && !isExpanded(s.prefs.expanded, node) ? node : null;
  const key = closed?.key ?? null;
  if (key === s.drag.expandKey) return;
  globalThis.clearTimeout(s.drag.expandTimer);
  s.drag.expandKey = key;
  if (!key) return;
  s.drag.expandTimer = globalThis.setTimeout(() => {
    if (!s.drag?.active) return;
    s.prefs.setExpanded(key, true);
    s.draw();
    markDragged(s);
    track(s);
  }, EXPAND_MS);
}

function track(s) {
  const { drag } = s;
  const at = `translate(${drag.x + 12}px, ${drag.y + 8}px)`;
  drag.ghost.style.setProperty("transform", at);
  const target = targetAt(s, drag.x, drag.y);
  drag.result = target
    ? resolveDrop(s.spaces, {
        dragKey: drag.node.key,
        targetKey: target.key,
        zone: target.zone,
      })
    : null;
  paint(s, drag.result);
  hoverExpand(s, target);
}

function markDragged(s) {
  itemOf(s, s.drag.node.key)?.classList.add("tree-dragging");
}

function ghostOf(node) {
  return h(
    "div",
    { class: "tree-drag-ghost", "aria-hidden": "true" },
    icon("drag", { size: 14 }),
    h("span", { class: "tree-drag-name", dir: "auto" }, node.name),
  );
}

function listen(on) {
  const method = on ? "addEventListener" : "removeEventListener";
  const document = doc();
  document[method]("pointermove", onPointerMove);
  document[method]("pointerup", onPointerUp);
  document[method]("pointercancel", stop);
  document[method]("keydown", onKeydown, true);
  document[method]("selectstart", prevent);
}

/** Ends the drag (or the press that did not become one), moving nothing. */
function stop() {
  const s = current;
  if (!s?.drag) return;
  current = null;
  const { drag } = s;
  globalThis.clearTimeout(drag.timer);
  globalThis.clearTimeout(drag.expandTimer);
  listen(false);
  drag.ghost?.remove();
  s.drag = null;
  s.dragging = false;
  if (drag.active) {
    doc().documentElement.classList.remove(
      "tree-dragging-on",
      "drop-not-allowed",
    );
    clearMarks(s);
    for (const element of s.container.querySelectorAll(".tree-dragging")) {
      element.classList.remove("tree-dragging");
    }
  }
  s.settle();
}

function begin() {
  const s = current;
  globalThis.clearTimeout(s.drag.timer);
  Object.assign(s.drag, { active: true, ghost: ghostOf(s.drag.node) });
  s.dragging = true;
  globalThis.getSelection?.()?.removeAllRanges();
  doc().body.append(s.drag.ghost);
  doc().documentElement.classList.add("tree-dragging-on");
  markDragged(s);
  track(s);
}

/** The click that ends a drag must not open the link under the pointer. */
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
  const s = current;
  if (!s?.drag || event.pointerId !== s.drag.pointerId) return;
  const { drag } = s;
  drag.x = event.clientX;
  drag.y = event.clientY;
  if (drag.active) {
    event.preventDefault();
    track(s);
    return;
  }
  const moved = Math.hypot(drag.x - drag.x0, drag.y - drag.y0);
  if (drag.touch) {
    if (moved > TOUCH_SLOP_PX) stop();
  } else if (moved >= THRESHOLD_PX) begin();
}

function onPointerUp(event) {
  const s = current;
  if (!s?.drag || event.pointerId !== s.drag.pointerId) return;
  const { active } = s.drag;
  let result = null;
  try {
    if (active) {
      s.drag.x = event.clientX;
      s.drag.y = event.clientY;
      track(s);
      result = s.drag.result;
    }
  } finally {
    stop();
  }
  if (!active) return;
  swallowNextClick();
  if (result?.ok) performMove(s, result.move);
}

function onKeydown(event) {
  if (event.key !== "Escape" || !current?.drag?.active) return;
  event.preventDefault();
  event.stopPropagation();
  stop();
}

function onPointerDown(s, event) {
  if (current || !event.isPrimary) return;
  if (event.pointerType === "mouse" && event.button !== 0) return;
  const start = event.target;
  if (typeof start?.closest !== "function" || start.closest(IGNORED)) return;
  const row = start.closest(".tree-row");
  const node = row && s.byKey.get(row.dataset.key);
  if (!node || s.renaming || !canDrag(s.spaces, node, s.ctx.me)) return;
  const touch = event.pointerType === "touch";
  const [x, y] = [event.clientX, event.clientY];
  s.drag = { pointerId: event.pointerId, node, touch, active: false };
  Object.assign(s.drag, { x0: x, y0: y, x, y });
  current = s;
  listen(true);
  if (touch) s.drag.timer = globalThis.setTimeout(begin, LONG_PRESS_MS);
}

/**
 * Makes the rendered tree of sidebar state `s` draggable; a drag in
 * progress carries on in the redrawn rows.
 */
export function attachTreeDrag(s) {
  const tree = s.container.querySelector(".space-tree");
  if (!tree) return;
  tree.addEventListener("pointerdown", (event) => onPointerDown(s, event));
  tree.addEventListener("dragstart", prevent);
  tree.addEventListener("contextmenu", (event) => {
    if (s.drag) prevent(event);
  });
  tree.addEventListener(
    "touchmove",
    (event) => s.drag?.active && prevent(event),
    { passive: false },
  );
  if (s.drag?.active) markDragged(s);
}
