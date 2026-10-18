/**
 * The board page's reloads (`web/ui/board/board-sync.js`) against the real
 * servers: the catch-up reload after a board's stream opens redraws only
 * when the board changed, keeping the drawn page's objects (a redraw of a
 * wide imported board's table freezes the page for seconds), while every
 * other reload redraws, also when it is merged with a catch-up.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mutate } from "../web/ui/board/board-data.js";
import { createBoardSync } from "../web/ui/board/board-sync.js";
import { startTestServers } from "./helpers.js";

/** The UI's `request()` reaches the real `/v2` as Alex. */
async function signedIn(t) {
  const started = await startTestServers();
  t.after(() => started.close());
  const original = globalThis.fetch;
  const headers = started.sessionFor(started.ids.users.alex);
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

function syncFor(boardId) {
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
    watchBoard: () => () => {},
    refreshShell() {},
  });
  return { state, draws, sync };
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
