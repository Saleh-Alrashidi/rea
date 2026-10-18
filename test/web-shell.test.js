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
  SHARE_MUTATIONS,
  SHARE_QUERIES,
  lastOwnerReason,
  normalizeResource,
  roleOptions,
  subjectEligibility,
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
import { SHELL_QUERY } from "../web/ui/shell/shell-data.js";
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

test("every document validates against the SPEC-2 schema", async () => {
  const schema = createSchema();
  const store = await createStore({ file: null });
  const principal = {
    kind: "session",
    userId: "1",
    scopes: new Set(ALL_SCOPES),
  };
  const context = {
    store,
    principal,
    hostOrigin: ORIGIN,
    appsOrigin: "http://127.0.0.1:4101",
    log: { error() {} },
    requireScope() {},
  };
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

test("account capabilities follow the SPEC-2 role table", () => {
  const user = (role, status = "active") => ({ id: "9", role, status });
  assert.equal(can(user("admin"), "manage_users"), true);
  assert.equal(can(user("member"), "manage_users"), false);
  assert.equal(can(user("member"), "create_workspace"), true);
  assert.equal(can(user("viewer"), "create_content"), false);
  assert.equal(can(user("viewer"), "create_note"), true);
  assert.equal(can(user("guest"), "create_team"), false);
  assert.equal(can(user("guest"), "create_note"), true);
  assert.equal(can(user("admin", "deactivated"), "create_note"), false);
  assert.equal(can(null, "create_note"), false);
  assert.equal(can(user("superuser"), "create_note"), false);
  assert.equal(hasRole("owner", "editor"), true);
  assert.equal(hasRole("viewer", "editor"), false);
  assert.equal(hasRole(null, "viewer"), false);
  assert.equal(hasRole("owner", "nonsense"), false);
  assert.equal(isViewOnly("viewer"), true);
  assert.equal(canCreateIn(user("member"), { my_access: "editor" }).ok, true);
  assert.equal(canCreateIn(user("member"), { my_access: "viewer" }).ok, false);
  assert.match(
    canCreateIn(user("viewer"), { my_access: "owner" }).reason,
    /role/,
  );
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

test("share rules: roles per kind, last owner, guests", () => {
  assert.deepEqual(roleOptions("note"), ["editor", "viewer"]);
  assert.deepEqual(roleOptions("workspace"), ["owner", "editor"]);
  assert.deepEqual(roleOptions("board"), ["owner", "editor", "viewer"]);

  const data = {
    boards: [
      {
        id: 4,
        name: "Hiring plan",
        board_kind: "private",
        my_access: "owner",
        members: [
          member("user", 1, "owner"),
          member("user", 3, "editor"),
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
  const [owner, editor, team] = board.members;
  assert.match(lastOwnerReason(board, owner), /^This board needs/);
  assert.equal(lastOwnerReason(board, editor), null);
  // Team owner grants never count as the owner a resource keeps.
  const withTeam = { ...board, members: [owner, { ...team, role: "owner" }] };
  assert.match(lastOwnerReason(withTeam, owner), /at least one owner/);
  assert.equal(lastOwnerReason(withTeam, withTeam.members[1]), null);
  board.members.push({ ...editor, id: "8", role: "owner" });
  assert.equal(lastOwnerReason(board, owner), null);

  const guest = { kind: "user", id: "6", role: "guest" };
  assert.equal(subjectEligibility(board, guest).ok, false);
  assert.equal(
    subjectEligibility({ ...board, setting: "share" }, guest).ok,
    true,
  );
  assert.equal(subjectEligibility({ kind: "workspace" }, guest).ok, false);
  assert.equal(subjectEligibility({ kind: "doc" }, guest).ok, true);
  assert.equal(subjectEligibility(board, { kind: "team", id: "2" }).ok, true);

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
  // Notes keep their owner outside shares, so no share is "the last owner".
  assert.equal(lastOwnerReason(note, note.members[0]), null);
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
