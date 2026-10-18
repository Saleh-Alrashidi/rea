/**
 * Edges of the ClickUp connector (SPEC-4 §1, §3.2) against the fake
 * ClickUp REST API: values outside ClickUp's formats (passed through for
 * the snapshot to report), duplicate rows, ClickUp workspaces without an
 * ID or name, task pagination ends, the snapshot's caps on people,
 * workspaces, columns, labels, comments and blocks, ignored limits, and
 * IDs that cannot be a path segment.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { validateSnapshot } from "../server/import/snapshot.js";
import { FIELD, clickupFixture } from "./fixtures/import/clickup-data.js";
import {
  boardNamed,
  boards,
  codes,
  docs,
  itemOf,
  routed,
  setup,
} from "./fixtures/import/clickup-scan.js";

const SPRINT = "Engineering / Sprint 12";
const QUIET = { include_comments: false, include_docs: false };
const def = (id, name, type, type_config = {}) => ({
  id,
  name,
  type,
  type_config,
});

/**
 * The fixture with odd values on "Triage" (Inbox), an empty drop_down
 * value, a list with fields but no tasks, and repeated space, list and
 * task rows.
 */
function oddData() {
  const data = clickupFixture();
  const inbox = data.lists.find((list) => list.id === "901104");
  inbox.fields = [
    def("f-count", "Count", "short_text"),
    def("f-mix", "Mix", "formula"),
    def("f-when", "When", "date"),
    def("f-pick", "Pick", "drop_down", {
      options: [
        { id: "p2", name: "Two", orderindex: "2" },
        { id: "pn", name: "No order", orderindex: null },
      ],
    }),
    def("f-deep", "Deep", "tasks"),
    def("f-none", "Untyped", ""),
    def("f-check", "Check", "checkbox"),
  ];
  // A list without tasks still gets the columns of its fields.
  data.lists.find((list) => list.id === "901105").fields = [
    def("f-solo", "Solo", "number"),
  ];
  data.tasks = data.tasks.filter((task) => task.list_id !== "901105");
  const triage = data.tasks.find((task) => task.id === "86d0004");
  Object.assign(triage, {
    due_date: "next week",
    start_date: "253402300800000",
    time_estimate: "abc",
    priority: { priority: "asap", color: "#123456" },
    status: { status: "Closed", color: "#6bc950" },
    fields: {
      "f-count": 42,
      "f-mix": { a: 1 },
      "f-when": "99999999999999999",
      "f-pick": "1",
      "f-deep": [[["kept", [["too deep"]]]]],
      "f-none": { label: "Plain" },
      "f-check": "true",
    },
  });
  // An empty drop_down value is no value (not the option at index 0).
  data.tasks.find((task) => task.id === "86d0005").fields = { "f-pick": "" };
  data.tasks.push({ ...triage, name: "Triage again" });
  data.spaces.push({ ...data.spaces[0] });
  data.lists.push({ ...inbox });
  return data;
}

test("values outside ClickUp's formats pass through for the snapshot", async (t) => {
  const data = oddData();
  const { run } = await setup(t, { data });
  const snapshot = await run({ options: QUIET });
  assert.equal(
    snapshot.workspaces.filter((ws) => ws.name.endsWith("/ Product")).length,
    1,
  );
  assert.equal(boards(snapshot).filter((b) => b.name === "Inbox").length, 1);
  const board = boardNamed(snapshot, "Inbox");
  assert.equal(board.items.filter((i) => i.source_id === "86d0004").length, 1);
  const item = itemOf(board, "86d0004");
  assert.equal(item.name, "Triage", "a repeated task is read once");
  assert.equal(item.group_source_id, "closed", "by the list's status type");
  assert.deepEqual(item.values, {
    status: "Closed",
    due_date: "next week",
    start_date: "253402300800000",
    priority: "asap",
    time_estimate: "abc",
    "f-count": "42",
    "f-mix": '{"a":1}',
    "f-when": "99999999999999999",
    "f-pick": "No order",
    "f-deep": "kept",
    "f-none": "Plain",
    "f-check": "Yes",
  });
  const inInbox = (w) => w.path.startsWith("workspaces[0].boards[3]");
  const unknown = codes(snapshot, "unknown_option").filter(inInbox);
  assert.deepEqual(unknown, [], "not for an empty value");
  const hiring = boardNamed(snapshot, "Hiring");
  assert.deepEqual([hiring.items, hiring.columns.at(-1).title], [[], "Solo"]);
  assert.deepEqual(itemOf(board, "86d0005").values, { status: "Open" });
  const untyped = board.columns.find((c) => c.title === "Untyped");
  assert.deepEqual(
    [untyped.type, untyped.original_type],
    ["text", "unsupported"],
  );
  assert.ok(
    codes(snapshot, "column_as_text").some((w) =>
      w.message.endsWith('"Untyped" (unsupported) was imported as text'),
    ),
  );
  const valid = validateSnapshot(snapshot);
  assert.ok(valid.ok, JSON.stringify(valid.errors));
  const normalized = itemOf(boardNamed(valid.snapshot, "Inbox"), "86d0004");
  assert.deepEqual(Object.keys(normalized.values), [
    "status",
    "priority",
    "f-count",
    "f-mix",
    "f-pick",
    "f-deep",
    "f-none",
    "f-check",
  ]);
  const invalid = valid.snapshot.warnings.filter(
    (w) => w.code === "invalid_value",
  );
  assert.equal(invalid.length, 4, "due, start, estimate and When are reported");
  assert.ok(
    valid.snapshot.warnings.some(
      (w) => w.code === "status_label_added" && w.message.includes('"asap"'),
    ),
  );
});

test("ClickUp workspaces without an ID or a name", async (t) => {
  const { server, run } = await setup(t);
  const teams = (edit) => server.fail({ route: "teams", kind: "edit", edit });
  teams(({ teams: [acme, side] }) => ({
    teams: [
      { ...acme, name: "  " },
      { ...side, id: "bad/id" },
    ],
  }));
  const blank = ({ spaces }) => ({
    spaces: spaces.map((space, n) =>
      n === 0 ? { ...space, name: " " } : space,
    ),
  });
  server.fail({ route: "spaces", kind: "edit", edit: blank });
  const unnamed = await run({ options: QUIET });
  assert.equal(unnamed.source_label, "ClickUp workspace Workspace 9001");
  assert.deepEqual(
    unnamed.workspaces.map((ws) => ws.name),
    ["Workspace 9001 / 90010001", "Workspace 9001 / Leadership"],
  );
  assert.ok(!unnamed.users.some((user) => user.source_id === "201"));
  teams(() => ({ teams: [] }));
  const none = await run();
  assert.deepEqual(
    [none.source_label, none.workspaces, none.users],
    ["ClickUp", [], []],
  );
  assert.ok(validateSnapshot(none).ok);
  teams(({ teams: [acme] }) => ({
    teams: [{ ...acme, name: "A".repeat(300) }],
  }));
  const long = await run({ options: QUIET });
  assert.equal(long.source_label, `ClickUp workspace ${"A".repeat(182)}…`);
});

test("task pages end at last_page or a short page; endless pages are capped", async (t) => {
  const data = clickupFixture();
  data.tasks = data.tasks.filter((task) => task.list_id !== "901101");
  const backlog = data.lists.find((list) => list.id === "901102");
  const template = data.tasks.find((task) => task.list_id === "901102");
  for (let n = 0; n < 98; n += 1) {
    data.tasks.push({
      ...template,
      id: `86f${1000 + n}`,
      name: `Idea ${n + 3}`,
    });
  }
  const { server, run } = await setup(t, { data });
  server.fail({
    route: "tasks",
    match: { list: "901103" },
    kind: "edit",
    edit: ({ tasks }) => ({ tasks }),
  });
  const repeat = ({ tasks }) => ({
    tasks: Array.from({ length: 100 }, (_, n) => ({
      ...tasks[0],
      id: `rep-${n}`,
    })),
    last_page: false,
  });
  server.fail({
    route: "tasks",
    match: { list: "901104" },
    kind: "edit",
    edit: repeat,
    times: 9,
  });
  const snapshot = await run({ options: { ...QUIET, limits: { items: 250 } } });
  const pages = (list) =>
    routed(server, "tasks").filter((r) => r.params.list === list).length;
  assert.equal(
    boardNamed(snapshot, `Engineering / ${backlog.name}`).items.length,
    100,
  );
  assert.equal(pages("901102"), 1, "100 tasks and last_page");
  assert.equal(pages("901103"), 1, "fewer than 100 tasks without last_page");
  assert.equal(pages("901104"), 4, "ceil(250 / 100) + 1 pages at most");
  assert.equal(
    boardNamed(snapshot, "Inbox").items.length,
    100,
    "repeats are read once",
  );
  const [capped] = codes(snapshot, "read_capped");
  assert.equal(capped.message, 'Tasks of list "Inbox": stopped after 4 pages');
  assert.equal(capped.path, "workspaces[0].boards[3]");
});

test("people and spaces beyond the snapshot's limits are left out", async (t) => {
  const data = clickupFixture();
  const side = data.teams.find((team) => team.id === "9002");
  for (let n = 0; n < 10_000; n += 1) {
    const id = 300_000 + n;
    data.users.push({ id, username: `Member ${n}`, email: `m${n}@side.test` });
    side.members.push(id);
  }
  for (let n = 0; n < 999; n += 1) {
    data.spaces.push({
      id: `9003${n}`,
      team_id: "9002",
      name: `Space ${n}`,
      private: false,
      archived: false,
    });
  }
  const { run } = await setup(t, { data });
  const snapshot = await run({ options: QUIET });
  assert.equal(snapshot.users.length, 10_000);
  assert.ok(
    !snapshot.users.some((user) => user.source_id === "105"),
    "Alex does not fit",
  );
  assert.equal(
    snapshot.workspaces.length,
    998,
    "room for two Workspace docs workspaces",
  );
  const [capped] = codes(snapshot, "read_capped");
  assert.deepEqual(capped, {
    code: "read_capped",
    message: "Only the first 998 spaces were read",
    path: "workspaces",
  });
  const valid = validateSnapshot(snapshot);
  assert.ok(valid.ok, JSON.stringify(valid.errors));
  assert.deepEqual(
    itemOf(boardNamed(valid.snapshot, SPRINT), "86c0002").values.assignees,
    undefined,
  );
});

test("a task's latest 250 comments are read; status labels are capped", async (t) => {
  const data = clickupFixture();
  const many = Array.from({ length: 260 }, (_, n) => ({
    ...data.comments["86c0001"][0],
    id: String(9000 + n),
    comment_text: `Note ${n}`,
    date: String(1_700_000_000_000 + n * 1000),
    reply_count: 0,
  }));
  data.comments["86c0001"] = many;
  // ClickUp repeats field definitions on each task: a small list keeps
  // its task pages under 10 MiB.
  const inbox = data.lists.find((list) => list.id === "901104");
  const options = Array.from({ length: 10_001 }, (_, n) => ({
    id: `o${n}`,
    name: `Option ${n}`,
    orderindex: n,
  }));
  inbox.fields = [def("f-many", "Many", "drop_down", { options })];
  const { server, run } = await setup(t, { data });
  const snapshot = await run({ options: { include_docs: false } });
  const board = boardNamed(snapshot, SPRINT);
  const plan = itemOf(board, "86c0001");
  assert.equal(plan.updates.length, 250);
  assert.deepEqual(
    [plan.updates[0].body, plan.updates.at(-1).body],
    ["Note 10", "Note 259"],
  );
  const reads = routed(server, "comments").filter(
    (r) => r.params.task === "86c0001",
  );
  assert.equal(reads.length, 10);
  const [warning] = codes(snapshot, "updates_capped");
  assert.equal(
    warning.message,
    "Tasks with more than 250 comments kept only their latest 250: 1",
  );
  const labeled = boardNamed(snapshot, "Inbox").columns.at(-1);
  assert.deepEqual([labeled.title, labeled.labels.length], ["Many", 10_000]);
  const valid = validateSnapshot(snapshot);
  assert.ok(valid.ok, JSON.stringify(valid.errors));
  const normalized = boardNamed(valid.snapshot, "Inbox").columns.at(-1);
  assert.equal(normalized.type, "text", "over 200 labels make a text column");
});

test("a doc cursor that never ends stops at the page bound", async (t) => {
  const { server, run } = await setup(t);
  let page = 0;
  const endless = () => ({ docs: [], next_cursor: `more${(page += 1)}` });
  server.fail({ route: "docs", kind: "edit", edit: endless, times: 99 });
  const limits = { docs: 100 };
  const snapshot = await run({ options: { include_comments: false, limits } });
  assert.equal(routed(server, "docs").length, 6, "ceil(100 / 50) + 1 per team");
  assert.deepEqual(docs(snapshot), []);
});

test("a repeated doc cursor or page adds no doc twice", async (t) => {
  const { server, run } = await setup(t);
  const options = { include_comments: false };
  // An API that ignored `cursor` would answer the first page again.
  const first = new Map();
  let page = 0;
  const ignoring = (body, record) => {
    const team = record.params.team;
    if (!first.has(team)) first.set(team, body.docs);
    return { docs: first.get(team), next_cursor: `fresh${(page += 1)}` };
  };
  server.fail({ route: "docs", kind: "edit", edit: ignoring, times: 99 });
  const snapshot = await run({ options });
  const ids = docs(snapshot).map((d) => d.source_id);
  assert.equal(new Set(ids).size, ids.length, "no doc twice");
  assert.ok(validateSnapshot(snapshot).ok);
  // The same cursor twice ends the listing.
  const repeated = await setup(t);
  const again = (body) => ({ ...body, next_cursor: "again" });
  repeated.server.fail({ route: "docs", kind: "edit", edit: again, times: 99 });
  await repeated.run({ options });
  assert.equal(routed(repeated.server, "docs").length, 4, "two per team");
});

test("limits above the defaults are lowered to them", async (t) => {
  const data = clickupFixture();
  const note = data.docs.find((doc) => doc.name === "Note 1");
  for (let n = 51; n <= 210; n += 1) {
    data.docs.push({ ...note, id: `8cnote-${n}`, name: `Note ${n}` });
  }
  const { run } = await setup(t, { data });
  const options = { include_comments: false, limits: { docs: 1000 } };
  const snapshot = await run({ options });
  assert.equal(docs(snapshot).length, 200);
  const [warning] = codes(snapshot, "limit_docs");
  assert.match(warning.message, /the scan limit of 200 docs/);
});

test("limits that are not positive integers are ignored", async (t) => {
  const { run } = await setup(t);
  const limits = { boards: 0, items: "3", updates: 1.5, docs: -1 };
  const snapshot = await run({ options: { limits } });
  assert.equal(boards(snapshot).length, 6);
  assert.equal(boardNamed(snapshot, SPRINT).items.length, 230);
  assert.equal(
    itemOf(boardNamed(snapshot, SPRINT), "86c0001").updates.length,
    32,
  );
  assert.equal(docs(snapshot).length, 55);
  assert.deepEqual(
    snapshot.warnings.filter((w) => w.code.startsWith("limit_")),
    [],
  );
});

test("huge lists and docs stay within Worklane's limits", async (t) => {
  const data = clickupFixture();
  const sprint = data.lists.find((list) => list.id === "901101");
  const extra = Array.from({ length: 500 }, (_, n) => ({
    id: `extra-${n}`,
    name: `Extra ${n}`,
    type: "short_text",
    type_config: {},
  }));
  sprint.fields = [...sprint.fields, ...extra];
  data.tasks[0].fields["extra-499"] = "beyond the limit";
  const wiki = data.docs.find((doc) => doc.name === "Company wiki");
  wiki.pages[0].content = Array.from(
    { length: 2100 },
    (_, n) => `Line ${n}`,
  ).join("\n");
  const { run } = await setup(t, { data });
  const snapshot = await run({ options: { include_comments: false } });
  const board = boardNamed(snapshot, SPRINT);
  assert.equal(board.columns.length, 500);
  // 8 standard columns and 18 listed fields leave room for 474 extras.
  assert.equal(board.columns.at(-1).title, "Extra 473");
  assert.equal(itemOf(board, "86c0001").values["extra-499"], undefined);
  const [capped] = codes(snapshot, "columns_capped");
  assert.match(
    capped.message,
    /^Only the first 500 columns were imported.*: 28$/,
  );
  const blocks = docs(snapshot).find((d) => d.title === "Company wiki").blocks;
  assert.equal(blocks.length, 2000);
  const [cut] = codes(snapshot, "truncated").filter((w) =>
    w.path.endsWith(".blocks"),
  );
  assert.deepEqual(cut, {
    code: "truncated",
    message: "Only the first 2000 of 2100 blocks were kept",
    path: "workspaces[3].docs[0].blocks",
  });
  assert.ok(validateSnapshot(snapshot).ok);
});

test("rows whose IDs cannot be a path segment are not requested", async (t) => {
  const data = clickupFixture();
  const list = data.lists.find((l) => l.id === "901104");
  data.lists.push({ ...list, id: "../../team", name: "Escape" });
  const task = data.tasks.find((each) => each.id === "86d0004");
  data.tasks.push({ ...task, id: "86d/0009", name: "Odd task", fields: {} });
  data.comments["86d/0009"] = data.comments["86c0003"];
  data.docs.push({ ...data.docs[3], id: "doc?x=1", name: "Odd doc" });
  const { server, run } = await setup(t, { data });
  const snapshot = await run({ options: { include_docs: true } });
  assert.deepEqual(server.errors, []);
  assert.ok(!boards(snapshot).some((b) => b.name === "Escape"));
  const odd = itemOf(boardNamed(snapshot, "Inbox"), "86d/0009");
  assert.deepEqual(
    [odd.name, odd.updates],
    ["Odd task", []],
    "kept, comments not read",
  );
  assert.ok(!docs(snapshot).some((d) => d.title === "Odd doc"));
  assert.ok(
    !server.requests.some(
      (r) => r.path.includes("..") || r.path.includes("%2F"),
    ),
  );
  assert.equal(
    itemOf(boardNamed(snapshot, SPRINT), "86c0001").values[FIELD.code],
    "Bluebird",
  );
});
