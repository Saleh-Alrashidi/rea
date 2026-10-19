/**
 * The List view's bulk bar (SPEC-6 §1.4): while tasks are selected
 * (editors only), a bar at the bottom of the view says how many and
 * offers Set status (the compact status menu, for every selected task),
 * Move to… (another board arrives in Phase 3: disabled, "coming soon"),
 * Delete (one confirmation for all, subtasks counted) and Clear.
 */

import { h } from "../../dom.js";
import { button } from "../components/button.js";
import { MOVE_TO_BOARD_SOON } from "./list-moves.js";
import { openStatusMenu } from "./status-menu.js";

/** The status every one of `items` has in `column`, else null. */
function commonStatus(items, column) {
  const values = new Set(items.map((item) => item.values[column.id] ?? null));
  return values.size === 1 ? [...values][0] : null;
}

function statusButton(view, items) {
  const column = view.roles.status;
  if (!column) return null;
  const trigger = button({
    label: "Set status",
    icon: "flag",
    variant: "ghost",
    size: "sm",
    className: "list-bulk-status",
    dataset: { focusKey: "list-bulk:status" },
    onClick: () =>
      openStatusMenu({
        anchor: trigger,
        column,
        value: commonStatus(items, column),
        onChange: (next) => view.actions.setValues(items, column, next),
      }),
  });
  return trigger;
}

/**
 * The bulk bar for the selected tasks of `view` (the list's context with
 * its `layout`), or null when none is selected.
 */
export function bulkBar(view) {
  if (!view.caps.edit) return null;
  const items = [...view.prefs.selected]
    .map((id) => view.layout.byId.get(id))
    .filter(Boolean);
  if (items.length === 0) return null;
  return h(
    "div",
    { class: "list-bulk", role: "toolbar", "aria-label": "Selected tasks" },
    h(
      "span",
      { class: "list-bulk-count", role: "status" },
      `${items.length} selected`,
    ),
    statusButton(view, items),
    button({
      label: "Move to…",
      icon: "arrowRight",
      variant: "ghost",
      size: "sm",
      className: "list-bulk-move",
      disabledReason: MOVE_TO_BOARD_SOON,
      dataset: { focusKey: "list-bulk:move" },
    }),
    button({
      label: "Delete",
      icon: "trash",
      variant: "ghost",
      size: "sm",
      className: "list-bulk-delete",
      dataset: { focusKey: "list-bulk:delete" },
      onClick: () => view.actions.deleteItems(items),
    }),
    button({
      label: "Clear",
      icon: "close",
      variant: "ghost",
      size: "sm",
      className: "list-bulk-clear",
      ariaLabel: "Clear the selection",
      dataset: { focusKey: "list-bulk:clear" },
      onClick: () => view.clearSelection(),
    }),
  );
}
