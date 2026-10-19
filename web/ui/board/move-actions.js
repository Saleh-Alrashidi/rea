/**
 * Task moves (SPEC-6 §1.3–§1.5): `moveItems(requests, { message })` runs
 * `move_item` for each request (`move-model.js`) in order, after moving
 * the rows on screen at once (`applyMove`).
 *
 * - A refused call stops the run: the moves already made are put back
 *   (best effort), the refresh after the run restores the board and the
 *   error toast says why.
 * - A move that went through announces `message` in the polite live
 *   region and shows "Moved “Name”" with Undo for 8 s. Undo, or Ctrl/⌘+Z
 *   while that toast shows (and focus is not in a text field), runs the
 *   way back recorded before the move (`undoMoves`).
 *
 * Only the last move can be undone; a newer move replaces its toast.
 */

import { announce } from "../components/announcer.js";
import { showToast } from "../components/toast.js";
import { mutate } from "./board-data.js";
import { applyMove, undoMoves } from "./move-model.js";

/** How long a move can be undone (its toast shows). */
export const UNDO_MS = 8000;
/** Inputs whose own Ctrl/⌘+Z undoes typing. */
const TEXT_INPUTS =
  "textarea, select, input:not([type=checkbox]):not([type=radio])";

/** `{ undo(), dismiss() }` of the last move while its toast shows. */
let undoable = null;
let listening = false;

/** `move_item` variables of a move request. */
export function moveVariables(request, encodeValues) {
  return {
    itemId: request.itemId,
    afterId: request.afterId ?? null,
    beforeId: request.beforeId ?? null,
    parentId: typeof request.parentId === "string" ? request.parentId : null,
    detach: request.parentId === null,
    groupId: request.groupId ?? null,
    values: request.values ? encodeValues(request.values) : null,
  };
}

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
 * Runs `requests` with one optimistic change; resolves with the requests
 * that undo them, or null when the server refused one.
 */
async function runMoves(kit, requests) {
  const { state } = kit;
  const back = undoMoves(state.board, requests);
  const call = (request) => [
    "moveItem",
    moveVariables(request, kit.encodeValues),
  ];
  const done = await kit.runAll(requests.map(call), {
    optimistic() {
      for (const request of requests) {
        applyMove(state.board, request, state.users);
      }
    },
    async rollback(count) {
      const made = new Set(requests.slice(0, count).map((r) => r.itemId));
      for (const request of back.filter((r) => made.has(r.itemId))) {
        await mutate(...call(request)).catch(() => null);
      }
    },
  });
  return done === requests.length ? back : null;
}

/** Shows the undo toast of a move whose way back is `back`. */
function offerUndo(kit, { back, label }) {
  undoable?.dismiss();
  const entry = {
    toast: null,
    dismiss: () => entry.toast?.dismiss(),
    async undo() {
      entry.dismiss();
      if (await runMoves(kit, back)) announce("Move undone");
    },
  };
  undoable = entry;
  entry.toast = showToast({
    message: label,
    type: "info",
    timeout: UNDO_MS,
    action: { label: "Undo", onClick: () => entry.undo() },
    onDismiss() {
      if (undoable === entry) undoable = null;
    },
  });
  listenForUndoKey();
}

/** The toast text of moving `requests`: "Moved “Name”" or "Moved 3 tasks". */
function movedLabel(board, requests) {
  if (requests.length !== 1) return `Moved ${requests.length} tasks`;
  const item = board.items.find((entry) => entry.id === requests[0].itemId);
  return `Moved “${item?.name ?? "task"}”`;
}

/** The move actions (`createActions` adds them). */
export function moveActions(kit) {
  return {
    /**
     * Moves tasks (see the module comment); resolves with whether every
     * move went through.
     * @param {object[]} requests move requests (`move-model.js`)
     * @param {{ message?: string }} [options] what to announce
     */
    async moveItems(requests, { message = null } = {}) {
      if (requests.length === 0) return false;
      const label = movedLabel(kit.state.board, requests);
      const back = await runMoves(kit, requests);
      if (!back) return false;
      if (message) announce(message);
      offerUndo(kit, { back, label });
      return true;
    },
  };
}
