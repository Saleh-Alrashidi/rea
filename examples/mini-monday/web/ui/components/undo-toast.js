/**
 * The undo toast of moves (SPEC-6 §1.4, §3.3): "Moved “Name” · Undo" for
 * 8 s. Undo, or Ctrl/⌘+Z while the toast shows (and focus is not in a
 * text field, whose own Ctrl/⌘+Z undoes typing), runs the way back the
 * caller recorded before the move. Only the last move can be undone:
 * a newer one replaces its toast. List and Kanban task moves and
 * sidebar moves share this one slot.
 *
 * ```js
 * offerUndo({ message: "Moved “Roadmap”", undo: () => moveBack() });
 * ```
 */

import { showToast } from "./toast.js";

/** How long a move can be undone (its toast shows). */
export const UNDO_MS = 8000;
const TEXT_INPUTS =
  "textarea, select, input:not([type=checkbox]):not([type=radio])";

/** `{ undo(), dismiss() }` of the last move while its toast shows. */
let undoable = null;
let listening = false;

function onUndoKey(event) {
  if (!undoable || event.altKey || event.shiftKey) return;
  if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z") {
    return;
  }
  const target = event.target;
  if (target?.isContentEditable || target?.matches?.(TEXT_INPUTS)) return;
  event.preventDefault();
  undoable.undo();
}

function listenForUndoKey() {
  if (listening) return;
  listening = true;
  globalThis.document.addEventListener("keydown", onUndoKey);
}

/**
 * Shows the undo toast `message`; `undo()` runs once, from the toast's
 * button or Ctrl/⌘+Z, while it shows.
 * @param {{ message: string, undo: () => unknown }} options
 */
export function offerUndo({ message, undo }) {
  undoable?.dismiss();
  const entry = {
    toast: null,
    done: false,
    dismiss: () => entry.toast?.dismiss(),
    undo() {
      if (entry.done) return;
      entry.done = true;
      entry.dismiss();
      undo();
    },
  };
  undoable = entry;
  entry.toast = showToast({
    message,
    type: "info",
    timeout: UNDO_MS,
    action: { label: "Undo", onClick: () => entry.undo() },
    onDismiss() {
      if (undoable === entry) undoable = null;
    },
  });
  listenForUndoKey();
}
