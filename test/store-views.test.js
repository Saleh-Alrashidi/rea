/**
 * Board views in the store (SPEC-5 §1.5, SPEC-6 §1.1): every board has a
 * List view. Boards start with DEFAULT_VIEWS (List, Main table, Kanban;
 * one owner, shared by new boards, the seed and imports), loading a data
 * file adds a List view to any board without one (idempotent, then
 * saved), `listViews` returns views in tab order (List first, so the
 * default view, the first non-app view, is the List view) and
 * `createView` adds a missing list, table or kanban view (each once per
 * board, at most MAX_VIEWS views).
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createStore } from "../server/store.js";
import {
  DEFAULT_VIEWS,
  MAX_VIEWS,
  VIEW_NAMES,
} from "../server/store/boards.js";
import { FORMAT } from "../server/store/persistence.js";
import { defaultView } from "../web/ui/board/board-views.js";

const quietLog = { error() {}, warn() {}, info() {}, log() {} };
const shape = (views) => views.map(({ type, name }) => `${type}:${name}`);

async function dataFile(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "mini-monday-views-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return path.join(dir, "data.json");
}

/**
 * A data file with board "Views" whose views keep only `keep` (types),
 * and the IDs of that board and the seeded roadmap.
 */
async function trimmedFile(t, keep) {
  const file = await dataFile(t);
  const seeded = await createStore({ file, log: quietLog });
  const board = seeded.createBoard({ name: "Views" });
  await seeded.flush();
  const doc = JSON.parse(await readFile(file, "utf8"));
  doc.views = doc.views.filter(
    (view) => view.board_id !== board.id || keep.includes(view.type),
  );
  await writeFile(file, JSON.stringify(doc));
  return { file, doc, boardId: board.id };
}

test("every board starts with List, Main table and Kanban", async () => {
  assert.deepEqual(shape(DEFAULT_VIEWS), [
    "list:List",
    "table:Main table",
    "kanban:Kanban",
  ]);
  assert.ok(
    Object.isFrozen(DEFAULT_VIEWS) && Object.isFrozen(DEFAULT_VIEWS[0]),
  );
  const store = await createStore({ log: quietLog });
  const board = store.createBoard({ name: "Fresh" });
  assert.deepEqual(shape(store.listViews(board.id)), shape(DEFAULT_VIEWS));
});

test("views are listed in tab order: List, Main table, Kanban, apps", async (t) => {
  // The seeded roadmap's List view is its newest record, yet it comes
  // first, so a client's default view (the first non-app view) is List.
  const store = await createStore({ log: quietLog });
  const roadmap = store.listBoards()[0];
  const views = store.listViews(roadmap.id);
  assert.deepEqual(
    views.map((view) => view.type),
    ["list", "table", "kanban", "app"],
  );
  const ids = views.map((view) => Number(view.id));
  assert.equal(Math.max(...ids), ids[0], "the List view was added last");
  // The web's rule (the first non-app view of Board.views) opens List.
  assert.equal(defaultView({ views }), "list");
  // Within a type, record order stays (two app views).
  const file = await dataFile(t);
  const seeded = await createStore({ file, log: quietLog });
  await seeded.flush();
  const doc = JSON.parse(await readFile(file, "utf8"));
  const app = doc.views.find((view) => view.type === "app");
  const second = { ...app, id: String(doc.next_id++), name: "Second app" };
  doc.views.unshift(second);
  await writeFile(file, JSON.stringify(doc));
  const loaded = await createStore({ file, log: quietLog });
  assert.deepEqual(
    loaded.listViews(app.board_id).map((view) => view.name),
    ["List", "Main table", "Kanban", "Second app", "Status summary"],
  );
});

test("loading adds a List view to boards without one, once, and saves", async (t) => {
  const { file, doc, boardId } = await trimmedFile(t, ["table", "kanban"]);
  const roadmap = doc.boards[0].id;
  doc.views = doc.views.filter(
    (view) => view.board_id !== roadmap || view.type !== "list",
  );
  await writeFile(file, JSON.stringify(doc));
  const store = await createStore({ file, log: quietLog });
  for (const id of [boardId, roadmap]) {
    const [list] = store.listViews(id);
    assert.deepEqual(
      [list.type, list.name, list.app_install_id],
      ["list", VIEW_NAMES.list, null],
    );
    assert.ok(Number(list.id) >= doc.next_id, "a new ID from the counter");
  }
  await store.flush();
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.equal(saved.format, FORMAT, "a current file, saved again");
  const lists = (data) => data.views.filter((view) => view.type === "list");
  assert.equal(lists(saved).length, saved.boards.length, "one per board");
  assert.equal(lists(saved).length, lists(doc).length + 2);
  // Idempotent: the next load adds nothing and has nothing to save.
  const text = await readFile(file, "utf8");
  const again = await createStore({ file, log: quietLog });
  await again.flush();
  assert.equal(await readFile(file, "utf8"), text);
  assert.deepEqual(again.listViews(boardId), store.listViews(boardId));
});

test("createView adds a missing view once, with its default name", async (t) => {
  const { file, boardId } = await trimmedFile(t, ["list"]);
  const store = await createStore({ file, log: quietLog });
  const events = [];
  store.on((event) => events.push(event));
  const kanban = store.createView(boardId, { type: "kanban" });
  assert.deepEqual(
    [kanban.type, kanban.name, kanban.app_install_id],
    ["kanban", VIEW_NAMES.kanban, null],
  );
  assert.deepEqual(events, [{ type: "view_created", board_id: boardId }]);
  const refusals = [
    [{ type: "list" }, "view_exists", "The board already has a List view"],
    [{ type: "kanban" }, "view_exists", "The board already has a Kanban view"],
    [
      { type: "app" },
      "invalid",
      "View type must be one of list, table, kanban",
    ],
    [
      { type: "table", name: " " },
      "invalid",
      "View name must be 1-255 characters",
    ],
  ];
  for (const [fields, reason, message] of refusals) {
    const result = store.createView(boardId, fields);
    assert.deepEqual(
      [result.ok, result.reason, result.message],
      [false, reason, message],
    );
  }
  assert.equal(store.createView("999999", { type: "list" }), null);
  assert.equal(events.length, 1, "refusals emit nothing");
  const table = store.createView(boardId, { type: "table", name: "Grid" });
  assert.deepEqual(
    store.listViews(boardId).map((view) => [view.type, view.name]),
    [
      ["list", "List"],
      ["table", "Grid"],
      ["kanban", "Kanban"],
    ],
    "tab order, not creation order",
  );
  assert.equal(table.name, "Grid");
});

test("a board holds at most MAX_VIEWS views", async (t) => {
  const file = await dataFile(t);
  const seeded = await createStore({ file, log: quietLog });
  const board = seeded.createBoard({ name: "Crowded" });
  await seeded.flush();
  const doc = JSON.parse(await readFile(file, "utf8"));
  const views = doc.views.filter((view) => view.board_id === board.id);
  doc.views = doc.views.filter(
    (view) => view.board_id !== board.id || view.type !== "kanban",
  );
  for (let n = views.length; n <= MAX_VIEWS; n += 1) {
    const id = String(doc.next_id++);
    doc.views.push({ ...views[0], id, name: `App ${n}`, type: "app" });
  }
  await writeFile(file, JSON.stringify(doc));
  const store = await createStore({ file, log: quietLog });
  assert.equal(store.listViews(board.id).length, MAX_VIEWS);
  const result = store.createView(board.id, { type: "kanban", name: "More" });
  assert.deepEqual(
    [result.reason, result.message],
    ["too_many_views", "A board has at most 20 views"],
  );
});
