/**
 * The board page's reloads (`web/ui/board/board-sync.js`) against the real
 * servers: the catch-up reload after a board's stream opens redraws only
 * when the board changed, keeping the drawn page's objects (a redraw of a
 * wide imported board's table freezes the page for seconds), while every
 * other reload redraws, also when it is merged with a catch-up. An open
 * task that moves to another board reports where it went, or that the
 * user cannot follow it (SPEC-6 §3.2).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mutate } from "../web/ui/board/board-data.js";
import { createBoardSync } from "../web/ui/board/board-sync.js";
import { startTestServers } from "./helpers.js";

/** The UI's `request()` reaches the real `/v2` as `user` (Alex). */
async function signedIn(t, user = "alex") {
  const started = await startTestServers();
  t.after(() => started.close());
  const original = globalThis.fetch;
  const headers = started.sessionFor(started.ids.users[user]);
  globalThis.fetch = (url, init = {}) =>
    original(new URL(url, started.hostOrigin), {
      ...init,
      headers: { ...init.headers, ...headers },
    });
  t.after(() => {
    globalThis.fetch = original;
  });
  return started;
}

function syncFor(boardId, { watchBoard = () => () => {} } = {}) {
  const moves = [];
  const state = {
    boardId,
    board: null,
    boardStatus: "loading",
    card: null,
    pendingMutations: 0,
    mutationSeq: 0,
    refreshFailed: false,
  };
  const draws = [];
  const sync = createBoardSync({
    state,
    render: (parts) => draws.push(parts ?? "all"),
    forwardEvent() {},
    watchBoard,
    refreshShell() {},
    onTaskMoved: (moved) => moves.push(moved),
  });
  return { state, draws, sync, moves };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

test("the catch-up reload redraws only a changed board", async (t) => {
  const { ids } = await signedIn(t);
  const { state, draws, sync } = syncFor(ids.boards.roadmap);
  await sync.refresh();
  assert.deepEqual(draws, ["all"]);
  const drawn = state.board;
  await sync.refresh({ ifChanged: true });
  assert.deepEqual(draws, ["all", ["card"]], "nothing changed: card only");
  assert.equal(state.board, drawn, "the drawn objects stay");
  const item = drawn.items[0];
  await mutate("renameItem", {
    boardId: ids.boards.roadmap,
    itemId: item.id,
    value: "Renamed elsewhere",
  });
  await sync.refresh({ ifChanged: true });
  assert.deepEqual(draws.at(-1), "all", "a change redraws");
  assert.notEqual(state.board, drawn);
  const renamed = state.board.items.find((entry) => entry.id === item.id);
  assert.equal(renamed.name, "Renamed elsewhere");
  await sync.refresh();
  assert.deepEqual(draws.at(-1), "all", "a plain reload always redraws");
});

test("a scheduled reload merged with a catch-up still redraws", async (t) => {
  const { ids } = await signedIn(t);
  const { draws, sync } = syncFor(ids.boards.roadmap);
  await sync.refresh();
  sync.scheduleRefresh();
  sync.scheduleRefresh({ ifChanged: true });
  await settle();
  assert.deepEqual(draws, ["all", "all"]);
  sync.scheduleRefresh({ ifChanged: true });
  await settle();
  assert.deepEqual(draws, ["all", "all", ["card"]]);
  sync.destroy();
});

/**
 * The roadmap's sync for `user` with the task `pick(items)` open, its
 * stream fed by the store's changes; `moves` records `onTaskMoved`.
 */
async function openTask(t, { user, pick }) {
  const started = await signedIn(t, user);
  const { store, ids } = started;
  const listeners = [];
  const unsubscribe = store.on((change) => listeners.forEach((l) => l(change)));
  t.after(unsubscribe);
  const watchBoard = (_boardId, listener) => {
    listeners.push(listener);
    return () => {};
  };
  const roadmap = ids.boards.roadmap;
  const { state, sync, moves } = syncFor(roadmap, { watchBoard });
  t.after(() => sync.destroy());
  const items = store.listItems({ boardId: roadmap }).items;
  const item = pick(items);
  state.card = { itemId: item.id, updates: {} };
  sync.subscribe(roadmap);
  return { ...started, item, items, state, moves };
}

const moveTo = ({ store, ids }, item, boardId) =>
  store.moveItemToBoard(item.id, { boardId }, { actorId: ids.users.alex });

test("an open task that moves to a board the user can open is followed there", async (t) => {
  const run = await openTask(t, { user: "alex", pick: (items) => items[0] });
  const { ids, moves, item, items } = run;
  // Another task's move does not concern the open task.
  moveTo(run, items[1], ids.boards.budget);
  await settle();
  assert.deepEqual(moves, []);
  moveTo(run, item, ids.boards.budget);
  await settle();
  assert.deepEqual(moves, [{ itemId: item.id, boardId: ids.boards.budget }]);
});

test("an open subtask whose parent moves where the user cannot follow is reported as such", async (t) => {
  // Sam cannot open Budget 2027 in the closed Leadership Space.
  const run = await openTask(t, { user: "sam", pick: (items) => items[2] });
  const { ids, moves, store, state, item: parent } = run;
  const child = store.createItem({
    boardId: ids.boards.roadmap,
    name: "Child",
    parentId: parent.id,
  });
  state.card = { itemId: child.id, updates: {} };
  moveTo(run, parent, ids.boards.budget);
  await settle();
  assert.deepEqual(moves, [{ itemId: child.id, boardId: null }]);
});
