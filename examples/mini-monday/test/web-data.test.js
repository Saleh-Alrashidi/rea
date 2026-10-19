import assert from "node:assert/strict";
import test from "node:test";
import { ALL_SCOPES } from "../server/auth.js";
import { DEFAULT_STATUS_SETTINGS } from "../server/column-values.js";
import { GraphQLError } from "../server/graphql/errors.js";
import { execute } from "../server/graphql/execute.js";
import { parse } from "../server/graphql/parse.js";
import { createSchema } from "../server/schema.js";
import { createStore } from "../server/store.js";
import { graphql, requestSessionToken } from "../web/api.js";
import { loadBoard, loadItem, mutate } from "../web/ui/board/board-data.js";
import { CLEAR_VALUE, encodeValue } from "../web/ui/board/values.js";
import { loadDirectory } from "../web/ui/components/directory.js";
import { loadShellData } from "../web/ui/shell/shell-data.js";

const STATUS_SETTINGS = JSON.stringify(DEFAULT_STATUS_SETTINGS);

function jsonResponse(status, body) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

/** Replaces globalThis.fetch for one test and records every call. */
function stubFetch(t, respond) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const call = { url, init, body: JSON.parse(init.body) };
    calls.push(call);
    return respond(call);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

function operationName(query) {
  return /^(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? null;
}

const RAW_ITEM = (id, groupId, status) => ({
  id,
  name: `Item ${id}`,
  group: { id: groupId },
  column_values: [
    { id: "name", text: `Item ${id}`, value: JSON.stringify(`Item ${id}`) },
    { id: "status", text: "Done", value: JSON.stringify({ index: status }) },
  ],
});

/** Canned responses keyed by the UI's operation names. */
const CANNED = {
  HostBoard: {
    boards: [
      {
        id: "1",
        name: "Roadmap",
        description: null,
        items_count: 2,
        board_kind: "share",
        my_access: "editor",
        workspace: { id: 4, name: "Main workspace" },
        columns: [
          { id: "name", title: "Name", type: "name", settings_str: "{}" },
          {
            id: "status",
            title: "Status",
            type: "status",
            settings_str: STATUS_SETTINGS,
          },
        ],
        groups: [
          { id: "later", title: "Later", color: "#a25ddc", position: 2 },
          { id: "now", title: "Now", color: "#579bfc", position: 1 },
        ],
        views: [],
      },
    ],
  },
  // Two pages: the first (cursor null) points at "page-2".
  HostBoardItems: ({ cursor }) => ({
    boards: [
      {
        items_page:
          cursor === null
            ? { cursor: "page-2", items: [RAW_ITEM("11", "now", 1)] }
            : { cursor: null, items: [RAW_ITEM("12", "later", 0)] },
      },
    ],
  }),
  HostItem: {
    items: [
      {
        ...RAW_ITEM("11", "now", 1),
        created_at: "2026-10-18T10:00:00.000Z",
        board: { id: "1" },
        group: { id: "now", title: "Now", color: "#579bfc" },
        creator: { id: "1", name: "Alex", initials: "A" },
        updates_count: 2,
      },
    ],
  },
};

function cannedServer({ body }) {
  const name = operationName(body.query);
  const canned = CANNED[name];
  if (typeof canned === "function") {
    return jsonResponse(200, { data: canned(body.variables) });
  }
  if (canned) return jsonResponse(200, { data: canned });
  const field = /\{\s*(\w+)\(/.exec(body.query)?.[1];
  return jsonResponse(200, { data: { [field]: { id: "99" } } });
}

test("graphql() posts same-origin JSON with the API version", async (t) => {
  const calls = stubFetch(t, () => jsonResponse(200, { data: { me: null } }));
  const result = await graphql("query Me { me { id } }", { a: 1 });
  assert.deepEqual(result, { data: { me: null } });
  const [{ url, init, body }] = calls;
  assert.equal(url, "/v2");
  assert.equal(init.method, "POST");
  assert.equal(init.credentials, "same-origin");
  assert.equal(init.headers["Content-Type"], "application/json");
  assert.equal(init.headers["API-Version"], "2026-01");
  assert.equal("X-App-Install" in init.headers, false);
  assert.deepEqual(body, {
    query: "query Me { me { id } }",
    variables: { a: 1 },
  });

  await graphql("{ me { id } }", {}, { installId: "7", operationName: "Op" });
  assert.equal(calls[1].init.headers["X-App-Install"], "7");
  assert.equal(calls[1].body.operationName, "Op");
  await assert.rejects(
    graphql("{ me { id } }", {}, { installId: "7\r\nX: y" }),
    TypeError,
  );
  await assert.rejects(
    graphql("{ me { id } }", {}, { apiVersion: "latest" }),
    TypeError,
  );
  assert.equal(calls.length, 2);
});

test("graphql() throws an Error carrying .errors for non-2xx responses", async (t) => {
  const errors = [
    { message: "Syntax Error", extensions: { code: "GRAPHQL_PARSE_FAILED" } },
  ];
  const responses = [
    jsonResponse(400, { errors }),
    jsonResponse(502, "<html>"),
  ];
  stubFetch(t, () => responses.shift());
  await assert.rejects(graphql("{"), (error) => {
    assert.equal(error.message, "Syntax Error");
    assert.equal(error.status, 400);
    assert.deepEqual(error.errors, errors);
    return true;
  });
  await assert.rejects(graphql("{ me { id } }"), (error) => {
    assert.equal(error.status, 502);
    assert.equal(error.errors[0].extensions.code, "INTERNAL");
    return true;
  });
});

test("requestSessionToken() posts the install ID and checks the reply", async (t) => {
  const replies = [
    jsonResponse(200, { token: "jwt", expires_at: "2026-10-18T12:05:00Z" }),
    jsonResponse(200, { token: 5 }),
  ];
  const calls = stubFetch(t, () => replies.shift());
  assert.deepEqual(await requestSessionToken("7"), {
    token: "jwt",
    expires_at: "2026-10-18T12:05:00Z",
  });
  assert.equal(calls[0].url, "/apps/session-token");
  assert.deepEqual(calls[0].body, { install_id: "7" });
  await assert.rejects(requestSessionToken("7"), /Malformed/);
  await assert.rejects(requestSessionToken("../7"), TypeError);
});

test("loadBoard() follows items_page cursors and orders groups", async (t) => {
  const calls = stubFetch(t, cannedServer);
  const board = await loadBoard("1");
  assert.deepEqual(
    board.groups.map((group) => group.id),
    ["now", "later"],
  );
  assert.deepEqual(
    board.items.map((item) => [item.id, item.groupId, item.values.status]),
    [
      ["11", "now", 1],
      ["12", "later", 0],
    ],
  );
  assert.equal(board.truncated, false);
  assert.equal(board.description, "");
  assert.equal(board.kind, "share");
  assert.equal(board.myAccess, "editor");
  assert.deepEqual(board.workspace, { id: "4", name: "Main workspace" });
  const pageCalls = calls.filter(
    (call) => operationName(call.body.query) === "HostBoardItems",
  );
  assert.deepEqual(
    pageCalls.map((call) => call.body.variables.cursor),
    [null, "page-2"],
  );
  // Two columns: 3,000 fields / (8 + 3 × 2) per item.
  for (const call of pageCalls) assert.equal(call.body.variables.limit, 214);
});

test("loadItem() decodes the task's board, creator and counts", async (t) => {
  stubFetch(t, cannedServer);
  const board = await loadBoard("1");
  const item = await loadItem("11", board.columns);
  assert.equal(item.boardId, "1");
  assert.equal(item.creator.name, "Alex");
  assert.equal(item.updatesCount, 2);
  assert.equal(item.subitemsCount, 0);
});

test("GraphQL errors from loaders and mutations become thrown Errors", async (t) => {
  stubFetch(t, () =>
    jsonResponse(200, {
      data: null,
      errors: [
        {
          message: "Missing scope boards:write",
          extensions: { code: "FORBIDDEN" },
        },
      ],
    }),
  );
  await assert.rejects(mutate("deleteItem", { itemId: "1" }), (error) => {
    assert.equal(error.code, "FORBIDDEN");
    return true;
  });
  await assert.rejects(mutate("dropDatabase", {}), TypeError);
});

test("every document the UI sends parses with the server parser", async (t) => {
  const calls = stubFetch(t, cannedServer);
  const board = await loadBoard("1");
  await loadItem("11", board.columns);
  const variables = {
    createBoard: { name: "B", workspaceId: "4", kind: "private" },
    updateBoard: { boardId: "1", attribute: "name", value: "B" },
    deleteBoard: { boardId: "1" },
    createGroup: { boardId: "1", name: "G", color: "#579bfc" },
    updateGroup: {
      boardId: "1",
      groupId: "g",
      attribute: "color",
      value: "#579bfc",
    },
    deleteGroup: { boardId: "1", groupId: "g" },
    createColumn: { boardId: "1", title: "T", type: "text" },
    createItem: { boardId: "1", groupId: null, name: "I", values: null },
    createSubitem: { parentId: "1", name: "S", values: null },
    createBoardView: { boardId: "1", type: "list" },
    changeValue: { boardId: "1", itemId: "1", columnId: "status", value: "{}" },
    renameItem: { boardId: "1", itemId: "1", value: "I" },
    moveItem: { itemId: "1", groupId: "g" },
    deleteItem: { itemId: "1" },
    createUpdate: { itemId: "1", body: "B", parentId: null },
    editUpdate: { id: "1", body: "B" },
    deleteUpdate: { id: "1" },
    likeUpdate: { id: "1" },
    unlikeUpdate: { id: "1" },
    pinUpdate: { id: "1", itemId: "1" },
    unpinUpdate: { id: "1", itemId: "1" },
  };
  for (const [name, args] of Object.entries(variables)) {
    assert.deepEqual(await mutate(name, args), { id: "99" }, name);
  }
  // The board and its two item pages, and the item.
  assert.equal(calls.length, 4 + Object.keys(variables).length);
  for (const { body } of calls) {
    assert.doesNotThrow(() => parse(body.query, { maxDepth: 12 }), body.query);
  }
});

// ------------------------------------------------------------------------
// End-to-end against the real schema and store, through the same request
// path http.js serves (parse → execute with a browser-session principal).

async function realApi(t) {
  const store = await createStore({ file: null });
  const schema = createSchema();
  const principal = {
    kind: "session",
    userId: "1",
    scopes: new Set(ALL_SCOPES),
  };
  const context = {
    store,
    principal,
    hostOrigin: "http://localhost:4100",
    appsOrigin: "http://127.0.0.1:4101",
    log: { error() {} },
    requireScope(scope) {
      if (!principal.scopes.has(scope)) {
        throw new GraphQLError(`Missing scope ${scope}`, { code: "FORBIDDEN" });
      }
    },
  };
  stubFetch(t, async ({ url, init, body }) => {
    assert.equal(url, "/v2");
    let document;
    try {
      document = parse(body.query);
    } catch (error) {
      return jsonResponse(400, { errors: [error] });
    }
    const apiVersion = init.headers["API-Version"];
    const result = await execute({
      schema,
      document,
      variables: body.variables ?? {},
      operationName: body.operationName ?? null,
      apiVersion,
      context: { ...context, apiVersion },
    });
    return jsonResponse("data" in result ? 200 : 400, result);
  });
}

async function checkSeededBoard() {
  const shell = await loadShellData();
  assert.equal(shell.me.name, "Alex Rivera");
  assert.equal(shell.me.role, "admin");
  const directory = await loadDirectory({ refresh: true });
  assert.ok(directory.users.size >= 3);
  const boards = shell.workspaces.flatMap((workspace) => workspace.boards);
  const roadmap = boards.find((board) => board.name === "Product roadmap");
  const board = await loadBoard(roadmap.id);
  assert.equal(board.kind, "public");
  const holder = shell.workspaces.find((workspace) =>
    workspace.boards.some((entry) => entry.id === roadmap.id),
  );
  assert.equal(board.workspace.id, holder.id);
  assert.deepEqual(
    board.groups.map((group) => group.id),
    ["this_sprint", "next_up", "done"],
  );
  assert.equal(board.items.length, 8);
  assert.ok(board.columns.find((column) => column.id === "status").status);
  const appView = board.views.find((view) => view.type === "app");
  assert.match(
    appView.app_url,
    /\/apps\/status-summary\/index\.html\?install_id=\d+$/,
  );
  return board;
}

async function checkItemFlow(board) {
  const boardId = board.id;
  const column = (id) => board.columns.find((entry) => entry.id === id);
  for (let index = 0; index < 60; index += 1) {
    await mutate("createItem", {
      boardId,
      groupId: "next_up",
      name: `Bulk ${index}`,
      values: index === 0 ? JSON.stringify({ status: { index: 2 } }) : null,
    });
  }
  const paged = await loadBoard(boardId);
  assert.equal(paged.items.length, 68);
  assert.equal(paged.truncated, false);
  const item = paged.items.find((entry) => entry.name === "Bulk 0");
  assert.deepEqual([item.groupId, item.values.status], ["next_up", 2]);
  const changes = [
    ["status", 1],
    ["person", ["2", "3"]],
    ["date", "2026-12-31"],
    ["estimate", "13.5"],
    ["notes", "Hello <b>world</b>"],
  ];
  for (const [columnId, value] of changes) {
    const json = encodeValue(column(columnId), value);
    await mutate("changeValue", {
      boardId,
      itemId: item.id,
      columnId,
      value: json,
    });
  }
  await mutate("renameItem", { boardId, itemId: item.id, value: "Renamed" });
  await mutate("moveItem", { itemId: item.id, groupId: "done" });
  await mutate("createUpdate", { itemId: item.id, body: "First" });
  await mutate("createUpdate", { itemId: item.id, body: "Second" });
  const detail = await loadItem(item.id, board.columns);
  assert.equal(detail.name, "Renamed");
  assert.equal(detail.group.id, "done");
  assert.deepEqual(detail.values, Object.fromEntries(changes));
  assert.equal(detail.updatesCount, 2);
  await mutate("changeValue", {
    boardId,
    itemId: item.id,
    columnId: "status",
    value: CLEAR_VALUE,
  });
  assert.equal((await loadItem(item.id, board.columns)).values.status, null);
  await assert.rejects(
    mutate("changeValue", {
      boardId,
      itemId: item.id,
      columnId: "status",
      value: '{"label":"Nope"}',
    }),
    (error) => error.code === "BAD_USER_INPUT",
  );
  await mutate("deleteItem", { itemId: item.id });
  assert.equal(await loadItem(item.id, board.columns), null);
}

async function checkStructureFlow(board) {
  const boardId = board.id;
  const group = await mutate("createGroup", {
    boardId,
    name: "Backlog",
    color: "#ff158a",
  });
  await mutate("updateGroup", {
    boardId,
    groupId: group.id,
    attribute: "color",
    value: "#00c875",
  });
  await mutate("updateGroup", {
    boardId,
    groupId: group.id,
    attribute: "title",
    value: "Icebox",
  });
  await mutate("createColumn", { boardId, title: "Budget", type: "numbers" });
  const updated = await loadBoard(boardId);
  const icebox = updated.groups.find((entry) => entry.id === group.id);
  assert.deepEqual([icebox.title, icebox.color], ["Icebox", "#00c875"]);
  assert.ok(updated.columns.some((entry) => entry.title === "Budget"));
  await mutate("deleteGroup", { boardId, groupId: group.id });

  const created = await mutate("createBoard", { name: "Launch plan" });
  await mutate("updateBoard", {
    boardId: created.id,
    attribute: "description",
    value: "Q4",
  });
  assert.equal((await loadBoard(created.id)).description, "Q4");
  await mutate("deleteBoard", { boardId: created.id });
  // An unknown board is either filtered out (null) or NOT_FOUND.
  await loadBoard(created.id).then(
    (value) => assert.equal(value, null),
    (error) => assert.equal(error.code, "NOT_FOUND"),
  );
}

/** A wide board loads whole: no request exceeds the 5,000-field budget. */
async function checkWideBoard() {
  const { id: boardId } = await mutate("createBoard", { name: "Wide" });
  for (let index = 0; index < 36; index += 1) {
    await mutate("createColumn", { boardId, title: `C${index}`, type: "text" });
  }
  for (let index = 0; index < 60; index += 1) {
    const name = `Wide ${index}`;
    await mutate("createItem", { boardId, groupId: null, name, values: null });
  }
  const board = await loadBoard(boardId);
  assert.equal(board.columns.length, 40);
  assert.equal(board.items.length, 60);
  assert.equal(board.truncated, false);
}

test("UI loaders and mutations work against the real schema", async (t) => {
  await realApi(t);
  const board = await checkSeededBoard();
  await checkItemFlow(board);
  await checkStructureFlow(board);
  await checkWideBoard();
});
