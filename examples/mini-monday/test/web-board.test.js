import assert from "node:assert/strict";
import test from "node:test";
import { capabilitiesOf } from "../server/access.js";
import { parse } from "../server/graphql/parse.js";
import {
  activityActor,
  dayLabel,
  describeActivity,
  groupActivityByDay,
} from "../web/ui/board/activity-model.js";
import {
  BOARD_QUERIES,
  loadActivity,
  loadBoard,
  loadBoardForms,
  mutate,
} from "../web/ui/board/board-data.js";
import { boardCapabilities } from "../web/ui/board/capabilities.js";
import { shareableFormLink, sortForms } from "../web/ui/board/forms-view.js";
import { prepareColumns } from "../web/ui/board/values.js";
import { FORM_ACCESS, formAccess } from "../web/ui/components/labels.js";
import { REASONS } from "../web/ui/components/permissions.js";
import { SHARE_MUTATIONS } from "../web/ui/components/share-model.js";
import { CREATE_MUTATIONS } from "../web/ui/shell/create.js";
import { request } from "../web/api.js";

const ORIGIN = "http://localhost:4100";
const STATUS_SETTINGS = JSON.stringify({
  labels: { 0: "Working on it", 1: "Done", 5: "" },
  labels_colors: { 0: "#fdab3d", 1: "#00c875", 5: "#c4c4c4" },
});

function jsonResponse(status, body) {
  const text = JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

// ------------------------------------------------------------ capabilities

test("board capabilities follow my_access and me.capabilities", () => {
  // `me` as the API returns it: the server's own capability list.
  const meOf = (role) => ({
    id: "2",
    role,
    capabilities: capabilitiesOf({ role, status: "active" }),
  });
  const member = meOf("member");
  const guest = meOf("guest");
  const viewer = boardCapabilities({ myAccess: "viewer" }, member);
  assert.deepEqual(
    [viewer.viewOnly, viewer.edit, viewer.manage, viewer.createForms],
    [true, false, false, false],
  );
  assert.equal(viewer.reasons.edit, REASONS.viewOnly);
  assert.equal(viewer.reasons.createForms, REASONS.viewOnly);

  const editor = boardCapabilities({ myAccess: "editor" }, member);
  assert.deepEqual(
    [editor.viewOnly, editor.edit, editor.manage, editor.createForms],
    [false, true, false, true],
  );
  assert.equal(editor.reasons.manage, REASONS.notOwner);
  assert.equal(editor.reasons.edit, null);

  const owner = boardCapabilities({ myAccess: "owner" }, member);
  assert.deepEqual([owner.edit, owner.manage], [true, true]);
  assert.equal(owner.reasons.manage, null);

  // A guest editor edits items but cannot create forms (no create_content).
  const guestEditor = boardCapabilities({ myAccess: "editor" }, guest);
  assert.deepEqual([guestEditor.edit, guestEditor.createForms], [true, false]);
  assert.equal(guestEditor.reasons.createForms, REASONS.noCreate);
  // The account role alone grants nothing: only the server's list counts.
  const roleOnly = { id: "2", role: "member", status: "active" };
  const noList = boardCapabilities({ myAccess: "editor" }, roleOnly);
  assert.equal(noList.createForms, false);

  // Unknown or missing access grants nothing.
  for (const board of [null, { myAccess: null }, { myAccess: "admin" }]) {
    const caps = boardCapabilities(board, member);
    assert.deepEqual(
      [caps.edit, caps.manage, caps.viewOnly],
      [false, false, false],
    );
  }
});

// ---------------------------------------------------------------- activity

const BOARD = {
  id: "4",
  columns: prepareColumns([
    { id: "name", title: "Name", type: "name", settings_str: "{}" },
    {
      id: "status",
      title: "Status",
      type: "status",
      settings_str: STATUS_SETTINGS,
    },
    { id: "date", title: "Due date", type: "date", settings_str: "{}" },
  ]),
  items: [{ id: "11", name: "Ship it" }],
};

const entry = (fields) => ({
  id: "1",
  actor: { id: "2", name: "Sam Lee", initials: "SL", color: "#d6409f" },
  actor_label: "Sam Lee",
  item_id: null,
  item_name: null,
  column_id: null,
  from_text: null,
  to_text: null,
  created_at: "2026-10-18T10:00:00.000Z",
  ...fields,
});

test("activity entries read as sentences with from → to chips", () => {
  const status = describeActivity(
    entry({
      kind: "column_value_changed",
      item_id: "11",
      item_name: "Ship it",
      column_id: "status",
      from_text: "Working on it",
      to_text: "Done",
    }),
    BOARD,
  );
  assert.deepEqual(status.segments, [
    { text: "changed " },
    { strong: "Status" },
    { text: " on " },
    { item: { id: "11", name: "Ship it" } },
  ]);
  // Status chips take the label colors of the board's column.
  assert.deepEqual(status.from, { text: "Working on it", color: "#fdab3d" });
  assert.deepEqual(status.to, { text: "Done", color: "#00c875" });

  // A cleared value has only a "from" side; dates read as days.
  const date = describeActivity(
    entry({
      kind: "column_value_changed",
      item_id: "11",
      item_name: "Ship it",
      column_id: "date",
      from_text: "2026-10-17",
    }),
    BOARD,
  );
  assert.equal(date.to, null);
  assert.match(date.from.text, /Oct/);
  assert.equal(date.from.color, null);

  // Items no longer on the board are not links; deleted ones never are.
  const gone = describeActivity(
    entry({
      kind: "item_moved",
      item_id: "99",
      item_name: "Old",
      from_text: "A",
      to_text: "B",
    }),
    BOARD,
  );
  assert.deepEqual(gone.segments[1], { item: { id: null, name: "Old" } });
  assert.deepEqual([gone.from.text, gone.to.text], ["A", "B"]);
  const deleted = describeActivity(
    entry({ kind: "item_deleted", item_id: "11", item_name: "Ship it" }),
    BOARD,
  );
  assert.deepEqual(deleted.segments[1], {
    item: { id: null, name: "Ship it" },
  });
  assert.equal(deleted.from, null);

  // Creation names the target group instead of chips.
  const created = describeActivity(
    entry({
      kind: "item_created",
      item_id: "11",
      item_name: "Ship it",
      to_text: "Next up",
    }),
    BOARD,
  );
  assert.deepEqual(created.segments.at(-1), { strong: "Next up" });
  assert.equal(created.to, null);

  // Unknown kinds still render, with whatever values they carry.
  const unknown = describeActivity(
    entry({ kind: "something_new", from_text: "x", to_text: "y" }),
    BOARD,
  );
  assert.deepEqual(unknown.segments, [{ text: "made a change" }]);
  assert.deepEqual([unknown.from.text, unknown.to.text], ["x", "y"]);
  // Unknown columns are named generically.
  const column = describeActivity(
    entry({ kind: "column_value_changed", column_id: "gone", to_text: "1" }),
    BOARD,
  );
  assert.deepEqual(column.segments[1], { strong: "a column" });
});

test("activity actors: users, form submissions or hidden people", () => {
  const user = activityActor(entry({ kind: "item_created" }));
  assert.equal(user.kind, "user");
  assert.equal(user.user.color, "#d6409f");
  const form = activityActor(
    entry({
      kind: "form_submitted",
      actor: null,
      actor_label: "Form: Feature request",
    }),
  );
  assert.deepEqual(form, { kind: "form", name: "Form: Feature request" });
  // Someone outside a guest's directory: no actor record, the server's
  // "Someone" label, and never the form icon.
  const hidden = activityActor(
    entry({ kind: "item_renamed", actor: null, actor_label: "Someone" }),
  );
  assert.deepEqual(hidden, { kind: "hidden", name: "Someone" });
  assert.equal(
    activityActor(entry({ actor: null, actor_label: null })).name,
    "Someone",
  );
});

test("activity groups by local day, newest first", () => {
  const now = new Date(2026, 9, 18, 15, 0);
  const at = (day, hour) => new Date(2026, 9, day, hour).toISOString();
  const days = groupActivityByDay(
    [
      entry({ id: "4", created_at: at(18, 14) }),
      entry({ id: "3", created_at: at(18, 9) }),
      entry({ id: "2", created_at: at(17, 20) }),
      entry({ id: "1", created_at: at(12, 8) }),
    ],
    now,
  );
  assert.deepEqual(
    days.map((day) => [day.label, day.entries.map((item) => item.id)]),
    [
      ["Today", ["4", "3"]],
      ["Yesterday", ["2"]],
      [dayLabel("2026-10-12", now), ["1"]],
    ],
  );
  assert.match(days[2].label, /October/);
  assert.match(dayLabel("2025-12-31", now), /2025/);
  assert.equal(dayLabel(null, now), "Earlier");
});

// ------------------------------------------------------------------- forms

test("form access labels and shareable links", () => {
  assert.equal(formAccess("public"), FORM_ACCESS.public);
  assert.equal(formAccess("nope"), FORM_ACCESS.closed);
  const form = (access, url) => ({ access, public_url: url });
  assert.equal(
    shareableFormLink(form("public", `${ORIGIN}/f/abc`), ORIGIN),
    `${ORIGIN}/f/abc`,
  );
  assert.equal(
    shareableFormLink(form("account", `${ORIGIN}/f/abc`), ORIGIN),
    `${ORIGIN}/f/abc`,
  );
  // Closed forms, other origins and non-web URLs are never offered.
  assert.equal(
    shareableFormLink(form("closed", `${ORIGIN}/f/abc`), ORIGIN),
    null,
  );
  assert.equal(
    shareableFormLink(form("public", "https://evil.test/f/abc"), ORIGIN),
    null,
  );
  assert.equal(
    shareableFormLink(form("public", "javascript:alert(1)"), ORIGIN),
    null,
  );
  assert.equal(shareableFormLink(form("public", "not a url"), ORIGIN), null);
  assert.equal(shareableFormLink(form("public", null), ORIGIN), null);
  assert.deepEqual(
    sortForms([
      { id: "3", title: "beta" },
      { id: "2", title: "Alpha" },
      { id: "1", title: "alpha" },
    ]).map((form) => form.id),
    ["1", "2", "3"],
  );
});

// ------------------------------------------------------ against the server

const BOARD_DOCUMENTS = {
  ...BOARD_QUERIES,
  setBoardKind: SHARE_MUTATIONS.boardKind,
};

test("board documents parse and validate against the schema", async () => {
  const { createSchema } = await import("../server/schema.js");
  const { execute } = await import("../server/graphql/execute.js");
  const { createStore } = await import("../server/store.js");
  const store = await createStore({ file: null });
  const schema = createSchema();
  for (const [name, source] of Object.entries(BOARD_DOCUMENTS)) {
    const document = parse(source, { maxDepth: 12 });
    const result = await execute({
      schema,
      document,
      variables: {},
      apiVersion: "2026-01",
      context: serverContext(store, "1"),
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

function serverContext(store, userId) {
  return {
    store,
    principal: { kind: "session", userId, scopes: new Set(ALL_SCOPES) },
    hostOrigin: ORIGIN,
    appsOrigin: "http://127.0.0.1:4101",
    apiVersion: "2026-01",
    log: { error() {} },
    requireScope() {},
  };
}

const ALL_SCOPES = [
  "boards:read",
  "boards:write",
  "storage:read",
  "storage:write",
];

/**
 * Serves the UI's requests from the real schema and store as `user`
 * (switchable with `as(userId)`), through the same parse → execute path.
 */
async function realServer(t) {
  const { createSchema } = await import("../server/schema.js");
  const { execute } = await import("../server/graphql/execute.js");
  const { createStore } = await import("../server/store.js");
  const store = await createStore({ file: null });
  const schema = createSchema();
  let userId = "1";
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const result = await execute({
      schema,
      document: parse(body.query),
      variables: body.variables ?? {},
      apiVersion: "2026-01",
      context: serverContext(store, userId),
    });
    return jsonResponse("data" in result ? 200 : 400, result);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  const userNamed = (name) =>
    store.listUsers().find((user) => user.name.startsWith(name)).id;
  const boardNamed = (name) =>
    store.listBoards({ limit: 100 }).find((board) => board.name === name).id;
  return {
    store,
    as(name) {
      userId = userNamed(name);
    },
    boardNamed,
  };
}

test("board loaders: members, activity and forms for the board's users", async (t) => {
  const server = await realServer(t);
  const roadmap = server.boardNamed("Product roadmap");
  const marketing = server.boardNamed("Marketing launch");

  const board = await loadBoard(roadmap);
  assert.equal(board.myAccess, "owner");
  assert.equal(board.workspaceAccessible, true);
  assert.ok(
    board.members.every((member) => ["user", "team"].includes(member.kind)),
  );
  const activity = await loadActivity(roadmap, { limit: 2 });
  assert.equal(activity.length, 2);
  assert.ok(activity.every((item) => typeof item.kind === "string"));
  const forms = await loadBoardForms(roadmap);
  assert.deepEqual(
    forms.map((form) => [form.title, form.access]),
    [["Feature request", "public"]],
  );
  assert.match(forms[0].public_url, /^http:\/\/localhost:4100\/f\/[\w-]+$/);

  // The guest sees their shareable board, outside any workspace they can open.
  server.as("Chris");
  const shared = await loadBoard(marketing);
  assert.equal(shared.myAccess, "editor");
  assert.equal(shared.workspaceAccessible, false);
  assert.deepEqual(
    shared.members.map((member) => [
      member.name,
      member.role,
      member.accountRole,
    ]),
    [
      ["Priya Nair", "owner", "member"],
      ["Chris Taylor", "editor", "guest"],
    ],
  );
  // Inaccessible boards read as missing everywhere: no data, no error text.
  assert.equal(await loadBoard(roadmap), null);
  assert.equal(await loadActivity(roadmap), null);
  assert.equal(await loadBoardForms(roadmap), null);

  // The viewer account reads the board but cannot change it.
  server.as("Jordan");
  assert.equal((await loadBoard(roadmap)).myAccess, "viewer");
  assert.ok((await loadActivity(roadmap)).length > 0);
  await assert.rejects(
    mutate("setBoardKind", { id: roadmap, kind: "private" }),
    (error) => error.code === "FORBIDDEN",
  );
});

test("members shared into a closed workspace's board work there without seeing the workspace", async (t) => {
  const server = await realServer(t);
  const hiring = server.boardNamed("Hiring plan");
  server.as("Noa");
  const board = await loadBoard(hiring);
  assert.equal(board.myAccess, "editor");
  assert.equal(board.workspaceAccessible, false);
  // The Forms view creates forms on this board directly.
  const data = await request(CREATE_MUTATIONS.form, {
    boardId: hiring,
    title: "Referral",
  });
  assert.ok(data.create_form.id);
  assert.deepEqual(
    (await loadBoardForms(hiring)).map((form) => form.title),
    ["Referral"],
  );
  // Sam has no grant on the private board: it does not exist for him.
  server.as("Sam");
  assert.equal(await loadBoard(hiring), null);
  assert.equal(await loadBoardForms(hiring), null);
});

test("board kind changes need owners and drop guests from non-shareable boards", async (t) => {
  const server = await realServer(t);
  const marketing = server.boardNamed("Marketing launch");
  server.as("Chris");
  await assert.rejects(
    mutate("setBoardKind", { id: marketing, kind: "private" }),
    (error) => error.code === "FORBIDDEN",
  );
  server.as("Priya");
  assert.deepEqual(
    await mutate("setBoardKind", { id: marketing, kind: "private" }),
    {
      id: marketing,
    },
  );
  const board = await loadBoard(marketing);
  assert.equal(board.kind, "private");
  assert.deepEqual(
    board.members.map((member) => member.name),
    ["Priya Nair"],
  );
  const [latest] = await loadActivity(marketing, { limit: 5 });
  assert.ok(["board_kind_changed", "member_removed"].includes(latest.kind));
  server.as("Chris");
  assert.equal(await loadBoard(marketing), null);
});
