import assert from "node:assert/strict";
import test from "node:test";
import {
  draggedIds,
  keyboardTarget,
  moveMessage,
  parentChoices,
  resolveDrop,
  rowRange,
  selectionOrder,
  zoneAt,
} from "../web/ui/board/list-dnd-model.js";
import { expanded, layoutOf, moveBoard, task } from "./web-dnd-fixtures.js";

const row = (rowKey, zone, extra = {}) => ({
  type: "row",
  rowKey,
  zone,
  ...extra,
});
const end = (groupKey) => ({ type: "group", groupKey });
const drop = (layout, ids, target) => resolveDrop(layout, { ids, target });
const F = "status:0";

test("a row's top 35% is before, its bottom 35% after, the rest inside", () => {
  assert.deepEqual(
    [0, 12, 12.6, 18, 23.3, 23.5, 36].map((y) => zoneAt(y, 36)),
    ["before", "before", "inside", "inside", "inside", "after", "after"],
  );
  assert.equal(zoneAt(5, 0), "inside");
});

test("the layout knows each row's group, display parent and order", () => {
  const layout = layoutOf(moveBoard(), { expanded: expanded("1") });
  assert.deepEqual(
    layout.rows.map((entry) => [entry.key, entry.depth, entry.parentId]),
    [
      [`${F}:7`, 0, null],
      [`${F}:1`, 0, null],
      [`${F}:2`, 1, "1"],
      [`${F}:3`, 1, "1"],
      [`${F}:5`, 0, null],
      ["status:1:4", 0, null],
      ["status:blank:6", 0, null],
    ],
  );
});

test("before / after a row: its sibling, with the line at its level", () => {
  const layout = layoutOf(moveBoard());
  const before = drop(layout, ["7"], row(`${F}:5`, "before"));
  assert.equal(before.ok, true);
  assert.deepEqual(before.moves, [{ itemId: "7", afterId: "1" }]);
  assert.deepEqual(before.indicator, {
    type: "line",
    rowKey: `${F}:5`,
    edge: "before",
    level: 0,
  });
  // The first place of a group: before its first task.
  const first = drop(layout, ["5"], row(`${F}:7`, "before"));
  assert.deepEqual(first.moves, [{ itemId: "5", beforeId: "7" }]);
  // After a collapsed parent: its sibling.
  const after = drop(layout, ["7"], row(`${F}:1`, "after"));
  assert.deepEqual(after.moves, [{ itemId: "7", afterId: "1" }]);
});

test("after an expanded parent: before its first subtask, one level in", () => {
  const layout = layoutOf(moveBoard(), { expanded: expanded("1") });
  const opened = drop(layout, ["5"], row(`${F}:1`, "after"));
  assert.deepEqual(opened.moves, [
    { itemId: "5", beforeId: "2", parentId: "1" },
  ]);
  assert.equal(opened.indicator.level, 1);
  // Strict (the keyboard): after the parent, as its sibling; C is
  // there already.
  const strict = drop(layout, ["7"], row(`${F}:1`, "after", { strict: true }));
  assert.deepEqual(strict.moves, [{ itemId: "7", afterId: "1" }]);
  const there = drop(layout, ["5"], row(`${F}:1`, "after", { strict: true }));
  assert.equal(there.reason, "no-op");
  // Between two subtasks: a subtask, the line at level 1.
  const between = drop(layout, ["7"], row(`${F}:3`, "before"));
  assert.deepEqual(between.moves, [
    { itemId: "7", afterId: "2", parentId: "1" },
  ]);
  assert.equal(between.indicator.level, 1);
});

test("inside a row: its last subtask; a collapsed parent asks to expand", () => {
  const layout = layoutOf(moveBoard());
  const leaf = drop(layout, ["7"], row(`${F}:5`, "inside"));
  assert.deepEqual(leaf.moves, [{ itemId: "7", parentId: "5" }]);
  assert.deepEqual(leaf.indicator, {
    type: "inside",
    rowKey: `${F}:5`,
    expand: false,
  });
  const parent = drop(layout, ["5"], row(`${F}:1`, "inside"));
  assert.deepEqual(parent.moves, [
    { itemId: "5", afterId: "3", parentId: "1" },
  ]);
  assert.equal(parent.indicator.expand, true);
  // A nested landing keeps the task's own status, even from another group.
  const other = drop(layout, ["4"], row(`${F}:5`, "inside"));
  assert.deepEqual(other.moves, [{ itemId: "4", parentId: "5" }]);
});

test("another status group: its label, or none for No status", () => {
  const layout = layoutOf(moveBoard());
  const into = drop(layout, ["6"], row(`${F}:7`, "before"));
  assert.deepEqual(into.moves, [
    { itemId: "6", beforeId: "7", values: { status: 0 } },
  ]);
  const out = drop(layout, ["4"], end("status:blank"));
  assert.deepEqual(out.moves, [
    { itemId: "4", afterId: "6", values: { status: null } },
  ]);
  assert.deepEqual(out.indicator, { type: "end", groupKey: "status:blank" });
  // A subtask taken out to the top level of a group takes its label.
  const expandedLayout = layoutOf(moveBoard(), { expanded: expanded("1") });
  const lifted = drop(expandedLayout, ["2"], row(`${F}:5`, "before"));
  assert.deepEqual(lifted.moves, [
    { itemId: "2", afterId: "1", parentId: null, values: { status: 0 } },
  ]);
  // The end of an empty group (shown on request): no neighbors.
  const empty = layoutOf(moveBoard(), { showEmpty: true });
  const alone = drop(empty, ["5"], end("status:1"));
  assert.deepEqual(alone.moves, [
    { itemId: "5", afterId: "4", values: { status: 1 } },
  ]);
});

test("assignee and board groups: replace or clear people, change the group", () => {
  const byPerson = layoutOf(moveBoard(), { groupBy: "assignee" });
  // B (Sam and Noa) moving within Sam's group keeps both.
  const within = drop(byPerson, ["4"], row("assignee:2:1", "before"));
  assert.deepEqual(within.moves, [{ itemId: "4", beforeId: "1" }]);
  const toNoa = drop(byPerson, ["5"], end("assignee:3"));
  assert.deepEqual(toNoa.moves, [
    { itemId: "5", afterId: "4", values: { people: ["3"] } },
  ]);
  const unassign = drop(byPerson, ["1"], end("assignee:unassigned"));
  assert.deepEqual(unassign.moves, [
    { itemId: "1", afterId: "6", values: { people: [] } },
  ]);
  const byGroup = layoutOf(moveBoard(), { groupBy: "group" });
  const closed = drop(byGroup, ["5"], end("group:closed"));
  assert.deepEqual(closed.moves, [
    { itemId: "5", afterId: "6", groupId: "closed" },
  ]);
  const none = layoutOf(moveBoard(), { groupBy: "none" });
  const plain = drop(none, ["6"], row("all:7", "before"));
  assert.deepEqual(plain.moves, [{ itemId: "6", beforeId: "7" }]);
});

test("invalid drops: own subtree, no-op, too deep, mixed selections", () => {
  const layout = layoutOf(moveBoard(), { expanded: expanded("1") });
  const reason = (ids, target) => drop(layout, ids, target).reason;
  assert.equal(reason(["1"], row(`${F}:1`, "inside")), "own-subtree");
  assert.equal(reason(["1"], row(`${F}:2`, "inside")), "own-subtree");
  assert.equal(reason(["1"], row(`${F}:3`, "before")), "own-subtree");
  assert.equal(reason(["1"], row(`${F}:1`, "before")), "no-op");
  // E is right before A already; A2 is A's last subtask.
  assert.equal(reason(["7"], row(`${F}:1`, "before")), "no-op");
  assert.equal(reason(["3"], row(`${F}:1`, "inside")), "no-op");
  assert.equal(reason(["1", "2"], end("status:blank")), "mixed");
  const invalid = drop(layout, ["1"], row(`${F}:3`, "before"));
  assert.deepEqual(
    [invalid.ok, invalid.moves, invalid.indicator.rowKey],
    [false, [], `${F}:3`],
  );
  // Six levels (depth 0–5) at most: a chain of five subtasks is full.
  const chain = ["1", "2", "3", "4", "5", "6"].map((id, index) =>
    task(id, `L${index}`, {
      position: index + 1,
      parentId: index === 0 ? null : String(index),
    }),
  );
  chain.push(
    task("7", "Leaf", { position: 9 }),
    task("8", "Pair", { position: 10 }),
  );
  chain.push(task("9", "Pair child", { position: 11, parentId: "8" }));
  const deep = layoutOf(moveBoard(chain), {
    expanded: expanded("1", "2", "3", "4", "5"),
  });
  const deepest = "status:blank:6";
  assert.equal(drop(deep, ["7"], row(deepest, "inside")).reason, "too-deep");
  assert.equal(drop(deep, ["7"], row("status:blank:5", "inside")).ok, true);
  // A task with a subtask needs two levels.
  assert.equal(
    drop(deep, ["8"], row("status:blank:5", "inside")).reason,
    "too-deep",
  );
  assert.equal(drop(deep, ["8"], row("status:blank:4", "inside")).ok, true);
  // Nothing under the pointer, or an unknown task.
  assert.equal(drop(layout, ["1"], null), null);
  assert.equal(drop(layout, ["99"], end(F)), null);
});

test("a selection moves in display order, each after the one before", () => {
  const layout = layoutOf(moveBoard());
  assert.deepEqual(selectionOrder(layout, ["4", "5", "7", "2"]), [
    "7",
    "5",
    "4",
    // Not shown (under a collapsed parent): after the shown ones.
    "2",
  ]);
  const ids = draggedIds(layout, {
    rowKey: `${F}:5`,
    selected: new Set(["5", "7"]),
  });
  assert.deepEqual(ids, ["7", "5"]);
  // A row outside the selection drags alone.
  assert.deepEqual(
    draggedIds(layout, { rowKey: "status:1:4", selected: new Set(["5"]) }),
    ["4"],
  );
  const both = drop(layout, ids, end("status:blank"));
  assert.deepEqual(both.moves, [
    { itemId: "7", afterId: "6", values: { status: null } },
    { itemId: "5", afterId: "7", values: { status: null } },
  ]);
  assert.equal(
    moveMessage(layout, both),
    "Moved 2 tasks to the end of No status",
  );
  // Dropped back where they are, together: nothing to do.
  const pair = drop(layout, ["7", "1"], row(`${F}:5`, "before"));
  assert.equal(pair.reason, "no-op");
  assert.deepEqual(rowRange(layout, `${F}:7`, "status:1:4"), [
    "7",
    "1",
    "5",
    "4",
  ]);
  assert.deepEqual(rowRange(layout, "status:1:4", `${F}:1`), ["1", "5", "4"]);
});

test("keyboard moves: among siblings, into the previous, out of the parent", () => {
  const layout = layoutOf(moveBoard(), { expanded: expanded("1") });
  const move = (rowKey, key) => {
    const target = keyboardTarget(layout, { rowKey, key });
    const id = layout.byKey.get(rowKey).item.id;
    return target && drop(layout, [id], target);
  };
  assert.equal(
    keyboardTarget(layout, { rowKey: `${F}:7`, key: "ArrowUp" }),
    null,
  );
  assert.deepEqual(move(`${F}:1`, "ArrowUp").moves, [
    { itemId: "1", beforeId: "7" },
  ]);
  // Down past an expanded parent lands after it, not inside it.
  assert.deepEqual(move(`${F}:7`, "ArrowDown").moves, [
    { itemId: "7", afterId: "1" },
  ]);
  assert.equal(
    keyboardTarget(layout, { rowKey: `${F}:5`, key: "ArrowDown" }),
    null,
  );
  assert.deepEqual(move(`${F}:3`, "ArrowUp").moves, [
    { itemId: "3", beforeId: "2" },
  ]);
  assert.deepEqual(move(`${F}:5`, "ArrowRight").moves, [
    { itemId: "5", afterId: "3", parentId: "1" },
  ]);
  assert.equal(
    keyboardTarget(layout, { rowKey: `${F}:7`, key: "ArrowRight" }),
    null,
  );
  // Out of the parent: right after it, keeping its own values. A1 is
  // Closed, a group not shown before the move; A2 lands in psych dept.
  const out = move(`${F}:2`, "ArrowLeft");
  assert.deepEqual(out.moves, [{ itemId: "2", afterId: "1", parentId: null }]);
  assert.equal(out.place.group, null);
  assert.equal(moveMessage(layout, out), "Moved “A1” after “A”");
  const second = move(`${F}:3`, "ArrowLeft");
  assert.deepEqual(second.moves, [
    { itemId: "3", afterId: "1", parentId: null },
  ]);
  assert.equal(
    moveMessage(layout, second),
    "Moved “A2” after “A” in psych dept",
  );
  // Dragged to the same place, the task takes the group's values.
  const target = keyboardTarget(layout, { rowKey: `${F}:2`, key: "ArrowLeft" });
  assert.deepEqual(
    drop(layout, ["2"], { ...target, keepValues: false }).moves,
    [{ itemId: "2", afterId: "1", parentId: null, values: { status: 0 } }],
  );
  assert.equal(
    keyboardTarget(layout, { rowKey: `${F}:1`, key: "ArrowLeft" }),
    null,
  );
});

test("moving out of a parent keeps the board group and the assignees", () => {
  const board = moveBoard();
  board.items.find((item) => item.id === "3").groupId = "closed";
  const byGroup = layoutOf(board, {
    groupBy: "group",
    expanded: expanded("1"),
  });
  const out = keyboardTarget(byGroup, {
    rowKey: "group:open:3",
    key: "ArrowLeft",
  });
  const resolution = drop(byGroup, ["3"], out);
  assert.deepEqual(resolution.moves, [
    { itemId: "3", afterId: "1", parentId: null },
  ]);
  assert.equal(resolution.place.group.key, "group:closed");
  const people = layoutOf(moveBoard(), {
    groupBy: "assignee",
    expanded: expanded("1"),
  });
  const rowKey = "assignee:2:2";
  const target = keyboardTarget(people, { rowKey, key: "ArrowLeft" });
  const unassigned = drop(people, ["2"], target);
  assert.deepEqual(unassigned.moves, [
    { itemId: "2", afterId: "1", parentId: null },
  ]);
  assert.equal(unassigned.place.group.label, "Unassigned");
});

test("parent choices skip the task's subtree, its parent and full depths", () => {
  const layout = layoutOf(moveBoard());
  const names = (id) =>
    parentChoices(layout, id).map(({ item, depth }) => `${depth}:${item.name}`);
  assert.deepEqual(names("1"), ["0:E", "0:B", "0:C", "0:D"]);
  assert.deepEqual(names("2"), ["0:E", "1:A2", "0:B", "0:C", "0:D"]);
  const inside = drop(layout, ["5"], { type: "parent", itemId: "4" });
  assert.deepEqual(inside.moves, [{ itemId: "5", parentId: "4" }]);
  assert.equal(moveMessage(layout, inside), "Moved “C” into “B” as a subtask");
});
