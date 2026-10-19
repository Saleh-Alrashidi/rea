/**
 * The List view's toolbar controls (SPEC-5 §3.2), after "+ Add task" and
 * the search: the Group by menu (with "Show empty groups"), the Subtasks
 * menu (collapsed or expanded), the Columns menu (show or hide each
 * column; the name always shows) and the "Show closed" toggle. Choices go
 * to the board's session memory through `change(mutate)`.
 */

import { h } from "../../dom.js";
import { icon } from "../components/icon.js";
import { openMenu } from "../components/menu.js";
import { GROUP_BY, effectiveGroupBy, listColumns } from "./list-model.js";

const SUBTASKS = Object.freeze({
  collapsed: "Collapsed",
  expanded: "Expanded",
});
/** Why a group-by choice is unavailable, by the role column it needs. */
const MISSING = Object.freeze({
  status: "This board has no status column",
  priority: "This board has no priority column",
  assignee: "This board has no people column",
});

/** A ghost toolbar button that opens a menu built by `items()`. */
function menuTool({ key, iconName, label, value, items }) {
  const trigger = h(
    "button",
    {
      type: "button",
      class: "btn btn-ghost btn-sm list-tool",
      "aria-haspopup": "menu",
      "aria-expanded": "false",
      dataset: { focusKey: `list-tool:${key}` },
      on: {
        click: () => openMenu({ anchor: trigger, label, items: items() }),
      },
    },
    icon(iconName),
    h(
      "span",
      { class: "btn-label" },
      value
        ? [`${label}: `, h("span", { class: "list-tool-value" }, value)]
        : label,
    ),
    icon("chevronDown", { size: 14 }),
  );
  return trigger;
}

function groupByItems({ prefs, roles, change }) {
  const current = effectiveGroupBy(prefs.groupBy, roles);
  const choices = Object.entries(GROUP_BY).map(([groupBy, label]) => ({
    label,
    checked: current === groupBy,
    disabledReason:
      effectiveGroupBy(groupBy, roles) === groupBy ? null : MISSING[groupBy],
    onSelect: () =>
      change((next) => {
        next.groupBy = groupBy;
      }),
  }));
  return [
    { type: "heading", label: "Group by" },
    ...choices,
    { type: "separator" },
    {
      label: "Show empty groups",
      checked: prefs.showEmpty,
      onSelect: () => change((next) => (next.showEmpty = !next.showEmpty)),
    },
  ];
}

function subtaskItems({ prefs, change }) {
  return Object.entries(SUBTASKS).map(([mode, label]) => ({
    label,
    checked: prefs.subtasks === mode,
    onSelect: () =>
      change((next) => {
        next.subtasks = mode;
        // The new default applies to every task again.
        next.expanded.clear();
      }),
  }));
}

function columnItems({ board, prefs, change }) {
  const { cells } = listColumns(board, prefs);
  const name = board.columns.find((column) => column.type === "name");
  return [
    { type: "heading", label: "Columns" },
    {
      label: name?.title || "Name",
      checked: true,
      disabledReason: "The name always shows",
    },
    ...cells.map(({ column, shown }) => ({
      label: column.title,
      checked: shown,
      onSelect: () => change((next) => next.columns.set(column.id, !shown)),
    })),
  ];
}

/**
 * The List view's toolbar controls for `board`.
 * @param {{ board: object, prefs: object,
 *   change(mutate: (prefs: object) => void): void }} options
 * @returns {HTMLElement[]}
 */
export function listTools({ board, prefs, change }) {
  const { roles } = listColumns(board, prefs);
  const options = { board, prefs, roles, change };
  const groupBy = effectiveGroupBy(prefs.groupBy, roles);
  return [
    menuTool({
      key: "group",
      iconName: "layers",
      label: "Group",
      value: GROUP_BY[groupBy],
      items: () => groupByItems(options),
    }),
    menuTool({
      key: "subtasks",
      iconName: "subtask",
      label: "Subtasks",
      value: SUBTASKS[prefs.subtasks],
      items: () => subtaskItems(options),
    }),
    menuTool({
      key: "columns",
      iconName: "columns",
      label: "Columns",
      value: null,
      items: () => columnItems(options),
    }),
    h(
      "button",
      {
        type: "button",
        class: [
          "btn",
          "btn-ghost",
          "btn-sm",
          "list-tool",
          prefs.showClosed && "on",
        ],
        "aria-pressed": String(prefs.showClosed),
        dataset: { focusKey: "list-tool:closed" },
        on: {
          click: () => change((next) => (next.showClosed = !next.showClosed)),
        },
      },
      icon("eye"),
      h("span", { class: "btn-label" }, "Show closed"),
    ),
  ];
}
