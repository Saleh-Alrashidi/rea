/**
 * Board views in the store (SPEC-5 §1.5): the view lists boards start
 * with (one owner, shared by new boards and imports) and `createView`
 * (list, table or kanban, each once per board, at most MAX_VIEWS views).
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createStore } from "../server/store.js";
import {
  CLICKUP_VIEWS,
  DEFAULT_VIEWS,
  MAX_VIEWS,
  VIEW_NAMES,
} from "../server/store/boards.js";

const quietLog = { error() {}, warn() {}, info() {}, log() {} };
const shape = (views) => views.map(({ type, name }) => `${type}:${name}`);

test("boards start with the shared default views; ClickUp's lead with List", async () => {
  assert.deepEqual(shape(DEFAULT_VIEWS), ["table:Main table", "kanban:Kanban"]);
  assert.deepEqual(shape(CLICKUP_VIEWS), [
    "list:List",
    "table:Main table",
    "kanban:Kanban",
  ]);
  assert.ok(Object.isFrozen(CLICKUP_VIEWS[0]));
  const store = await createStore({ log: quietLog });
  const board = store.createBoard({ name: "Fresh" });
  assert.deepEqual(shape(store.listViews(board.id)), shape(DEFAULT_VIEWS));
});

test("createView adds a missing view once, with its default name", async () => {
  const store = await createStore({ log: quietLog });
  const board = store.createBoard({ name: "Views" });
  const events = [];
  store.on((event) => events.push(event));
  const list = store.createView(board.id, { type: "list" });
  assert.deepEqual(
    [list.type, list.name, list.app_install_id],
    ["list", VIEW_NAMES.list, null],
  );
  assert.deepEqual(events, [{ type: "view_created", board_id: board.id }]);
  const refusals = [
    [{ type: "list" }, "view_exists", "The board already has a List view"],
    [{ type: "kanban" }, "view_exists", "The board already has a Kanban view"],
    [
      { type: "app" },
      "invalid",
      "View type must be one of list, table, kanban",
    ],
    [
      { type: "list", name: " " },
      "invalid",
      "View name must be 1-255 characters",
    ],
  ];
  for (const [fields, reason, message] of refusals) {
    const result = store.createView(board.id, fields);
    assert.deepEqual(
      [result.ok, result.reason, result.message],
      [false, reason, message],
    );
  }
  assert.equal(store.createView("999999", { type: "list" }), null);
  assert.equal(events.length, 1, "refusals emit nothing");
  assert.equal(store.listViews(board.id).length, 3);
});

test("a board holds at most MAX_VIEWS views", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "mini-monday-views-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "data.json");
  const seeded = await createStore({ file, log: quietLog });
  const board = seeded.createBoard({ name: "Crowded" });
  await seeded.flush();
  const doc = JSON.parse(await readFile(file, "utf8"));
  const [table] = doc.views.filter((view) => view.board_id === board.id);
  for (let n = 2; n < MAX_VIEWS; n += 1) {
    const id = String(doc.next_id++);
    doc.views.push({ ...table, id, name: `App ${n}`, type: "app" });
  }
  await writeFile(file, JSON.stringify(doc));
  const store = await createStore({ file, log: quietLog });
  assert.equal(store.listViews(board.id).length, MAX_VIEWS);
  const result = store.createView(board.id, { type: "list", name: "More" });
  assert.deepEqual(
    [result.reason, result.message],
    ["too_many_views", "A board has at most 20 views"],
  );
});
