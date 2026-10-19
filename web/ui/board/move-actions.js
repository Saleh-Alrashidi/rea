/**
 * Task moves (SPEC-6 §1.3–§1.5): `moveItems(requests, { message })` runs
 * `move_item` for each request (`move-model.js`) in order, after moving
 * the rows on screen at once (`applyMove`).
 *
 * - A refused call stops the run: the moves already made are put back
 *   (best effort), the refresh after the run restores the board and the
 *   error toast says why.
 * - A move that went through announces `message` in the polite live
 *   region and shows "Moved “Name”" with Undo for 8 s (`undo-toast.js`,
 *   shared with the sidebar's moves); Undo runs the way back recorded
 *   before the move (`undoMoves`).
 *
 * Moving tasks to another board (SPEC-6 §3.2) is `board-transfer.js`.
 */

import { announce } from "../components/announcer.js";
import { offerUndo } from "../components/undo-toast.js";
import { mutate } from "./board-data.js";
import { transferActions } from "./board-transfer.js";
import { applyMove, undoMoves } from "./move-model.js";

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
function undoToast(kit, { back, label }) {
  offerUndo({
    message: label,
    async undo() {
      if (await runMoves(kit, back)) announce("Move undone");
    },
  });
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
    ...transferActions(kit),
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
      undoToast(kit, { back, label });
      return true;
    },
  };
}
