import assert from "node:assert/strict";
import test from "node:test";
import {
  completeOption,
  customFields,
  subtasksOf,
  tagList,
  taskLayout,
  taskParent,
} from "../web/ui/board/task-model.js";
import { prepareColumns } from "../web/ui/board/values.js";
import { meetingsBoard, task } from "./web-task-fixtures.js";

const titles = (columns) => columns.map((column) => column.title);

test("the layout partitions columns by role, never by title", () => {
  const board = meetingsBoard([]);
  const layout = taskLayout(board.columns);
  assert.deepEqual(
    layout.grid.map((row) => [row.key, row.label, titles(row.columns)]),
    [
      ["status", "Status", ["Status"]],
      ["assignees", "Assignees", ["Assignees"]],
      ["dates", "Dates", ["Start date", "Due date"]],
      ["priority", "Priority", ["Priority"]],
      ["time_estimate", "Time estimate", ["Time estimate"]],
      ["tags", "Tags", ["Tags"]],
    ],
  );
  assert.equal(layout.description.id, "description");
  // The second "Status" and "Priority" have no role: custom fields, in
  // board order, as is every column without a role.
  assert.deepEqual(titles(layout.custom), [
    "Minuts",
    "Files",
    "Status",
    "#",
    "Priority",
  ]);
});

test("a board without roles falls back by type and keeps the rest custom", () => {
  const columns = prepareColumns([
    { id: "name", title: "Name", type: "name", settings_str: "{}" },
    { id: "notes", title: "Description", type: "text", settings_str: "{}" },
    { id: "stage", title: "Stage", type: "status", settings_str: "{}" },
    { id: "when", title: "When", type: "date", settings_str: "{}" },
  ]);
  const layout = taskLayout(columns);
  // One date column is the due date; its row carries its own title.
  assert.deepEqual(
    layout.grid.map((row) => [row.key, row.label]),
    [
      ["status", "Stage"],
      ["dates", "When"],
    ],
  );
  // A text column titled "Description" is not the description.
  assert.equal(layout.description, null);
  assert.deepEqual(titles(layout.custom), ["Description"]);
});

test("custom fields split into filled and empty, in board order", () => {
  const board = meetingsBoard([]);
  const layout = taskLayout(board.columns);
  const item = task("1", "Weekly sync", { minuts: "a\nb", count: "3" });
  const { filled, empty } = customFields(layout, item);
  assert.deepEqual(titles(filled), ["Minuts", "#"]);
  assert.deepEqual(titles(empty), ["Files", "Status", "Priority"]);
});

test("Complete sets the first done or closed label", () => {
  const board = meetingsBoard([]);
  const status = board.columns.find((column) => column.id === "status");
  assert.equal(completeOption(status).label, "Closed");
  // Without label types, the label reading "Done" finishes work.
  const plain = board.columns.find((column) => column.id === "state");
  assert.equal(completeOption(plain).label, "Done");
  const priority = board.columns.find((column) => column.id === "priority");
  assert.equal(completeOption(priority), null);
  assert.equal(completeOption(null), null);
});

test("tags split on commas, trimmed, once each", () => {
  assert.deepEqual(tagList(" urgent, design ,,urgent, QA "), [
    "urgent",
    "design",
    "QA",
  ]);
  assert.deepEqual(tagList(null), []);
});

test("subtasks come from the board, with progress and the unloaded ones", () => {
  const board = meetingsBoard([
    task("1", "Agenda"),
    task("2", "Room", { status: 2 }, { parentId: "1", groupId: "closed" }),
    task("3", "Notes", { status: 0 }, { parentId: "1" }),
    task("4", "Deep", {}, { parentId: "3" }),
    task("5", "Other"),
  ]);
  const status = board.columns.find((column) => column.id === "status");
  const result = subtasksOf(board, {
    item: board.items[0],
    status,
    subitemsCount: 3,
  });
  // Direct children only, in board order, whatever their group.
  assert.deepEqual(
    result.rows.map((row) => [row.item.name, row.done]),
    [
      ["Room", true],
      ["Notes", false],
    ],
  );
  assert.equal(result.done, 1);
  assert.equal(result.total, 2);
  assert.equal(result.missing, 1);
  const none = subtasksOf(board, { item: board.items[4], status: null });
  assert.deepEqual([none.total, none.done, none.missing], [0, 0, 0]);
});

test("the parent comes from the loaded item, else the board row", () => {
  const board = meetingsBoard([
    task("1", "Agenda"),
    task("2", "Room", {}, { parentId: "1" }),
  ]);
  const [parent, child] = board.items;
  assert.deepEqual(taskParent(board, child, null), {
    id: "1",
    name: "Agenda",
  });
  const detail = { parent: { id: "9", name: "Not on the board" } };
  assert.deepEqual(taskParent(board, child, detail), detail.parent);
  assert.equal(taskParent(board, child, { parent: null }), null);
  assert.equal(taskParent(board, parent, null), null);
});
