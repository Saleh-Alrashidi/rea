/**
 * Kanban view: one lane per status label of the board's status column
 * (`column-roles.js`: the `status` role, else the first status column),
 * plus "No status". Cards move between lanes with HTML5 drag and drop or,
 * from the keyboard, with each card's status pill (the compact status
 * menu, SPEC-6 §1.1); a card's title opens the task view. View-only users
 * see the same lanes without dragging, status menus or "+ Add item".
 *
 * Every card carries `data-item-id` and every lane `data-lane-key` (its
 * `laneKey`), and each item its `position` in the board's manual order
 * (`decodeItem`): what reordering cards inside a lane (SPEC-6 §1.5) needs
 * to name a card's neighbors.
 */

import { clear, h } from "../../dom.js";
import { emptyState } from "../components/empty-state.js";
import { formatDay } from "../components/format.js";
import { icon } from "../components/icon.js";
import { peopleStack, statusLabel, statusPill } from "./cells.js";
import { roleColumns } from "./column-roles.js";
import { laneKey, lanesFor } from "./status-lanes.js";
import { statusOption, textColorOn } from "./values.js";

const DRAG_TYPE = "application/x-mini-monday-item";
const ID_PATTERN = /^\d{1,20}$/;

function cardMeta(ctx, item) {
  const { assignees: people, due_date: date } = roleColumns(ctx.board.columns);
  const group = ctx.board.groups.find((entry) => entry.id === item.groupId);
  const ids = people ? (item.values[people.id] ?? []) : [];
  const due = date ? item.values[date.id] : null;
  return h(
    "div",
    { class: "kanban-card-meta" },
    group ? h("span", { class: "kanban-group" }, group.title) : null,
    due
      ? h(
          "time",
          { class: "kanban-date", datetime: due },
          icon("calendar", { size: 12 }),
          formatDay(due),
        )
      : null,
    ids.length > 0 ? peopleStack(ids, ctx.users) : null,
  );
}

function dragHandlers(item, getCard) {
  return {
    dragstart(event) {
      event.dataTransfer.setData(DRAG_TYPE, item.id);
      event.dataTransfer.setData("text/plain", item.name);
      event.dataTransfer.effectAllowed = "move";
      getCard().classList.add("dragging");
    },
    dragend: () => getCard().classList.remove("dragging"),
  };
}

function cardStatus(ctx, item, column) {
  const value = item.values[column.id] ?? null;
  if (!ctx.caps.edit) {
    // The lane already says "No status"; a blank chip would add nothing.
    return statusOption(column, value)?.label
      ? statusLabel(column, value)
      : null;
  }
  return statusPill({
    column,
    value,
    label: `${column.title} for ${item.name}`,
    focusKey: `kanban-status:${item.id}`,
    placeholder: "Set status",
    compact: true,
    onChange: (next) => ctx.actions.setValue(item, column, next),
  });
}

function kanbanCard(ctx, item, column) {
  const editable = ctx.caps.edit;
  const card = h(
    "article",
    {
      class: ["kanban-card", !editable && "readonly"],
      draggable: editable ? "true" : null,
      dataset: { itemId: item.id },
      "aria-label": item.name,
      on: editable ? dragHandlers(item, () => card) : null,
    },
    h(
      "button",
      {
        type: "button",
        class: "kanban-card-title",
        dataset: { focusKey: `kanban-open:${item.id}` },
        on: { click: () => ctx.openItem(item.id) },
      },
      item.name,
    ),
    h(
      "div",
      { class: "kanban-card-row" },
      cardStatus(ctx, item, column),
      cardMeta(ctx, item),
    ),
  );
  return card;
}

function draggedItem(ctx, event) {
  const id = event.dataTransfer.getData(DRAG_TYPE);
  if (!ID_PATTERN.test(id)) return null;
  return ctx.board.items.find((item) => item.id === id) ?? null;
}

function dropHandlers(ctx, { lane, column }) {
  const accepts = (event) => event.dataTransfer?.types?.includes(DRAG_TYPE);
  return {
    dragover(event) {
      if (!accepts(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      event.currentTarget.classList.add("drop-target");
    },
    dragleave(event) {
      if (!event.currentTarget.contains(event.relatedTarget)) {
        event.currentTarget.classList.remove("drop-target");
      }
    },
    drop(event) {
      event.currentTarget.classList.remove("drop-target");
      if (!accepts(event)) return;
      event.preventDefault();
      const item = draggedItem(ctx, event);
      if (!item) return;
      if (laneKey(column, item.values[column.id] ?? null) === lane.key) return;
      ctx.actions.setValue(item, column, lane.index);
    },
  };
}

function addCardForm(ctx, { lane, column }) {
  const input = h("input", {
    class: "inline-input add-item-input",
    type: "text",
    maxlength: 255,
    placeholder: "+ Add item",
    "aria-label": `Add item to ${lane.label}`,
    autocomplete: "off",
    dataset: { focusKey: `kanban-add:${lane.key}` },
  });
  return h(
    "form",
    {
      class: "lane-add",
      on: {
        submit(event) {
          event.preventDefault();
          const name = input.value.trim();
          if (!name) return;
          input.value = "";
          const values = lane.index === null ? {} : { [column.id]: lane.index };
          ctx.actions.createItem({ groupId: null, name, values });
        },
      },
    },
    input,
  );
}

function laneElement(ctx, { lane, column, items }) {
  const headingId = `lane-heading-${lane.key}`;
  const editable = ctx.caps.edit;
  const section = h(
    "section",
    {
      class: "lane",
      "aria-labelledby": headingId,
      dataset: { laneKey: lane.key },
      on: editable ? dropHandlers(ctx, { lane, column }) : null,
    },
    h(
      "header",
      { class: "lane-header" },
      h("h2", { class: "lane-title", id: headingId }, lane.label),
      h(
        "span",
        { class: "lane-count" },
        String(items.length),
        h("span", { class: "visually-hidden" }, " items"),
      ),
    ),
    h(
      "div",
      { class: "lane-cards" },
      items.length > 0
        ? items.map((item) => kanbanCard(ctx, item, column))
        : h(
            "p",
            { class: "lane-empty" },
            editable ? "Drop items here" : "No items",
          ),
    ),
    editable ? addCardForm(ctx, { lane, column }) : null,
  );
  section.style.setProperty("--lane-color", lane.color);
  section.style.setProperty("--lane-text", textColorOn(lane.color));
  return section;
}

/**
 * Renders the kanban view into `container`.
 * @param {HTMLElement} container
 * @param {{ board: object, items: object[], users: Map, actions: object,
 *   caps: object, openItem(id: string): void }} ctx
 */
export function renderKanban(container, ctx) {
  const column = roleColumns(ctx.board.columns).status;
  if (!column) {
    clear(container).append(
      emptyState({
        icon: "kanban",
        title: "Kanban needs a status column",
        text: ctx.caps.manage
          ? "Add a status column in the main table to sort items into lanes."
          : "Board owners can add a status column to sort items into lanes.",
      }),
    );
    return;
  }
  const lanes = lanesFor(column);
  const byLane = new Map(lanes.map((lane) => [lane.key, []]));
  for (const item of ctx.items) {
    byLane.get(laneKey(column, item.values[column.id] ?? null)).push(item);
  }
  clear(container).append(
    h(
      "div",
      {
        class: "kanban",
        role: "region",
        "aria-label": `Kanban by ${column.title}`,
      },
      lanes.map((lane) =>
        laneElement(ctx, { lane, column, items: byLane.get(lane.key) }),
      ),
    ),
  );
}
