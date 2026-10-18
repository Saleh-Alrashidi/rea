/**
 * Kanban view: one lane per status label of the board's first status column
 * (plus "No status"). Cards move between lanes with HTML5 drag and drop or,
 * from the keyboard, with each card's status pill.
 */

import { clear, h } from "../dom.js";
import { avatarStack, statusPill } from "./cells.js";
import { icon } from "./icons.js";

const DRAG_TYPE = "application/x-mini-monday-item";
const ID_PATTERN = /^\d{1,20}$/;
const BLANK_LANE = "blank";

function laneKey(column, value) {
  const known = column.status.options.some((option) => option.index === value);
  return known ? String(value) : BLANK_LANE;
}

function lanesFor(column) {
  const lanes = column.status.options.map((option) => ({
    key: String(option.index),
    index: option.index,
    label: option.label,
    color: option.color,
  }));
  lanes.push({
    key: BLANK_LANE,
    index: null,
    label: "No status",
    color: column.status.blank?.color ?? "#c4c4c4",
  });
  return lanes;
}

function cardMeta(ctx, item) {
  const people = ctx.board.columns.find((column) => column.type === "people");
  const date = ctx.board.columns.find((column) => column.type === "date");
  const group = ctx.board.groups.find((entry) => entry.id === item.groupId);
  const ids = people ? (item.values[people.id] ?? []) : [];
  const due = date ? item.values[date.id] : null;
  return h(
    "div",
    { class: "kanban-card-meta" },
    group ? h("span", { class: "kanban-group" }, group.title) : null,
    due ? h("span", { class: "kanban-date" }, due) : null,
    ids.length > 0 ? avatarStack(ids, ctx.users) : null,
  );
}

function kanbanCard(ctx, item, column) {
  const card = h(
    "article",
    {
      class: "kanban-card",
      draggable: "true",
      dataset: { itemId: item.id },
      "aria-label": item.name,
      on: {
        dragstart(event) {
          event.dataTransfer.setData(DRAG_TYPE, item.id);
          event.dataTransfer.setData("text/plain", item.name);
          event.dataTransfer.effectAllowed = "move";
          card.classList.add("dragging");
        },
        dragend: () => card.classList.remove("dragging"),
      },
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
      statusPill({
        column,
        value: item.values[column.id] ?? null,
        label: `${column.title} for ${item.name}`,
        focusKey: `kanban-status:${item.id}`,
        placeholder: "Set status",
        onChange: (next) => ctx.actions.setValue(item, column, next),
      }),
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
  const section = h(
    "section",
    {
      class: "lane",
      "aria-labelledby": headingId,
      on: dropHandlers(ctx, { lane, column }),
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
      items.map((item) => kanbanCard(ctx, item, column)),
    ),
    addCardForm(ctx, { lane, column }),
  );
  section.style.setProperty("--lane-color", lane.color);
  return section;
}

/**
 * Renders the kanban view into `container`.
 * @param {HTMLElement} container
 * @param {{ board: object, items: object[], users: Map, actions: object,
 *   openItem(id: string): void }} ctx
 */
export function renderKanban(container, ctx) {
  const column = ctx.board.columns.find((entry) => entry.type === "status");
  if (!column) {
    clear(container).append(
      h(
        "div",
        { class: "empty-state" },
        icon("kanban", { size: 32 }),
        h("h2", null, "Kanban needs a status column"),
        h(
          "p",
          null,
          "Add a status column in the main table to sort items into lanes.",
        ),
      ),
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
