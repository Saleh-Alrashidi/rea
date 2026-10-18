/**
 * Event streams are bounded by who opened them: a browser session's
 * streams end with that session (SPEC-2 §4: logout ends the session), no
 * single user can hold every stream slot, one change computes each access
 * verdict once however many streams share it, and closing the servers
 * leaves no store listener behind.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createEventHub } from "../server/events.js";
import { startServers } from "../server/http.js";
import { createStore } from "../server/store.js";
import {
  fakeResponse,
  openStream,
  recordingLog,
  startTestServers,
} from "./helpers.js";

test("a browser session's streams end when it signs out or switches", async (t) => {
  const servers = await startTestServers();
  t.after(() => servers.close());
  const { ids, hostUrl, store } = servers;
  const priya = servers.sessionFor(ids.users.priya);
  const board = new URL(`/v2/events?board_id=${ids.boards.marketing}`, hostUrl);
  const inbox = new URL("/v2/events?stream=me", hostUrl);
  const streams = [
    await openStream(board, priya),
    await openStream(inbox, priya),
  ];
  t.after(() => streams.forEach((stream) => stream.close()));
  for (const stream of streams) await stream.next(/^: connected\n\n/);
  // Another session of the same user keeps its stream.
  const other = await openStream(inbox, servers.sessionFor(ids.users.priya));
  t.after(() => other.close());
  await other.next(/^: connected\n\n/);
  const logout = await fetch(new URL("/auth/logout", hostUrl), {
    method: "POST",
    headers: priya,
  });
  assert.equal(logout.status, 204);
  for (const stream of streams) await stream.ends();
  const [item] = store.listItems({ boardId: ids.boards.marketing }).items;
  store.renameItem(item.id, "Still live");
  assert.equal(other.response.status, 200);
  // Switching users (demo login) ends the old session's streams too.
  const sam = servers.sessionFor(ids.users.sam);
  const samStream = await openStream(inbox, sam);
  t.after(() => samStream.close());
  await samStream.next(/^: connected\n\n/);
  const switched = await fetch(new URL("/auth/demo-login", hostUrl), {
    method: "POST",
    headers: { ...sam, "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: ids.users.noa }),
  });
  await switched.body?.cancel();
  assert.equal(switched.status, 204);
  await samStream.ends();
});

test("a stream whose session expired ends at the next change", async () => {
  const store = await createStore({ file: null });
  const [board] = store.listBoards();
  let alive = true;
  const hub = createEventHub({ store, sessionActive: () => alive });
  const res = fakeResponse();
  const options = { boardId: board.id, userId: "1", sessionId: "s1" };
  assert.equal(hub.handle(null, res, options), true);
  store.updateBoard(board.id, { name: "Seen" });
  assert.match(res.writes.at(-1), /board_updated/);
  alive = false;
  store.updateBoard(board.id, { name: "Not seen" });
  assert.equal(res.writableEnded, true);
  assert.equal(hub.size, 0);
  hub.close();
});

test("one user cannot take every stream slot", async () => {
  const store = await createStore({ file: null });
  const hub = createEventHub({ store });
  const open = (userId) => {
    const res = fakeResponse();
    return { ok: hub.handle(null, res, { stream: "me", userId }), res };
  };
  const mine = Array.from({ length: 32 }, () => open("6"));
  assert.ok(mine.every((entry) => entry.ok));
  const refused = open("6");
  assert.equal(refused.ok, false);
  assert.equal(refused.res.status, 429);
  const [error] = JSON.parse(refused.res.body ?? "{}").errors ?? [];
  assert.equal(error?.extensions.code, "RATE_LIMITED");
  assert.equal(open("2").ok, true, "other users still connect");
  hub.endSession("none");
  assert.equal(hub.size, 33);
  hub.close();
});

test("one change computes each stream verdict once per user and board", async () => {
  const base = await createStore({ file: null });
  const counts = { getBoard: 0 };
  const store = Object.freeze({
    ...base,
    getBoard: (id) => {
      counts.getBoard += 1;
      return base.getBoard(id);
    },
  });
  const [board] = store.listBoards();
  const hub = createEventHub({ store });
  const responses = Array.from({ length: 30 }, () => fakeResponse());
  for (const res of responses) {
    hub.handle(null, res, { boardId: board.id, userId: "1" });
  }
  counts.getBoard = 0;
  base.updateBoard(board.id, { name: "Shared verdict" });
  assert.ok(counts.getBoard <= 2, `getBoard ran ${counts.getBoard} times`);
  assert.ok(
    responses.every((res) =>
      /Shared verdict|board_updated/.test(res.writes.at(-1)),
    ),
  );
  hub.close();
});

test("closing the servers removes their store listeners", async () => {
  const base = await createStore({ file: null });
  let listening = 0;
  const store = Object.freeze({
    ...base,
    on(listener) {
      listening += 1;
      const off = base.on(listener);
      return () => {
        listening -= 1;
        off();
      };
    },
  });
  for (let round = 0; round < 3; round += 1) {
    const servers = await startServers({
      store,
      hostPort: 0,
      appsPort: 0,
      log: recordingLog(),
    });
    await servers.close();
    assert.equal(listening, 0, `after round ${round + 1}`);
  }
});
