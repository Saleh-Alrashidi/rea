/**
 * Deleting a group from the board page (`actions.deleteGroup`): the
 * server cascades through the subitems of the group's items wherever
 * they sit (SPEC-5 §1.1), so the confirmation counts them all, naming
 * those in other groups, and the optimistic change removes the same set.
 * Runs on `fake-dom.js` with a modal that confirms on submit and a
 * stubbed `fetch`.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  groupDeletionMessage,
  createActions,
} from "../web/ui/board/actions.js";
import { groupDeletion } from "../web/ui/board/list-model.js";
import {
  FakeElement,
  findAll,
  fire,
  hasClass,
  installFakeDom,
} from "./fake-dom.js";
import { meetingsBoard, task } from "./web-task-fixtures.js";

/** The meetings board: a closed parent with an open subtask (and its own). */
function board() {
  return meetingsBoard([
    task("1", "Closed parent", {}, { groupId: "closed" }),
    task("2", "Open subtask", {}, { parentId: "1" }),
    task("3", "Its own subtask", {}, { parentId: "2" }),
    task("4", "Closed subtask", {}, { parentId: "1", groupId: "closed" }),
    task("5", "Unrelated", {}),
  ]);
}

test("a group's deletion holds its items and every descendant", () => {
  const items = board().items;
  const gone = groupDeletion(items, "closed");
  assert.deepEqual([...gone.ids].sort(), ["1", "2", "3", "4"]);
  assert.deepEqual([gone.inGroup, gone.elsewhere, gone.otherGroups], [2, 2, 1]);
  const open = groupDeletion(items, "open");
  assert.deepEqual([...open.ids].sort(), ["2", "3", "5"]);
  assert.equal(open.elsewhere, 0, "a subtask in the group is its own item");
});

test("the confirmation names the subitems in other groups", () => {
  const group = { title: "Closed" };
  const gone = groupDeletion(board().items, "closed");
  assert.equal(
    groupDeletionMessage(group, gone),
    "“Closed”, its 2 items and their 2 subitems in another group will be deleted.",
  );
  assert.equal(
    groupDeletionMessage(group, { inGroup: 1, elsewhere: 3, otherGroups: 2 }),
    "“Closed”, its 1 item and their 3 subitems in other groups will be deleted.",
  );
  assert.equal(
    groupDeletionMessage(group, { inGroup: 1, elsewhere: 0, otherGroups: 0 }),
    "“Closed” and its 1 item will be deleted.",
  );
  // Counts of a partly loaded board are a lower bound.
  assert.match(
    groupDeletionMessage(group, gone, { truncated: true }),
    /will be deleted\. Not every item of this board is loaded, so there may be more\.$/,
  );
});

/** Modals that open and close, and forms that are always valid. */
function patchDialogs() {
  Object.assign(FakeElement.prototype, {
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
      fire(this, "close");
    },
    reportValidity: () => true,
  });
}

test("deleting a group confirms the cascade and removes the same items", async (t) => {
  const doc = installFakeDom(t);
  patchDialogs();
  const sent = [];
  t.mock.method(globalThis, "fetch", async (_path, init) => {
    sent.push(JSON.parse(init.body).variables);
    const body = { data: { delete_group: { id: "closed" } } };
    return new Response(JSON.stringify(body), { status: 200 });
  });
  const state = { board: board(), pendingMutations: 0, mutationSeq: 0 };
  const closedCards = [];
  const actions = createActions({
    state,
    render() {},
    refresh() {},
    refreshShell() {},
    navigate() {},
    focusAfterRender() {},
    onItemDeleted: (id) => closedCards.push(id),
    onBoardDeleted() {},
  });
  const [, closed] = state.board.groups;
  const deleting = actions.deleteGroup(closed);
  await new Promise((resolve) => setImmediate(resolve));
  const [dialog] = findAll(doc.body, (node) => node.localName === "dialog");
  const [message] = findAll(dialog, (node) => hasClass(node, "dialog-message"));
  assert.equal(
    message.textContent,
    "“Closed”, its 2 items and their 2 subitems in another group will be deleted.",
  );
  const [form] = findAll(dialog, (node) => node.localName === "form");
  fire(form, "submit");
  await deleting;
  assert.deepEqual(
    state.board.items.map((item) => item.id),
    ["5"],
  );
  assert.deepEqual(
    state.board.groups.map((group) => group.id),
    ["open"],
  );
  assert.deepEqual(closedCards.sort(), ["1", "2", "3", "4"]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent, [{ boardId: "1", groupId: "closed" }]);
});
