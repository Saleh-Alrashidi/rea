import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createStore } from "../server/store.js";
import { plainEntry, plainText } from "./helpers.js";

// ID generation (store-state.js), data-file loading and persistence
// (server/store/persistence.js), exercised through createStore. The seed
// is covered by store-seed.test.js.

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

test("numeric IDs come from one counter and records are frozen", async () => {
  const store = await memoryStore();
  const boards = store.listBoards();
  const all = [
    ...store.listUsers(),
    ...store.listTeams(),
    ...store.listWorkspaces(),
    ...boards,
    ...store.listApps(),
    ...store.listInstalls(),
    ...boards.flatMap((b) => store.listViews(b.id)),
    ...boards.flatMap((b) => store.listItems({ boardId: b.id }).items),
    ...store.listUpdates("7"),
    ...store.listDocs(),
    ...store.listNotes(),
    ...store.listForms(),
    ...boards.flatMap((b) => store.listActivity(b.id)),
    ...store.listUsers().flatMap((u) => store.listNotifications(u.id)),
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
  const doc = store.listDocs()[0];
  assert.ok(Object.isFrozen(doc.blocks[0]) && Object.isFrozen(doc.members));
  assert.throws(() => doc.members.push({}), TypeError);
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

/** Changes every SPEC-2 collection through the store API. */
function touchEverything(store) {
  const roadmap = roadmapOf(store);
  const user = store.createUser({
    name: "Robin Park",
    email: "robin@example.test",
    role: "member",
    title: "Support Lead",
  });
  store.updateUser("3", { title: "Staff Engineer" }, { actorId: "1" });
  const team = store.createTeam({
    name: "Support",
    creatorId: user.id,
    memberIds: ["2"],
  });
  const workspace = store.createWorkspace({
    name: "Support desk",
    kind: "closed",
    color: "#0B8A5F",
    creatorId: user.id,
  });
  const board = store.createBoard({
    name: "Tickets",
    creatorId: user.id,
    workspaceId: workspace.id,
    boardKind: "share",
  });
  store.share({
    resourceKind: "board",
    resourceId: board.id,
    subjectKind: "team",
    subjectIds: [team.id],
    role: "editor",
    actorId: user.id,
  });
  const doc = store.createDoc({
    title: "Runbook",
    workspaceId: workspace.id,
    creatorId: user.id,
    blocks: [{ type: "todo", text: "Triage" }],
  });
  store.updateDoc(
    doc.id,
    { expectedVersion: 1, blocks: [...doc.blocks, { type: "divider" }] },
    { actorId: user.id },
  );
  const note = store.createNote({ ownerId: user.id, title: "Shift notes" });
  store.updateNote(note.id, { expectedVersion: 1, pinned: true });
  const form = store.createForm({
    boardId: roadmap.id,
    title: "Bug report",
    creatorId: "1",
  });
  store.submitForm(form.id, { name: "Crash on save" });
  store.markNotificationsRead("1", { all: true });
  return { user, team, workspace, board, doc, note, form };
}

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
  const made = touchEverything(first);
  await first.flush();
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.equal(saved.format, "mini-monday-store/4", "SPEC-5 data format");
  assert.equal(
    "settings_str" in saved.columns[0],
    false,
    "derived fields are not saved",
  );
  const second = await createStore({ file, now: clock() });
  for (const method of [
    "listUsers",
    "listTeams",
    "listWorkspaces",
    "listBoards",
    "listApps",
    "listInstalls",
    "listApiTokens",
    "listDocs",
    "listNotes",
    "listForms",
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
  for (const board of first.listBoards()) {
    assert.deepEqual(
      second.listActivity(board.id, { limit: 1000 }),
      first.listActivity(board.id, { limit: 1000 }),
    );
  }
  for (const user of first.listUsers()) {
    assert.deepEqual(
      second.listNotifications(user.id, { limit: 200 }),
      first.listNotifications(user.id, { limit: 200 }),
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
  assert.equal(second.getDoc(made.doc.id).version, 2);
  assert.equal(second.getNote(made.note.id).pinned, true);
  assert.equal(second.getForm(made.form.id).response_count, 1);
  assert.equal(second.getWorkspace(made.workspace.id).color, "#0b8a5f");
  assert.deepEqual(
    second.findFormByToken(made.form.token),
    first.getForm(made.form.id),
  );
  const next = second.createBoard({ name: "After reload" });
  assert.equal(Number(next.id), saved.next_id, "the counter continues");
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
    broken((doc) => (doc.users[0].role = "owner")),
    broken((doc) => doc.columns.push({ ...doc.columns[1] })),
    // SPEC-2 records: shapes, nested records, uniqueness and references.
    broken((doc) => (doc.format = "mini-monday-store/1")),
    broken((doc) => (doc.users[1].email = "ALEX@example.test")),
    broken((doc) => (doc.users[0].status = "suspended")),
    broken((doc) => (doc.boards[0].board_kind = "secret")),
    broken((doc) => (doc.boards[0].workspace_id = "999")),
    broken((doc) => (doc.boards[0].members[0].role = "admin")),
    broken((doc) =>
      doc.boards[0].members.push({ kind: "group", id: "1", role: "owner" }),
    ),
    broken((doc) => (doc.teams[0].members[0].role = "lead")),
    broken((doc) => (doc.docs[0].blocks[0].type = "table")),
    broken((doc) => (doc.docs[0].blocks[1].id = doc.docs[0].blocks[0].id)),
    broken((doc) => (doc.docs[0].blocks[0].checked = true)),
    broken((doc) => (doc.notes[1].shares[0].role = "owner")),
    broken((doc) => (doc.notes[0].owner_id = "999")),
    broken((doc) => (doc.forms[0].questions[0].column_id = "person")),
    broken((doc) => doc.forms[0].questions.reverse()),
    broken((doc) => (doc.forms[1].token = doc.forms[0].token)),
    broken((doc) => (doc.notifications[0].kind = "mention")),
    broken((doc) => (doc.activity[0].board_id = "999")),
    broken((doc) => (doc.workspaces[0].color = "indigo")),
    // Rich text: a string or non-empty parts { text } / { user_id }.
    broken((doc) => (doc.notifications[0].text = [])),
    broken((doc) => (doc.notifications[0].text = [{ user_id: "x" }])),
    broken((doc) => (doc.notifications[0].text = [{ text: 1 }])),
    broken((doc) => (doc.activity[0].to_text = [{ text: "a", user_id: "1" }])),
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

test("rich texts persist, and plain texts of earlier files still load", async (t) => {
  const { file } = await tempFile(t, "data.json");
  const store = await createStore({ file });
  await store.flush();
  const saved = JSON.parse(await readFile(file, "utf8"));
  const [rich] = saved.notifications;
  assert.deepEqual(rich.text[0], { user_id: rich.actor_id }, "names by ID");
  // Files written before rich text keep names in strings and labels.
  rich.text = "Sam Lee posted an update";
  const [entry] = saved.activity;
  Object.assign(entry, {
    actor_label: "Old name",
    from_text: "A",
    to_text: "B",
  });
  await writeFile(file, JSON.stringify(saved));
  const reloaded = await createStore({ file });
  const note = reloaded.getNotification(rich.id);
  assert.equal(plainText(reloaded, note.text), "Sam Lee posted an update");
  const [shown] = reloaded
    .listActivity(entry.board_id, { limit: 1000 })
    .filter((each) => each.id === entry.id)
    .map((each) => plainEntry(reloaded, each));
  const actor = reloaded.getUser(entry.actor_id);
  assert.deepEqual(
    [shown.actor_label, shown.from_text, shown.to_text],
    [actor.name, "A", "B"],
    "a user actor is named from their ID",
  );
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
  assert.equal(
    empty.createBoard({ name: "Nowhere" }),
    null,
    "boards need a workspace",
  );
});
