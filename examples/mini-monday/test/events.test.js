/**
 * Server-sent events: the /v2/events route (auth, filtering, cleanup on
 * close), the hub itself (heartbeats, disconnects, stalled readers) and the
 * servers' close() lifecycle.
 */
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { createEventHub } from "../server/events.js";
import { createStore } from "../server/store.js";
import {
  browserSession,
  gql,
  startTestServers,
  storeWithToken,
} from "./helpers.js";

const CHANGE = /event: change\ndata: (.*)\n\n/;

/**
 * Opens an SSE stream with fetch. `next(pattern)` reads until `pattern`
 * matches the unread text, consumes through the match and returns it.
 */
async function openStream(url, headers = {}) {
  const controller = new AbortController();
  const response = await fetch(url, { headers, signal: controller.signal });
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let unread = "";
  let ended = false;
  // A read that lost a race against the timeout is kept for the next call.
  let pending = null;
  const next = async (pattern, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const match = pattern.exec(unread);
      if (match) {
        unread = unread.slice(match.index + match[0].length);
        return match;
      }
      if (ended) throw new Error(`stream ended before ${pattern}`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out waiting for ${pattern}`);
      let timer;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(resolve, left, null);
      });
      pending ??= reader.read();
      const chunk = await Promise.race([pending, timeout]);
      clearTimeout(timer);
      if (chunk === null) continue;
      pending = null;
      if (chunk.done) ended = true;
      else unread += decoder.decode(chunk.value, { stream: true });
    }
  };
  const ends = async () => {
    if (pending) ended ||= (await pending).done;
    pending = null;
    while (!ended) ended = (await reader.read()).done;
  };
  return { response, next, ends, close: () => controller.abort() };
}

async function setup(t) {
  const store = await createStore({ file: null });
  const scopes = ["storage:read"];
  const record = { token: "storage-only-token", user_id: "1", scopes };
  const view = storeWithToken(store, { ...record, label: "storage" });
  const servers = await startTestServers({ store: view });
  t.after(() => servers.close());
  const boards = servers.store.listBoards();
  const [roadmap, marketing] = boards;
  const url = (boardId) =>
    new URL(`/v2/events?board_id=${boardId}`, servers.hostUrl);
  const auth = { Authorization: `Bearer ${servers.tokens.readOnly}` };
  const createItem = (board, name) =>
    gql(servers.hostUrl, {
      query: `mutation C($b: ID!, $n: String!) {
        create_item(board_id: $b, item_name: $n) { id } }`,
      variables: { b: board.id, n: name },
      token: servers.tokens.readWrite,
    });
  return { ...servers, roadmap, marketing, url, auth, createItem };
}

test("a board stream receives that board's changes after mutations", async (t) => {
  const { url, auth, roadmap, marketing, createItem } = await setup(t);
  const stream = await openStream(url(roadmap.id), auth);
  t.after(() => stream.close());
  assert.equal(stream.response.status, 200);
  const headers = stream.response.headers;
  assert.equal(headers.get("content-type"), "text/event-stream");
  assert.equal(headers.get("cache-control"), "no-store");
  assert.equal(headers.get("x-content-type-options"), "nosniff");
  await stream.next(/^: connected\n\n/);
  const created = await createItem(roadmap, "Live item");
  const itemId = created.body.data.create_item.id;
  const [, data] = await stream.next(CHANGE);
  assert.deepEqual(JSON.parse(data), {
    type: "item_created",
    board_id: roadmap.id,
    item_id: itemId,
    group_id: "this_sprint",
  });
  // Another board's change is never delivered to this stream.
  await createItem(marketing, "Elsewhere");
  await createItem(roadmap, "Second");
  const [, second] = await stream.next(CHANGE);
  assert.equal(JSON.parse(second).board_id, roadmap.id);
  assert.notEqual(JSON.parse(second).item_id, itemId);
});

test("event stream auth, board validation and methods", async (t) => {
  const { url, auth, roadmap, hostUrl, hostOrigin, tokens } = await setup(t);
  const status = async (target, headers, init = {}) => {
    const response = await fetch(target, { headers, ...init });
    await response.body?.cancel();
    return response.status;
  };
  const board = url(roadmap.id);
  assert.equal(await status(board, {}), 401);
  assert.equal(await status(board, { Authorization: "Bearer nope" }), 401);
  const { Cookie } = await browserSession(hostUrl);
  assert.equal(await status(board, { Cookie }), 403);
  const crossSite = { Cookie, "Sec-Fetch-Site": "cross-site" };
  assert.equal(await status(board, crossSite), 403);
  const foreign = { Cookie, Origin: "http://127.0.0.1:1" };
  assert.equal(await status(board, foreign), 403);
  const sameOrigin = { Cookie, "Sec-Fetch-Site": "same-origin" };
  assert.equal(await status(board, sameOrigin), 200);
  assert.equal(await status(board, { Cookie, Origin: hostOrigin }), 200);
  const token = { Authorization: tokens.readWrite };
  assert.equal(await status(board, token), 200);
  assert.equal(await status(url("999999"), auth), 404);
  assert.equal(await status(url("abc"), auth), 400);
  const storageOnly = { Authorization: "storage-only-token" };
  assert.equal(await status(board, storageOnly), 403);
  const missing = new URL("/v2/events", hostUrl);
  assert.equal(await status(missing, auth), 400);
  const post = await fetch(board, { method: "POST", headers: auth });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET");
});

test("servers.close() ends open streams", async (t) => {
  const servers = await setup(t);
  const stream = await openStream(
    servers.url(servers.roadmap.id),
    servers.auth,
  );
  await stream.next(/: connected\n\n/);
  const started = Date.now();
  await Promise.all([servers.close(), stream.ends()]);
  assert.ok(Date.now() - started < 900, "no forced-close grace period needed");
});

/** A plain HTTP server that hands every request to `hub`. */
async function hubServer(t, hub, boardId) {
  const server = createServer((req, res) => hub.handle(req, res, { boardId }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    hub.close();
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${server.address().port}/`;
}

test("the hub sends heartbeats and filters by board", async (t) => {
  const store = await createStore({ file: null });
  const [board, other] = store.listBoards();
  const hub = createEventHub({ store, heartbeatMs: 20 });
  const stream = await openStream(await hubServer(t, hub, board.id));
  await stream.next(/^: connected\n\n/);
  await stream.next(/^: heartbeat\n\n/);
  await stream.next(/^: heartbeat\n\n/);
  assert.equal(hub.size, 1);
  store.updateBoard(other.id, { name: "Not this board" });
  store.updateBoard(board.id, { name: "Renamed" });
  const [, data] = await stream.next(CHANGE);
  const updated = { type: "board_updated", board_id: board.id };
  assert.deepEqual(JSON.parse(data), updated);
  stream.close();
});

test("the hub drops disconnected clients and refuses streams once closed", async (t) => {
  const store = await createStore({ file: null });
  const [board] = store.listBoards();
  // No heartbeat runs during the test, so only the close event cleans up.
  const hub = createEventHub({ store, heartbeatMs: 60_000 });
  const url = await hubServer(t, hub, board.id);
  const stream = await openStream(url);
  await stream.next(/: connected/);
  assert.equal(hub.size, 1);
  stream.close();
  for (let tries = 0; hub.size > 0 && tries < 100; tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(hub.size, 0, "a disconnected client is dropped");
  const other = await openStream(url);
  await other.next(/: connected/);
  hub.close();
  await other.ends();
  assert.equal(hub.size, 0);
  const late = await fetch(url);
  assert.equal(late.status, 503);
  const body = await late.json();
  assert.equal(body.errors[0].extensions.code, "SERVICE_UNAVAILABLE");
});

/** A minimal response double that records writes. */
function fakeResponse() {
  const res = new EventEmitter();
  Object.assign(res, { writableLength: 0, writes: [], destroyed: false });
  res.writableEnded = false;
  res.writeHead = (status, headers) => Object.assign(res, { status, headers });
  res.flushHeaders = () => {};
  res.write = (text) => res.writes.push(text);
  res.end = () => (res.writableEnded = true);
  res.destroy = () => (res.destroyed = true);
  return res;
}

test("a stalled reader is disconnected instead of buffering forever", async () => {
  const store = await createStore({ file: null });
  const [board] = store.listBoards();
  const hub = createEventHub({ store });
  const res = fakeResponse();
  assert.equal(hub.handle(null, res, { boardId: board.id }), true);
  assert.equal(res.status, 200);
  assert.deepEqual(res.writes, [": connected\n\n"]);
  res.writableLength = 2 * 1024 * 1024;
  store.updateBoard(board.id, { name: "Again" });
  assert.equal(res.destroyed, true);
  assert.equal(hub.size, 0);
  store.updateBoard(board.id, { name: "Once more" });
  assert.equal(res.writes.length, 2, "no writes after the drop");
  hub.close();
  assert.throws(() => createEventHub({}), TypeError);
  assert.throws(() => createEventHub({ store, heartbeatMs: 0 }), TypeError);
});

test("close() ends connections, is idempotent and frees the ports", async () => {
  const servers = await startTestServers();
  const response = await fetch(new URL("/main.js", servers.hostUrl));
  await response.text();
  const first = servers.close();
  assert.equal(servers.close(), first);
  await first;
  await assert.rejects(fetch(new URL("/main.js", servers.hostUrl)));
  await assert.rejects(
    startTestServers({ hostOrigin: "localhost:1" }),
    TypeError,
  );
  const same = {
    hostOrigin: "http://localhost:1",
    appsOrigin: "http://localhost:1",
  };
  await assert.rejects(startTestServers(same), /must differ/);
});
