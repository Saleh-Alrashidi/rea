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
  assert.deepEqual(neighborsAt(siblings, 9), { afterId: "2" });
  assert.deepEqual(neighborsAt([], 0), {});
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
  // Between its own subtasks (E, A1, A, A2, B), no neighbor names A's
  // place (move_item refuses them): A comes back after A2, before B.
  byName(board, "A1").position = 600;
  assert.deepEqual(undoMoves(board, [moveA]), [{ itemId: "1", beforeId: "4" }]);
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

test("undo after the task's own subtask: before the next item that stays", () => {
  // P, S, X, Q where S is X's subtask: "after P" would put X before S.
  const board = moveBoard([
    task("1", "P", { position: 1024 }),
    task("3", "X", { position: 3072 }),
    task("2", "S", { position: 2048, parentId: "3" }),
    task("4", "Q", { position: 4096 }),
    task("5", "R", { position: 5120 }),
  ]);
  const before = order(board);
  const moveX = { itemId: "3", afterId: "4" };
  const back = undoMoves(board, [moveX]);
  assert.deepEqual(back, [{ itemId: "3", beforeId: "4" }]);
  applyMove(board, moveX, USERS);
  assert.deepEqual(order(board), ["P", "S", "Q", "X", "R"]);
  for (const request of back) applyMove(board, request, USERS);
  assert.deepEqual(order(board), before);
  // Q moves too: it is not back yet when X's record runs, so X goes
  // before R, and Q then after X.
  const both = [moveX, { itemId: "4", afterId: "5" }];
  const backBoth = undoMoves(board, both);
  assert.deepEqual(backBoth, [
    { itemId: "3", beforeId: "5" },
    { itemId: "4", afterId: "3" },
  ]);
  for (const request of [...both, ...backBoth]) {
    applyMove(board, request, USERS);
  }
  assert.deepEqual(order(board), before);
  // Nothing free and staying after it: after the nearest earlier item.
  const last = moveBoard([
    task("1", "P", { position: 1024 }),
    task("3", "X", { position: 3072 }),
    task("2", "S", { position: 2048, parentId: "3" }),
  ]);
  assert.deepEqual(undoMoves(last, [{ itemId: "3", beforeId: "1" }]), [
    { itemId: "3", afterId: "1" },
  ]);
  // A move without neighbors keeps the position, and so does its undo.
  assert.deepEqual(undoMoves(last, [{ itemId: "3", parentId: "1" }]), [
    { itemId: "3", parentId: null },
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
  // An index past the end lands last.
  const far = { item: b, items, cards, index: 9, lane: facility, column };
  assert.equal(laneMove({ ...far, fromKey: "1" }).afterId, "5");
});

/**
 * Board order Z, S1, A, X, S2, S3, Q, B, where S1-S3 are X's subtasks:
 * the facility lane shows S1, A, S2, S3, B and the psych dept lane Z, X, Q.
 */
function subtaskLanes(zPosition = 100) {
  const board = moveBoard([
    task("1", "Z", { position: zPosition, status: 1 }),
    task("2", "S1", { position: 200, status: 0, parentId: "4" }),
    task("3", "A", { position: 300, status: 0 }),
    task("4", "X", { position: 400, status: 1 }),
    task("5", "S2", { position: 500, status: 0, parentId: "4" }),
    task("6", "S3", { position: 550, status: 0, parentId: "4" }),
    task("7", "Q", { position: 600, status: 1 }),
    task("8", "B", { position: 700, status: 0 }),
  ]);
  const column = board.columns[1];
  const lane = (key) =>
    manualOrder(board.items).filter(
      (item) => String(item.values.status ?? "blank") === key,
    );
  const drop = (index) =>
    laneMove({
      item: byName(board, "X"),
      items: board.items,
      cards: lane("0"),
      index,
      lane: lanesFor(column)[0],
      column,
      fromKey: "1",
    });
  return { board, lane, drop };
}

test("kanban drops next to the card's own subtasks use the board's order", () => {
  const { board, lane, drop } = subtaskLanes();
  const values = { status: 0 };
  // First in the lane, before S1: after the last free item before it.
  assert.deepEqual(drop(0), { itemId: "4", afterId: "1", values });
  // After subtask S1: before the first free item after it.
  assert.deepEqual(drop(1), { itemId: "4", beforeId: "3", values });
  // Between A and S2 it already sits there: only the status changes.
  assert.deepEqual(drop(2), { itemId: "4", values });
  // After S3: before Q, the first free item after it (another lane's).
  assert.deepEqual(drop(4), { itemId: "4", beforeId: "7", values });
  assert.deepEqual(drop(5), { itemId: "4", afterId: "8", values });
  // Between S2 and S3 no neighbor names the place: refused.
  assert.equal(drop(3), null);
  const names = () => lane("0").map((item) => item.name);
  applyMove(board, drop(4), USERS);
  assert.deepEqual(names(), ["S1", "A", "S2", "S3", "X", "B"]);
  // Before S1 when it starts the board (Z comes later): refused.
  assert.equal(subtaskLanes(250).drop(0), null);
});

test("kanban drops that change nothing within the lane are no moves", () => {
  // B, A, X, S in one lane, S being X's subtask.
  const board = moveBoard([
    task("1", "B", { position: 100 }),
    task("2", "A", { position: 200 }),
    task("3", "X", { position: 300 }),
    task("4", "S", { position: 400, parentId: "3" }),
  ]);
  const column = board.columns[1];
  const blank = lanesFor(column).at(-1);
  const cards = manualOrder(board.items);
  const drop = (index) =>
    laneMove({
      item: byName(board, "X"),
      items: board.items,
      cards,
      index,
      lane: blank,
      column,
      fromKey: blank.key,
    });
  // After S, X's only place would be "after A", where it already is.
  assert.equal(drop(3), null);
  assert.equal(drop(2), null);
  assert.deepEqual(drop(1), { itemId: "3", afterId: "1" });
  assert.deepEqual(drop(0), { itemId: "3", beforeId: "1" });
});

test("items without a loaded neighbor keep the manual order stable", () => {
  const board = moveBoard([
    task("10", "X", { position: 1024 }),
    task("9", "Y", { position: 1024 }),
  ]);
  // Equal positions: by ID, as the server sorts.
  assert.deepEqual(order(board), ["Y", "X"]);
});
