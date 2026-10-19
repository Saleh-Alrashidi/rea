/**
 * Moving things in the sidebar (SPEC-6 §3.3), pure: drop bands, who may
 * drag what, what a drop does (place, indicator, refusals), Move up /
 * down / to…, the way back for Undo and the mutation variables.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  canDrag,
  moveInto,
  moveVariables,
  resolveDrop,
  stepMove,
  wayBack,
  zoneAt,
} from "../web/ui/shell/sidebar-drop-model.js";
import { buildSpaces, findNode } from "../web/ui/shell/sidebar-model.js";
import { WORKSPACES } from "./web-sidebar-fixtures.js";

const spaces = buildSpaces(WORKSPACES);
const drop = (dragKey, targetKey, zone) =>
  resolveDrop(spaces, { dragKey, targetKey, zone });
/** A drop's outcome in short: its place (or refusal) and indicator. */
function outcome(result) {
  const { indicator } = result;
  const paint = `${indicator.type} ${indicator.key}`;
  if (!result.ok) return { refused: result.reason, paint };
  return { place: result.move.place, paint };
}

test("drop bands: containers take Lists anywhere, rows split in halves", () => {
  const band = (dragKind, targetKind, offset) =>
    zoneAt({ dragKind, targetKind, offset, height: 32 });
  assert.equal(band("board", "board", 10), "before");
  assert.equal(band("board", "doc", 20), "after");
  assert.equal(band("doc", "folder", 2), "inside");
  assert.equal(band("board", "space", 30), "inside");
  assert.equal(band("folder", "folder", 5), "before");
  assert.equal(band("folder", "space", 5), "inside");
  assert.equal(band("folder", "board", 5), "after");
  assert.equal(band("space", "board", 5), "before");
  assert.equal(band("space", "space", 25), "after");
});

test("who may drag: Space editors, owners of their Lists, admins for Spaces", () => {
  const node = (key) => findNode(spaces, key);
  const member = { is_admin: false };
  assert.equal(canDrag(spaces, node("board:101"), member), true);
  assert.equal(canDrag(spaces, node("folder:10"), member), true);
  assert.equal(canDrag(spaces, node("form:300"), member), false);
  assert.equal(canDrag(spaces, node("space:1"), member), false);
  assert.equal(canDrag(spaces, node("space:1"), { is_admin: true }), true);
  // A view-only Space: nothing moves, unless the user owns the List.
  assert.equal(canDrag(spaces, node("board:110"), member), false);
  const owned = buildSpaces([
    {
      ...WORKSPACES[1],
      boards: [{ ...WORKSPACES[1].boards[0], my_access: "owner" }],
    },
  ]);
  assert.equal(canDrag(owned, findNode(owned, "board:110"), member), true);
  assert.equal(canDrag(spaces, null, member), false);
});

test("Lists reorder in their folder and move into folders and Spaces", () => {
  assert.deepEqual(outcome(drop("board:102", "board:101", "before")), {
    place: { spaceId: "1", folderId: "10", beforeId: "101" },
    paint: "before board:101",
  });
  assert.deepEqual(outcome(drop("board:100", "folder:11", "inside")), {
    place: { spaceId: "1", folderId: "11" },
    paint: "inside folder:11",
  });
  // Into a folder: after its last List.
  assert.deepEqual(outcome(drop("board:100", "folder:10", "inside")).place, {
    spaceId: "1",
    folderId: "10",
    afterId: "102",
  });
  // Onto a doc of a folder: the List goes after the folder's Lists.
  assert.deepEqual(outcome(drop("board:103", "doc:201", "before")), {
    place: { spaceId: "1", folderId: "10", afterId: "102" },
    paint: "inside folder:10",
  });
  // Out of a folder, next to a root List.
  assert.deepEqual(outcome(drop("board:101", "board:103", "after")).place, {
    spaceId: "1",
    folderId: null,
    afterId: "103",
  });
  // A doc onto a Space: the end of its root docs.
  assert.deepEqual(outcome(drop("doc:201", "space:1", "inside")), {
    place: { spaceId: "1", folderId: null, afterId: "200" },
    paint: "inside space:1",
  });
});

test("drops that change nothing or reach a view-only Space are refused", () => {
  assert.deepEqual(outcome(drop("board:101", "board:102", "before")), {
    refused: "no-op",
    paint: "before board:102",
  });
  assert.equal(drop("board:102", "board:101", "after").reason, "no-op");
  assert.equal(drop("board:102", "folder:10", "inside").reason, "no-op");
  assert.equal(drop("board:101", "board:101", "after").reason, "no-op");
  assert.deepEqual(outcome(drop("board:100", "board:110", "before")), {
    refused: "no-edit",
    paint: "before board:110",
  });
  assert.equal(drop("board:100", "space:2", "inside").reason, "no-edit");
  assert.equal(drop("form:300", "space:1", "inside"), null, "forms stay");
  assert.equal(drop("board:404", "space:1", "inside"), null);
});

test("a List moving to another Space goes through (the server decides)", () => {
  const twoSpaces = buildSpaces([
    WORKSPACES[0],
    { ...WORKSPACES[1], my_access: "editor" },
  ]);
  const result = resolveDrop(twoSpaces, {
    dragKey: "board:100",
    targetKey: "board:110",
    zone: "after",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(moveVariables(result.move), {
    id: "100",
    workspaceId: "2",
    folderId: null,
    toRoot: true,
    afterId: "110",
    beforeId: null,
  });
});

test("folders reorder within their Space only", () => {
  assert.deepEqual(outcome(drop("folder:11", "folder:10", "before")), {
    place: { spaceId: "1", beforeId: "10" },
    paint: "before folder:10",
  });
  // Over a folder's content: after that folder.
  assert.deepEqual(outcome(drop("folder:10", "board:101", "after")), {
    refused: "no-op",
    paint: "after folder:10",
  });
  // Over the root's Lists or the Space: after the last folder.
  assert.deepEqual(outcome(drop("folder:10", "board:100", "after")), {
    place: { spaceId: "1", afterId: "11" },
    paint: "after folder:11",
  });
  assert.deepEqual(outcome(drop("folder:10", "space:2", "inside")), {
    refused: "other-space",
    paint: "inside space:2",
  });
  assert.equal(drop("folder:10", "board:110", "after").reason, "other-space");
  assert.deepEqual(
    moveVariables(drop("folder:11", "folder:10", "before").move),
    {
      id: "11",
      afterId: null,
      beforeId: "10",
    },
  );
});

test("Spaces reorder before or after a Space (its content counts as after)", () => {
  assert.deepEqual(outcome(drop("space:2", "space:1", "before")), {
    place: { beforeId: "1" },
    paint: "before space:1",
  });
  assert.equal(drop("space:2", "board:100", "before").reason, "no-op");
  assert.deepEqual(outcome(drop("space:1", "board:110", "before")), {
    place: { afterId: "2" },
    paint: "after space:2",
  });
  assert.equal(drop("space:1", "space:2", "before").reason, "no-op");
});

test("Move up / down, Move to… and the way back", () => {
  assert.deepEqual(stepMove(spaces, "board:102", "up").place, {
    spaceId: "1",
    folderId: "10",
    beforeId: "101",
  });
  assert.equal(stepMove(spaces, "board:102", "down"), null, "last in folder");
  assert.deepEqual(stepMove(spaces, "space:1", "down").place, {
    afterId: "2",
  });
  assert.equal(stepMove(spaces, "form:300", "up"), null);
  const sprint = findNode(spaces, "board:101");
  assert.deepEqual(moveInto(spaces, sprint, { spaceId: "1" }).place, {
    spaceId: "1",
    folderId: null,
    afterId: "104",
  });
  assert.deepEqual(
    moveInto(spaces, sprint, { spaceId: "1", folderId: "11" }).place,
    { spaceId: "1", folderId: "11" },
  );
  assert.equal(moveInto(spaces, sprint, { spaceId: "9" }), null);
  assert.deepEqual(wayBack(spaces, sprint).place, {
    spaceId: "1",
    folderId: "10",
    beforeId: "102",
  });
  assert.deepEqual(wayBack(spaces, findNode(spaces, "folder:11")).place, {
    spaceId: "1",
    afterId: "10",
  });
  assert.deepEqual(moveVariables(wayBack(spaces, sprint)), {
    id: "101",
    workspaceId: "1",
    folderId: "10",
    toRoot: false,
    afterId: null,
    beforeId: "102",
  });
});
