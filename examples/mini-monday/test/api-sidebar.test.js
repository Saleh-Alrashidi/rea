/**
 * The sidebar order and moves over GraphQL (SPEC-6 §3.1, §3.2):
 * `move_board`, `move_doc`, `move_folder` and `move_workspace` place a
 * record right after `after_id` and/or before `before_id` at the
 * midpoint, renumbering the container when a side has no neighbor; lists
 * come in that order. Within a Space, Space editors move; to another
 * Space, the record's owner with editor access there; Spaces, admins.
 * Private boards stay private wherever they go, and refusals change
 * nothing.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { POSITION_SPACING } from "../server/store/positions.js";
import { openStream, startTestServers } from "./helpers.js";

const S = POSITION_SPACING;
const PLACE =
  "workspace_id: $w, folder_id: $f, to_root: $r, after_id: $a, before_id: $b";
const VARS = "$w: ID, $f: ID, $r: Boolean, $a: ID, $b: ID";
const MOVE_BOARD = `mutation M($i: ID!, ${VARS}) { move_board(board_id: $i,
  ${PLACE}) { id position workspace { id } folder { id } } }`;
const MOVE_DOC = `mutation M($i: ID!, ${VARS}) { move_doc(doc_id: $i,
  ${PLACE}) { id position workspace { id } folder { id } } }`;
const MOVE_FOLDER = `mutation M($i: ID!, $a: ID, $b: ID) {
  move_folder(folder_id: $i, after_id: $a, before_id: $b) { id position } }`;
const MOVE_SPACE = `mutation M($i: ID!, $a: ID, $b: ID) {
  move_workspace(workspace_id: $i, after_id: $a, before_id: $b) { id position } }`;
const CREATE_FOLDER = `mutation C($w: ID!, $n: String!) {
  create_folder(workspace_id: $w, name: $n) { id } }`;
const SIDEBAR = `{ workspaces { id name boards { name position folder { id } }
  docs { title position folder { id } } folders { name position
  docs { title } } } }`;

async function setup(t) {
  const servers = await startTestServers();
  t.after(() => servers.close());
  const { users } = servers.ids;
  const active = ["alex", "sam", "noa", "priya", "jordan", "chris"];
  const as = Object.fromEntries(
    active.map((key) => [key, servers.as(users[key])]),
  );
  const events = [];
  servers.store.on((event) => events.push(event));
  const folder = async (client, workspaceId, name) =>
    (await client.data(CREATE_FOLDER, { w: workspaceId, n: name }))
      .create_folder.id;
  const space = async (client, id) =>
    (await client.data(SIDEBAR)).workspaces.find((w) => w.id === id);
  return { ...servers, ...servers.ids, as, events, folder, space };
}

/** Lets `userId` edit the closed Leadership Space. */
function shareLeadership({ store, workspaces, users }, userId) {
  store.share({
    resourceKind: "workspace",
    resourceId: workspaces.leadership,
    subjectKind: "user",
    subjectIds: [userId],
    role: "editor",
    actorId: users.alex,
  });
}

const boardNamed = (store, name) =>
  store.listBoards({ limit: 100 }).find((board) => board.name === name);

/**
 * Sam's boards A, B and C in Main, moved by midpoints and renumbering to
 * the order A, B, roadmap, C, marketing; returns `id(name)`.
 */
async function arranged(ctx) {
  const { as, store, boards, workspaces, events, space } = ctx;
  const { main } = workspaces;
  for (const name of ["A", "B", "C"]) {
    await as.sam.data(
      `mutation { create_board(board_name: "${name}", workspace_id: "${main}") { id } }`,
    );
  }
  const id = (name) => boardNamed(store, name).id;
  const move = (client, vars) => client.data(MOVE_BOARD, vars);
  const after = await move(as.sam, { i: id("C"), a: boards.roadmap });
  assert.equal(
    after.move_board.position,
    1.5 * S,
    "between roadmap and the next",
  );
  assert.deepEqual(events.at(-1), {
    type: "board_moved",
    board_id: id("C"),
    workspace_id: main,
    folder_id: null,
    position: 1.5 * S,
  });
  const first = await move(as.sam, { i: id("A"), b: boards.roadmap });
  assert.equal(first.move_board.position, 0.5 * S, "first: renumbered");
  const between = await move(as.sam, {
    i: id("B"),
    a: id("A"),
    b: boards.roadmap,
  });
  assert.equal(between.move_board.position, 0.75 * S);
  const order = (await space(as.priya, main)).boards.map((b) => [
    b.name,
    b.position,
  ]);
  assert.deepEqual(order, [
    ["A", 0.5 * S],
    ["B", 0.75 * S],
    ["Product roadmap", S],
    ["C", 2 * S],
    ["Marketing launch", 3 * S],
  ]);
  return id;
}

test("move_board places boards at midpoints and renumbers at the edges", async (t) => {
  const ctx = await setup(t);
  const { as, workspaces, events } = ctx;
  const { main } = workspaces;
  const id = await arranged(ctx);
  const move = (client, vars) => client.data(MOVE_BOARD, vars);
  // Into a folder (last there), with neighbors there, and back to the root.
  const plans = await ctx.folder(as.sam, main, "Plans");
  const both = { i: id("A"), f: plans, r: true };
  assert.equal(await as.sam.code(MOVE_BOARD, both), "BAD_USER_INPUT");
  await move(as.sam, { i: id("A"), f: plans });
  const second = await move(as.sam, { i: id("B"), f: plans });
  assert.deepEqual(second.move_board, {
    id: id("B"),
    position: 2 * S,
    workspace: { id: main },
    folder: { id: plans },
  });
  const outside = await as.sam.error(MOVE_BOARD, { i: id("C"), a: id("A") });
  assert.equal(outside.extensions.code, "NOT_FOUND", "A is in the folder");
  const inFolder = await move(as.sam, { i: id("C"), f: plans, b: id("A") });
  assert.equal(inFolder.move_board.position, 0.5 * S);
  const root = await move(as.sam, { i: id("C"), r: true });
  assert.deepEqual(root.move_board.folder, null);
  assert.equal(root.move_board.position, 4 * S, "last at the root");
  const count = events.length;
  await move(as.sam, { i: id("C") });
  assert.equal(
    events.length,
    count,
    "a move that changes nothing emits nothing",
  );
});

test("refused board moves change nothing", async (t) => {
  const ctx = await setup(t);
  const { as, store, boards } = ctx;
  const id = await arranged(ctx);
  const before = JSON.stringify(store.listBoards({ limit: 100 }));
  const refusals = [
    [as.sam, { i: id("C"), a: boards.roadmap, b: id("A") }, "BAD_USER_INPUT"],
    [as.sam, { i: id("C"), a: id("C") }, "BAD_USER_INPUT"],
    [as.sam, { i: id("C"), a: boards.marketing }, "NOT_FOUND"],
    [as.sam, { i: id("C"), a: "99999" }, "NOT_FOUND"],
    [as.sam, { i: id("C"), a: boards.hiring }, "NOT_FOUND"],
    [as.alex, { i: id("C"), a: boards.hiring }, "NOT_FOUND"],
    [as.sam, { i: id("C"), f: "99999" }, "NOT_FOUND"],
    [as.jordan, { i: boards.roadmap, a: id("A") }, "FORBIDDEN"],
    [as.chris, { i: boards.marketing, b: boards.marketing }, "FORBIDDEN"],
    [as.priya, { i: boards.hiring }, "NOT_FOUND"],
  ];
  for (const [client, vars, code] of refusals) {
    assert.equal(
      await client.code(MOVE_BOARD, vars),
      code,
      JSON.stringify(vars),
    );
  }
  const hidden = await as.sam.error(MOVE_BOARD, {
    i: id("C"),
    a: boards.marketing,
  });
  assert.equal(hidden.message, `Board "${boards.marketing}" was not found`);
  const elsewhere = await as.alex.error(MOVE_BOARD, {
    i: id("C"),
    a: boards.hiring,
  });
  assert.equal(
    elsewhere.message,
    `Board "${boards.hiring}" is not in that place`,
  );
  assert.equal(JSON.stringify(store.listBoards({ limit: 100 })), before);
});

test("moving a board to another Space needs its owner and editor access there", async (t) => {
  const ctx = await setup(t);
  const { as, store, boards, workspaces, users } = ctx;
  const { main, leadership } = workspaces;
  await as.sam.data(
    `mutation { create_board(board_name: "Sam's", workspace_id: "${main}") { id } }`,
  );
  const mine = boardNamed(store, "Sam's").id;
  const away = { i: mine, w: leadership };
  assert.equal(
    await as.sam.code(MOVE_BOARD, away),
    "NOT_FOUND",
    "a hidden Space",
  );
  shareLeadership(ctx, users.sam);
  const moved = await as.sam.data(MOVE_BOARD, away);
  assert.deepEqual(moved.move_board, {
    id: mine,
    position: 3 * S,
    workspace: { id: leadership },
    folder: null,
  });
  // Editors who do not own the board cannot take it elsewhere.
  const roadmap = await as.sam.error(MOVE_BOARD, {
    i: boards.roadmap,
    w: leadership,
  });
  assert.equal(roadmap.extensions.code, "FORBIDDEN");
  assert.equal(roadmap.message, "This needs owner access to the board");
  assert.equal(
    await as.noa.code(MOVE_BOARD, { i: boards.hiring, w: main }),
    "FORBIDDEN",
  );
  // A private board moved into a folder of another Space stays private.
  const hidden = await ctx.folder(as.alex, main, "Hidden");
  const mismatch = { i: boards.hiring, w: leadership, f: hidden };
  assert.equal(await as.alex.code(MOVE_BOARD, mismatch), "BAD_USER_INPUT");
  const into = await as.alex.data(MOVE_BOARD, { i: boards.hiring, f: hidden });
  assert.deepEqual(into.move_board.workspace, { id: main });
  assert.deepEqual(into.move_board.folder, { id: hidden });
  const read = `query ($b: ID!) { boards(ids: [$b]) { board_kind folder { id } } }`;
  assert.deepEqual((await as.sam.data(read, { b: boards.hiring })).boards, []);
  assert.deepEqual((await as.noa.data(read, { b: boards.hiring })).boards, [
    { board_kind: "private", folder: { id: hidden } },
  ]);
  const samFolders = (await ctx.space(as.sam, main)).folders;
  assert.deepEqual(samFolders, [{ name: "Hidden", position: S, docs: [] }]);
});

test("a board stream sees the move; one that loses access to the board ends", async (t) => {
  const ctx = await setup(t);
  const { as, store, workspaces, users, hostUrl, sessionFor } = ctx;
  const { main, leadership } = workspaces;
  await as.sam.data(
    `mutation { create_board(board_name: "Sam's", workspace_id: "${main}") { id } }`,
  );
  const board = boardNamed(store, "Sam's").id;
  const url = new URL(`/v2/events?board_id=${board}`, hostUrl);
  const watch = async (userId) => {
    const stream = await openStream(url, sessionFor(userId));
    t.after(() => stream.close());
    await stream.next(/^: connected\n\n/);
    return stream;
  };
  const [sam, noa] = [await watch(users.sam), await watch(users.noa)];
  shareLeadership(ctx, users.sam);
  await as.sam.data(MOVE_BOARD, { i: board, w: leadership });
  const [, data] = await sam.next(/event: change\ndata: (.*)\n\n/);
  assert.deepEqual(JSON.parse(data), {
    type: "board_moved",
    board_id: board,
    workspace_id: leadership,
    folder_id: null,
    position: 3 * S,
  });
  // Noa could open the public board in Main, not in closed Leadership.
  assert.doesNotMatch(await noa.ends(), /board_moved/);
});

test("move_doc follows the board rules", async (t) => {
  const ctx = await setup(t);
  const { as, docs, workspaces, users } = ctx;
  const { main, leadership } = workspaces;
  const notes = await ctx.folder(as.sam, main, "Notes");
  await as.sam.data(MOVE_DOC, { i: docs.vision, f: notes });
  const first = await as.sam.data(MOVE_DOC, {
    i: docs.brief,
    f: notes,
    b: docs.vision,
  });
  assert.deepEqual(first.move_doc, {
    id: docs.brief,
    position: 0.5 * S,
    workspace: { id: main },
    folder: { id: notes },
  });
  const [folder] = (await ctx.space(as.sam, main)).folders;
  assert.deepEqual(folder.docs, [
    { title: "Launch brief" },
    { title: "Product vision" },
  ]);
  assert.equal(
    await as.jordan.code(MOVE_DOC, { i: docs.vision, r: true }),
    "FORBIDDEN",
  );
  assert.equal(await as.noa.code(MOVE_DOC, { i: docs.brief }), "NOT_FOUND");
  // Across Spaces: the doc's owner, with editor access to the target.
  assert.equal(
    await as.priya.code(MOVE_DOC, { i: docs.brief, w: leadership }),
    "NOT_FOUND",
  );
  shareLeadership(ctx, users.priya);
  shareLeadership(ctx, users.sam);
  assert.equal(
    await as.sam.code(MOVE_DOC, { i: docs.vision, w: leadership }),
    "FORBIDDEN",
    "Sam edits the vision doc but does not own it",
  );
  const moved = await as.priya.data(MOVE_DOC, { i: docs.brief, w: leadership });
  assert.deepEqual(moved.move_doc.workspace, { id: leadership });
  assert.equal(moved.move_doc.folder, null);
  assert.equal(moved.move_doc.position, 2 * S, "after the offsite doc");
});

test("move_folder reorders folders within their Space", async (t) => {
  const ctx = await setup(t);
  const { as, workspaces, events } = ctx;
  const { main, leadership } = workspaces;
  const ids = [];
  for (const name of ["One", "Two", "Three"]) {
    ids.push(await ctx.folder(as.sam, main, name));
  }
  const [f1, f2, f3] = ids;
  const moved = await as.noa.data(MOVE_FOLDER, { i: f3, b: f1 });
  assert.equal(moved.move_folder.position, 0.5 * S);
  assert.deepEqual(events.at(-1), {
    type: "folder_moved",
    resource_kind: "folder",
    resource_id: f3,
    workspace_id: main,
    position: 0.5 * S,
  });
  await as.noa.data(MOVE_FOLDER, { i: f1, a: f2 });
  const order = (await ctx.space(as.sam, main)).folders.map((f) => [
    f.name,
    f.position,
  ]);
  assert.deepEqual(order, [
    ["Three", S],
    ["Two", 2 * S],
    ["One", 2.5 * S],
  ]);
  const other = await ctx.folder(as.alex, leadership, "Board");
  assert.equal(
    await as.sam.code(MOVE_FOLDER, { i: f1, a: other }),
    "NOT_FOUND",
  );
  const elsewhere = await as.alex.error(MOVE_FOLDER, { i: f1, a: other });
  assert.equal(elsewhere.message, `Folder "${other}" is not in that place`);
  assert.equal(
    await as.sam.code(MOVE_FOLDER, { i: f1, a: f1 }),
    "BAD_USER_INPUT",
  );
  assert.equal(
    await as.jordan.code(MOVE_FOLDER, { i: f1, b: f2 }),
    "FORBIDDEN",
  );
  assert.equal(await as.chris.code(MOVE_FOLDER, { i: f1, b: f2 }), "NOT_FOUND");
});

test("admins reorder Spaces", async (t) => {
  const ctx = await setup(t);
  const { as, workspaces, events } = ctx;
  const { main, leadership } = workspaces;
  const moved = await as.alex.data(MOVE_SPACE, { i: leadership, b: main });
  assert.deepEqual(moved.move_workspace, { id: leadership, position: 0.5 * S });
  assert.deepEqual(events.at(-1), {
    type: "workspace_moved",
    resource_kind: "workspace",
    resource_id: leadership,
    position: 0.5 * S,
  });
  const names = async (client) =>
    (await client.data(SIDEBAR)).workspaces.map((w) => w.name);
  assert.deepEqual(await names(as.alex), ["Leadership", "Main workspace"]);
  await as.alex.data(MOVE_SPACE, { i: main, b: leadership });
  assert.deepEqual(await names(as.alex), ["Main workspace", "Leadership"]);
  const refused = await as.sam.error(MOVE_SPACE, { i: main, a: main });
  assert.equal(refused.extensions.code, "FORBIDDEN");
  assert.equal(await as.sam.code(MOVE_SPACE, { i: leadership }), "NOT_FOUND");
  assert.equal(
    await as.alex.code(MOVE_SPACE, { i: main, a: main }),
    "BAD_USER_INPUT",
  );
});
