/**
 * Folders over GraphQL (SPEC-6 §3.1, §3.2): Space editors create, edit
 * and delete them (others read FORBIDDEN, or NOT_FOUND without access to
 * the Space, worded like an unknown ID); deleting a folder moves its
 * boards and docs to the Space's root and deletes nothing; folders show
 * only what the caller can open, a private board stays private in any
 * folder, and `Board.folder` / `Doc.folder` tell where things sit.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { POSITION_SPACING } from "../server/store/positions.js";
import { startTestServers } from "./helpers.js";

const S = POSITION_SPACING;
const CREATE = `mutation C($w: ID!, $n: String!, $c: String) {
  create_folder(workspace_id: $w, name: $n, color: $c) {
    id name color position workspace { id } boards { id } docs { id } } }`;
const UPDATE = `mutation U($f: ID!, $n: String, $c: String) {
  update_folder(folder_id: $f, name: $n, color: $c) { id name color } }`;
const DELETE = `mutation D($f: ID!) { delete_folder(folder_id: $f) { id } }`;
const MOVE_BOARD = `mutation B($b: ID!, $f: ID) {
  move_board(board_id: $b, folder_id: $f) { id folder { id } } }`;
const MOVE_DOC = `mutation D($d: ID!, $f: ID) {
  move_doc(doc_id: $d, folder_id: $f) { id folder { id } } }`;
const FOLDERS = `query { workspaces { id folders { id name position
  boards { id } docs { id } } } }`;

async function setup(t) {
  const servers = await startTestServers();
  t.after(() => servers.close());
  const { users } = servers.ids;
  const active = ["alex", "sam", "noa", "priya", "jordan", "chris"];
  const as = Object.fromEntries(
    active.map((key) => [key, servers.as(users[key])]),
  );
  return { ...servers, ...servers.ids, as };
}

const foldersOf = async (client, workspaceId) => {
  const { workspaces } = await client.data(FOLDERS);
  return workspaces.find((w) => w.id === workspaceId)?.folders ?? null;
};

test("Space editors create, rename, recolor and delete folders", async (t) => {
  const { as, workspaces, store } = await setup(t);
  const { main, leadership } = workspaces;
  const made = await as.sam.data(CREATE, { w: main, n: " Engineering " });
  const engineering = made.create_folder;
  assert.deepEqual(engineering, {
    id: engineering.id,
    name: "Engineering",
    color: store.getWorkspace(main).color,
    position: S,
    workspace: { id: main },
    boards: [],
    docs: [],
  });
  const design = (
    await as.noa.data(CREATE, { w: main, n: "Design", c: "#AABBCC" })
  ).create_folder;
  assert.deepEqual([design.color, design.position], ["#aabbcc", 2 * S]);
  assert.deepEqual(
    (await foldersOf(as.priya, main)).map((f) => [f.name, f.position]),
    [
      ["Engineering", S],
      ["Design", 2 * S],
    ],
  );
  // Viewer accounts read FORBIDDEN; no access to the Space reads NOT_FOUND.
  assert.equal(await as.jordan.code(CREATE, { w: main, n: "X" }), "FORBIDDEN");
  assert.equal(await as.chris.code(CREATE, { w: main, n: "X" }), "NOT_FOUND");
  assert.equal(
    await as.sam.code(CREATE, { w: leadership, n: "X" }),
    "NOT_FOUND",
  );
  assert.equal(
    await as.sam.code(CREATE, { w: main, n: " " }),
    "BAD_USER_INPUT",
  );
  assert.equal(
    await as.sam.code(CREATE, { w: main, n: "X", c: "red" }),
    "BAD_USER_INPUT",
  );
  const renamed = await as.priya.data(UPDATE, {
    f: engineering.id,
    n: "Eng",
    c: "#123456",
  });
  assert.deepEqual(renamed.update_folder, {
    id: engineering.id,
    name: "Eng",
    color: "#123456",
  });
  const kept = await as.sam.data(UPDATE, { f: engineering.id, c: "#654321" });
  assert.equal(kept.update_folder.name, "Eng", "unchanged without a name");
  assert.equal(
    await as.jordan.code(UPDATE, { f: design.id, n: "Y" }),
    "FORBIDDEN",
  );
  // A hidden folder reads exactly like an unknown one.
  const secret = (await as.alex.data(CREATE, { w: leadership, n: "People" }))
    .create_folder;
  const hidden = await as.sam.error(UPDATE, { f: secret.id, n: "Y" });
  const unknown = await as.sam.error(UPDATE, { f: "99999", n: "Y" });
  assert.equal(hidden.extensions.code, "NOT_FOUND");
  assert.equal(hidden.message, `Folder "${secret.id}" was not found`);
  assert.equal(unknown.message, `Folder "99999" was not found`);
  assert.equal(await as.chris.code(DELETE, { f: design.id }), "NOT_FOUND");
  assert.equal(await as.jordan.code(DELETE, { f: design.id }), "FORBIDDEN");
  await as.noa.data(DELETE, { f: design.id });
  assert.deepEqual(
    (await foldersOf(as.sam, main)).map((f) => f.name),
    ["Eng"],
  );
});

test("delete_folder moves its boards and docs to the Space root", async (t) => {
  const { as, workspaces, boards, docs, store } = await setup(t);
  const { main } = workspaces;
  const folder = (await as.sam.data(CREATE, { w: main, n: "Plans" }))
    .create_folder;
  await as.sam.data(MOVE_BOARD, { b: boards.roadmap, f: folder.id });
  const moved = await as.sam.data(MOVE_DOC, { d: docs.vision, f: folder.id });
  assert.deepEqual(moved.move_doc, {
    id: docs.vision,
    folder: { id: folder.id },
  });
  const [inside] = await foldersOf(as.sam, main);
  assert.deepEqual(inside.boards, [{ id: boards.roadmap }]);
  assert.deepEqual(inside.docs, [{ id: docs.vision }]);
  const items = store.countItems(boards.roadmap);
  await as.sam.data(DELETE, { f: folder.id });
  assert.equal(store.getFolder(folder.id), null);
  const where = await as.sam.data(
    `query ($b: ID!, $d: ID!) { boards(ids: [$b]) { folder { id } position }
      docs(ids: [$d]) { folder { id } position } }`,
    { b: boards.roadmap, d: docs.vision },
  );
  // Back at the root, after what was already there.
  assert.deepEqual(where.boards, [{ folder: null, position: 3 * S }]);
  assert.deepEqual(where.docs, [{ folder: null, position: 3 * S }]);
  assert.equal(store.countItems(boards.roadmap), items, "nothing deleted");
  assert.ok(store.getDoc(docs.vision));
});

test("folders show only what the caller can open", async (t) => {
  const { as, workspaces, boards } = await setup(t);
  const { main, leadership } = workspaces;
  const people = (await as.alex.data(CREATE, { w: leadership, n: "People" }))
    .create_folder;
  for (const board of [boards.hiring, boards.budget]) {
    await as.alex.data(MOVE_BOARD, { b: board, f: people.id });
  }
  // Noa opens only the private hiring board of the closed Leadership
  // Space: she sees its folder with that board alone, and cannot edit it.
  const READ = `query ($b: ID!) { boards(ids: [$b]) { board_kind
    folder { id name boards { id } docs { id } }
    workspace { folders { id boards { id } } } } }`;
  const { boards: seen } = await as.noa.data(READ, { b: boards.hiring });
  assert.deepEqual(seen, [
    {
      board_kind: "private",
      folder: {
        id: people.id,
        name: "People",
        boards: [{ id: boards.hiring }],
        docs: [],
      },
      workspace: {
        folders: [{ id: people.id, boards: [{ id: boards.hiring }] }],
      },
    },
  ]);
  assert.equal(
    await as.noa.code(UPDATE, { f: people.id, n: "Mine" }),
    "NOT_FOUND",
  );
  const alexView = await as.alex.data(READ, { b: boards.hiring });
  assert.deepEqual(alexView.boards[0].folder.boards, [
    { id: boards.hiring },
    { id: boards.budget },
  ]);
  // In an open Space a shareable board stays hidden from non-members.
  const mixed = (await as.priya.data(CREATE, { w: main, n: "Launch" }))
    .create_folder;
  for (const board of [boards.roadmap, boards.marketing]) {
    await as.priya.data(MOVE_BOARD, { b: board, f: mixed.id });
  }
  const [samFolder] = await foldersOf(as.sam, main);
  assert.deepEqual(samFolder.boards, [{ id: boards.roadmap }]);
  const [priyaFolder] = await foldersOf(as.priya, main);
  assert.deepEqual(priyaFolder.boards, [
    { id: boards.roadmap },
    { id: boards.marketing },
  ]);
});
