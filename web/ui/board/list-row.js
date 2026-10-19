/**
 * One task row of the List view (SPEC-5 §3.4): a treegrid row whose name
 * cell holds, in order, the expand toggle (tasks with subtasks), the
 * status circle (a label menu for editors), the name (opens the task),
 * the rename pencil (editors), the subtask chip, the description
 * indicator and the comment chip; then the visible cells
 * (`list-cells.js`).
 *
 * The same task can show in several groups (grouped by assignee), so
 * focus keys carry the group key as well as the item ID.
 */

import { h } from "../../dom.js";
import { iconButton } from "../components/button.js";
import { isRebuilding } from "../components/focus.js";
import { plural } from "../components/format.js";
import { icon } from "../components/icon.js";
import { openStatusMenu } from "./cells.js";
import { listCell } from "./list-cells.js";
import { highlightParts } from "./list-model.js";
import {
  isDoneOption,
  isEmptyValue,
  statusOption,
  textColorOn,
} from "./values.js";

function expandToggle(ctx, { row, key }) {
  if (row.childCount === 0) {
    return h("span", { class: "list-expand-space", "aria-hidden": "true" });
  }
  const { item, expanded } = row;
  return iconButton({
    icon: expanded ? "chevronDown" : "chevronRight",
    label: `${expanded ? "Collapse" : "Expand"} subtasks of ${item.name}`,
    size: "sm",
    className: "list-expand",
    dataset: { focusKey: `list-expand:${key}` },
    attributes: { "aria-expanded": String(expanded) },
    onClick: () => ctx.toggleItem(item.id, !expanded),
  });
}

/**
 * A 14px ring in the status color, checked for finished labels; editors
 * get a label menu. `key` makes its focus key unique (`list-status:<key>`).
 * The task view's subtask rows share it.
 * @param {{ roles: object, caps: object, actions: object }} ctx
 * @param {{ item: object, key: string }} options
 */
export function statusCircle(ctx, { item, key }) {
  const column = ctx.roles.status;
  if (!column) return null;
  const value = item.values[column.id] ?? null;
  const option = statusOption(column, value);
  const text = option?.label || "No status";
  const done = isDoneOption(option);
  const classes = ["list-status", done && "done", !option?.label && "empty"];
  const mark = done ? icon("check", { size: 10 }) : null;
  let circle;
  if (ctx.caps.edit) {
    circle = h(
      "button",
      {
        type: "button",
        class: classes,
        title: text,
        "aria-label": `${column.title} of ${item.name}: ${text}. Change`,
        "aria-haspopup": "menu",
        "aria-expanded": "false",
        dataset: { focusKey: `list-status:${key}` },
        on: {
          click: () =>
            openStatusMenu({
              anchor: circle,
              column,
              value,
              onChange: (next) => ctx.actions.setValue(item, column, next),
            }),
        },
      },
      mark,
    );
  } else {
    const label = `${column.title}: ${text}`;
    circle = h(
      "span",
      { class: classes, role: "img", "aria-label": label, title: text },
      mark,
    );
  }
  if (option?.label) {
    circle.style.setProperty("--status-color", option.color);
    circle.style.setProperty("--status-ink", textColorOn(option.color));
  }
  return circle;
}

function nameButton(ctx, { item, key }) {
  const parts = highlightParts(item.name, ctx.search);
  return h(
    "button",
    {
      type: "button",
      class: "list-name",
      dir: "auto",
      title: item.name,
      dataset: { focusKey: `list-open:${key}` },
      on: { click: () => ctx.openItem(item.id) },
    },
    parts.map((part) => (part.match ? h("mark", null, part.text) : part.text)),
  );
}

/**
 * The inline rename input. Enter saves and Escape cancels, both returning
 * focus to the name; leaving it saves too (`ctx.endRename` waits for the
 * click that moved focus, so rebuilding the list does not swallow it).
 */
function renameInput(ctx, { item, key }) {
  let done = false;
  const input = h("input", {
    class: "inline-input list-name-input",
    type: "text",
    maxlength: 255,
    dir: "auto",
    autocomplete: "off",
    spellcheck: "true",
    "aria-label": `Rename ${item.name}`,
    dataset: { focusKey: `list-name:${key}` },
    value: item.name,
  });
  const finish = ({ save, refocus }) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    const changed = save && name !== "" && name !== item.name;
    ctx.endRename(key, {
      refocus,
      save: changed ? () => ctx.actions.renameItem(item, name) : null,
    });
  };
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== "Escape") return;
    event.preventDefault();
    // Escape must not close a surrounding dialog or popover.
    event.stopPropagation();
    finish({ save: event.key === "Enter", refocus: true });
  });
  input.addEventListener("blur", () => {
    if (!isRebuilding(input)) finish({ save: true, refocus: false });
  });
  return input;
}

function chips(ctx, { row, key }) {
  const { item, expanded, childCount } = row;
  const description = ctx.roles.description;
  const described = description && !isEmptyValue(item.values[description.id]);
  return [
    childCount > 0
      ? h(
          "button",
          {
            type: "button",
            class: "list-chip list-subtasks",
            "aria-expanded": String(expanded),
            "aria-label": `${plural(childCount, "subtask")} of ${item.name}. ${expanded ? "Collapse" : "Expand"}`,
            title: plural(childCount, "subtask"),
            dataset: { focusKey: `list-subtasks:${key}` },
            on: { click: () => ctx.toggleItem(item.id, !expanded) },
          },
          icon("subtask", { size: 14 }),
          String(childCount),
        )
      : null,
    described
      ? h(
          "span",
          { class: "list-indicator", title: "Has a description" },
          icon("text", { size: 14, label: "Has a description" }),
        )
      : null,
    item.updatesCount > 0
      ? h(
          "button",
          {
            type: "button",
            class: "list-chip list-comments",
            "aria-label": `${plural(item.updatesCount, "comment")} on ${item.name}. Open`,
            title: plural(item.updatesCount, "comment"),
            dataset: { focusKey: `list-comments:${key}` },
            on: { click: () => ctx.openItem(item.id) },
          },
          icon("chat", { size: 14 }),
          String(item.updatesCount),
        )
      : null,
  ];
}

function nameCell(ctx, { row, key }) {
  const { item } = row;
  const renaming = ctx.prefs.renaming === key;
  return h(
    "div",
    { role: "gridcell", class: "list-cell list-name-cell" },
    expandToggle(ctx, { row, key }),
    statusCircle(ctx, { item, key }),
    renaming ? renameInput(ctx, { item, key }) : nameButton(ctx, { item, key }),
    ctx.caps.edit && !renaming
      ? iconButton({
          icon: "edit",
          label: `Rename ${item.name}`,
          size: "sm",
          className: "list-rename",
          dataset: { focusKey: `list-rename:${key}` },
          onClick: () => ctx.startRename(key),
        })
      : null,
    chips(ctx, { row, key }),
  );
}

/**
 * The treegrid row of `row` (`listGroups`) in `group` with `cells` (the
 * shown `listColumns` cells).
 * @param {object} ctx list view context
 * @param {{ row: object, group: object, cells: object[] }} options
 */
export function listRow(ctx, { row, group, cells }) {
  const { item } = row;
  const key = `${group.key}:${item.id}`;
  const status = ctx.roles.status;
  const done =
    Boolean(status) &&
    isDoneOption(statusOption(status, item.values[status.id] ?? null));
  const rowCtx = { ...ctx, keyPrefix: `list-cell:${key}` };
  const element = h(
    "div",
    {
      role: "row",
      class: ["list-row", done && "done"],
      "aria-level": String(row.depth + 1),
      "aria-expanded": row.childCount > 0 ? String(row.expanded) : null,
      dataset: { itemId: item.id },
    },
    nameCell(ctx, { row, key }),
    cells.map((cell) =>
      h(
        "div",
        { role: "gridcell", class: ["list-cell", `list-cell-${cell.kind}`] },
        listCell(rowCtx, { item, cell, done }),
      ),
    ),
  );
  element.style.setProperty("--depth", String(row.depth));
  return element;
}
