/**
 * `ctx.bus`: the app's event emitter for server-sent updates and shell
 * state. It owns the SSE connections: the signed-in user's notification
 * stream (started by `main.js`) and one reference-counted board stream per
 * watched board.
 *
 * Events (`bus.on(type, listener)`):
 *
 * | type           | data                                   | emitted by            |
 * | -------------- | -------------------------------------- | --------------------- |
 * | `notification` | the `stream=me` notification event     | the user stream       |
 * | `board-change` | a board change `{ type, board_id, … }` | watched board streams |
 * | `theme`        | `{ mode, theme }`                      | the theme toggle      |
 * | `shell`        | `{ workspaces }` after a shell refresh | `refreshShell()`      |
 * | `workspace`    | a workspace ID: pages announce the     | pages (board, doc, …) |
 * |                | workspace they show; the sidebar       |                       |
 * |                | switches to it                         |                       |
 */

const ID_PATTERN = /^\d{1,20}$/;

/** Event names the shell emits or listens to. */
export const BUS_EVENTS = Object.freeze({
  notification: "notification",
  boardChange: "board-change",
  theme: "theme",
  shell: "shell",
  workspace: "workspace",
});

function safeCall(listener, data) {
  try {
    listener(data);
  } catch (error) {
    globalThis.console?.error?.("Bus listener failed", error);
  }
}

/**
 * Creates the bus. `subscribeBoardEvents(boardId, onChange, onEnd) → close`
 * opens a board stream (`api.subscribeBoardEvents`; injectable for tests);
 * `onEnd()` reports that the server ended it for good.
 *
 * @param {{ subscribeBoardEvents(boardId: string,
 *   onChange: (change: object) => void, onEnd: () => void): () => void }} options
 */
export function createBus({ subscribeBoardEvents }) {
  const listeners = new Map();
  const boards = new Map();

  function on(type, listener) {
    if (typeof listener !== "function") {
      throw new TypeError("listener must be a function");
    }
    let set = listeners.get(type);
    if (!set) {
      set = new Set();
      listeners.set(type, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }

  function emit(type, data) {
    for (const listener of Array.from(listeners.get(type) ?? [])) {
      safeCall(listener, data);
    }
  }

  /** The server ended `entry`'s stream: drop it and tell its watchers. */
  function boardEnded(boardId, entry) {
    if (boards.get(boardId) !== entry) return;
    boards.delete(boardId);
    entry.close?.();
    for (const onEnd of Array.from(entry.ends)) safeCall(onEnd);
  }

  function openBoard(boardId) {
    const entry = { listeners: new Set(), ends: new Set(), close: null };
    boards.set(boardId, entry);
    const onChange = (change) => {
      const target = change.board_id;
      if (target !== undefined && String(target) !== boardId) return;
      for (const listener of Array.from(entry.listeners)) {
        safeCall(listener, change);
      }
      emit(BUS_EVENTS.boardChange, change);
    };
    try {
      entry.close = subscribeBoardEvents(boardId, onChange, () =>
        boardEnded(boardId, entry),
      );
    } catch (error) {
      globalThis.console?.error?.("Board events unavailable", error);
    }
    return entry;
  }

  /**
   * Calls `listener(change)` for every change of `boardId` (one shared
   * stream per board) and re-emits them as `board-change`; `onEnd()` runs
   * when the server ends the stream (the board was deleted or the user lost
   * access), after which a new `watchBoard` opens a fresh one. Returns
   * `unwatch()`; the stream closes with its last watcher.
   */
  function watchBoard(boardId, listener, onEnd = null) {
    const id = String(boardId);
    if (!ID_PATTERN.test(id)) throw new TypeError("boardId must be an ID");
    const entry = boards.get(id) ?? openBoard(id);
    entry.listeners.add(listener);
    if (onEnd) entry.ends.add(onEnd);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      entry.listeners.delete(listener);
      if (onEnd) entry.ends.delete(onEnd);
      if (entry.listeners.size > 0 || boards.get(id) !== entry) return;
      boards.delete(id);
      entry.close?.();
    };
  }

  /** Closes every board stream and drops all listeners. */
  function close() {
    for (const entry of boards.values()) entry.close?.();
    boards.clear();
    listeners.clear();
  }

  return { on, emit, watchBoard, close };
}
