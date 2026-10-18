/**
 * Keeps the open board current: single-flight board reloads (with stale
 * results discarded), the open item card's detail and the board's
 * server-sent change stream (through `ctx.bus.watchBoard`; debounced
 * refresh on each change). Board renames and deletions refresh the shell.
 */

import { showError } from "../components/toast.js";
import { loadBoard, loadItem } from "./board-data.js";

const REFRESH_DELAY_MS = 250;

/**
 * Creates the sync controller for the board page `state`.
 * `forwardEvent(change)` receives every change of the open board (for app
 * views); `watchBoard(boardId, listener) → unwatch` is `ctx.bus.watchBoard`
 * and `refreshShell()` reloads the sidebar's board lists.
 *
 * @param {{ state: object, render(parts?: string[]): void,
 *   forwardEvent(change: object): void,
 *   watchBoard(boardId: string, listener: (change: object) => void): () => void,
 *   refreshShell(): void }} options
 */
export function createBoardSync(options) {
  const { state, render, forwardEvent, watchBoard, refreshShell } = options;
  let events = { boardId: null, close: null };
  let destroyed = false;
  let refreshTimer = null;
  let refreshing = null;
  let refreshAgain = false;

  function refresh() {
    if (refreshing) {
      refreshAgain = true;
      return refreshing;
    }
    refreshing = (async () => {
      try {
        do {
          refreshAgain = false;
          await reloadBoard();
        } while (refreshAgain);
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  function scheduleRefresh() {
    globalThis.clearTimeout(refreshTimer);
    refreshTimer = globalThis.setTimeout(refresh, REFRESH_DELAY_MS);
  }

  function handleRefreshError(error) {
    if (!state.board) {
      state.boardStatus = "error";
      render();
      return;
    }
    if (!state.refreshFailed) showError(error, "Couldn’t refresh the board");
    state.refreshFailed = true;
  }

  async function reloadBoard() {
    const { boardId, mutationSeq } = state;
    if (!boardId || destroyed) return;
    let board;
    try {
      board = await loadBoard(boardId);
    } catch (error) {
      if (boardId === state.boardId) handleRefreshError(error);
      return;
    }
    // Discard stale results: another board, or a mutation started meanwhile
    // (its completion triggers another refresh).
    const stale =
      destroyed ||
      boardId !== state.boardId ||
      mutationSeq !== state.mutationSeq ||
      state.pendingMutations > 0;
    if (stale) return;
    state.refreshFailed = false;
    state.board = board;
    state.boardStatus = board ? "ready" : "missing";
    if (state.card && board) await reloadCard();
    if (boardId === state.boardId) render();
  }

  async function reloadCard() {
    const { card } = state;
    if (!card || !state.board) return;
    try {
      const detail = await loadItem(card.itemId, state.board.columns);
      if (state.card !== card) return;
      const belongs = detail !== null && detail.boardId === state.boardId;
      card.detail = belongs ? detail : null;
      card.status = belongs ? "ready" : "missing";
    } catch {
      if (state.card === card && !card.detail) card.status = "error";
    }
  }

  function onBoardEvent(change) {
    const boardId = change.board_id;
    if (boardId !== undefined && String(boardId) !== state.boardId) return;
    forwardEvent(change);
    if (change.type === "board_updated" || change.type === "board_deleted") {
      refreshShell();
    }
    scheduleRefresh();
  }

  function subscribe(boardId) {
    if (events.boardId === boardId) return;
    events.close?.();
    events = { boardId, close: null };
    if (!boardId) return;
    try {
      events.close = watchBoard(boardId, onBoardEvent);
    } catch (error) {
      globalThis.console?.error?.("Board events unavailable", error);
    }
  }

  /** Stops the stream and discards results that are still in flight. */
  function destroy() {
    destroyed = true;
    globalThis.clearTimeout(refreshTimer);
    events.close?.();
    events = { boardId: null, close: null };
  }

  return { refresh, scheduleRefresh, reloadCard, subscribe, destroy };
}
