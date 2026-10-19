/**
 * Dragging kanban cards (SPEC-6 §1.5) with HTML5 drag and drop. While a
 * card is over a lane, the place it would take is painted as the List
 * view's 2 px accent line: before the card under the pointer's upper
 * half, after the last card, or at the top of an empty lane. A drop that
 * changes nothing, or at a place no `move_item` can name (next to the
 * card's own subtasks, `laneMove`), paints red and does nothing: no call
 * and no toast. Dropping runs one `move_item` through
 * `actions.moveItems` (`laneMove`): the card's new neighbors in the lane
 * and, from another lane, that lane's status (or none for "No status"),
 * with the undo toast every move has.
 *
 * During a drag the page knows the dragged card (`dragging`), since the
 * data of a drag is only readable on drop.
 */

import { laneMove } from "./move-model.js";
import { laneKey } from "./status-lanes.js";

const DRAG_TYPE = "application/x-mini-monday-item";
const ID_PATTERN = /^\d{1,20}$/;
const MARKS = ["drop-before", "drop-after", "drop-end", "drop-invalid"];
const MARKED = MARKS.map((mark) => `.${mark}`).join(", ");

/** `{ itemId }` of the card being dragged on this page, or null. */
let dragging = null;

function clearMarks(element) {
  const root = element.closest(".kanban") ?? element;
  for (const marked of root.querySelectorAll(MARKED)) {
    marked.classList.remove(...MARKS);
  }
}

/** The lane's other cards and the slot among them at height `y`. */
function slotAt(section, y, itemId) {
  const cards = [...section.querySelectorAll(".kanban-card")].filter(
    (card) => card.dataset.itemId !== itemId,
  );
  const index = cards.findIndex((card) => {
    const box = card.getBoundingClientRect();
    return y < box.top + box.height / 2;
  });
  return { cards, index: index === -1 ? cards.length : index };
}

function paint(section, { cards, index, invalid }) {
  clearMarks(section);
  let target = [section.querySelector(".lane-cards"), "drop-end"];
  if (index < cards.length) target = [cards[index], "drop-before"];
  else if (cards.length > 0) target = [cards.at(-1), "drop-after"];
  const [element, mark] = target;
  element?.classList.add(mark, ...(invalid ? ["drop-invalid"] : []));
}

/** `dragstart` / `dragend` of the card of `item` (`getCard()` is it). */
export function cardDragHandlers(item, getCard) {
  return {
    dragstart(event) {
      event.dataTransfer.setData(DRAG_TYPE, item.id);
      event.dataTransfer.setData("text/plain", item.name);
      event.dataTransfer.effectAllowed = "move";
      dragging = { itemId: item.id };
      getCard().classList.add("dragging");
    },
    dragend() {
      dragging = null;
      const card = getCard();
      card.classList.remove("dragging");
      clearMarks(card);
    },
  };
}

/**
 * The drop handlers of `lane` (of status `column`) whose cards show
 * `items` in display order. `ctx` is the kanban context (`board`,
 * `actions`).
 */
export function laneDropHandlers(ctx, { lane, column, items }) {
  const accepts = (event) => event.dataTransfer?.types?.includes(DRAG_TYPE);
  const itemOf = (id) =>
    ID_PATTERN.test(id ?? "")
      ? (ctx.board.items.find((item) => item.id === id) ?? null)
      : null;
  /** The move of `item` dropped at height `y` of `section`, and its slot. */
  const moveAt = (section, item, y) => {
    const slot = slotAt(section, y, item.id);
    const fromKey = laneKey(column, item.values[column.id] ?? null);
    const request = laneMove({
      item,
      items: ctx.board.items,
      cards: items,
      index: slot.index,
      lane,
      column,
      fromKey,
    });
    return { slot, request };
  };
  return {
    dragover(event) {
      if (!accepts(event)) return;
      event.preventDefault();
      const section = event.currentTarget;
      section.classList.add("drop-target");
      const item = itemOf(dragging?.itemId);
      if (!item) return;
      const { slot, request } = moveAt(section, item, event.clientY);
      event.dataTransfer.dropEffect = request ? "move" : "none";
      paint(section, { ...slot, invalid: !request });
    },
    dragleave(event) {
      const section = event.currentTarget;
      if (section.contains(event.relatedTarget)) return;
      section.classList.remove("drop-target");
      clearMarks(section);
    },
    drop(event) {
      const section = event.currentTarget;
      section.classList.remove("drop-target");
      clearMarks(section);
      if (!accepts(event)) return;
      event.preventDefault();
      const item = itemOf(event.dataTransfer.getData(DRAG_TYPE));
      if (!item) return;
      const { request } = moveAt(section, item, event.clientY);
      if (!request) return;
      const where = request.values ? `to ${lane.label}` : `in ${lane.label}`;
      const message = `Moved “${item.name}” ${where}`;
      ctx.actions.moveItems([request], { message });
    },
  };
}
