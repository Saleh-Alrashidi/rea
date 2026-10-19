import assert from "node:assert/strict";
import test from "node:test";
import { ALL_SCOPES } from "../server/auth.js";
import { execute } from "../server/graphql/execute.js";
import { parse } from "../server/graphql/parse.js";
import { createSchema } from "../server/schema.js";
import { createStore } from "../server/store.js";
import { request } from "../web/api.js";
import { MY_WORK_QUERY } from "../web/ui/board/my-work-data.js";
import { SEARCH_QUERY } from "../web/ui/components/command-palette.js";
import { DIRECTORY_QUERY } from "../web/ui/components/directory.js";
import { pickerSubjects } from "../web/ui/components/people-picker.js";
import {
  can,
  canCreateIn,
  hasRole,
  isViewOnly,
} from "../web/ui/components/permissions.js";
import {
  SHARE_CANDIDATES_QUERY,
  SHARE_MUTATIONS,
  SHARE_QUERIES,
  normalizeResource,
} from "../web/ui/components/share-model.js";
import { BUS_EVENTS, createBus } from "../web/ui/shell/bus.js";
import {
  CREATE_MUTATIONS,
  CREATE_TARGETS_QUERY,
} from "../web/ui/shell/create.js";
import {
  MARK_READ_MUTATION,
  NOTIFICATIONS_QUERY,
  UNREAD_COUNT_QUERY,
} from "../web/ui/shell/notifications.js";
import { SHELL_QUERY, loadShellData } from "../web/ui/shell/shell-data.js";
import { HOME_QUERY } from "../web/pages/home.js";
import { SHARED_DETAILS_QUERY, SHARED_QUERY } from "../web/pages/shared.js";

const ORIGIN = "http://localhost:4100";

/** Every GraphQL document the shell, components and pages send. */
const DOCUMENTS = {
  SHELL_QUERY,
  DIRECTORY_QUERY,
  NOTIFICATIONS_QUERY,
  UNREAD_COUNT_QUERY,
  MARK_READ_MUTATION,
  SEARCH_QUERY,
  CREATE_TARGETS_QUERY,
  MY_WORK_QUERY,
  HOME_QUERY,
  SHARED_QUERY,
  SHARED_DETAILS_QUERY,
  SHARE_CANDIDATES_QUERY,
  ...Object.fromEntries(
    Object.entries(SHARE_QUERIES).map(([k, v]) => [`share query ${k}`, v]),
  ),
  ...Object.fromEntries(
    Object.entries(SHARE_MUTATIONS).map(([k, v]) => [`share ${k}`, v]),
  ),
  ...Object.fromEntries(
    Object.entries(CREATE_MUTATIONS).map(([k, v]) => [`create ${k}`, v]),
  ),
};

function jsonResponse(status, body) {
  const text = JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

function stubFetch(t, respond) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => respond();
  t.after(() => {
    globalThis.fetch = original;
  });
}

test("request() turns GraphQL errors into ApiErrors with code and version", async (t) => {
  const responses = [
    jsonResponse(200, {
      data: null,
      errors: [
        {
          message: "The doc changed",
          extensions: { code: "VERSION_CONFLICT", version: 7 },
        },
      ],
    }),
    jsonResponse(200, {
      data: { me: { id: "1" } },
      errors: [{ message: "x" }],
    }),
    jsonResponse(200, { data: null }),
  ];
  stubFetch(t, () => responses.shift());
  await assert.rejects(request("{ me { id } }"), (error) => {
    assert.equal(error.name, "ApiError");
    assert.equal(error.code, "VERSION_CONFLICT");
    assert.equal(error.version, 7);
    return true;
  });
  // Partial data next to an error is never returned as if complete.
  await assert.rejects(request("{ me { id } }"), /x/);
  await assert.rejects(request("{ me { id } }"), /no data/);
});

test("every shell and page document parses with the server parser", () => {
  for (const [name, document] of Object.entries(DOCUMENTS)) {
    assert.doesNotThrow(() => parse(document, { maxDepth: 12 }), name);
  }
});

/** A request context of user 1 (Alex) with every scope, over `store`. */
function sessionContext(store) {
  const principal = {
    kind: "session",
    userId: "1",
    scopes: new Set(ALL_SCOPES),
  };
  return {
    store,
    principal,
    hostOrigin: ORIGIN,
    appsOrigin: "http://127.0.0.1:4101",
    log: { error() {} },
    requireScope() {},
  };
}

test("every document validates against the SPEC-2 schema", async () => {
  const schema = createSchema();
  const store = await createStore({ file: null });
  const context = sessionContext(store);
  for (const [name, source] of Object.entries(DOCUMENTS)) {
    // Empty variables: validation runs first, then required variables fail
    // coercion before any resolver runs.
    const result = await execute({
      schema,
      document: parse(source),
      variables: {},
      apiVersion: "2026-01",
      context: { ...context, apiVersion: "2026-01" },
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

test("the shell's boards carry their default view, List (SPEC-6 §1.1)", async (t) => {
  const store = await createStore({ file: null });
  const result = await execute({
    schema: createSchema(),
    document: parse(SHELL_QUERY),
    variables: {},
    apiVersion: "2026-01",
    context: { ...sessionContext(store), apiVersion: "2026-01" },
  });
  assert.equal(result.errors, undefined);
  stubFetch(t, () => jsonResponse(200, result));
  const shell = await loadShellData();
  const boards = shell.workspaces.flatMap((workspace) => workspace.boards);
  assert.ok(boards.length > 0, "the seed has boards");
  // The sidebar shows each with its default view's icon.
  assert.deepEqual(
    [...new Set(boards.map((board) => board.defaultView))],
    ["list"],
  );
  assert.ok(boards.every((board) => !Object.hasOwn(board, "views")));
});

test("controls read the caller's access and the server's capability list", () => {
  const me = (capabilities) => ({ id: "9", role: "member", capabilities });
  const creator = me(["create_workspace", "create_content", "create_note"]);
  assert.equal(can(creator, "create_content"), true);
  assert.equal(can(creator, "manage_users"), false);
  assert.equal(can(me([]), "create_note"), false);
  assert.equal(hasRole("owner", "editor"), true);
  assert.equal(hasRole("viewer", "editor"), false);
  assert.equal(hasRole(null, "viewer"), false);
  assert.equal(hasRole("owner", "nonsense"), false);
  assert.equal(isViewOnly("viewer"), true);
  assert.equal(canCreateIn(creator, { my_access: "editor" }).ok, true);
  assert.equal(canCreateIn(creator, { my_access: "viewer" }).ok, false);
  assert.match(canCreateIn(me([]), { my_access: "owner" }).reason, /role/);
});

function member(kind, id, role, accountRole = null) {
  return {
    kind,
    id,
    name: `${kind} ${id}`,
    role,
    user: accountRole ? { role: accountRole } : null,
    team: null,
  };
}

test("share resources normalize members with their verdicts", () => {
  const data = {
    boards: [
      {
        id: 4,
        name: "Hiring plan",
        board_kind: "private",
        my_access: "owner",
        members: [
          {
            ...member("user", 1, "owner"),
            can_remove: false,
            can_change_role: false,
            role_options: ["owner"],
          },
          member("team", 2, "viewer"),
        ],
      },
    ],
  };
  assert.equal(normalizeResource("board", data, "5"), null);
  const board = normalizeResource("board", data, "4");
  assert.equal(board.canManage, true);
  assert.equal(board.hash, "#/boards/4");
  assert.equal(board.setting, "private");
  const [owner, team] = board.members;
  assert.deepEqual(
    [owner.canRemove, owner.canChangeRole, owner.roleOptions],
    [false, false, ["owner"]],
  );
  // Missing verdicts allow nothing.
  assert.deepEqual(
    [team.canRemove, team.canChangeRole, team.roleOptions],
    [false, false, []],
  );

  const note = normalizeResource(
    "note",
    {
      notes: [
        {
          id: 9,
          title: "1:1",
          my_access: "viewer",
          owner: { id: 1, name: "Alex" },
          shares: [member("user", 2, "viewer")],
        },
      ],
    },
    "9",
  );
  assert.equal(note.canManage, false);
  assert.equal(note.owner.id, "1");
});

test("the people picker never offers deactivated users", () => {
  const subjects = pickerSubjects({
    users: [
      { id: 1, name: "Alex", status: "active" },
      { id: 7, name: "Morgan", status: "deactivated" },
    ],
    teams: [{ id: 2, name: "Product" }],
  });
  assert.deepEqual(
    subjects.map((subject) => `${subject.kind}:${subject.id}`),
    ["user:1", "team:2"],
  );
  assert.equal(
    pickerSubjects({
      users: [],
      teams: [{ id: 2, name: "P" }],
      allowTeams: false,
    }).length,
    0,
  );
});

test("the bus shares one stream per board and filters other boards", () => {
  const opened = [];
  const bus = createBus({
    subscribeBoardEvents(boardId, onChange, onEnd) {
      const stream = { boardId, onChange, onEnd, closed: false };
      opened.push(stream);
      return () => (stream.closed = true);
    },
  });
  const seen = [];
  const relayed = [];
  bus.on(BUS_EVENTS.boardChange, (change) => relayed.push(change.type));
  const stopA = bus.watchBoard("4", (change) => seen.push(["a", change.type]));
  const stopB = bus.watchBoard("4", (change) => seen.push(["b", change.type]));
  assert.equal(opened.length, 1);
  opened[0].onChange({ type: "item_updated", board_id: "4" });
  opened[0].onChange({ type: "item_updated", board_id: "5" });
  assert.deepEqual(seen, [
    ["a", "item_updated"],
    ["b", "item_updated"],
  ]);
  assert.deepEqual(relayed, ["item_updated"]);
  stopA();
  stopA();
  assert.equal(opened[0].closed, false);
  stopB();
  assert.equal(opened[0].closed, true);
  assert.throws(() => bus.watchBoard("../4", () => {}), TypeError);

  // The server ends a stream (lost access): its watchers hear it once, and
  // the next watch opens a new stream instead of the dead one.
  const ends = [];
  const stopC = bus.watchBoard(
    "7",
    () => {},
    () => ends.push("c"),
  );
  bus.watchBoard(
    "7",
    () => {},
    () => ends.push("d"),
  );
  opened.at(-1).onEnd();
  opened.at(-1).onEnd();
  assert.deepEqual(ends, ["c", "d"]);
  assert.equal(opened.at(-1).closed, true);
  stopC();
  bus.watchBoard("7", () => {});
  assert.equal(opened.length, 3, "a fresh stream after the end");
});
