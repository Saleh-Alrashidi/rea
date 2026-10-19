/**
 * Keeps the open board current: single-flight board reloads (with stale
 * results discarded), the open task's detail and the board's
 * server-sent change stream (through `ctx.bus.watchBoard`; debounced
 * refresh on each change). Board renames and deletions refresh the shell.
 * When the server ends the stream (the user lost access, the board was
 * deleted) the board reloads at once, so the page shows what is left,
 * and the shell refreshes its board lists. When the board is still there
 * afterwards, its stream was refused (too many open streams) or ended for
 * another reason: `onLivePaused()` reports that live updates stopped.
 * When the open task moves to another board (`item_moved_to_board`, also
 * for a subtask whose parent moved), `onTaskMoved({ itemId, boardId })`
 * says where it is now: `boardId` null when the user cannot open it there.
 */

import { showError } from "../components/toast.js";
import { loadBoard, loadItem, loadItemBoardId } from "./board-data.js";
import { loadUpdates } from "./updates-data.js";

const REFRESH_DELAY_MS = 250;
/** Board events about item updates (`store/updates.js`). */
const UPDATE_EVENTS = new Set([
  "update_created",
  "update_edited",
  "update_deleted",
  "update_liked",
]);

/** A failed reload: an error page before the first load, else one toast. */
function refreshFailed(state, render, error) {
  if (!state.board) {
    state.boardStatus = "error";
    render();
    return;
  }
  if (!state.refreshFailed) showError(error, "Couldn’t refresh the board");
  state.refreshFailed = true;
}

/**
 * Single-flight board reloads around `reload(always)`. `refresh()` reloads
 * and redraws the page; `refresh({ ifChanged: true })` redraws only when
 * the board changed (a no-op redraw of a wide board's table freezes the
 * page). Calls during a reload are merged into one more, which redraws if
 * any merged call asked to; `scheduleRefresh(options)` is a debounced
 * `refresh` merged the same way.
 */
function createReloads(reload) {
  let timer = null;
  let running = null;
  let again = false;
  // Whether a reload asked for (and not yet run) must redraw the page.
  let drawAlways = false;
  let scheduledAlways = false;

  function refresh({ ifChanged = false } = {}) {
    if (!ifChanged) drawAlways = true;
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          const always = drawAlways;
          drawAlways = false;
          await reload(always);
        } while (again);
      } finally {
        running = null;
      }
    })();
    return running;
  }

  function scheduleRefresh({ ifChanged = false } = {}) {
    if (!ifChanged) scheduledAlways = true;
    globalThis.clearTimeout(timer);
    timer = globalThis.setTimeout(() => {
      const options = { ifChanged: !scheduledAlways };
      scheduledAlways = false;
      refresh(options);
    }, REFRESH_DELAY_MS);
  }

  return {
    refresh,
    scheduleRefresh,
    cancel: () => globalThis.clearTimeout(timer),
  };
}

/**
 * Reports where the open task went (`onTaskMoved`) when `change` moved it
 * to another board, unless the page moved on meanwhile (`current()`
 * false, another task open) or it is back on this board.
 */
async function followMovedTask({ state, current, onTaskMoved }, change) {
  const { card } = state;
  if (!card || card.itemId !== String(change.item_id)) return;
  let boardId = null;
  try {
    boardId = await loadItemBoardId(card.itemId);
  } catch (error) {
    globalThis.console?.error?.("Couldn’t find the moved task", error);
  }
  if (!current() || state.card !== card || boardId === state.boardId) return;
  onTaskMoved?.({ itemId: card.itemId, boardId });
}

/**
 * Creates the sync controller for the board page `state`.
 * `forwardEvent(change)` receives every change of the open board (for app
 * views); `watchBoard(boardId, listener, onEnd) → unwatch` is `ctx.bus.watchBoard`
 * and `refreshShell()` reloads the sidebar's board lists.
 *
 * @param {{ state: object, render(parts?: string[]): void,
 *   forwardEvent(change: object): void,
 *   watchBoard(boardId: string, listener: (change: object) => void,
 *     onEnd: () => void): () => void,
 *   refreshShell(): void, onLivePaused?(): void,
 *   onTaskMoved?(moved: { itemId: string, boardId: string | null }): void }} options
 */
export function createBoardSync(options) {
  const { state, render, forwardEvent, watchBoard, refreshShell } = options;
  let events = { boardId: null, close: null };
  let destroyed = false;
  const reloads = createReloads((always) => reloadBoard(always));
  const { refresh, scheduleRefresh } = reloads;

  async function reloadBoard(always) {
    const { boardId, mutationSeq } = state;
    if (!boardId || destroyed) return;
    let board;
    try {
      board = await loadBoard(boardId);
    } catch (error) {
      if (boardId === state.boardId) refreshFailed(state, render, error);
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
    // An unchanged board keeps its objects, which the drawn page refers to.
    const unchanged =
      !always &&
      board !== null &&
      state.board !== null &&
      JSON.stringify(board) === JSON.stringify(state.board);
    if (!unchanged) state.board = board;
    state.boardStatus = board ? "ready" : "missing";
    if (state.card && board) await reloadCard();
    if (boardId === state.boardId) render(unchanged ? ["card"] : undefined);
  }

  /**
   * Loads the open task and its updates side by side; a failed updates
   * load keeps the updates shown, or marks them "error" when there are
   * none. `card.updates` (`{ status, list, hasMore, limit, cursor,
   * threads, pageSize }`) is passed live: `loadUpdates` reloads what it
   * shows and pages back to a route target (`card.target`) not shown.
   */
  async function reloadCard() {
    const { card } = state;
    if (!card || !state.board) return;
    const target = card.target?.id ?? null;
    const [detail, updates] = await Promise.allSettled([
      loadItem(card.itemId, state.board.columns),
      loadUpdates(card.itemId, { shown: card.updates, target }),
    ]);
    if (state.card !== card) return;
    if (detail.status === "rejected") {
      if (!card.detail) card.status = "error";
    } else {
      const found = detail.value;
      const belongs = found !== null && found.boardId === state.boardId;
      card.detail = belongs ? found : null;
      card.status = belongs ? "ready" : "missing";
    }
    if (updates.status === "fulfilled" && updates.value) {
      card.updates = { ...card.updates, ...updates.value, status: "ready" };
    } else if (!card.updates.list) card.updates.status = "error";
  }

  function onBoardEvent(change) {
    const boardId = change.board_id;
    if (boardId !== undefined && String(boardId) !== state.boardId) return;
    forwardEvent(change);
    const left =
      change.type === "item_moved_to_board" && change.to_board_id !== undefined;
    if (left) {
      const current = () => !destroyed;
      followMovedTask(
        { state, current, onTaskMoved: options.onTaskMoved },
        change,
      );
    }
    if (change.type === "board_updated" || change.type === "board_deleted") {
      refreshShell();
    }
    // An update's change (SPEC-6 §2.4) reloads the open task; the board's
    // views redraw only if the board changed (an update count).
    scheduleRefresh({ ifChanged: UPDATE_EVENTS.has(change.type) });
  }

  function subscribe(boardId) {
    if (events.boardId === boardId) return;
    events.close?.();
    events = { boardId, close: null };
    if (!boardId) return;
    const ended = async () => {
      if (events.boardId !== boardId) return;
      // A later subscribe() may open a new stream.
      events = { boardId: null, close: null };
      if (destroyed) return;
      refreshShell();
      await refresh();
      const open = state.boardId === boardId && state.boardStatus === "ready";
      if (!destroyed && open) options.onLivePaused?.();
    };
    try {
      events.close = watchBoard(boardId, onBoardEvent, ended);
    } catch (error) {
      globalThis.console?.error?.("Board events unavailable", error);
    }
  }

  /** Stops the stream and discards results that are still in flight. */
  function destroy() {
    destroyed = true;
    reloads.cancel();
    events.close?.();
    events = { boardId: null, close: null };
  }

  return { refresh, scheduleRefresh, reloadCard, subscribe, destroy };
}
