/**
 * The task view's fields (SPEC-5 §4.2): the fields grid of role columns
 * (status pill with "✓ Complete", assignees, Start → Due, priority, time
 * estimate, tags), the description and every other column as a custom
 * field, with empty ones behind "Show N empty fields".
 *
 * Values render and edit as in the List view (`listCell`: pickers, label
 * menus, the date popover); an empty one reads "Empty" (task-view.css).
 * Text is multi-line: it shows pre-wrap and edits in the shared textarea
 * editor (`textEditor`), which saves on blur or Ctrl/⌘+Enter, cancels on
 * Escape and saves only a changed text. Tags show as chips and edit as
 * their comma text on one line (in a textarea when the text has a line
 * break). View-only users see the same values, static.
 */

import { h } from "../../dom.js";
import { iconButton } from "../components/button.js";
import { plural } from "../components/format.js";
import { icon } from "../components/icon.js";
import { inlineInput } from "../components/inline-edit.js";
import { textEditor } from "../components/text-editor.js";
import { openStatusMenu } from "./cells.js";
import { listCell } from "./list-cells.js";
import { afterClick } from "./list-view.js";
import { completeOption, customFields, tagList } from "./task-model.js";
import { isDoneOption, statusOption, textColorOn } from "./values.js";

const GRID_ICONS = Object.freeze({
  status: "myWork",
  assignees: "users",
  dates: "calendar",
  priority: "flag",
  time_estimate: "clock",
  tags: "pin",
});
const TYPE_ICONS = Object.freeze({
  status: "list",
  people: "person",
  date: "calendar",
  numbers: "grid",
  text: "text",
});
const EMPTY = Object.freeze({ editor: "Empty", viewer: "Empty" });

const labelOf = (column, item) => `${column.title} for ${item.name}`;

/** The List view's cell of `column` (`kind`) inside the task view. */
function cell(props, column, kind) {
  const ctx = { ...props, keyPrefix: "task-field" };
  return listCell(ctx, {
    item: props.item,
    cell: { column, kind },
    done: props.done,
  });
}

function fieldRow({ label, iconName, className }, value) {
  return h(
    "div",
    { class: ["task-field", className] },
    h(
      "dt",
      { class: "task-field-label", title: label },
      icon(iconName, { size: 16 }),
      h("span", null, label),
    ),
    h("dd", { class: "task-field-value" }, value),
  );
}

const emptyText = (text = EMPTY.viewer) =>
  h("span", { class: "task-empty" }, text);

// --------------------------------------------------------- text editing

/** Whether the user is selecting text (a click then edits nothing). */
const selecting = () => String(globalThis.getSelection?.() ?? "") !== "";

/**
 * The editor of text field `key` (`textEditor`): Ctrl/⌘+Enter (Enter on
 * one line) saves and Escape cancels, both returning focus to the field;
 * leaving it saves once the click that moved focus is done. Only a
 * changed text is saved.
 */
function fieldEditor(props, { key, column, value, multiline }) {
  let done = false;
  return textEditor({
    value,
    label: labelOf(column, props.item),
    multiline,
    focusKey: `task-edit:${key}`,
    onEnd({ save, leaving, text }) {
      if (done) return;
      done = true;
      const finish = () =>
        props.endEdit(key, {
          refocus: !leaving,
          save:
            save && text.changed
              ? () => props.actions.setValue(props.item, column, text.value)
              : null,
        });
      if (leaving) afterClick(finish);
      else finish();
    },
  });
}

/**
 * Text field `key` as shown: pre-wrap text (a click edits it, unless text
 * is being selected) with an edit button, or the `empty` words.
 */
function textValue(props, { key, column, value, empty }) {
  const editKey = `task-edit-btn:${key}`;
  if (!value) {
    if (!props.caps.edit) return emptyText(empty.viewer);
    return h(
      "button",
      {
        type: "button",
        class: "task-empty-button",
        "aria-label": `${column.title}: empty. Edit`,
        dataset: { focusKey: editKey },
        on: { click: () => props.startEdit(key) },
      },
      empty.editor,
    );
  }
  if (!props.caps.edit)
    return h("div", { class: "task-text", dir: "auto" }, value);
  const text = h(
    "div",
    {
      class: "task-text editable",
      dir: "auto",
      on: { click: () => selecting() || props.startEdit(key) },
    },
    value,
  );
  return h(
    "div",
    { class: "task-text-row" },
    text,
    iconButton({
      icon: "edit",
      label: `Edit ${column.title}`,
      size: "sm",
      className: "task-edit",
      dataset: { focusKey: editKey },
      onClick: () => props.startEdit(key),
    }),
  );
}

function textField(props, column, { key, empty = EMPTY }) {
  const value = props.item.values[column.id] ?? "";
  if (props.ui.editing === key) {
    return fieldEditor(props, { key, column, value, multiline: true });
  }
  return textValue(props, { key, column, value, empty });
}

// ---------------------------------------------------------- the grid

/** The status pill (a label menu for editors) and "✓ Complete". */
function statusValue(props, column) {
  const { item, actions } = props;
  const value = item.values[column.id] ?? null;
  const option = statusOption(column, value);
  const text = option?.label ?? "";
  const done = isDoneOption(option);
  const classes = ["task-status", !text && "empty", done && "done"];
  const content = [
    done ? icon("check", { size: 14 }) : null,
    h("span", { class: "task-status-label", dir: "auto" }, text || "Empty"),
  ];
  let pill;
  if (props.caps.edit) {
    pill = h(
      "button",
      {
        type: "button",
        class: classes,
        "aria-haspopup": "menu",
        "aria-expanded": "false",
        "aria-label": `${column.title}: ${text || "not set"}. Change`,
        dataset: { focusKey: "task-status" },
        on: {
          click: () =>
            openStatusMenu({
              anchor: pill,
              column,
              value,
              onChange: (next) => actions.setValue(item, column, next),
            }),
        },
      },
      content,
      icon("chevronDown", { size: 14 }),
    );
  } else {
    pill = h("span", { class: classes }, content);
  }
  if (text) {
    pill.style.setProperty("--pill-color", option.color);
    pill.style.setProperty("--pill-text", textColorOn(option.color));
  }
  return [pill, completeButton(props, { column, done })];
}

/** Sets the board's first `done`/`closed` label, when it has one. */
function completeButton(props, { column, done }) {
  const finish = completeOption(column);
  if (!props.caps.edit || !finish || done) return null;
  return h(
    "button",
    {
      type: "button",
      class: "btn btn-secondary btn-sm task-complete",
      "aria-label": `Complete: set ${column.title} to ${finish.label}`,
      title: `Set ${column.title} to ${finish.label}`,
      dataset: { focusKey: "task-complete" },
      on: {
        click() {
          props.actions.setValue(props.item, column, finish.index);
          // The button goes once the task is done; focus the status.
          props.focusIn("task-status");
        },
      },
    },
    icon("check", { size: 14 }),
    h("span", { class: "btn-label" }, "Complete"),
  );
}

function numberValue(props, column) {
  const { item } = props;
  const value = item.values[column.id] ?? "";
  if (!props.caps.edit) {
    return value === ""
      ? emptyText()
      : h("span", { class: "task-number" }, value);
  }
  return inlineInput({
    value,
    label: labelOf(column, item),
    type: "number",
    className: "task-number-input",
    placeholder: "Empty",
    focusKey: `task-field:${column.id}`,
    onCommit: (next) =>
      props.actions.setValue(item, column, next === "" ? null : next),
  });
}

/** Tags: chips of the comma text; editors edit the text on one line. */
function tagsValue(props, column) {
  const key = `field:${column.id}`;
  const value = props.item.values[column.id] ?? "";
  if (props.ui.editing === key) {
    return fieldEditor(props, { key, column, value, multiline: false });
  }
  const tags = tagList(value);
  const chips =
    tags.length > 0
      ? h(
          "span",
          { class: "task-tags" },
          tags.map((tag) => h("span", { class: "task-tag", dir: "auto" }, tag)),
        )
      : emptyText();
  if (!props.caps.edit) return chips;
  return h(
    "button",
    {
      type: "button",
      class: "task-value-button",
      "aria-label": `${column.title}: ${tags.join(", ") || "empty"}. Edit`,
      dataset: { focusKey: `task-edit-btn:${key}` },
      on: { click: () => props.startEdit(key) },
    },
    chips,
  );
}

/** Start → Due (either alone when the board has one). */
function datesValue(props, { columns }, roles) {
  const paired = columns.length > 1;
  const parts = columns.map((column) => {
    const due = column === roles.due_date;
    return h(
      "span",
      { class: ["task-date", due ? "due" : "start", paired && "paired"] },
      cell(props, column, due ? "due" : "date"),
    );
  });
  if (!paired) return parts;
  const arrow = icon("arrowRight", { size: 14, className: "task-date-arrow" });
  return [parts[0], arrow, parts[1]];
}

function gridValue(props, row, roles) {
  const [column] = row.columns;
  switch (row.key) {
    case "status":
      return statusValue(props, column);
    case "assignees":
      return cell(props, column, "assignees");
    case "dates":
      return datesValue(props, row, roles);
    case "priority":
      return cell(props, column, "priority");
    case "time_estimate":
      return numberValue(props, column);
    default:
      return tagsValue(props, column);
  }
}

/**
 * The fields grid: a label/value row per role row of `layout.grid`, or
 * null when the board has none.
 * @param {object} props task view props (`task-view.js`)
 * @param {object} layout `taskLayout(board.columns)`
 */
export function fieldsGrid(props, layout) {
  if (layout.grid.length === 0) return null;
  return h(
    "dl",
    { class: "task-fields" },
    layout.grid.map((row) =>
      fieldRow(
        {
          label: row.label,
          iconName: GRID_ICONS[row.key],
          className: `task-field-${row.key}`,
        },
        gridValue(props, row, layout.roles),
      ),
    ),
  );
}

// ------------------------------------------- description, custom fields

/** The description (the `description` role column), or null. */
export function descriptionSection(props, layout) {
  const column = layout.description;
  if (!column) return null;
  return h(
    "section",
    {
      class: "task-section task-description",
      "aria-labelledby": "task-description-heading",
    },
    h(
      "h3",
      { class: "task-heading", id: "task-description-heading" },
      column.title,
    ),
    textField(props, column, {
      key: "description",
      empty: { editor: "Add a description", viewer: "No description" },
    }),
  );
}

function customValue(props, column) {
  switch (column.type) {
    case "text":
      return textField(props, column, { key: `field:${column.id}` });
    case "numbers":
      return numberValue(props, column);
    case "status":
    case "people":
    case "date":
      return cell(props, column, column.type);
    default:
      return emptyText("—");
  }
}

function emptyToggle(props, count) {
  const { showEmpty } = props.ui;
  return h(
    "button",
    {
      type: "button",
      class: "btn btn-ghost btn-sm task-empty-toggle",
      "aria-expanded": String(showEmpty),
      "aria-controls": "task-custom-fields",
      dataset: { focusKey: "task-empty-toggle" },
      on: { click: () => props.toggleEmpty() },
    },
    icon(showEmpty ? "chevronUp" : "chevronDown", { size: 14 }),
    h(
      "span",
      { class: "btn-label" },
      showEmpty ? "Hide empty fields" : `Show ${plural(count, "empty field")}`,
    ),
  );
}

/**
 * Every other column as a label/editor row, in board order; empty ones
 * show only on request (or while being edited). Null without any.
 */
export function customSection(props, layout) {
  const { filled, empty } = customFields(layout, props.item);
  if (filled.length + empty.length === 0) return null;
  const hidden = new Set(empty);
  const shown = layout.custom.filter(
    (column) =>
      props.ui.showEmpty ||
      !hidden.has(column) ||
      props.ui.editing === `field:${column.id}`,
  );
  return h(
    "section",
    {
      class: "task-section task-custom",
      "aria-labelledby": "task-custom-heading",
    },
    h(
      "h3",
      { class: "task-heading", id: "task-custom-heading" },
      "Custom fields",
    ),
    h(
      "dl",
      { class: "task-custom-fields", id: "task-custom-fields" },
      shown.map((column) =>
        fieldRow(
          {
            label: column.title,
            iconName: TYPE_ICONS[column.type] ?? "text",
            className: `task-field-${column.type}`,
          },
          customValue(props, column),
        ),
      ),
    ),
    empty.length > 0 ? emptyToggle(props, empty.length) : null,
  );
}
