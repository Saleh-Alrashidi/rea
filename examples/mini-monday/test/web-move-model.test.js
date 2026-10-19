import assert from "node:assert/strict";
import test from "node:test";
import { moveVariables } from "../web/ui/board/move-actions.js";
import {
  applyMove,
  laneMove,
  manualOrder,
  neighborsAt,
  provisionalPosition,
  undoMoves,
} from "../web/ui/board/move-model.js";
import { lanesFor } from "../web/ui/board/status-lanes.js";
import { USERS, moveBoard, task } from "./web-dnd-fixtures.js";

const order = (board) => manualOrder(board.items).map((item) => item.name);
const byName = (board, name) => board.items.find((item) => item.name === name);

test("neighbors: the sibling before the place, else the first one", () => {
  const siblings = [{ id: "1" }, { id: "2" }];
  assert.deepEqual(neighborsAt(siblings, 0), { beforeId: "1" });
  assert.deepEqual(neighborsAt(siblings, 1), { afterId: "1" });
  assert.deepEqual(neighborsAt(siblings, 2), { afterId: "2" });
  assert.deepEqual(neighborsAt([], 0), {});
  // The moved task's own subtasks are no neighbors.
  const three = [{ id: "1" }, { id: "2" }, { id: "3" }];
  assert.deepEqual(neighborsAt(three, 2, new Set(["2"])), { beforeId: "3" });
  assert.deepEqual(neighborsAt(three, 3, new Set(["3"])), { afterId: "2" });
  assert.deepEqual(neighborsAt(three, 0, new Set(["1"])), { beforeId: "2" });
  assert.deepEqual(neighborsAt(three, 1, new Set(["1", "2", "3"])), {});
});

test("provisional positions follow move_item's neighbor rule", () => {
  const board = moveBoard();
  const { items } = board;
  const c = byName(board, "C");
  // After A: between A and the next item of the manual order (A1).
  assert.equal(provisionalPosition(items, c, { afterId: "1" }), 1536);
  // Before A: between E and A.
  assert.equal(provisionalPosition(items, c, { beforeId: "1" }), 768);
  // Before the first and after the last item: half a spacing outside.
  assert.equal(provisionalPosition(items, c, { beforeId: "7" }), 0);
  assert.equal(provisionalPosition(items, c, { afterId: "6" }), 6656);
  // Both neighbors, none, or an unknown one.
  const both = { afterId: "7", beforeId: "4" };
  assert.equal(provisionalPosition(items, c, both), 2304);
  assert.equal(provisionalPosition(items, c, {}), 5120);
  assert.equal(provisionalPosition(items, c, { afterId: "99" }), 5120);
  // The moved item is no neighbor of itself: after B is before D.
  assert.equal(provisionalPosition(items, c, { afterId: "4" }), 5120);
});

test("applying a move changes place, parent, group and values with texts", () => {
  const board = moveBoard();
  applyMove(
    board,
    {
      itemId: "5",
      beforeId: "7",
      parentId: "4",
      groupId: "closed",
      values: { status: 1, people: ["3"] },
    },
    USERS,
  );
  const c = byName(board, "C");
  assert.deepEqual(
    [c.position, c.parentId, c.groupId, c.values.status, c.texts.status],
    [0, "4", "closed", 1, "psych dept"],
  );
  assert.equal(c.texts.people, "Noa Levi");
  assert.equal(order(board)[0], "C");
  applyMove(board, { itemId: "5", parentId: null, values: { status: null } });
  assert.deepEqual(
    [c.parentId, c.values.status, c.texts.status],
    [null, null, null],
  );
});

test("undo records the place before the move, outside the task's subtree", () => {
  const board = moveBoard();
  // C sat after B.
  assert.deepEqual(undoMoves(board, [{ itemId: "5", afterId: "7" }]), [
    { itemId: "5", afterId: "4" },
  ]);
  // A's subtasks sit right after it, but A comes back after E.
  const moveA = { itemId: "1", afterId: "6" };
  assert.deepEqual(undoMoves(board, [moveA]), [{ itemId: "1", afterId: "7" }]);
  byName(board, "A1").position = 600;
  assert.deepEqual(undoMoves(board, [moveA]), [{ itemId: "1", afterId: "7" }]);
  // The first item comes back before the next item that stays.
  const first = [{ itemId: "7", afterId: "6" }];
  assert.deepEqual(undoMoves(board, first), [{ itemId: "7", beforeId: "2" }]);
  // Parent, group and values come back only where the move changed them.
  const nested = {
    itemId: "3",
    afterId: "5",
    parentId: null,
    groupId: "closed",
    values: { status: 0, people: ["2"] },
  };
  assert.deepEqual(undoMoves(board, [nested]), [
    {
      itemId: "3",
      afterId: "1",
      parentId: "1",
      groupId: "open",
      values: { status: 1, people: [] },
    },
  ]);
});

test("undo of several moves runs in the original order and restores it", () => {
  const board = moveBoard();
  const before = order(board);
  const requests = [
    { itemId: "5", afterId: "6", values: { status: null } },
    { itemId: "7", afterId: "5", values: { status: null } },
    { itemId: "4", afterId: "7", parentId: "6" },
  ];
  const back = undoMoves(board, requests);
  // E (first in the manual order) comes back first, before A.
  assert.deepEqual(
    back.map((entry) => entry.itemId),
    ["7", "4", "5"],
  );
  for (const request of requests) applyMove(board, request, USERS);
  assert.deepEqual(order(board).slice(-3), ["C", "E", "B"]);
  for (const request of back) applyMove(board, request, USERS);
  assert.deepEqual(order(board), before);
  assert.deepEqual(
    ["4", "5", "7"].map((id) => {
      const item = board.items.find((entry) => entry.id === id);
      return [item.parentId, item.values.status];
    }),
    [
      [null, 1],
      [null, 0],
      [null, 0],
    ],
  );
});

test("moves become move_item variables", () => {
  const encode = (values) => JSON.stringify(values);
  assert.deepEqual(moveVariables({ itemId: "5", afterId: "1" }, encode), {
    itemId: "5",
    afterId: "1",
    beforeId: null,
    parentId: null,
    detach: false,
    groupId: null,
    values: null,
  });
  const out = { itemId: "3", beforeId: "4", parentId: null, values: { a: 1 } };
  assert.deepEqual(moveVariables(out, encode), {
    itemId: "3",
    afterId: null,
    beforeId: "4",
    parentId: null,
    detach: true,
    groupId: null,
    values: '{"a":1}',
  });
  const nest = { itemId: "3", parentId: "5", groupId: "closed" };
  const variables = moveVariables(nest, encode);
  assert.deepEqual(
    [variables.parentId, variables.detach, variables.groupId],
    ["5", false, "closed"],
  );
});

test("kanban drops: neighbors in the lane, the lane's label from elsewhere", () => {
  const board = moveBoard();
  const column = board.columns[1];
  const lanes = lanesFor(column);
  const facility = lanes[0];
  const blank = lanes.at(-1);
  const cards = ["E", "A", "C"].map((name) => byName(board, name));
  const [e, a, c] = cards;
  // Reordering within the lane: C to the top, E after A.
  const { items } = board;
  const top = { item: c, items, cards, index: 0, lane: facility, column };
  assert.deepEqual(laneMove({ ...top, fromKey: "0" }), {
    itemId: "5",
    beforeId: "7",
  });
  const down = { item: e, items, cards, index: 1, lane: facility, column };
  assert.deepEqual(laneMove({ ...down, fromKey: "0" }), {
    itemId: "7",
    afterId: "1",
  });
  // Dropped where it is: nothing to do.
  const same = { item: a, items, cards, index: 1, lane: facility, column };
  assert.equal(laneMove({ ...same, fromKey: "0" }), null);
  // From another lane: the lane's label (none for No status).
  const b = byName(board, "B");
  const into = { item: b, items, cards, index: 3, lane: facility, column };
  assert.deepEqual(laneMove({ ...into, fromKey: "1" }), {
    itemId: "4",
    afterId: "5",
    values: { status: 0 },
  });
  const empty = { item: b, items, cards: [], index: 0, lane: blank, column };
  assert.deepEqual(laneMove({ ...empty, fromKey: "1" }), {
    itemId: "4",
    values: { status: null },
  });
  // A lane can show the card's own subtask: never its neighbor.
  const blankCards = [byName(board, "D"), byName(board, "A1")];
  const parent = { item: a, items, cards: blankCards, index: 2, lane: blank };
  assert.deepEqual(laneMove({ ...parent, column, fromKey: "0" }), {
    itemId: "1",
    afterId: "6",
    values: { status: null },
  });
  // An index past the end lands last.
  const far = { item: b, items, cards, index: 9, lane: facility, column };
  assert.equal(laneMove({ ...far, fromKey: "1" }).afterId, "5");
});

test("items without a loaded neighbor keep the manual order stable", () => {
  const board = moveBoard([
    task("10", "X", { position: 1024 }),
    task("9", "Y", { position: 1024 }),
  ]);
  // Equal positions: by ID, as the server sorts.
  assert.deepEqual(order(board), ["Y", "X"]);
});
