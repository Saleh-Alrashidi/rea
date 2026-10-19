/**
 * The List view's moves besides dragging (SPEC-6 §1.4): selecting rows
 * (a row's checkbox toggles it, Shift selects the range from the last
 * toggled row, Ctrl/⌘-click on a row's name toggles it too), keyboard
 * moves of the focused row (Alt+↑ / Alt+↓ among its siblings, Alt+→ into
 * the previous sibling, Alt+← out of its parent), the row's "…" menu
 * (Move up, Move down, Make subtask of…, Move out of parent, Move to…)
 * and running a resolved drop (`moveRows`): the new parent is expanded
 * so the moved rows stay in sight, the move is announced and, after a
 * keyboard move, focus follows the row.
 *
 * `moveTools(view)` returns these for the view context; `view` holds the
 * list context (`prefs`, `change`, `actions`, `focusAfterRender`) and
 * the rendered `layout` (`listLayout`).
 */

import { announce } from "../components/announcer.js";
import { formDialog } from "../components/dialog.js";
import {
  keyboardTarget,
  moveMessage,
  parentChoices,
  resolveDrop,
  rowRange,
} from "./list-dnd-model.js";

/** "Move to…" another board arrives with Phase 3 (SPEC-6 §3.2). */
export const MOVE_TO_BOARD_SOON = "Coming soon: moving tasks to another board";
const KEY_WORDS = Object.freeze({
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowRight: "into the task above",
  ArrowLeft: "out of its parent",
});
const REFUSALS = Object.freeze({
  "own-subtree": "a task can’t go inside itself",
  "too-deep": "subtasks go at most 5 levels deep",
  "no-op": "it is already there",
  mixed: "the selection holds a task and its subtask",
});

/** The row a move of `itemId` lands in: its new group's key, or null. */
function landedGroup(view, resolution) {
  const { place } = resolution;
  if (place.group) return place.group.key;
  const parent = view.layout.rows.find((row) => row.item.id === place.parentId);
  return parent?.groupKey ?? null;
}

/** Runs `resolution` (an `ok` drop); `focus` keeps focus on the row. */
function moveRows(view, resolution, { focus = false } = {}) {
  const { place, moves } = resolution;
  if (place.parentId) view.prefs.expanded.set(place.parentId, true);
  const group = landedGroup(view, resolution);
  if (focus && group && moves.length === 1) {
    view.focusAfterRender(`list-open:${group}:${moves[0].itemId}`);
  }
  const message = moveMessage(view.layout, resolution);
  return view.actions.moveItems(moves, { message });
}

/** Moves the row `rowKey` by keyboard `key` (an arrow), or says why not. */
function keyMove(view, rowKey, key) {
  const row = view.layout.byKey.get(rowKey);
  if (!row) return;
  const target = keyboardTarget(view.layout, { rowKey, key });
  const resolution =
    target && resolveDrop(view.layout, { ids: [row.item.id], target });
  if (resolution?.ok) {
    moveRows(view, resolution, { focus: true });
    return;
  }
  const why = REFUSALS[resolution?.reason] ?? "there is nowhere to go";
  announce(`Can’t move “${row.item.name}” ${KEY_WORDS[key]}: ${why}`);
}

/** Asks which task `row`'s task becomes a subtask of, then moves it. */
async function pickParent(view, row) {
  const choices = parentChoices(view.layout, row.item.id);
  if (choices.length === 0) return;
  const indent = (depth) => "   ".repeat(depth);
  const values = await formDialog({
    title: `Make “${row.item.name}” a subtask`,
    submitLabel: "Make subtask",
    fields: [
      {
        name: "parent",
        label: "Parent task",
        autofocus: true,
        value: choices[0].item.id,
        options: choices.map(({ item, depth }) => ({
          value: item.id,
          label: `${indent(depth)}${item.name}`,
        })),
      },
    ],
  });
  if (!values?.parent) return;
  const target = { type: "parent", itemId: values.parent };
  const resolution = resolveDrop(view.layout, { ids: [row.item.id], target });
  if (resolution?.ok) moveRows(view, resolution, { focus: true });
}

/** The items of row `rowKey`'s "…" menu. */
function rowMenu(view, rowKey) {
  const row = view.layout.byKey.get(rowKey);
  if (!row) return [];
  const can = (key) => {
    const target = keyboardTarget(view.layout, { rowKey, key });
    const ids = [row.item.id];
    return Boolean(target && resolveDrop(view.layout, { ids, target })?.ok);
  };
  const item = (label, icon, key) => ({
    label,
    icon,
    disabled: !can(key),
    onSelect: () => keyMove(view, rowKey, key),
  });
  return [
    item("Move up", "chevronUp", "ArrowUp"),
    item("Move down", "chevronDown", "ArrowDown"),
    {
      label: "Make subtask of…",
      icon: "subtask",
      disabled: parentChoices(view.layout, row.item.id).length === 0,
      onSelect: () => pickParent(view, row),
    },
    item("Move out of parent", "chevronLeft", "ArrowLeft"),
    { type: "separator" },
    {
      label: "Move to…",
      icon: "arrowRight",
      disabledReason: MOVE_TO_BOARD_SOON,
    },
  ];
}

/**
 * Toggles row `rowKey`'s task in the selection, or with `range` selects
 * every row from the last toggled one to it.
 */
function select(view, rowKey, { range = false } = {}) {
  const row = view.layout.byKey.get(rowKey);
  if (!row) return;
  view.change((prefs) => {
    if (range && prefs.anchor) {
      for (const id of rowRange(view.layout, prefs.anchor, rowKey)) {
        prefs.selected.add(id);
      }
      return;
    }
    if (!prefs.selected.delete(row.item.id)) prefs.selected.add(row.item.id);
    prefs.anchor = rowKey;
  });
}

/** The move tools of the view context (see the module comment). */
export function moveTools(view) {
  return {
    moveRows: (resolution) => moveRows(view, resolution),
    keyMove: (rowKey, key) => keyMove(view, rowKey, key),
    rowMenu: (rowKey) => rowMenu(view, rowKey),
    select: (rowKey, options) => select(view, rowKey, options),
    clearSelection: () =>
      view.change((prefs) => {
        prefs.selected.clear();
        prefs.anchor = null;
      }),
  };
}
