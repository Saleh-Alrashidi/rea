/**
 * Moving tasks to another board (SPEC-6 §3.2, §3.3): the List view's
 * "Move to…" (a task's "…" menu and the bulk bar) and dropping task rows
 * on a List in the sidebar run `moveItemsToBoard(ids, { boardId })`.
 *
 * - Without a `boardId` a dialog asks for the board: every other board
 *   the user can edit, by Space.
 * - When the target lacks columns whose values the tasks hold
 *   (`droppedColumnsPreview`), a confirm lists them first.
 * - Each top-level task of the selection (`transferRoots`; subtasks go
 *   with their parent) moves with one `move_item_to_board`. The rows
 *   leave the list at once; a refused call stops the run with its error
 *   toast and the refresh restores what did not move.
 * - The toast names the target and the columns the server reports it
 *   dropped, with "Open" to go there.
 */

import { request } from "../../api.js";
import { boardHash } from "../../router.js";
import { announce } from "../components/announcer.js";
import { confirmDialog, formDialog } from "../components/dialog.js";
import { hasRole } from "../components/permissions.js";
import { showError, showToast } from "../components/toast.js";
import {
  droppedColumnsPreview,
  movedItems,
  tasksLabel,
  transferConfirm,
  transferMessage,
  transferRoots,
} from "./board-transfer-model.js";

export const TRANSFER_QUERIES = Object.freeze({
  targets: `query TransferTargets {
  workspaces { id name boards { id name my_access } }
}`,
  board: `query TransferBoard($ids: [ID!]) {
  boards(ids: $ids, limit: 1) { id name my_access columns { id title type role } }
}`,
});

export const MOVE_ITEM_TO_BOARD = `mutation MoveItemToBoard($itemId: ID!, $boardId: ID!) {
  move_item_to_board(item_id: $itemId, board_id: $boardId) {
    item { id }
    dropped_columns
  }
}`;

/** Asks which board to move to; resolves with its ID or null. */
async function pickBoard(currentId, label) {
  const data = await request(TRANSFER_QUERIES.targets);
  const options = data.workspaces.flatMap((workspace) =>
    workspace.boards
      .filter((board) => String(board.id) !== currentId)
      .filter((board) => hasRole(board.my_access, "editor"))
      .map((board) => ({
        value: String(board.id),
        label: `${board.name} · ${workspace.name}`,
      })),
  );
  if (options.length === 0) {
    showToast({ message: "There’s no other board you can edit." });
    return null;
  }
  const values = await formDialog({
    title: `Move ${label}`,
    submitLabel: "Move",
    fields: [
      {
        name: "boardId",
        label: "To board",
        autofocus: true,
        value: options[0].value,
        options,
      },
    ],
  });
  return values?.boardId || null;
}

/** The target board `{ id, name, columns }`, or null when it is gone. */
async function loadTarget(boardId) {
  const data = await request(TRANSFER_QUERIES.board, { ids: [boardId] });
  const board = data.boards[0];
  return board ? { ...board, id: String(board.id) } : null;
}

/** Runs the moves; resolves with the dropped column titles, or null. */
async function runTransfer(kit, { roots, moved, target }) {
  const { state } = kit;
  const gone = new Set(moved.map((item) => item.id));
  state.pendingMutations += 1;
  state.mutationSeq += 1;
  state.board.items = state.board.items.filter((item) => !gone.has(item.id));
  kit.render();
  const dropped = new Set();
  try {
    for (const item of roots) {
      const variables = { itemId: item.id, boardId: target.id };
      const data = await request(MOVE_ITEM_TO_BOARD, variables);
      for (const title of data.move_item_to_board.dropped_columns) {
        dropped.add(title);
      }
    }
    return [...dropped];
  } catch (error) {
    showError(error, "Couldn’t move the tasks");
    return null;
  } finally {
    state.pendingMutations -= 1;
    kit.refresh();
  }
}

/** Moves the tasks `ids` of the board (see the module comment). */
async function moveItemsToBoard(kit, ids, { boardId = null } = {}) {
  const board = kit.state.board;
  const roots = transferRoots(board.items, ids);
  if (roots.length === 0) return false;
  const targetId = boardId ?? (await pickBoard(board.id, tasksLabel(roots)));
  if (!targetId || targetId === board.id) return false;
  const target = await loadTarget(targetId);
  if (!target) {
    showToast({ message: "That board is no longer available.", type: "error" });
    return false;
  }
  const moved = movedItems(board.items, roots);
  const columns = droppedColumnsPreview({
    sourceColumns: board.columns,
    targetColumns: target.columns,
    items: moved,
  });
  if (columns.length > 0) {
    const confirm = transferConfirm({ roots, target, columns });
    if (!(await confirmDialog(confirm))) return false;
  }
  const dropped = await runTransfer(kit, { roots, moved, target });
  if (!dropped) return false;
  const message = transferMessage({ roots, target, dropped });
  announce(message);
  showToast({
    message,
    type: "success",
    timeout: 8000,
    action: {
      label: "Open",
      onClick: () => (globalThis.location.hash = boardHash(target.id)),
    },
  });
  return true;
}

/** The transfer action (`moveActions` adds it). */
export function transferActions(kit) {
  return {
    /**
     * Moves tasks `ids` (in display order) to board `boardId`, or to a
     * board the user picks; resolves with whether they moved.
     */
    moveItemsToBoard: (ids, options) =>
      moveItemsToBoard(kit, ids, options).catch((error) => {
        showError(error, "Couldn’t move the tasks");
        return false;
      }),
  };
}
