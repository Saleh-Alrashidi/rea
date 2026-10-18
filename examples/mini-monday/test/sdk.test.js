import assert from "node:assert/strict";
import test from "node:test";
import { createClient, PROTOCOL } from "../sdk/mini-monday-sdk.js";

const HOST = "http://localhost:4100";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A fake iframe window: message listeners plus a parent that records posts. */
function fakeWindow() {
  const listeners = new Set();
  const parent = {
    posted: [],
    postMessage(message, targetOrigin) {
      this.posted.push({ message, targetOrigin });
    },
  };
  return {
    parent,
    listenerCount: () => listeners.size,
    addEventListener(type, listener) {
      if (type === "message") listeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === "message") listeners.delete(listener);
    },
    dispatch({ data, origin = HOST, source = parent }) {
      for (const listener of Array.from(listeners)) {
        listener({ data, origin, source });
      }
    },
  };
}

function setup(t, options = {}) {
  const win = fakeWindow();
  const client = createClient({ hostOrigin: HOST, window: win, ...options });
  t.after(() => client.destroy());
  const requests = () => win.parent.posted.map((post) => post.message);
  const respond = (request, fields, event = {}) =>
    win.dispatch({
      data: {
        protocol: PROTOCOL,
        kind: "response",
        requestId: request.requestId,
        ...fields,
      },
      ...event,
    });
  const emit = (type, data, event = {}) =>
    win.dispatch({
      data: { protocol: PROTOCOL, kind: "event", type, data },
      ...event,
    });
  return {
    win,
    client,
    requests,
    last: () => requests().at(-1),
    respond,
    emit,
  };
}

/** Tracks whether a promise has settled without awaiting it. */
function track(promise) {
  const state = { settled: false };
  state.done = promise.then(
    (value) => Object.assign(state, { settled: true, value }),
    (error) => Object.assign(state, { settled: true, error }),
  );
  return state;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
/** For requests a test only inspects on the wire; destroy() rejects them. */
const unawaited = (promise) => promise.catch(() => {});

test("hostOrigin must be an exact http(s) origin", () => {
  const win = fakeWindow();
  const invalid = [
    undefined,
    42,
    "",
    "*",
    "null",
    "localhost:4100",
    "http://localhost:4100/",
    "http://localhost:4100/app",
    "http://LOCALHOST:4100",
    "http://localhost:80",
    "http://user@localhost:4100",
    "javascript:alert(1)",
    "ftp://localhost:4100",
    "file:///tmp",
  ];
  for (const hostOrigin of invalid) {
    assert.throws(
      () => createClient({ hostOrigin, window: win }),
      TypeError,
      String(hostOrigin),
    );
  }
  assert.throws(() => createClient(), TypeError);
  for (const hostOrigin of ["https://host.example", "http://127.0.0.1:4100"]) {
    createClient({ hostOrigin, window: win }).destroy();
  }
  assert.equal(win.listenerCount(), 0);
});

test("timeoutMs and window are validated", () => {
  const win = fakeWindow();
  for (const timeoutMs of [0, -1, Number.NaN, Infinity, "5", 2 ** 31]) {
    assert.throws(
      () => createClient({ hostOrigin: HOST, timeoutMs, window: win }),
      TypeError,
    );
  }
  for (const window of [
    null,
    {},
    { addEventListener() {}, removeEventListener() {} },
  ]) {
    assert.throws(() => createClient({ hostOrigin: HOST, window }), TypeError);
  }
});

test("requests carry the protocol and a UUID and target the exact host origin", async (t) => {
  const { client, win, requests } = setup(t);
  unawaited(client.get("context"));
  unawaited(client.set("settings", { color: "red" }));
  unawaited(client.execute("notice", { message: "hi" }));
  unawaited(client.execute("valueCreatedForUser"));
  unawaited(client.api("{ me { id } }"));
  unawaited(client.storage.getItem("k"));
  client.listen("events", () => {});
  assert.equal(win.parent.posted.length, 7);
  for (const { targetOrigin } of win.parent.posted)
    assert.equal(targetOrigin, HOST);
  const ids = new Set();
  for (const message of requests()) {
    assert.equal(message.protocol, "mini-monday/1");
    assert.equal(message.kind, "request");
    assert.match(message.requestId, UUID);
    ids.add(message.requestId);
  }
  assert.equal(ids.size, 7);
  assert.deepEqual(
    requests().map(({ method, args }) => ({ method, args })),
    [
      { method: "get", args: { type: "context" } },
      { method: "set", args: { type: "settings", value: { color: "red" } } },
      {
        method: "execute",
        args: { type: "notice", params: { message: "hi" } },
      },
      { method: "execute", args: { type: "valueCreatedForUser", params: {} } },
      { method: "api", args: { query: "{ me { id } }" } },
      { method: "storage", args: { segment: "global", op: "get", key: "k" } },
      { method: "listen", args: { type: "events" } },
    ],
  );
});

test("messages with the wrong origin, source, protocol or kind are ignored", async (t) => {
  const { client, last, respond, win } = setup(t);
  const pending = track(client.get("context"));
  const request = last();
  const ok = { ok: true, data: { boardId: "1" } };
  respond(request, ok, { origin: "http://127.0.0.1:4101" });
  respond(request, ok, { origin: "http://localhost:4100/" });
  respond(request, ok, { source: {} });
  respond(request, ok, { source: null });
  respond(request, { ...ok, protocol: undefined });
  respond(request, { ...ok, protocol: "mini-monday/2" });
  respond(request, { ...ok, kind: "request" });
  respond(request, { ...ok, kind: undefined });
  win.dispatch({ data: null });
  win.dispatch({ data: "mini-monday/1" });
  await flush();
  assert.equal(pending.settled, false);
  respond(request, ok);
  await pending.done;
  assert.deepEqual(pending.value, { boardId: "1" });
});

test("a response resolves only its own pending request", async (t) => {
  const { client, requests, respond } = setup(t);
  const first = track(client.get("context"));
  const second = track(client.get("settings"));
  const [firstRequest, secondRequest] = requests();
  respond(
    { requestId: globalThis.crypto.randomUUID() },
    { ok: true, data: "x" },
  );
  respond({ requestId: 42 }, { ok: true, data: "x" });
  respond(secondRequest, { ok: true, data: "settings" });
  await flush();
  assert.equal(first.settled, false);
  assert.equal(second.value, "settings");
  // A duplicate response for a settled request is ignored.
  respond(secondRequest, { ok: true, data: "again" });
  respond(firstRequest, { ok: true, data: "context" });
  await first.done;
  assert.equal(first.value, "context");
  assert.equal(second.value, "settings");
});

test("a forged event cannot resolve a request and a forged response never reaches listeners", async (t) => {
  const { client, last, respond, win } = setup(t);
  const seen = [];
  client.listen("events", (data) => seen.push(data));
  const pending = track(client.get("context"));
  const request = last();
  win.dispatch({
    data: {
      protocol: PROTOCOL,
      kind: "event",
      type: "events",
      requestId: request.requestId,
      ok: true,
      data: "forged",
    },
  });
  await flush();
  assert.equal(pending.settled, false);
  assert.deepEqual(seen, ["forged"]);
  respond(request, { ok: true, type: "events", data: "real" });
  await pending.done;
  assert.equal(pending.value, "real");
  assert.deepEqual(seen, ["forged"]);
});

test("a request rejects with TIMEOUT after timeoutMs", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { client, last, respond } = setup(t, { timeoutMs: 1000 });
  const pending = track(client.get("itemIds"));
  t.mock.timers.tick(999);
  await flush();
  assert.equal(pending.settled, false);
  t.mock.timers.tick(1);
  await pending.done;
  assert.equal(pending.error.code, "TIMEOUT");
  assert.match(pending.error.message, /timed out/);
  // A late response is ignored.
  respond(last(), { ok: true, data: [] });
});

test("ok:false responses reject with the host message and code", async (t) => {
  const { client, requests, respond } = setup(t);
  const notSupported = client.get("nope");
  const malformed = client.get("context");
  const badShape = client.get("settings");
  const [a, b, c] = requests();
  respond(a, {
    ok: false,
    error: { message: "Unsupported get type", code: "NOT_SUPPORTED" },
  });
  respond(b, { ok: false, error: "boom" });
  respond(c, { ok: "yes", data: 1 });
  await assert.rejects(notSupported, {
    message: "Unsupported get type",
    code: "NOT_SUPPORTED",
  });
  await assert.rejects(malformed, {
    message: "Request failed",
    code: "UNKNOWN",
  });
  await assert.rejects(badShape, { code: "BAD_RESPONSE" });
});

test("listen reference counts subscriptions per type", async (t) => {
  const { client, requests, emit } = setup(t);
  const calls = [];
  const stopA = client.listen("events", (data) => calls.push(["a", data]));
  const stopB = client.listen("events", (data) => calls.push(["b", data]));
  const stopSettings = client.listen("settings", (data) =>
    calls.push(["s", data]),
  );
  const methods = () =>
    requests().map(({ method, args }) => `${method}:${args.type}`);
  assert.deepEqual(methods(), ["listen:events", "listen:settings"]);
  emit("events", { type: "change", board_id: "1" });
  emit("context", { theme: "dark" });
  assert.deepEqual(calls, [
    ["a", { type: "change", board_id: "1" }],
    ["b", { type: "change", board_id: "1" }],
  ]);
  stopA();
  stopA();
  assert.deepEqual(methods(), ["listen:events", "listen:settings"]);
  emit("events", 2);
  assert.deepEqual(calls.at(-1), ["b", 2]);
  assert.equal(calls.length, 3);
  stopB();
  stopB();
  assert.deepEqual(methods(), [
    "listen:events",
    "listen:settings",
    "unlisten:events",
  ]);
  emit("events", 3);
  assert.equal(calls.length, 3);
  client.listen("events", (data) => calls.push(["c", data]));
  assert.equal(methods().at(-1), "listen:events");
  stopSettings();
  assert.equal(methods().at(-1), "unlisten:settings");
  assert.throws(() => client.listen("", () => {}), TypeError);
  assert.throws(() => client.listen("events"), TypeError);
});

test("a throwing listen callback is caught and logged", (t) => {
  const error = t.mock.method(console, "error", () => {});
  const { client, emit } = setup(t);
  const seen = [];
  client.listen("filter", () => {
    throw new Error("app bug");
  });
  client.listen("filter", (data) => seen.push(data));
  emit("filter", { term: "x" });
  assert.deepEqual(seen, [{ term: "x" }]);
  assert.equal(error.mock.callCount(), 1);
  assert.equal(error.mock.calls[0].arguments[1].message, "app bug");
});

test("a failed listen request is logged, not thrown", async (t) => {
  const error = t.mock.method(console, "error", () => {});
  const { client, last, respond } = setup(t);
  client.listen("bogus", () => {});
  respond(last(), {
    ok: false,
    error: { message: "Unsupported listen type", code: "NOT_SUPPORTED" },
  });
  await flush();
  assert.equal(error.mock.callCount(), 1);
  assert.equal(error.mock.calls[0].arguments[1].code, "NOT_SUPPORTED");
});

test("api() resolves GraphQL responses and rejects errors without data", async (t) => {
  const { client, requests, respond } = setup(t);
  const withData = client.api(
    "query Q($id: ID!) { items(ids: [$id]) { id } }",
    {
      variables: { id: "1" },
      operationName: "Q",
    },
  );
  const partial = client.api("{ me { id } boards { id } }");
  const nullData = client.api("{ nope }");
  const noData = client.api("{ broken");
  const [a, b, c, d] = requests();
  assert.deepEqual(a.args, {
    query: "query Q($id: ID!) { items(ids: [$id]) { id } }",
    variables: { id: "1" },
    operationName: "Q",
  });
  assert.deepEqual(b.args, { query: "{ me { id } boards { id } }" });
  const errors = [
    {
      message: "Cannot query field nope",
      extensions: { code: "GRAPHQL_VALIDATION_FAILED" },
    },
  ];
  respond(a, { ok: true, data: { data: { items: [{ id: "1" }] } } });
  respond(b, {
    ok: true,
    data: { data: { me: { id: "1" }, boards: null }, errors },
  });
  respond(c, { ok: true, data: { data: null, errors } });
  respond(d, { ok: true, data: { errors: [{ message: "Syntax Error" }] } });
  assert.deepEqual(await withData, { data: { items: [{ id: "1" }] } });
  assert.deepEqual((await partial).errors, errors);
  await assert.rejects(nullData, (error) => {
    assert.equal(error.message, "Cannot query field nope");
    assert.equal(error.code, "GRAPHQL_VALIDATION_FAILED");
    assert.deepEqual(error.errors, errors);
    return true;
  });
  await assert.rejects(noData, (error) => {
    assert.equal(error.message, "Syntax Error");
    assert.deepEqual(error.errors, [{ message: "Syntax Error" }]);
    return true;
  });
});

test("storage methods map to the global and instance segments", (t) => {
  const { client, requests } = setup(t);
  const { storage } = client;
  for (const promise of [
    storage.getItem("a"),
    storage.setItem("a", "1"),
    storage.setItem("a", "2", { previousVersion: 3 }),
    storage.deleteItem("a"),
    storage.instance.getItem("note"),
    storage.instance.setItem("note", "hi", { previousVersion: 0 }),
    storage.instance.setItem("note", "hi", {}),
    storage.instance.deleteItem("note"),
  ]) {
    unawaited(promise);
  }
  assert.ok(requests().every(({ method }) => method === "storage"));
  assert.deepEqual(
    requests().map(({ args }) => args),
    [
      { segment: "global", op: "get", key: "a" },
      { segment: "global", op: "set", key: "a", value: "1" },
      {
        segment: "global",
        op: "set",
        key: "a",
        value: "2",
        previousVersion: 3,
      },
      { segment: "global", op: "delete", key: "a" },
      { segment: "instance", op: "get", key: "note" },
      {
        segment: "instance",
        op: "set",
        key: "note",
        value: "hi",
        previousVersion: 0,
      },
      { segment: "instance", op: "set", key: "note", value: "hi" },
      { segment: "instance", op: "delete", key: "note" },
    ],
  );
});

test("storage results pass through unchanged", async (t) => {
  const { client, last, respond } = setup(t);
  const read = client.storage.instance.getItem("note");
  respond(last(), { ok: true, data: { value: "hello", version: 2 } });
  assert.deepEqual(await read, { value: "hello", version: 2 });
  const write = client.storage.instance.setItem("note", "x", {
    previousVersion: 1,
  });
  const conflict = { success: false, version: 2, reason: "version_conflict" };
  respond(last(), { ok: true, data: conflict });
  assert.deepEqual(await write, conflict);
});

test("a postMessage failure rejects the request without leaking it", async (t) => {
  const { client, win } = setup(t);
  win.parent.postMessage = () => {
    throw new Error("DataCloneError");
  };
  await assert.rejects(client.set("settings", { fn() {} }), {
    message: "DataCloneError",
  });
});

test("destroy() removes the listener and rejects pending requests", async (t) => {
  const { client, win, last, respond, emit, requests } = setup(t);
  const seen = [];
  const stop = client.listen("events", (data) => seen.push(data));
  const pending = client.get("context");
  const request = last();
  assert.equal(win.listenerCount(), 1);
  client.destroy();
  client.destroy();
  assert.equal(win.listenerCount(), 0);
  await assert.rejects(pending, { code: "DESTROYED" });
  respond(request, { ok: true, data: {} });
  emit("events", 1);
  assert.deepEqual(seen, []);
  const sent = requests().length;
  stop();
  assert.equal(requests().length, sent, "no unlisten after destroy");
  await assert.rejects(client.get("context"), { code: "DESTROYED" });
  await assert.rejects(client.storage.getItem("k"), { code: "DESTROYED" });
  assert.throws(() => client.listen("events", () => {}), { code: "DESTROYED" });
});
