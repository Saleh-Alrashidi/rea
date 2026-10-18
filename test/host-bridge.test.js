import assert from "node:assert/strict";
import test from "node:test";
import { execute } from "../server/graphql/execute.js";
import { parse } from "../server/graphql/parse.js";
import { createSchema } from "../server/schema.js";
import { createStore } from "../server/store.js";
import { createClient } from "../sdk/mini-monday-sdk.js";
import { createHostBridge } from "../web/host-bridge.js";

const PROTOCOL = "mini-monday/1";
const HOST = "http://localhost:4100";
const APP = "http://127.0.0.1:4101";
const CONTEXT = { boardId: "1", instanceId: "7", theme: "light" };
const TOKEN = { token: "jwt", expires_at: "2026-10-18T12:05:00.000Z" };
const CANNED = {
  getContext: CONTEXT,
  getSettings: { color: "blue" },
  setSettings: (value) => ({ ...value, saved: true }),
  getSessionToken: TOKEN,
  getLocation: { href: HOST },
  getFilter: { term: "launch" },
  getItemIds: ["11", "12"],
  notice: undefined,
  openItemCard: undefined,
  confirm: true,
  openLinkInTab: undefined,
  graphql: { data: { me: { id: "1" } } },
};

const flush = () => new Promise((resolve) => setImmediate(resolve));

function messageTarget() {
  const listeners = new Set();
  return {
    listenerCount: () => listeners.size,
    addEventListener: (type, fn) => type === "message" && listeners.add(fn),
    removeEventListener: (type, fn) => listeners.delete(fn),
    dispatch(event) {
      for (const listener of Array.from(listeners)) listener(event);
    },
  };
}

/** Handlers that record each call and return the CANNED values. */
function defaultHandlers(calls) {
  const entries = Object.entries(CANNED).map(([name, result]) => [
    name,
    async (argument) => {
      calls.push([name, argument]);
      return typeof result === "function" ? result(argument) : result;
    },
  ]);
  return Object.fromEntries(entries);
}

function setup(t, overrides = {}) {
  const win = messageTarget();
  const posted = [];
  // Like a browser, replies must survive structured cloning.
  const postMessage = (message, targetOrigin) =>
    posted.push({ message: structuredClone(message), targetOrigin });
  const iframe = { contentWindow: { postMessage } };
  const calls = [];
  const handlers = { ...defaultHandlers(calls), ...overrides };
  const options = { iframe, appOrigin: APP, handlers, window: win };
  const bridge = createHostBridge(options);
  t.after(() => bridge.destroy());
  const source = iframe.contentWindow;
  const send = (data, event = {}) =>
    win.dispatch({ data, origin: APP, source, ...event });
  let counter = 0;
  async function call(method, args, event = {}) {
    counter += 1;
    const requestId = `request-${counter}`;
    const request = { protocol: PROTOCOL, kind: "request", requestId };
    send({ ...request, method, args }, event);
    await flush();
    const replies = posted.filter((p) => p.message.requestId === requestId);
    assert.ok(replies.length <= 1, "at most one reply per request");
    assert.ok(replies.every(({ targetOrigin }) => targetOrigin === APP));
    return replies[0]?.message;
  }
  const outcome = (expected) => async (method, args) => {
    const reply = await call(method, args);
    assert.equal(reply?.ok, expected, JSON.stringify(reply));
    if (!expected) {
      assert.deepEqual(Object.keys(reply.error).sort(), ["code", "message"]);
    }
    return expected ? reply.data : reply.error;
  };
  const ok = outcome(true);
  const fails = outcome(false);
  const fixture = { bridge, win, iframe, posted, calls, handlers, send };
  return Object.assign(fixture, { call, ok, fails });
}

test("createHostBridge validates its options", () => {
  const win = messageTarget();
  const iframe = { contentWindow: null };
  const valid = { iframe, appOrigin: APP, handlers: {}, window: win };
  const origins = ["", "*", "null", `${APP}/`, `${APP}/x`, "javascript:x"];
  const overrides = [undefined, "ftp://a.example", ...origins]
    .map((appOrigin) => ({ appOrigin }))
    .concat([{ iframe: null }, { iframe: {} }, { handlers: null }]);
  for (const override of [...overrides, { window: {} }]) {
    const options = { ...valid, ...override };
    assert.throws(() => createHostBridge(options), TypeError);
  }
  assert.throws(() => createHostBridge(), TypeError);
  createHostBridge(valid).destroy();
  assert.equal(win.listenerCount(), 0);
});

test("only well-formed requests from the iframe and app origin are answered", async (t) => {
  const { call, send, posted, iframe } = setup(t);
  const args = { type: "context" };
  const events = [{ origin: HOST }, { origin: `${APP}/` }];
  for (const event of [...events, { source: {} }, { source: null }]) {
    assert.equal(await call("get", args, event), undefined);
  }
  for (const method of ["nope", "__proto__", "constructor", undefined]) {
    assert.equal(await call(method, args), undefined, String(method));
  }
  const base = { protocol: PROTOCOL, kind: "request", method: "get", args };
  const ids = [undefined, "", 7, "x".repeat(101)];
  const malformed = [
    { ...base, requestId: "r", protocol: undefined },
    { ...base, requestId: "r", protocol: "mini-monday/2" },
    { ...base, requestId: "r", kind: "response" },
    { ...base, requestId: "r", kind: "event" },
    ...ids.map((requestId) => ({ ...base, requestId })),
    null,
    [base],
    "request",
  ];
  for (const data of malformed) send(data);
  await flush();
  assert.equal(posted.length, 0);
  send({ ...base, requestId: "x".repeat(100) });
  await flush();
  assert.equal(posted.length, 1);
  // A detached iframe has no window, so even a null source is ignored.
  iframe.contentWindow = null;
  send({ ...base, requestId: "detached" }, { source: null });
  await flush();
  assert.equal(posted.length, 1);
});

test("get and set return handler values in protocol replies", async (t) => {
  const { call, ok, calls } = setup(t);
  const reply = await call("get", { type: "context" });
  const { requestId } = reply;
  const response = { protocol: PROTOCOL, kind: "response", requestId };
  assert.deepEqual(reply, { ...response, ok: true, data: CONTEXT });
  assert.deepEqual(await ok("get", { type: "settings" }), { color: "blue" });
  assert.deepEqual(await ok("get", { type: "sessionToken" }), TOKEN);
  assert.deepEqual(await ok("get", { type: "location" }), { href: HOST });
  assert.deepEqual(await ok("get", { type: "filter" }), { term: "launch" });
  assert.deepEqual(await ok("get", { type: "itemIds" }), ["11", "12"]);
  const settings = await ok("set", { type: "settings", value: { a: 1 } });
  assert.deepEqual(settings, { a: 1, saved: true });
  assert.deepEqual(calls.at(-1), ["setSettings", { a: 1 }]);
  const names = Object.keys(CANNED).slice(0, 7);
  assert.deepEqual(calls.map(([name]) => name).sort(), names.sort());
});

test("listen/unlisten control which events emit() posts", async (t) => {
  const { bridge, ok, posted } = setup(t);
  const change = { type: "change", board_id: "1", item_id: "11" };
  assert.equal(bridge.emit("events", change), false);
  const subscribed = { subscribed: true };
  assert.deepEqual(await ok("listen", { type: "events" }), subscribed);
  assert.deepEqual(await ok("listen", { type: "settings" }), subscribed);
  const before = posted.length;
  assert.equal(bridge.emit("events", change), true);
  assert.equal(bridge.emit("context", { theme: "dark" }), false);
  assert.equal(bridge.emit("settings", { color: "red" }), true);
  const event = (type, data) => ({
    message: { protocol: PROTOCOL, kind: "event", type, data },
    targetOrigin: APP,
  });
  assert.deepEqual(posted.slice(before), [
    event("events", change),
    event("settings", { color: "red" }),
  ]);
  const unsubscribed = await ok("unlisten", { type: "events" });
  assert.deepEqual(unsubscribed, { subscribed: false });
  assert.equal(bridge.emit("events", change), false);
});

test("execute types call their handlers with validated params", async (t) => {
  const { ok, calls, handlers } = setup(t);
  const run = (type, params) => ok("execute", { type, params });
  assert.deepEqual(await run("notice", { message: "Saved" }), { ok: true });
  await run("notice", { message: "Oops", type: "error", timeout: 5000 });
  await run("openItemCard", { itemId: "11" });
  await run("openItemCard", { itemId: 12 });
  const confirm = { message: "Delete?", confirmButton: "Delete" };
  assert.deepEqual(await run("confirm", confirm), { confirm: true });
  await run("openLinkInTab", { url: "https://example.test/a?b=1#c" });
  await run("openLinkInTab", { url: "HTTP://Example.test" });
  assert.deepEqual(await run("valueCreatedForUser"), { ok: true });
  assert.deepEqual(calls, [
    ["notice", { message: "Saved", type: "info", timeout: undefined }],
    ["notice", { message: "Oops", type: "error", timeout: 5000 }],
    ["openItemCard", { itemId: "11" }],
    ["openItemCard", { itemId: "12" }],
    ["confirm", confirm],
    ["openLinkInTab", { url: "https://example.test/a?b=1#c" }],
    ["openLinkInTab", { url: "http://example.test/" }],
  ]);
  handlers.confirm = async () => "yes";
  const answer = await run("confirm", { message: "Sure?" });
  assert.deepEqual(answer, { confirm: false });
});

const write = { segment: "global", op: "set", key: "k", value: "v" };
const bad = (method, args) => [method, args, "BAD_REQUEST"];
const unsupported = (method, args) => [method, args, "NOT_SUPPORTED"];
const badExecute = (type, params) => bad("execute", { type, params });
const badStorage = (patch) => bad("storage", { ...write, ...patch });
const badSetting = (value) => bad("set", { type: "settings", value });
const scriptUrls = ["javascript:alert(1)", "JaVaScRiPt:x", "  javascript:x"];
const otherUrls = ["java\tscript:x", "data:text/html,x", "file:///etc/passwd"];
const relativeUrls = ["/relative", "//example.test/x", "blob:x", "", 42];
const rejectedUrls = [...scriptUrls, ...otherUrls, ...relativeUrls];
const badKeys = ["", "k".repeat(257), "a\u0000b", "a\nb", "a\u001fb", "\u007f"];
const REJECTED = [
  ...[undefined, {}, ["context"]].map((args) => bad("get", args)),
  unsupported("get", { type: "secrets" }),
  unsupported("get", { type: "__proto__" }),
  unsupported("set", { type: "context", value: {} }),
  ...[undefined, null, "red", ["red"]].map(badSetting),
  unsupported("listen", { type: "itemIds" }),
  bad("listen", { type: 1 }),
  unsupported("unlisten", { type: "bogus" }),
  unsupported("execute", { type: "runScript", params: {} }),
  badExecute("notice", "hi"),
  badExecute("notice", {}),
  badExecute("notice", { message: "  " }),
  badExecute("notice", { message: "x", type: "warn" }),
  badExecute("notice", { message: "x", timeout: -1 }),
  badExecute("notice", { message: "x", timeout: "5" }),
  ...[undefined, "", "1/../2", "#/boards", 1.5, -1].map((itemId) =>
    badExecute("openItemCard", { itemId }),
  ),
  badExecute("confirm", {}),
  badExecute("confirm", { message: "x", confirmButton: 1 }),
  ...rejectedUrls.map((url) => badExecute("openLinkInTab", { url })),
  ...[undefined, {}, { query: " " }].map((args) => bad("api", args)),
  bad("api", { query: "{ me { id } }", variables: [] }),
  bad("api", { query: "{ me { id } }", operationName: 1 }),
  bad("storage", undefined),
  badStorage({ segment: "account" }),
  badStorage({ op: "list" }),
  badStorage({ op: "__proto__" }),
  ...[...badKeys, 5].map((key) => badStorage({ key })),
  ...[undefined, 5, "v".repeat(65_537)].map((value) => badStorage({ value })),
  ...[1.5, -1, "1", 2 ** 31].map((version) =>
    badStorage({ previousVersion: version }),
  ),
];

test("invalid requests are refused before any handler runs", async (t) => {
  const { fails, calls } = setup(t);
  for (const [method, args, code] of REJECTED) {
    const label = `${method} ${JSON.stringify(args)?.slice(0, 70)}`;
    assert.equal((await fails(method, args)).code, code, label);
  }
  assert.deepEqual(calls, []);
});

/** Records graphql requests and answers with `respond(request)`. */
function graphqlSpy(respond) {
  const requests = [];
  const graphql = async (request) => {
    requests.push(request);
    return respond(request);
  };
  return { requests, graphql };
}

test("storage requests use the context install_id, never the app's", async (t) => {
  const written = { success: true, version: 3 };
  const data = { app_storage: null, set_app_storage: written };
  data.delete_app_storage = written;
  const spy = graphqlSpy(() => ({ data }));
  const { ok } = setup(t, { graphql: spy.graphql });
  const forged = { installId: "999", install_id: "999" };
  const note = { segment: "instance", key: "n" };
  await ok("storage", { ...note, op: "get", ...forged });
  await ok("storage", { ...write, previousVersion: 2 });
  await ok("storage", { ...write, value: "" });
  await ok("storage", { ...note, op: "delete", ...forged });
  const instance = { installId: "7", ...note };
  const global = { installId: "7", segment: "global", key: "k" };
  const sent = spy.requests.map((r) => [r.operationName, r.variables]);
  assert.deepEqual(sent, [
    ["BridgeAppStorageGet", instance],
    ["BridgeAppStorageSet", { ...global, value: "v", previousVersion: 2 }],
    ["BridgeAppStorageSet", { ...global, value: "" }],
    ["BridgeAppStorageDelete", instance],
  ]);
});

test("storage GraphQL errors keep their code; malformed results are INTERNAL", async (t) => {
  const log = t.mock.method(console, "error", () => {});
  let response;
  let sent = 0;
  const graphql = async () => (sent += 1) && response;
  const { ok, fails, handlers } = setup(t, { graphql });
  const get = { segment: "global", op: "get", key: "k" };
  const message = "Missing scope storage:read";
  const forbidden = { message, extensions: { code: "FORBIDDEN" } };
  response = { data: { app_storage: null }, errors: [forbidden] };
  assert.deepEqual(await fails("storage", get), { message, code: "FORBIDDEN" });
  const odd = { message: "odd", extensions: { code: "not a code" } };
  response = { data: null, errors: [odd] };
  assert.equal((await fails("storage", get)).code, "INTERNAL");
  response = { data: { set_app_storage: null } };
  assert.equal((await fails("storage", write)).code, "INTERNAL");
  assert.equal(log.mock.callCount(), 1, "only the malformed result is logged");
  response = { data: { app_storage: null } };
  await ok("storage", { ...get, key: "k".repeat(256) });
  await ok("storage", { ...get, key: "café/ü ✓ ../" });
  handlers.getContext = async () => ({ boardId: "1" });
  assert.equal((await fails("storage", get)).code, "INTERNAL", "no install");
  assert.equal(sent, 5);
});

test("api forwards GraphQL requests and returns their responses", async (t) => {
  const body = { data: { me: { id: "1" } }, errors: [{ message: "partial" }] };
  const spy = graphqlSpy(() => body);
  const { ok } = setup(t, { graphql: spy.graphql });
  const query = "query Me { me { id } }";
  const args = { query, variables: { a: 1 }, operationName: "Me" };
  assert.deepEqual(await ok("api", args), body);
  await ok("api", { query });
  const defaults = { query, variables: {}, operationName: null };
  assert.deepEqual(spy.requests, [args, defaults]);
  // A non-2xx GraphQL body thrown by api.js is the response itself.
  const errors = [{ message: "Syntax Error", locations: [{ line: 1 }] }];
  const thrown = Object.assign(new Error("HTTP 400"), { errors });
  const graphql = () => Promise.reject(thrown);
  const { ok: okThrown } = setup(t, { graphql });
  assert.deepEqual(await okThrown("api", { query: "{ x" }), { errors });
});

test("handler failures become INTERNAL without leaking details", async (t) => {
  const log = t.mock.method(console, "error", () => {});
  const secret = new Error("ECONNREFUSED /srv/db.sock token=abc123");
  const reject = () => Promise.reject(secret);
  const { call, fails } = setup(t, {
    getSettings: reject,
    setSettings: () => {
      throw new TypeError("sync failure");
    },
    graphql: reject,
    getContext: async () => ({ instanceId: "7", callback() {} }),
    getItemIds: undefined,
  });
  const replies = [
    await call("get", { type: "settings" }),
    await call("set", { type: "settings", value: {} }),
    await call("api", { query: "{ me { id } }" }),
    await call("storage", { segment: "global", op: "get", key: "k" }),
    // A result that cannot be structured-cloned still gets a reply.
    await call("get", { type: "context" }),
  ];
  const internal = { message: "Internal error", code: "INTERNAL" };
  for (const reply of replies) {
    assert.deepEqual(reply.error, internal);
    const text = JSON.stringify(reply);
    assert.doesNotMatch(text, /ECONNREFUSED|abc123|sync failure|\bat\b/);
  }
  assert.equal(log.mock.callCount(), 5);
  const missing = await fails("get", { type: "itemIds" });
  assert.equal(missing.code, "NOT_SUPPORTED");
});

test("destroy() stops handling requests and suppresses in-flight replies", async (t) => {
  let release;
  const getItemIds = () => new Promise((resolve) => (release = resolve));
  const { bridge, win, call, ok, send, posted } = setup(t, { getItemIds });
  await ok("listen", { type: "events" });
  const request = { protocol: PROTOCOL, kind: "request", requestId: "slow" };
  send({ ...request, method: "get", args: { type: "itemIds" } });
  const count = posted.length;
  bridge.destroy();
  bridge.destroy();
  assert.equal(win.listenerCount(), 0);
  release(["1"]);
  await flush();
  assert.equal(bridge.emit("events", {}), false);
  assert.equal(await call("get", { type: "context" }), undefined);
  assert.equal(posted.length, count);
});

/** Wires an SDK client and a host bridge through cloned, async postMessage. */
function connect(handlers) {
  const host = messageTarget();
  const app = messageTarget();
  const deliver = (target, event) =>
    setImmediate(() =>
      target.dispatch({ ...event, data: structuredClone(event.data) }),
    );
  const parent = {
    postMessage: (data, to) =>
      to === HOST && deliver(host, { data, origin: APP, source: app }),
  };
  app.parent = parent;
  app.postMessage = (data, to) =>
    to === APP && deliver(app, { data, origin: HOST, source: parent });
  const iframe = { contentWindow: app };
  const options = { iframe, appOrigin: APP, handlers, window: host };
  const bridge = createHostBridge(options);
  const client = createClient({ hostOrigin: HOST, window: app });
  return { bridge, client };
}

/** A resolver context with the seeded install's app principal. */
async function appContext() {
  const store = await createStore({ file: null });
  const [{ id: installId, app_id: appId }] = store.listInstalls();
  const scopes = new Set(store.getApp(appId).scopes);
  const principal = { kind: "app", userId: "1", scopes, installId, appId };
  const requireScope = (scope) => {
    if (!scopes.has(scope)) throw new Error(`Missing scope ${scope}`);
  };
  const extra = { hostOrigin: HOST, appsOrigin: APP, log: { error() {} } };
  return { store, principal, apiVersion: "2026-01", requireScope, ...extra };
}

test("the SDK and host bridge round-trip storage through the GraphQL engine", async (t) => {
  const schema = createSchema();
  const context = await appContext();
  const { store, principal } = context;
  const graphql = async ({ query, variables, operationName }) => {
    const request = { schema, document: parse(query), variables, context };
    Object.assign(request, { operationName, apiVersion: "2026-01" });
    return JSON.parse(JSON.stringify(await execute(request)));
  };
  const view = { ...CONTEXT, instanceId: principal.installId };
  const handlers = { ...defaultHandlers([]), getContext: () => view, graphql };
  const { bridge, client } = connect(handlers);
  t.after(() => client.destroy());
  t.after(() => bridge.destroy());
  const notes = client.storage.instance;
  const missing = { value: null, version: null };
  assert.deepEqual(await notes.getItem("note"), missing);
  const first = await notes.setItem("note", "first");
  assert.deepEqual(first, { success: true, version: 1 });
  const next = await notes.setItem("note", "second", { previousVersion: 1 });
  assert.deepEqual(next, { success: true, version: 2 });
  const stale = await notes.setItem("note", "x", { previousVersion: 1 });
  const reason = "version_conflict";
  assert.deepEqual(stale, { success: false, version: 2, reason });
  assert.deepEqual(await notes.getItem("note"), {
    value: "second",
    version: 2,
  });
  assert.deepEqual(await client.storage.getItem("note"), missing);
  await client.storage.setItem("shared", "g");
  const read = (scope, key) => store.getAppStorage(scope, key);
  const instance = `install:${principal.installId}`;
  assert.deepEqual(read(instance, "note"), { value: "second", version: 2 });
  const shared = read(`app:${principal.appId}`, "shared");
  assert.deepEqual(shared, { value: "g", version: 1 });
  const removed = await notes.deleteItem("note");
  assert.deepEqual(removed, { success: true, version: null });
  const badKey = notes.setItem("bad\u0000key", "x");
  await assert.rejects(badKey, { code: "BAD_REQUEST" });
  const invalid = { code: "GRAPHQL_VALIDATION_FAILED" };
  await assert.rejects(client.api("{ nope }"), invalid);
  const events = [];
  client.listen("events", (data) => events.push(data));
  assert.deepEqual(await client.get("context"), view);
  const change = { type: "change", board_id: "1" };
  assert.equal(bridge.emit("events", change), true);
  await flush();
  assert.deepEqual(events, [change]);
});
