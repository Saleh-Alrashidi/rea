import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "../server/store.js";

// Part-1 store infrastructure: app storage, API token lookup and change
// listeners.
const START = Date.UTC(2026, 9, 18, 9, 0, 0);
const clock = () => {
  let tick = 0;
  return () => new Date(START + 1000 * tick++);
};
const quietLog = () => {
  const errors = [];
  return { errors, error: (...args) => errors.push(args) };
};
const memoryStore = (options = {}) => createStore({ now: clock(), ...options });
const record = (store) => {
  const events = [];
  const off = store.on((event) => events.push(event));
  return { events, off };
};

test("app storage versions writes and reports conflicts", async () => {
  const store = await memoryStore();
  const { events } = record(store);
  const scope = "install:24";
  assert.equal(store.getAppStorage(scope, "note"), null);
  assert.deepEqual(store.setAppStorage(scope, "note", "a"), {
    success: true,
    version: 1,
  });
  assert.deepEqual(store.setAppStorage(scope, "note", "b", 1), {
    success: true,
    version: 2,
  });
  assert.deepEqual(store.setAppStorage(scope, "note", "c", 1), {
    success: false,
    version: 2,
    reason: "version_conflict",
  });
  assert.deepEqual(store.getAppStorage(scope, "note"), {
    value: "b",
    version: 2,
  });
  assert.deepEqual(store.setAppStorage(scope, "new", "x", 0), {
    success: false,
    version: null,
    reason: "version_conflict",
  });
  assert.deepEqual(store.deleteAppStorage(scope, "note"), {
    success: true,
    version: null,
  });
  assert.equal(store.getAppStorage(scope, "note"), null);
  assert.deepEqual(store.setAppStorage(scope, "note", "d", 2), {
    success: false,
    version: null,
    reason: "version_conflict",
  });
  assert.deepEqual(
    store.setAppStorage(scope, "note", "e"),
    { success: true, version: 3 },
    "versions are never reused",
  );
  assert.deepEqual(store.deleteAppStorage(scope, "absent"), {
    success: true,
    version: null,
  });
  assert.equal(
    store.getAppStorage("app:23", "note"),
    null,
    "segments are separate",
  );
  store.setAppStorage("app:23", "note", "global");
  assert.equal(store.getAppStorage(scope, "note").value, "e");
  assert.equal(store.getAppStorage(scope, "a/../b"), null, "keys are opaque");
  for (const bad of ["install:", "board:4", "install:4/x", "", 24]) {
    assert.throws(() => store.getAppStorage(bad, "k"), TypeError);
  }
  assert.throws(() => store.setAppStorage(scope, "k", 5), TypeError);
  assert.throws(() => store.setAppStorage(scope, "k", "v", "1"), TypeError);
  assert.throws(() => store.setAppStorage(scope, 5, "v"), TypeError);
  assert.deepEqual(events, [], "storage writes are not board changes");
});

test("findApiToken matches whole tokens only", async () => {
  const store = await memoryStore();
  const [readWrite] = store.listApiTokens();
  assert.deepEqual(store.findApiToken(readWrite.token), readWrite);
  for (const bad of [
    readWrite.token.slice(0, -1),
    `${readWrite.token}A`,
    "",
    undefined,
    42,
  ]) {
    assert.equal(store.findApiToken(bad), null);
  }
});

test("listeners unsubscribe and a throwing listener does not stop others", async () => {
  const log = quietLog();
  const store = await memoryStore({ log });
  const seen = [];
  store.on(() => {
    throw new Error("boom");
  });
  const off = store.on((event) => seen.push(event.type));
  store.createBoard({ name: "One" });
  off();
  off();
  store.createBoard({ name: "Two" });
  assert.deepEqual(seen, ["board_created"]);
  assert.equal(log.errors.length, 2);
  assert.match(String(log.errors[0][0]), /listener failed/);
  assert.throws(() => store.on("nope"), TypeError);
});
