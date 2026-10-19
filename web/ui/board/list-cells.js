/**
 * Cells of the List view (SPEC-5 §3.4) other than the name: assignees and
 * people as avatar stacks, dates as short days (the due date red when
 * overdue and the task not finished), priority as a flag with its label,
 * other status columns as rounded pills, text on one line and numbers
 * right-aligned.
 *
 * Editors get the existing pickers (people, status labels) and inline
 * inputs; a date opens a popover with a date input; a multi-line text
 * value opens the task view, since only single-line values are edited
 * inline. View-only users see the same values as static elements.
 */

import { h } from "../../dom.js";
import { formatDay, todayString } from "../components/format.js";
import { icon } from "../components/icon.js";
import { inlineInput } from "../components/inline-edit.js";
import { openPopover } from "../components/popover.js";
import { MAX_TEXT, firstLine } from "../components/text-editor.js";
import { cellEditor, openStatusMenu } from "./cells.js";
import { statusOption, textColorOn } from "./values.js";

/** The cell's accessible label: "<column> for <task>". */
const labelOf = (column, item) => `${column.title} for ${item.name}`;

function datePicker({ anchor, value, label, onChange }) {
  const input = h("input", {
    class: "input list-date-input",
    type: "date",
    "aria-label": label,
    "data-autofocus": true,
    value: value ?? "",
  });
  const popover = openPopover({
    anchor,
    label,
    className: "list-date-popover",
    content: h(
      "form",
      {
        class: "list-date-form",
        on: {
          submit(event) {
            event.preventDefault();
            popover?.close();
            const next = input.value || null;
            if (next !== value) onChange(next);
          },
        },
      },
      input,
      h(
        "div",
        { class: "list-date-actions" },
        h("button", { type: "submit", class: "btn btn-primary btn-sm" }, "Set"),
        value
          ? h(
              "button",
              {
                type: "button",
                class: "btn btn-ghost btn-sm",
                on: {
                  click() {
                    popover?.close();
                    onChange(null);
                  },
                },
              },
              "Clear",
            )
          : null,
      ),
    ),
  });
}

/** A date: "Oct 3", red when overdue; editors open a date popover. */
function dateCell(ctx, { item, column, overdue }) {
  const value = item.values[column.id] ?? null;
  const label = labelOf(column, item);
  const content = value
    ? h("time", { datetime: value }, formatDay(value))
    : icon("calendar", { size: 14, className: "list-faint" });
  const classes = ["list-date", !value && "empty", overdue && "overdue"];
  if (!ctx.caps.edit) {
    return h(
      "span",
      { class: classes, title: value ? null : label },
      value ? content : null,
    );
  }
  const trigger = h(
    "button",
    {
      type: "button",
      class: classes,
      "aria-label": `${label}: ${value ? formatDay(value) : "no date"}. Change date`,
      "aria-haspopup": "dialog",
      "aria-expanded": "false",
      dataset: { focusKey: `${ctx.keyPrefix}:${column.id}` },
      on: {
        click: () =>
          datePicker({
            anchor: trigger,
            value,
            label,
            onChange: (next) => ctx.actions.setValue(item, column, next),
          }),
      },
    },
    content,
  );
  return trigger;
}

/** A status-like value the user may change from a label menu. */
function labelTrigger(ctx, { item, column, className, children, text }) {
  const value = item.values[column.id] ?? null;
  const label = labelOf(column, item);
  if (!ctx.caps.edit) {
    return h(
      "span",
      {
        class: className,
        role: "img",
        "aria-label": `${label}: ${text || "not set"}`,
      },
      children,
    );
  }
  const trigger = h(
    "button",
    {
      type: "button",
      class: className,
      "aria-label": `${label}: ${text || "not set"}. Change`,
      "aria-haspopup": "menu",
      "aria-expanded": "false",
      dataset: { focusKey: `${ctx.keyPrefix}:${column.id}` },
      on: {
        click: () =>
          openStatusMenu({
            anchor: trigger,
            column,
            value,
            onChange: (next) => ctx.actions.setValue(item, column, next),
          }),
      },
    },
    children,
  );
  return trigger;
}

/** Priority: a flag in the label color plus the label; empty is faint. */
function priorityCell(ctx, { item, column }) {
  const option = statusOption(column, item.values[column.id] ?? null);
  const text = option?.label ?? "";
  const flag = icon("flag", {
    size: 14,
    className: text ? "list-flag" : "list-faint",
  });
  if (text) flag.style.setProperty("--flag-color", option.color);
  return labelTrigger(ctx, {
    item,
    column,
    text,
    className: ["list-priority", !text && "empty"],
    children: [
      flag,
      text ? h("span", { class: "list-priority-label" }, text) : null,
    ],
  });
}

/** Another status column: a rounded pill in the label color. */
function statusCell(ctx, { item, column }) {
  const option = statusOption(column, item.values[column.id] ?? null);
  const text = option?.label ?? "";
  const pill = labelTrigger(ctx, {
    item,
    column,
    text,
    className: ["list-pill", !text && "empty"],
    children: text,
  });
  if (text) {
    pill.style.setProperty("--pill-color", option.color);
    pill.style.setProperty("--pill-text", textColorOn(option.color));
  }
  return pill;
}

/** Text on one line; a multi-line value shows its first line and "…". */
function textCell(ctx, { item, column }) {
  const value = item.values[column.id] ?? "";
  const line = firstLine(value);
  const shown = line.more ? `${line.text}…` : line.text;
  if (ctx.caps.edit && !line.multiline) {
    return inlineInput({
      value,
      label: labelOf(column, item),
      className: "list-text-input",
      maxLength: MAX_TEXT,
      focusKey: `${ctx.keyPrefix}:${column.id}`,
      onCommit: (next) =>
        ctx.actions.setValue(item, column, next === "" ? null : next),
    });
  }
  const attrs = { class: "list-text", dir: "auto", title: line.text || null };
  if (!ctx.caps.edit) return h("span", attrs, shown);
  // Multi-line text is edited in the task view.
  return h(
    "button",
    {
      ...attrs,
      type: "button",
      "aria-label": `${labelOf(column, item)}: ${line.text}. Edit in the task view`,
      dataset: { focusKey: `${ctx.keyPrefix}:${column.id}` },
      on: { click: () => ctx.openItem(item.id) },
    },
    shown,
  );
}

function numberCell(ctx, { item, column }) {
  const value = item.values[column.id] ?? "";
  if (!ctx.caps.edit) return h("span", { class: "list-number" }, value);
  return inlineInput({
    value,
    label: labelOf(column, item),
    type: "number",
    className: "list-number-input",
    focusKey: `${ctx.keyPrefix}:${column.id}`,
    onCommit: (next) =>
      ctx.actions.setValue(item, column, next === "" ? null : next),
  });
}

/** People: the shared people picker (static avatars for viewers). */
function peopleCell(ctx, { item, column }) {
  return cellEditor({
    column,
    value: item.values[column.id] ?? [],
    users: ctx.users,
    assignable: ctx.board.assignableUsers,
    itemName: item.name,
    focusKey: `${ctx.keyPrefix}:${column.id}`,
    readOnly: !ctx.caps.edit,
    onChange: (next) => ctx.actions.setValue(item, column, next),
  });
}

/**
 * The content of the cell `{ column, kind }` (`listColumns`) for `item`.
 * `ctx.keyPrefix` makes focus keys unique per row; `done` says the task is
 * finished (its due date is never overdue).
 * @param {object} ctx list view context
 * @param {{ item: object, cell: { column: object, kind: string },
 *   done: boolean }} options
 */
export function listCell(ctx, { item, cell, done }) {
  const { column, kind } = cell;
  switch (kind) {
    case "assignees":
    case "people":
      return peopleCell(ctx, { item, column });
    case "due": {
      const value = item.values[column.id] ?? null;
      const overdue = Boolean(value) && !done && value < todayString();
      return dateCell(ctx, { item, column, overdue });
    }
    case "date":
      return dateCell(ctx, { item, column, overdue: false });
    case "priority":
      return priorityCell(ctx, { item, column });
    case "status":
      return statusCell(ctx, { item, column });
    case "numbers":
      return numberCell(ctx, { item, column });
    case "text":
      return textCell(ctx, { item, column });
    default:
      return null;
  }
}
