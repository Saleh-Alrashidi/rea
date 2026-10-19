/**
 * `move_item_to_board` (SPEC-6 §3.2): an item moves with its subitems,
 * updates, replies and likes; values follow columns of the same role,
 * else of the same title and type; status labels match by name,
 * case-insensitively (else no status); people keep only those who can
 * open the target board; `dropped_columns` names the columns whose
 * values were left behind. It needs editor access on both boards, logs
 * the move on both (naming the other board only to readers who can open
 * it), streams events to both, and a refused move changes nothing.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { POSITION_SPACING } from "../server/store/positions.js";
import { startTestServers } from "./helpers.js";

const S = POSITION_SPACING;
const MOVE = `mutation M($i: ID!, $b: ID!, $g: String) {
  move_item_to_board(item_id: $i, board_id: $b, group_id: $g) {
    item { id position parent_item_id board { id } group { id }
      column_values { id text } subitems { id name parent_item_id }
      updates { body likes_count replies { body } } }
    dropped_columns } }`;

const label = (name, color = "#c4c4c4") => ({ label: name, color });
const SOURCE_COLUMNS = [
  {
    key: "st",
    title: "Status",
    type: "status",
    role: "status",
    labels: [label("To do"), label("In Progress"), label("Done")],
  },
  { key: "who", title: "Assignees", type: "people", role: "assignees" },
  { key: "due", title: "Due date", type: "date", role: "due_date" },
  { key: "notes", title: "Notes", type: "text" },
  { key: "pts", title: "Points", type: "numbers" },
  { key: "extra", title: "Extra", type: "text" },
  { key: "unused", title: "Unused", type: "text" },
  {
    key: "phase",
    title: "Phase",
    type: "status",
    labels: [label("Alpha"), label("Beta")],
  },
];
const TARGET_COLUMNS = [
  {
    key: "stage",
    title: "Stage",
    type: "status",
    role: "status",
    labels: [label("to do"), label("in progress"), label("Review")],
  },
  { key: "owner", title: "Owner", type: "people", role: "assignees" },
  { key: "deadline", title: "Deadline", type: "date", role: "due_date" },
  { key: "notes", title: "Notes", type: "text" },
  { key: "pts", title: "Points", type: "text" },
  { key: "phase", title: "Phase", type: "status", labels: [label("BETA")] },
];

/** An imported board (roles come from imports) in the main Space. */
function importBoard(store, ids, fields) {
  const result = store.importBoard({
    workspaceId: ids.workspaces.main,
    importerId: ids.users.alex,
    description: null,
    meta: { source: "clickup", sourceId: fields.name, sourceUrl: null },
    label: "Import from ClickUp",
    summary: "Imported",
    members: [],
    ...fields,
  });
  return result.board;
}

async function setup(t) {
  const servers = await startTestServers();
  t.after(() => servers.close());
  const { store, ids } = servers;
  const { users } = ids;
  const source = importBoard(store, ids, {
    name: "Source",
    boardKind: "public",
    groups: [{ key: "open", title: "Open", color: "#579bfc" }],
    columns: SOURCE_COLUMNS,
    items: [
      {
        key: "p",
        groupKey: "open",
        name: "Parent",
        values: {
          st: "In Progress",
          who: [users.sam, users.noa],
          due: "2026-11-01",
          notes: "Keep",
          pts: 3,
          extra: "lost",
          phase: "Beta",
        },
        updates: [
          {
            body: "Top",
            creatorId: users.sam,
            replies: [{ body: "Re", creatorId: users.noa }],
          },
        ],
      },
      {
        key: "c",
        parentKey: "p",
        groupKey: "open",
        name: "Child",
        values: { st: "Done", who: [users.noa], phase: "Alpha" },
      },
      {
        key: "g",
        parentKey: "c",
        groupKey: "open",
        name: "Grandchild",
        values: { notes: "deep" },
      },
      { groupKey: "open", name: "Stays", values: {} },
    ],
  });
  const target = importBoard(store, ids, {
    name: "Target",
    boardKind: "private",
    members: [{ userId: users.sam, role: "editor" }],
    groups: [
      { key: "backlog", title: "Backlog", color: "#579bfc" },
      { key: "doing", title: "Doing", color: "#fdab3d" },
    ],
    columns: TARGET_COLUMNS,
    items: [{ groupKey: "doing", name: "Already there", values: {} }],
  });
  const items = store.listItems({ boardId: source.id, limit: 10 }).items;
  const named = (name) => items.find((item) => item.name === name);
  const [top] = store.listUpdates(named("Parent").id);
  store.likeUpdate(top.id, users.noa);
  const events = [];
  store.on((event) => events.push(event));
  const as = (key) => servers.as(users[key]);
  return { ...servers, source, target, named, events, as };
}

test("an item moves with its subitems, updates and mapped values", async (t) => {
  const { store, source, target, named, events, as } = await setup(t);
  const [parent, child, grandchild] = ["Parent", "Child", "Grandchild"].map(
    named,
  );
  const last = Math.max(
    ...store.listItems({ boardId: target.id }).items.map((i) => i.position),
  );
  const { move_item_to_board: moved } = await as("sam").data(MOVE, {
    i: parent.id,
    b: target.id,
  });
  const text = Object.fromEntries(
    moved.item.column_values.map((value) => [value.id, value.text]),
  );
  const column = (title) =>
    store.listColumns(target.id).find((c) => c.title === title).id;
  assert.deepEqual(
    {
      id: moved.item.id,
      board: moved.item.board.id,
      group: moved.item.group.id,
      position: moved.item.position,
      parent: moved.item.parent_item_id,
    },
    {
      id: parent.id,
      board: target.id,
      group: "backlog",
      position: last + S,
      parent: null,
    },
    "the first group, after every item of the board",
  );
  assert.deepEqual(
    [
      text[column("Stage")],
      text[column("Owner")],
      text[column("Deadline")],
      text[column("Notes")],
      text[column("Points")],
      text[column("Phase")],
    ],
    ["in progress", "Sam Lee", "2026-11-01", "Keep", null, "BETA"],
    "role, then title and type; labels by name; only people with access",
  );
  assert.deepEqual(moved.dropped_columns, ["Points", "Extra"]);
  assert.deepEqual(moved.item.subitems, [
    { id: child.id, name: "Child", parent_item_id: parent.id },
  ]);
  assert.deepEqual(moved.item.updates, [
    { body: "Top", likes_count: 1, replies: [{ body: "Re" }] },
  ]);
  // The subtree came along and keeps its shape.
  const records = [child, grandchild].map((item) => store.getItem(item.id));
  assert.deepEqual(
    records.map((r) => [r.board_id, r.group_id, r.parent_id, r.position]),
    [
      [target.id, "backlog", parent.id, last + 2 * S],
      [target.id, "backlog", child.id, last + 3 * S],
    ],
  );
  assert.deepEqual(records[0].values, {}, "no matching status, no access");
  assert.deepEqual(
    store.listItems({ boardId: source.id }).items.map((item) => item.name),
    ["Stays"],
  );
  // Both boards log the move, naming the other board by reference.
  const log = (board) => store.listActivity(board.id, { limit: 1 })[0];
  assert.deepEqual(
    [log(source).kind, log(source).from_text, log(source).to_text],
    ["item_moved", "Source", [{ board_id: target.id }]],
  );
  assert.deepEqual(
    [log(target).kind, log(target).from_text, log(target).to_text],
    ["item_moved", [{ board_id: source.id }], "Target"],
  );
  assert.deepEqual(
    events.map((e) => [e.type, e.board_id, e.item_id]),
    [
      ["item_moved_to_board", target.id, parent.id],
      ["item_moved_to_board", target.id, child.id],
      ["item_moved_to_board", target.id, grandchild.id],
      ["item_moved_to_board", source.id, parent.id],
      ["item_moved_to_board", source.id, child.id],
      ["item_moved_to_board", source.id, grandchild.id],
    ],
  );
  assert.equal(events[0].from_board_id, source.id);
  assert.equal(events[3].to_board_id, target.id);
  // A subitem moves out of its parent: top level on the other board, in
  // the group asked for; the public source is named on the target.
  const back = await as("sam").data(MOVE, {
    i: grandchild.id,
    b: source.id,
    g: "open",
  });
  assert.equal(back.move_item_to_board.item.parent_item_id, null);
  assert.deepEqual(back.move_item_to_board.dropped_columns, []);
  const notes = store.listColumns(source.id).find((c) => c.title === "Notes");
  assert.equal(store.getItem(grandchild.id).values[notes.id], "deep");
  assert.deepEqual(log(target).to_text, [{ board_id: source.id }]);
});

const LOG = `query Q($b: ID!) { boards(ids: [$b]) {
  activity_logs(limit: 2) { kind from_text to_text } } }`;

test("the move's activity names the other board only to readers who can open it", async (t) => {
  const { store, source, target, named, as, ids } = await setup(t);
  const { users, boards } = ids;
  /** The board's latest log entry (`index` 1: the one before) as `user` reads it. */
  const read = async (user, board, index = 0) => {
    const { boards: found } = await as(user).data(LOG, { b: board });
    const entry = found[0].activity_logs[index];
    return [entry.kind, entry.from_text, entry.to_text];
  };
  // Into the private target: Sam and admins can open it, Priya cannot.
  await as("sam").data(MOVE, { i: named("Parent").id, b: target.id });
  assert.deepEqual(await read("priya", source.id), [
    "item_moved",
    "Source",
    "another board",
  ]);
  for (const user of ["sam", "alex"]) {
    assert.deepEqual(await read(user, source.id), [
      "item_moved",
      "Source",
      "Target",
    ]);
  }
  assert.deepEqual(await read("sam", target.id), [
    "item_moved",
    "Source",
    "Target",
  ]);
  // A Main board of a closed Space is named only to its members.
  const secret = store.createWorkspace({
    name: "M&A",
    kind: "closed",
    creatorId: users.alex,
  });
  const globex = store.createBoard({
    name: "Acquire Globex",
    creatorId: users.alex,
    workspaceId: secret.id,
    boardKind: "public",
  });
  const [roadmapItem] = store.listItems({ boardId: boards.roadmap }).items;
  await as("alex").data(MOVE, { i: roadmapItem.id, b: globex.id });
  const away = await read("priya", boards.roadmap);
  assert.equal(away[2], "another board");
  assert.equal((await read("alex", boards.roadmap))[2], "Acquire Globex");
  // A guest on a shareable board reads neither direction's other board.
  const share = store.createBoard({
    name: "Agency work",
    creatorId: users.alex,
    boardKind: "share",
  });
  store.share({
    resourceKind: "board",
    resourceId: share.id,
    subjectKind: "user",
    subjectIds: [users.chris],
    role: "viewer",
    actorId: users.alex,
  });
  const task = store.createItem({
    boardId: share.id,
    name: "Task",
    creatorId: users.alex,
  });
  await as("alex").data(MOVE, { i: task.id, b: boards.budget });
  await as("alex").data(MOVE, { i: task.id, b: share.id });
  assert.deepEqual(await read("chris", share.id, 1), [
    "item_moved",
    "Agency work",
    "another board",
  ]);
  assert.deepEqual(await read("chris", share.id), [
    "item_moved",
    "another board",
    "Agency work",
  ]);
  assert.equal((await read("alex", share.id, 1))[2], "Budget 2027");
  assert.equal((await read("alex", share.id))[1], "Budget 2027");
  const { boards: hidden } = await as("chris").data(LOG, { b: boards.budget });
  assert.deepEqual(hidden, [], "the guest cannot open the other board");
});

test("move_item_to_board needs editor access on both boards; refusals change nothing", async (t) => {
  const { store, source, target, named, as, ids } = await setup(t);
  const parent = named("Parent");
  const before = JSON.stringify([
    store.listItems({ boardId: source.id }),
    store.listItems({ boardId: target.id }),
  ]);
  const refusals = [
    // Jordan only views the source; nothing tells him about the target.
    ["jordan", { i: parent.id, b: target.id }, "FORBIDDEN"],
    ["jordan", { i: parent.id, b: ids.boards.roadmap }, "FORBIDDEN"],
    ["noa", { i: parent.id, b: target.id }, "NOT_FOUND"],
    ["sam", { i: parent.id, b: source.id }, "BAD_USER_INPUT"],
    ["sam", { i: parent.id, b: target.id, g: "nope" }, "NOT_FOUND"],
    ["sam", { i: "99999", b: target.id }, "NOT_FOUND"],
    ["sam", { i: parent.id, b: "99999" }, "NOT_FOUND"],
    ["chris", { i: parent.id, b: target.id }, "NOT_FOUND"],
  ];
  for (const [user, vars, code] of refusals) {
    assert.equal(
      await as(user).code(MOVE, vars),
      code,
      `${user} ${JSON.stringify(vars)}`,
    );
  }
  // A viewer of the target cannot move items into it.
  store.share({
    resourceKind: "board",
    resourceId: target.id,
    subjectKind: "user",
    subjectIds: [ids.users.noa],
    role: "viewer",
    actorId: ids.users.alex,
  });
  assert.equal(
    await as("noa").code(MOVE, { i: parent.id, b: target.id }),
    "FORBIDDEN",
  );
  assert.equal(
    JSON.stringify([
      store.listItems({ boardId: source.id }),
      store.listItems({ boardId: target.id }),
    ]),
    before,
  );
});
