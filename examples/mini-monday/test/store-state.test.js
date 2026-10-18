import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { ALL_SCOPES } from "../server/auth.js";
import { createStore } from "../server/store.js";

// Seed content, ID generation, data-file loading and persistence (the parts
// implemented by server/store-state.js), exercised through createStore.

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
const roadmapOf = (store) =>
  store.listBoards().find((b) => b.name === "Product roadmap");

async function tempFile(t, ...parts) {
  const dir = await mkdtemp(path.join(tmpdir(), "mini-monday-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, ...parts) };
}

test("seed data matches the spec", async () => {
  const store = await memoryStore();
  const users = store.listUsers();
  assert.deepEqual(
    users.map((u) => [u.id, u.name, u.email, u.is_admin]),
    [
      ["1", "Alex Rivera", "alex@example.test", true],
      ["2", "Sam Lee", "sam@example.test", false],
      ["3", "Noa Cohen", "noa@example.test", false],
    ],
  );
  const [roadmap, marketing] = store.listBoards();
  assert.equal(roadmap.name, "Product roadmap");
  assert.equal(marketing.name, "Marketing launch");
  assert.deepEqual(
    store
      .listGroups(roadmap.id)
      .map((g) => [g.id, g.title, g.color, g.position]),
    [
      ["this_sprint", "This sprint", "#579bfc", 0],
      ["next_up", "Next up", "#a25ddc", 1],
      ["done", "Done", "#00c875", 2],
    ],
  );
  assert.deepEqual(
    store.listColumns(roadmap.id).map((c) => [c.id, c.title, c.type]),
    [
      ["name", "Name", "name"],
      ["status", "Status", "status"],
      ["person", "Owner", "people"],
      ["date", "Due date", "date"],
      ["estimate", "Estimate", "numbers"],
      ["notes", "Notes", "text"],
    ],
  );
  const status = store.getColumn(roadmap.id, "status");
  assert.equal(status.settings.labels[1], "Done");
  assert.equal(status.settings_str, JSON.stringify(status.settings));
  assert.equal(store.getColumn(roadmap.id, "notes").settings_str, "{}");
  assert.equal(store.countItems(roadmap.id), 8);
  assert.equal(store.countItems(marketing.id), 3);
  assert.deepEqual(
    store.listGroups(marketing.id).map((g) => g.id),
    ["topics"],
  );
  const values = store
    .listItems({ boardId: roadmap.id, limit: 8 })
    .items.map((i) => i.values);
  for (const column of ["status", "person", "date", "estimate", "notes"]) {
    assert.ok(
      values.some((v) => column in v),
      `some item has ${column}`,
    );
    assert.ok(
      values.some((v) => !(column in v)),
      `some item lacks ${column}`,
    );
  }
  assert.ok(values.some((v) => v.person?.length === 2));
  assert.ok(new Set(values.map((v) => v.status?.index)).size >= 3);
});

test("seed includes the Status summary app, its install, view and tokens", async () => {
  const store = await memoryStore();
  const roadmap = roadmapOf(store);
  const [app] = store.listApps();
  assert.equal(app.name, "Status summary");
  assert.equal(app.path, "/apps/status-summary/index.html");
  assert.deepEqual(app.scopes, [
    "boards:read",
    "storage:read",
    "storage:write",
  ]);
  assert.match(app.client_id, /^[0-9a-f]{32}$/);
  assert.match(app.client_secret, /^[\w-]{43}$/);
  const [install] = store.listInstalls({ boardId: roadmap.id });
  assert.deepEqual(store.getInstall(install.id), install);
  assert.equal(install.app_id, app.id);
  const views = store.listViews(roadmap.id);
  assert.deepEqual(
    views.map((v) => [v.name, v.type, v.app_install_id]),
    [
      ["Main table", "table", null],
      ["Kanban", "kanban", null],
      ["Status summary", "app", install.id],
    ],
  );
  const tokens = store.listApiTokens();
  assert.deepEqual(
    tokens.map((t) => [t.label, t.user_id, t.scopes]),
    [
      ["read-write", "1", [...ALL_SCOPES]],
      ["read-only", "1", ["boards:read", "storage:read"]],
    ],
  );
  for (const { token } of tokens) assert.match(token, /^[\w-]{43}$/);
  const other = await memoryStore();
  assert.notEqual(other.listApiTokens()[0].token, tokens[0].token);
  assert.notEqual(other.listApps()[0].client_secret, app.client_secret);
  assert.deepEqual(
    other.listBoards(),
    store.listBoards(),
    "content is deterministic",
  );
});

test("numeric IDs come from one counter and records are frozen", async () => {
  const store = await memoryStore();
  const all = [
    ...store.listUsers(),
    ...store.listBoards(),
    ...store.listApps(),
    ...store.listInstalls(),
    ...store.listBoards().flatMap((b) => store.listViews(b.id)),
    ...store
      .listBoards()
      .flatMap((b) => store.listItems({ boardId: b.id }).items),
    ...store.listUpdates("7"),
  ];
  const ids = all.map((r) => r.id);
  assert.ok(ids.every((id) => /^[1-9]\d*$/.test(id)));
  assert.equal(new Set(ids).size, ids.length);
  const board = store.createBoard({ name: "Next", creatorId: "1" });
  assert.equal(Number(board.id), Math.max(...ids.map(Number)) + 1);
  const item = store.getItem("7");
  assert.ok(Object.isFrozen(item) && Object.isFrozen(item.values));
  assert.throws(() => {
    item.name = "changed";
  }, TypeError);
  assert.throws(() => item.values.person.push("2"), TypeError);
  assert.equal(store.getItem(7), null, "IDs are strings");
});

test("groups get unique slug IDs and positions", async () => {
  const store = await memoryStore();
  const board = store.createBoard({ name: "Groups" });
  const { events } = record(store);
  const ids = ["Topics", "Group", "!!!", "Group", "Ünïcödé Plan!"].map(
    (title) => store.createGroup(board.id, { title }).id,
  );
  assert.deepEqual(ids, [
    "topics_2",
    "group",
    "group_2",
    "group_3",
    "unicode_plan",
  ]);
  const purple = store.createGroup(board.id, {
    title: "Later",
    color: "#a25ddc",
  });
  assert.deepEqual(purple, {
    id: "later",
    board_id: board.id,
    title: "Later",
    color: "#a25ddc",
    position: 6,
  });
  assert.equal(store.getGroup(board.id, "group_2").color, "#579bfc");
  const updated = store.updateGroup(board.id, "later", { title: "Soon" });
  assert.deepEqual([updated.title, updated.color], ["Soon", "#a25ddc"]);
  assert.equal(store.updateGroup(board.id, "missing", { title: "x" }), null);
  assert.equal(store.createGroup("999", { title: "x" }), null);
  assert.throws(() => store.createGroup(board.id, { title: "" }), TypeError);
  assert.equal(events.length, 7);
  assert.deepEqual(events.at(-1), {
    type: "group_updated",
    board_id: board.id,
    group_id: "later",
  });
  assert.equal(events[0].type, "group_created");
  assert.equal(events[0].group_id, "topics_2");
});

test("createColumn makes <type> and <type>_<n> IDs", async () => {
  const store = await memoryStore();
  const board = store.createBoard({ name: "Columns" });
  const { events } = record(store);
  const made = [
    ["Second status", "status"],
    ["Budget", "numbers"],
    ["Cost", "numbers"],
    ["Reviewers", "people"],
    ["Summary", "text"],
  ].map(([title, type]) => store.createColumn(board.id, { title, type }));
  assert.deepEqual(
    made.map((c) => c.id),
    ["status_2", "numbers", "numbers_2", "people", "text"],
  );
  assert.deepEqual(made[0].settings.labels, {
    0: "Working on it",
    1: "Done",
    2: "Stuck",
    5: "",
  });
  assert.deepEqual(events[1], {
    type: "column_created",
    board_id: board.id,
    column_id: "numbers",
  });
  assert.throws(
    () => store.createColumn(board.id, { title: "Name 2", type: "name" }),
    TypeError,
  );
  assert.throws(
    () => store.createColumn(board.id, { title: "F", type: "formula" }),
    TypeError,
  );
  assert.equal(store.createColumn("999", { title: "x", type: "text" }), null);
  assert.equal(events.length, 5);
});

test("a file store seeds, persists atomically and reloads", async (t) => {
  const { dir, file } = await tempFile(t, "nested", "deeper", "data.json");
  const first = await createStore({ file, now: clock() });
  await first.flush();
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const roadmap = roadmapOf(first);
  const item = first.createItem({
    boardId: roadmap.id,
    name: "Persist me",
    values: { date: "2026-12-01" },
  });
  first.createGroup(roadmap.id, { title: "Backlog" });
  first.createColumn(roadmap.id, { title: "Score", type: "numbers" });
  first.setAppStorage("install:24", "note", "saved");
  first.deleteAppStorage("install:24", "note");
  first.setAppStorage("install:24", "note", "again");
  await first.flush();
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.equal(saved.format, "mini-monday-store/1");
  assert.equal(
    "settings_str" in saved.columns[0],
    false,
    "derived fields are not saved",
  );
  const second = await createStore({ file, now: clock() });
  for (const method of [
    "listUsers",
    "listBoards",
    "listApps",
    "listInstalls",
    "listApiTokens",
  ]) {
    assert.deepEqual(second[method](), first[method](), method);
  }
  for (const method of ["listGroups", "listColumns", "listViews"]) {
    assert.deepEqual(
      second[method](roadmap.id),
      first[method](roadmap.id),
      method,
    );
  }
  assert.deepEqual(
    second.listItems({ boardId: roadmap.id, limit: 50 }),
    first.listItems({ boardId: roadmap.id, limit: 50 }),
  );
  assert.deepEqual(second.getItem(item.id), item);
  assert.deepEqual(second.listUpdates("7"), first.listUpdates("7"));
  assert.deepEqual(second.getAppStorage("install:24", "note"), {
    value: "again",
    version: 2,
  });
  const next = second.createBoard({ name: "After reload" });
  assert.equal(Number(next.id), Number(item.id) + 1, "the counter continues");
  await second.flush();
  const entries = await readdir(path.join(dir, "nested", "deeper"));
  assert.deepEqual(entries, ["data.json"], "no temp files remain");
});

test("debounced writes land within 100 ms without flush", async (t) => {
  const { file } = await tempFile(t, "data.json");
  const store = await createStore({ file });
  await store.flush();
  store.createBoard({ name: "Debounced" });
  await sleep(200);
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.ok(saved.boards.some((b) => b.name === "Debounced"));
});

test("concurrent writes coalesce and the last state wins", async (t) => {
  const { dir, file } = await tempFile(t, "data.json");
  const store = await createStore({ file });
  const roadmap = roadmapOf(store);
  for (let i = 0; i < 50; i += 1)
    store.createItem({ boardId: roadmap.id, name: `Bulk ${i}` });
  const inFlight = store.flush();
  const late = store.createItem({ boardId: roadmap.id, name: "During write" });
  store.setAppStorage("install:24", "note", "during");
  await Promise.all([inFlight, store.flush(), store.flush()]);
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.equal(
    saved.items.filter((i) => i.name.startsWith("Bulk ")).length,
    50,
  );
  assert.ok(saved.items.some((i) => i.id === late.id));
  assert.equal(saved.storage[0].value, "during");
  const reloaded = await createStore({ file });
  assert.equal(reloaded.countItems(roadmap.id), 59);
  assert.deepEqual(await readdir(dir), ["data.json"]);
});

test("an invalid data file is rejected and left untouched", async (t) => {
  const { file } = await tempFile(t, "data.json");
  const cases = ["{not json", JSON.stringify({ format: "other" }), "[]"];
  const store = await createStore({ file });
  await store.flush();
  const good = JSON.parse(await readFile(file, "utf8"));
  const broken = (mutate) => {
    const copy = structuredClone(good);
    mutate(copy);
    return JSON.stringify(copy);
  };
  cases.push(
    broken((doc) => delete doc.items),
    broken((doc) => (doc.items[0].values.status = { index: 9 })),
    broken((doc) => (doc.items[0].values.person = ["99"])),
    broken((doc) => (doc.items[0].group_id = "missing")),
    broken((doc) => (doc.items[1].id = doc.items[0].id)),
    broken((doc) => (doc.next_id = 2)),
    broken((doc) => (doc.users[0].is_admin = "yes")),
    broken((doc) => doc.columns.push({ ...doc.columns[1] })),
  );
  for (const text of cases) {
    await writeFile(file, text);
    await assert.rejects(
      createStore({ file }),
      /Invalid mini-monday data file/,
    );
    assert.equal(await readFile(file, "utf8"), text);
  }
});

test("a failed write keeps changes and a later flush retries", async (t) => {
  const { dir } = await tempFile(t);
  const file = path.join(dir, "blocked", "data.json");
  const log = quietLog();
  const store = await createStore({ file, log });
  await writeFile(
    path.join(dir, "blocked"),
    "a file where the directory should be",
  );
  await assert.rejects(store.flush(), (error) =>
    ["EEXIST", "ENOTDIR"].includes(error.code),
  );
  assert.ok(log.errors.length >= 1);
  store.createBoard({ name: "Kept in memory" });
  await rm(path.join(dir, "blocked"));
  await mkdir(path.join(dir, "blocked"));
  await store.flush();
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.ok(saved.boards.some((b) => b.name === "Kept in memory"));
});

test("memory stores never touch the disk", async (t) => {
  const { dir } = await tempFile(t);
  const cwd = process.cwd();
  process.chdir(dir);
  t.after(() => process.chdir(cwd));
  for (const file of [null, ":memory:"]) {
    const store = await createStore({ file });
    store.createBoard({ name: "Memory" });
    await store.flush();
  }
  assert.deepEqual(await readdir(dir), []);
  const empty = await createStore({ seed: false });
  assert.deepEqual([empty.listUsers(), empty.listBoards()], [[], []]);
});
