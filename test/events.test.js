/**
 * Server-sent events: the /v2/events route (auth, filtering, board access
 * per user, streams that end when access is lost, the `stream=me`
 * notification stream, cleanup on close), the hub itself (heartbeats,
 * disconnects, stalled readers) and the servers' close() lifecycle.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { createEventHub } from "../server/events.js";
import { createStore } from "../server/store.js";
import {
  SEED_USERS,
  browserSession,
  fakeResponse,
  gql,
  openStream,
  plainText,
  seedKeys,
  seedRole,
  startTestServers,
  storeWithToken,
} from "./helpers.js";

const CHANGE = /event: change\ndata: (.*)\n\n/;
const NOTIFICATION = /event: notification\ndata: (.*)\n\n/;

async function setup(t) {
  const store = await createStore({ file: null });
  const scopes = ["storage:read"];
  const record = { token: "storage-only-token", user_id: "1", scopes };
  const view = storeWithToken(store, { ...record, label: "storage" });
  const servers = await startTestServers({ store: view });
  t.after(() => servers.close());
  const { getBoard } = servers.store;
  const roadmap = getBoard(servers.ids.boards.roadmap);
  // Another board the token's user (Alex) can write to.
  const other = getBoard(servers.ids.boards.budget);
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
  return { ...servers, roadmap, other, url, auth, createItem };
}

test("a board stream receives that board's changes after mutations", async (t) => {
  const { url, auth, roadmap, other, createItem } = await setup(t);
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
  await createItem(other, "Elsewhere");
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

test("board streams need board access; hidden boards are 404 like unknown ones", async (t) => {
  const { url, ids, sessionFor, tokenFor } = await setup(t);
  const status = async (target, headers) => {
    const response = await fetch(target, { headers });
    await response.body?.cancel();
    return response.status;
  };
  for (const user of SEED_USERS.filter((key) => key !== "morgan")) {
    const session = sessionFor(ids.users[user]);
    const token = { Authorization: tokenFor(ids.users[user]) };
    for (const key of seedKeys("board")) {
      const want = seedRole("board", key, user) === null ? 404 : 200;
      const board = url(ids.boards[key]);
      assert.equal(await status(board, session), want, `${user} ${key}`);
      assert.equal(await status(board, token), want, `${user} token ${key}`);
    }
  }
  const morgan = { Authorization: tokenFor(ids.users.morgan) };
  assert.equal(await status(url(ids.boards.roadmap), morgan), 401);
});

const shareBoard = (store, { board, user, actor }) =>
  store.share({
    resourceKind: "board",
    resourceId: board,
    subjectKind: "user",
    subjectIds: [user],
    role: "viewer",
    actorId: actor,
  });

test("a board stream ends when its user loses access or the board goes", async (t) => {
  const { url, ids, sessionFor, store } = await setup(t);
  const { marketing } = ids.boards;
  const { sam, priya, jordan } = ids.users;
  shareBoard(store, { board: marketing, user: sam, actor: priya });
  const stream = await openStream(url(marketing), sessionFor(sam));
  t.after(() => stream.close());
  assert.equal(stream.response.status, 200);
  await stream.next(/^: connected\n\n/);
  store.createItem({ boardId: marketing, name: "Seen", creatorId: priya });
  const [, data] = await stream.next(CHANGE);
  assert.equal(JSON.parse(data).type, "item_created");
  store.unshare({
    resourceKind: "board",
    resourceId: marketing,
    subjectKind: "user",
    subjectId: sam,
    actorId: priya,
  });
  assert.equal(await stream.ends(), "", "the removal itself is not sent");
  // Deactivation ends a viewer's stream on a public board.
  const viewer = await openStream(url(ids.boards.roadmap), sessionFor(jordan));
  await viewer.next(/: connected/);
  store.deactivateUser(jordan);
  await viewer.ends();
  // The owner sees the deletion, then the stream ends.
  const owner = await openStream(url(marketing), sessionFor(priya));
  await owner.next(/: connected/);
  store.deleteBoard(marketing);
  const [, gone] = await owner.next(CHANGE);
  assert.deepEqual(JSON.parse(gone), {
    type: "board_deleted",
    board_id: marketing,
  });
  await owner.ends();
});

test("stream=me delivers the user's own notification events only", async (t) => {
  const { ids, sessionFor, store, hostUrl, as, tokenFor } = await setup(t);
  const { sam, noa, priya, alex } = ids.users;
  const me = new URL("/v2/events?stream=me", hostUrl);
  const samStream = await openStream(me, sessionFor(sam));
  t.after(() => samStream.close());
  const noaStream = await openStream(me, {
    Authorization: `Bearer ${tokenFor(noa)}`,
  });
  t.after(() => noaStream.close());
  assert.equal(samStream.response.status, 200);
  await samStream.next(/^: connected\n\n/);
  await noaStream.next(/^: connected\n\n/);
  shareBoard(store, { board: ids.boards.marketing, user: sam, actor: priya });
  const [, data] = await samStream.next(NOTIFICATION);
  const event = JSON.parse(data);
  assert.deepEqual(Object.keys(event).sort(), [
    "kind",
    "resource_id",
    "resource_kind",
    "text",
    "type",
    "url",
    "user_ids",
  ]);
  assert.equal(event.type, "notification_created");
  assert.deepEqual(event.user_ids, [sam]);
  const record = store.getNotification(event.resource_id);
  assert.equal(record.user_id, sam);
  assert.equal(record.kind, "share");
  // The visible notification itself, so clients can show it at once, with
  // its text as Sam reads it.
  const { kind, url } = record;
  assert.deepEqual(
    { kind: event.kind, text: event.text, url: event.url },
    {
      kind,
      text: "Priya Nair shared the board “Marketing launch” with you (viewer)",
      url,
    },
  );
  assert.equal(event.text, plainText(store, record.text));
  await as(sam).data("mutation { mark_notifications_read(all: true) }");
  const [, read] = await samStream.next(NOTIFICATION);
  assert.deepEqual(JSON.parse(read), {
    type: "notifications_read",
    user_ids: [sam],
  });
  // Noa's first event is Noa's own assignment: Sam's never reached Noa.
  const [item] = store.listItems({ boardId: ids.boards.roadmap }).items;
  store.setColumnValue(item.id, "person", [noa], { actorId: alex });
  const [, noaData] = await noaStream.next(NOTIFICATION);
  const noaEvent = JSON.parse(noaData);
  assert.deepEqual(noaEvent.user_ids, [noa]);
  assert.equal(store.getNotification(noaEvent.resource_id).kind, "assign");
  store.deactivateUser(noa);
  await noaStream.ends();
  const bad = await fetch(new URL("/v2/events?stream=all", hostUrl), {
    headers: sessionFor(sam),
  });
  await bad.body?.cancel();
  assert.equal(bad.status, 400);
  const anonymous = await fetch(me);
  await anonymous.body?.cancel();
  assert.equal(anonymous.status, 401);
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
