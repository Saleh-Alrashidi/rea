/**
 * The sidebar's and the task transfer's requests against the real schema
 * and store (SPEC-6 §3.2, §3.3): every document validates, and the
 * variables the pure models build do what the tree promised — a drop
 * into a folder, a reorder, Undo, a new folder, a Space reorder, and a
 * task moved to another board with its dropped columns.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ALL_SCOPES } from "../server/auth.js";
import { execute } from "../server/graphql/execute.js";
import { parse } from "../server/graphql/parse.js";
import { createSchema } from "../server/schema.js";
import { createStore } from "../server/store.js";
import { request } from "../web/api.js";
import {
  MOVE_ITEM_TO_BOARD,
  TRANSFER_QUERIES,
} from "../web/ui/board/board-transfer.js";
import { CREATE_MUTATIONS } from "../web/ui/shell/create.js";
import {
  DOC_VERSION_QUERY,
  SIDEBAR_MUTATIONS,
  createFolder,
  renameNode,
  runMove,
} from "../web/ui/shell/sidebar-data.js";
import { resolveDrop, wayBack } from "../web/ui/shell/sidebar-drop-model.js";
import { buildSpaces, findNode } from "../web/ui/shell/sidebar-model.js";
import { loadShellData } from "../web/ui/shell/shell-data.js";

const DOCUMENTS = {
  DOC_VERSION_QUERY,
  MOVE_ITEM_TO_BOARD,
  ...TRANSFER_QUERIES,
  ...SIDEBAR_MUTATIONS,
};

function contextOf(store, userId) {
  return {
    store,
    principal: { kind: "session", userId, scopes: new Set(ALL_SCOPES) },
    hostOrigin: "http://localhost:4100",
    appsOrigin: "http://127.0.0.1:4101",
    log: { error() {} },
    requireScope() {},
    apiVersion: "2026-01",
  };
}

/** Answers the web client's requests with the schema, as user `userId`. */
function serve(t, store, userId = "1") {
  const schema = createSchema();
  const original = globalThis.fetch;
  globalThis.fetch = async (_path, init) => {
    const { query, variables } = JSON.parse(init.body);
    const result = await execute({
      schema,
      document: parse(query),
      variables,
      apiVersion: "2026-01",
      context: contextOf(store, userId),
    });
    const text = JSON.stringify(result);
    return { ok: true, status: 200, text: async () => text };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
}

const names = (nodes) => nodes.map((node) => node.name);
const spacesNow = async () => buildSpaces((await loadShellData()).workspaces);

test("every sidebar and transfer document validates", async () => {
  const schema = createSchema();
  const store = await createStore({ file: null });
  for (const [name, source] of Object.entries(DOCUMENTS)) {
    const result = await execute({
      schema,
      document: parse(source),
      variables: {},
      apiVersion: "2026-01",
      context: contextOf(store, "1"),
    });
    const invalid = (result.errors ?? []).filter((error) =>
      ["GRAPHQL_VALIDATION_FAILED", "GRAPHQL_PARSE_FAILED"].includes(
        error.code,
      ),
    );
    assert.deepEqual(
      invalid.map((error) => error.message),
      [],
      name,
    );
  }
});

test("drops, Undo and new folders reach the server as the tree shows them", async (t) => {
  const store = await createStore({ file: null });
  serve(t, store);
  let spaces = await spacesNow();
  const main = spaces.find((space) => space.name === "Main space");
  const folderId = await createFolder(main.id, "Q4");
  const extra = await request(CREATE_MUTATIONS.doc, {
    title: "Retro",
    workspaceId: main.id,
  });
  spaces = await spacesNow();
  const space = () => spaces.find((each) => each.id === main.id);
  assert.deepEqual(names(space().children), [
    "Q4",
    "Product roadmap",
    "Product vision",
    "Retro",
    "Feature request",
  ]);
  // The roadmap into the folder (from the Space's root).
  const into = resolveDrop(spaces, {
    dragKey: "board:4",
    targetKey: `folder:${folderId}`,
    zone: "inside",
  });
  const back = wayBack(spaces, into.move.node);
  await runMove(into.move);
  spaces = await spacesNow();
  // Its form sits with it (SPEC-6 §3.1).
  assert.deepEqual(names(findNode(spaces, `folder:${folderId}`).children), [
    "Product roadmap",
    "Feature request",
  ]);
  // Undo puts it back at the root.
  await runMove(back);
  spaces = await spacesNow();
  assert.equal(findNode(spaces, "board:4").folderId, null);
  // Docs reorder: "Retro" before "Product vision".
  const reorder = resolveDrop(spaces, {
    dragKey: `doc:${extra.create_doc.id}`,
    targetKey: "doc:47",
    zone: "before",
  });
  await runMove(reorder.move);
  spaces = await spacesNow();
  assert.deepEqual(
    names(space().children.filter((node) => node.kind === "doc")),
    ["Retro", "Product vision"],
  );
  await renameNode(findNode(spaces, `folder:${folderId}`), "Q4 plans");
  spaces = await spacesNow();
  assert.equal(findNode(spaces, `folder:${folderId}`).name, "Q4 plans");
});

test("Spaces reorder for admins; the server refuses others", async (t) => {
  const store = await createStore({ file: null });
  serve(t, store);
  let spaces = await spacesNow();
  assert.deepEqual(names(spaces), ["Main space", "Leadership"]);
  const move = resolveDrop(spaces, {
    dragKey: spaces[1].key,
    targetKey: spaces[0].key,
    zone: "before",
  }).move;
  await runMove(move);
  spaces = await spacesNow();
  assert.deepEqual(names(spaces), ["Leadership", "Main space"]);
  // Sam (a member) sees only Main space.
  serve(t, store, "2");
  const main = { node: spaces[1], place: {} };
  await assert.rejects(runMove(main), (error) => {
    assert.equal(error.code, "FORBIDDEN");
    return true;
  });
});

test("a task moves to another board and reports its dropped columns", async (t) => {
  const store = await createStore({ file: null });
  serve(t, store);
  const target = await request(CREATE_MUTATIONS.workspace, { name: "Ops" });
  const { create_board: board } = await request(
    `mutation ($w: ID) { create_board(board_name: "Sprint", workspace_id: $w) { id } }`,
    { w: target.create_workspace.id },
  );
  const item = store.listItems({ boardId: "4", limit: 1 }).items[0];
  const data = await request(MOVE_ITEM_TO_BOARD, {
    itemId: item.id,
    boardId: board.id,
  });
  assert.equal(data.move_item_to_board.item.id, item.id);
  assert.ok(Array.isArray(data.move_item_to_board.dropped_columns));
  assert.equal(store.getItem(item.id).board_id, board.id);
  const loaded = await request(TRANSFER_QUERIES.board, { ids: [board.id] });
  assert.equal(loaded.boards[0].name, "Sprint");
});
