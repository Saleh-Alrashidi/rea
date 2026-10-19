/**
 * Moving tasks to another board from the List view or the sidebar
 * (SPEC-6 §3.2, §3.3), pure: which tasks move, the preview of the
 * columns whose values stay behind (the server's published mapping:
 * role, then title and type) and the wording of the confirm and toast.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  columnMapping,
  droppedColumnsPreview,
  movedItems,
  transferConfirm,
  transferMessage,
  transferRoots,
} from "../web/ui/board/board-transfer-model.js";

const column = (id, title, type, role = null) => ({ id, title, type, role });
const SOURCE = [
  column("name", "Name", "name"),
  column("status", "Stage", "status", "status"),
  column("owner", "Owner", "people", "assignees"),
  column("effort", "Effort", "numbers"),
  column("notes", "Notes", "text"),
  column("risk", "Risk", "status"),
];
const TARGET = [
  column("name", "Task", "name"),
  column("state", "Status", "status", "status"),
  column("people", "People", "people"),
  column("effort2", "Effort", "numbers"),
  column("notes2", "Notes", "long_text"),
];

const item = (id, values = {}, parentId = null) => ({
  id,
  name: `Task ${id}`,
  parentId,
  values,
  texts: {},
});

test("columns map by role first, then by exact title and type", () => {
  const mapping = columnMapping(SOURCE, TARGET);
  assert.deepEqual(
    Object.fromEntries([...mapping].map(([id, to]) => [id, to.id])),
    { status: "state", effort: "effort2" },
  );
  // Each target column is taken once.
  const twice = columnMapping(
    [column("a", "Effort", "numbers"), column("b", "Effort", "numbers")],
    [column("c", "Effort", "numbers")],
  );
  assert.deepEqual([...twice.keys()], ["a"]);
});

test("the preview lists unmapped columns that hold a value on a moved task", () => {
  const items = [
    item("1", { status: 1, owner: ["5"], notes: "" }),
    item("2", { risk: 0 }, "1"),
  ];
  assert.deepEqual(
    droppedColumnsPreview({
      sourceColumns: SOURCE,
      targetColumns: TARGET,
      items,
    }),
    ["Owner", "Risk"],
    "board order; empty values and mapped columns drop nothing",
  );
  assert.deepEqual(
    droppedColumnsPreview({
      sourceColumns: SOURCE,
      targetColumns: SOURCE,
      items,
    }),
    [],
  );
});

test("a selected subtask moves with its selected parent", () => {
  const items = [
    item("1"),
    item("2", {}, "1"),
    item("3", {}, "2"),
    item("4"),
    item("5", {}, "4"),
  ];
  assert.deepEqual(
    transferRoots(items, ["3", "1", "5", "9"]).map((each) => each.id),
    ["1", "5"],
  );
  const roots = transferRoots(items, ["1"]);
  assert.deepEqual(
    movedItems(items, roots).map((each) => each.id),
    ["1", "2", "3"],
  );
  // A cycle in loaded data does not hang.
  const loop = [item("7", {}, "8"), item("8", {}, "7")];
  assert.deepEqual(
    transferRoots(loop, ["7", "8"]).map((each) => each.id),
    [],
  );
});

test("the confirm and the toast name the target and the columns", () => {
  const target = { id: "9", name: "Sprint" };
  const one = [item("1")];
  assert.deepEqual(transferConfirm({ roots: one, target, columns: ["Risk"] }), {
    title: "Move “Task 1” to “Sprint”?",
    message:
      "“Sprint” has no matching column for Risk, so its values stay behind.",
    confirmButton: "Move",
  });
  const two = [item("1"), item("2")];
  assert.match(
    transferConfirm({ roots: two, target, columns: ["Risk", "Owner"] }).message,
    /columns for Risk, Owner, so their values/,
  );
  assert.equal(
    transferMessage({ roots: two, target, dropped: [] }),
    "Moved 2 tasks to “Sprint”",
  );
  assert.equal(
    transferMessage({ roots: one, target, dropped: ["Risk"] }),
    "Moved “Task 1” to “Sprint”. Not moved: Risk",
  );
});
