/**
 * The ClickUp connector (SPEC-4 §3.2) against the fake ClickUp REST API:
 * requests and pagination, people, spaces and lists, standard columns,
 * every custom field type, subtasks and comments. Each scan is also
 * checked with `validateSnapshot`, the engine's only entry point. Docs
 * are in `import-clickup-docs.test.js`; errors, retries, the request
 * rate, limits and options in `import-clickup-errors.test.js`; odd
 * values, caps and pagination edges in `import-clickup-edges.test.js`.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { updateCount } from "../server/import/snapshot-board.js";
import { FIELD, SPRINT_TASKS, T0 } from "./fixtures/import/clickup-data.js";
import {
  boardNamed,
  codes,
  columnNamed,
  fullScan,
  itemOf,
  routed,
} from "./fixtures/import/clickup-scan.js";

const SPRINT = "Engineering / Sprint 12";

test("scans through ClickUp's REST API with its pagination", async () => {
  const { server, snapshot, valid } = await fullScan();
  assert.deepEqual(server.errors, [], "every request fits the fake API");
  assert.ok(valid.ok, JSON.stringify(valid.errors));
  for (const request of server.requests) {
    assert.equal(request.method, "GET");
    assert.equal(request.authorization, server.token);
    assert.equal(request.accept, "application/json");
  }
  assert.equal(routed(server, "teams").length, 1);
  const pages = routed(server, "tasks").filter(
    (r) => r.params.list === "901101",
  );
  assert.deepEqual(
    pages.map((r) => r.query),
    [0, 1, 2].map((page) => ({
      page: String(page),
      include_closed: "true",
      subtasks: "true",
      archived: "false",
    })),
    `${SPRINT_TASKS} tasks = three pages of 100, until last_page`,
  );
  for (const route of ["spaces", "folders", "folder_lists", "space_lists"]) {
    const queries = routed(server, route).map((r) => r.query);
    assert.ok(
      queries.every((q) => q.archived === "false"),
      route,
    );
  }
  const lists = routed(server, "list").map((r) => r.params.list);
  assert.deepEqual(lists, [
    "901101",
    "901102",
    "901103",
    "901104",
    "901105",
    "902101",
  ]);
  assert.ok(
    !routed(server, "folder_lists").some((r) => r.params.folder === "90011003"),
  );
  assert.ok(!server.requests.some((r) => r.params.space === "90010003"));
  assert.equal(snapshot.source, "clickup");
  assert.equal(
    snapshot.source_label,
    "ClickUp workspaces Acme Corp, Side Project",
  );
});

test("team members and people seen in tasks become users", async () => {
  const { snapshot, valid } = await fullScan();
  assert.deepEqual(
    snapshot.users.map((u) => [u.source_id, u.name, u.email]),
    [
      ["101", "Dana Scully", "dana@acme.test"],
      ["102", "Fox Mulder", "fox@acme.test"],
      ["103", "Walter Skinner", "walter@acme.test"],
      ["104", "Gina Guest", "gina@partner.test"],
      ["106", null, "nobody@acme.test"],
      ["201", "Sam Side", "sam@side.test"],
      ["105", "Alex Krycek", "alex@former.test"],
    ],
    "Dana is in both teams once; Alex is only an assignee",
  );
  assert.equal(valid.snapshot.users[4].name, "nobody");
});

test("spaces become workspaces and lists become boards", async () => {
  const { snapshot, valid } = await fullScan();
  assert.deepEqual(
    snapshot.workspaces.map((ws) => [ws.source_id, ws.name, ws.kind]),
    [
      ["90010001", "Acme Corp / Product", "open"],
      ["90010002", "Acme Corp / Leadership", "closed"],
      ["90020001", "Side Project / Garden", "open"],
      ["team-9001", "Acme Corp / Workspace docs", "closed"],
    ],
  );
  assert.deepEqual(
    snapshot.workspaces.map((ws) => ws.boards.map((b) => [b.name, b.kind])),
    [
      [
        [SPRINT, "public"],
        ["Engineering / Backlog", "private"],
        ["Secret projects / Plans", "private"],
        ["Inbox", "public"],
      ],
      [["Hiring", "private"]],
      [["Seeds", "public"]],
      [],
    ],
  );
  // Each list keeps its folder (null when folderless) and its own name.
  const placement = (ws) => ws.boards.map((b) => [b.source_name, b.folder]);
  const engineering = { source_id: "90011001", name: "Engineering" };
  const secret = { source_id: "90011002", name: "Secret projects" };
  const placed = [
    [
      ["Sprint 12", engineering],
      ["Backlog", engineering],
      ["Plans", secret],
      ["Inbox", null],
    ],
    [["Hiring", null]],
    [["Seeds", null]],
    [],
  ];
  assert.deepEqual(snapshot.workspaces.map(placement), placed);
  assert.deepEqual(valid.snapshot.workspaces.map(placement), placed);
  const sprint = boardNamed(snapshot, SPRINT);
  assert.equal(sprint.source_id, "901101");
  assert.equal(sprint.source_url, "https://app.clickup.com/9001/v/li/901101");
  assert.equal(sprint.description, "Current sprint");
  assert.equal(
    boardNamed(snapshot, "Inbox").description,
    "Everything new lands here",
  );
  assert.equal(boardNamed(snapshot, "Hiring").description, null);
  assert.deepEqual(sprint.groups, [
    { source_id: "open", title: "Open", color: "#579bfc" },
    { source_id: "closed", title: "Closed", color: "#00c875" },
  ]);
  assert.deepEqual(
    codes(snapshot, "members_not_imported").map((w) => w.path),
    [
      "workspaces[0].boards[1]",
      "workspaces[0].boards[2]",
      "workspaces[1].boards[0]",
    ],
  );
  assert.ok(
    snapshot.workspaces
      .flatMap((ws) => ws.boards)
      .every((b) => b.members.length === 0),
  );
});

test("standard columns: status, people, dates, priority, estimate, tags, description", async () => {
  const { snapshot } = await fullScan();
  const sprint = boardNamed(snapshot, SPRINT);
  assert.deepEqual(
    sprint.columns
      .slice(0, 8)
      .map((c) => [c.source_id, c.title, c.type, c.original_type, c.role]),
    [
      ["status", "Status", "status", "status", "status"],
      ["assignees", "Assignees", "people", "assignees", "assignees"],
      ["due_date", "Due date", "date", "due_date", "due_date"],
      ["start_date", "Start date", "date", "start_date", "start_date"],
      ["priority", "Priority", "status", "priority", "priority"],
      [
        "time_estimate",
        "Time estimate (h)",
        "numbers",
        "time_estimate",
        "time_estimate",
      ],
      ["tags", "Tags", "text", "tags", "tags"],
      ["description", "Description", "text", "text_content", "description"],
    ],
    "the standard columns carry their roles",
  );
  assert.ok(
    sprint.columns.slice(8).every((c) => c.role === undefined),
    "custom fields have no role",
  );
  assert.deepEqual(
    sprint.columns[0].labels,
    [
      { label: "to do", color: "#d3d3d3", type: "open" },
      { label: "in progress", color: "#4194f6", type: "custom" },
      { label: "review", color: "#a875ff", type: "custom" },
      { label: "complete", color: "#6bc950", type: "done" },
      { label: "closed", color: "#008844", type: "closed" },
      { label: "blocked", color: "#ff0000", type: "custom" },
    ],
    "the list's statuses by orderindex with their types, then one only a task uses",
  );
  assert.deepEqual(sprint.columns[4].labels, [
    { label: "Urgent", color: "#df2f4a" },
    { label: "High", color: "#fdab3d" },
    { label: "Normal", color: "#579bfc" },
    { label: "Low", color: "#c4c4c4" },
  ]);
  const plan = itemOf(sprint, "86c0001");
  const {
    status,
    assignees,
    due_date,
    start_date,
    priority,
    time_estimate,
    tags,
    description,
  } = plan.values;
  assert.deepEqual(
    {
      status,
      assignees,
      due_date,
      start_date,
      priority,
      time_estimate,
      tags,
      description,
    },
    {
      status: "in progress",
      assignees: ["101", "102"],
      due_date: "2023-11-14",
      start_date: "2023-11-12",
      priority: "Urgent",
      time_estimate: 1.5,
      tags: "backend, api",
      description: "Planning notes\n",
    },
  );
  assert.equal(plan.created_at, new Date(T0 - 10 * 86_400_000).toISOString());
  assert.equal(plan.creator_source_id, "102");
  const ship = itemOf(sprint, "86c0002");
  assert.equal(
    ship.values.time_estimate,
    0.34,
    "1,234,567 ms rounded to 0.01 h",
  );
  assert.equal(ship.values.description.length, 2000);
  assert.deepEqual(ship.values.assignees, ["105"]);
  assert.equal(ship.values.priority, "Low");
  assert.equal(itemOf(sprint, "86c0005").values.priority, "Normal");
  assert.equal(itemOf(sprint, "86c0003").values.priority, "High");
  const points = columnNamed(sprint, "Sprint points");
  assert.deepEqual([points.type, ship.values.points], ["numbers", 3]);
});

test("groups follow the status type; standard-field losses are reported", async () => {
  const { snapshot } = await fullScan();
  const sprint = boardNamed(snapshot, SPRINT);
  const group = (id) => itemOf(sprint, id).group_source_id;
  assert.deepEqual(
    ["86c0001", "86c0002", "86c0003", "86c0006", "86c1007"].map(group),
    ["open", "closed", "closed", "open", "open"],
    "in progress, complete (done), closed, blocked (custom), to do",
  );
  assert.equal(
    itemOf(boardNamed(snapshot, "Engineering / Backlog"), "86d0002")
      .group_source_id,
    "closed",
  );
  const one = (code) => {
    const found = codes(snapshot, code);
    assert.equal(found.length, 1, code);
    return found[0];
  };
  assert.match(one("time_dropped").message, /"Due date" .*: 1$/);
  assert.equal(one("time_dropped").path, "workspaces[0].boards[0].columns[2]");
  assert.match(
    one("date_only").message,
    /^Dates without a time in "Start date" were read as the day ClickUp shows; .*: 1$/,
  );
  assert.match(
    one("teams_dropped").message,
    /Team assignments in "Assignees".*: 1$/,
  );
  assert.match(one("rounded").message, /rounded to 0\.01 h: 1$/);
  assert.match(
    one("truncated").message,
    /Descriptions longer than 2,000 characters were cut: 1$/,
  );
  assert.match(one("checklists_dropped").message, /: 1$/);
  assert.equal(one("checklists_dropped").path, "workspaces[0].boards[0]");
});

test("custom fields of every type", async () => {
  const { snapshot } = await fullScan();
  const sprint = boardNamed(snapshot, SPRINT);
  const column = (key) =>
    sprint.columns.find((c) => c.source_id === FIELD[key]);
  const types = Object.keys(FIELD).map((key) => [
    key,
    column(key).type,
    column(key).original_type,
  ]);
  assert.deepEqual(types, [
    ["stage", "status", "drop_down"],
    ["areas", "text", "labels"],
    ["points", "numbers", "number"],
    ["budget", "numbers", "currency"],
    ["rating", "numbers", "emoji"],
    ["launch", "date", "date"],
    ["notes", "text", "text"],
    ["code", "text", "short_text"],
    ["email", "text", "email"],
    ["phone", "text", "phone"],
    ["link", "text", "url"],
    ["reviewer", "people", "users"],
    ["approved", "text", "checkbox"],
    ["office", "text", "location"],
    ["progress", "text", "manual_progress"],
    ["score", "text", "formula"],
    ["related", "text", "tasks"],
    ["files", "text", "attachment"],
    ["hidden", "text", "short_text"],
  ]);
  assert.deepEqual(
    column("stage").labels,
    [
      { label: "Design", color: "#04a9f4" },
      { label: "Build", color: "#ff7fab" },
      { label: "Ship", color: "#c4c4c4" },
    ],
    "options by orderindex; the blank option is dropped",
  );
  const values = itemOf(sprint, "86c0001").values;
  const value = (key) => values[FIELD[key]];
  assert.deepEqual(
    Object.keys(FIELD).map((key) => [key, value(key)]),
    [
      ["stage", "Build"],
      ["areas", "UI, API"],
      ["points", "8"],
      ["budget", 1250.5],
      ["rating", 4],
      ["launch", "2023-11-24"],
      ["notes", "Line one\nLine two"],
      ["code", "Bluebird"],
      ["email", "pm@acme.test"],
      ["phone", "+1 555 0100"],
      ["link", "https://specs.acme.test/sprint-12"],
      ["reviewer", ["103"]],
      ["approved", "Yes"],
      ["office", "1 Main St, Springfield"],
      ["progress", "40%"],
      ["score", "2"],
      ["related", "Ship it, Write tests"],
      ["files", "brief.pdf"],
      ["hidden", undefined],
    ],
  );
  const ship = itemOf(sprint, "86c0002").values;
  assert.equal(ship[FIELD.stage], undefined, "orderindex 9 names no option");
  assert.equal(ship[FIELD.approved], "No");
  assert.equal(ship[FIELD.areas], "API", "an unknown label ID is left out");
  assert.equal(ship[FIELD.hidden], "only on tasks", "a field only tasks carry");
  assert.equal(
    itemOf(sprint, "86c0006").values[FIELD.stage],
    "Ship",
    "by option ID",
  );
});

test("custom field losses are reported once per column", async () => {
  const { snapshot, valid } = await fullScan();
  const at = (code) => codes(snapshot, code).map((w) => [w.path, w.message]);
  const columns = "workspaces[0].boards[0].columns";
  assert.deepEqual(at("labels_as_text"), [
    [
      `${columns}[9]`,
      'Labels field "Areas" was imported as comma-separated text',
    ],
  ]);
  assert.deepEqual(at("unit_dropped"), [
    [
      `${columns}[11]`,
      'Field "Budget" is in USD; Worklane keeps the numbers only',
    ],
  ]);
  const asText = [
    ["Office", "location"],
    ["Progress", "manual_progress"],
    ["Score", "formula"],
    ["Related tasks", "tasks"],
    ["Files", "attachment"],
  ];
  assert.deepEqual(
    at("column_as_text"),
    asText.map(([title, type], n) => [
      `${columns}[${21 + n}]`,
      `Field "${title}" (${type}) was imported as text`,
    ]),
  );
  assert.deepEqual(
    at("unknown_option").map(([path, message]) => [
      path,
      message.endsWith(": 1"),
    ]),
    [
      [`${columns}[8]`, true],
      [`${columns}[9]`, true],
    ],
  );
  const sprint = boardNamed(valid.snapshot, SPRINT);
  assert.equal(
    itemOf(sprint, "86c0001").values[FIELD.points],
    8,
    "the snapshot parses numbers",
  );
});

test("subtasks keep their parent", async () => {
  const { snapshot, valid } = await fullScan();
  const sprint = boardNamed(snapshot, SPRINT);
  assert.equal(
    sprint.items.length,
    SPRINT_TASKS,
    "the archived task is left out",
  );
  assert.equal(itemOf(sprint, "86c0004").parent_source_id, "86c0003");
  assert.equal(itemOf(sprint, "86c0005").parent_source_id, "86c0004");
  assert.equal(itemOf(sprint, "86c0001").parent_source_id, null);
  const inbox = boardNamed(valid.snapshot, "Inbox");
  assert.equal(
    itemOf(inbox, "86d0005").parent_source_id,
    null,
    "parent on another list",
  );
  assert.ok(valid.snapshot.warnings.some((w) => w.code === "unknown_parent"));
});

test("comments become updates in time order, with their replies", async () => {
  const { server, snapshot, valid } = await fullScan();
  const plan = itemOf(boardNamed(snapshot, SPRINT), "86c0001");
  assert.equal(plan.updates.length, 30, "30 comments (two pages)");
  assert.deepEqual(plan.updates[0], {
    body: "Planning started",
    author_source_id: "101",
    author_name: "Dana Scully",
    created_at: new Date(T0).toISOString(),
  });
  // SPEC-6 §2.1: threaded replies stay replies of their comment, as
  // written (no "Reply: " prefix), oldest first.
  const threads = plan.updates.filter((u) => u.replies !== undefined);
  assert.deepEqual(
    threads.map((u) => u.body),
    ["Comment 10"],
  );
  assert.deepEqual(
    threads[0].replies.map((u) => [u.body, u.author_name]),
    [
      ["First reply", "Walter Skinner"],
      ["Second reply", "Dana Scully"],
    ],
  );
  const kept = itemOf(boardNamed(valid.snapshot, SPRINT), "86c0001");
  assert.equal(updateCount(kept), 32, "the snapshot keeps both replies");
  const times = plan.updates.map((u) => Date.parse(u.created_at));
  assert.deepEqual(
    times,
    [...times].sort((a, b) => a - b),
  );
  const reads = routed(server, "comments").filter(
    (r) => r.params.task === "86c0001",
  );
  assert.deepEqual(
    reads.map((r) => r.query),
    [{}, { start: String(T0 + 5 * 60_000), start_id: "5006" }],
    "the second page starts at the oldest comment of the first",
  );
  assert.deepEqual(
    routed(server, "replies").map((r) => r.params.comment),
    ["5010"],
  );
  const written = itemOf(boardNamed(snapshot, SPRINT), "86c0003").updates[0];
  assert.deepEqual(
    [written.body, written.author_name],
    ["Status changed by automation", "ClickBot"],
  );
  const bot = itemOf(boardNamed(valid.snapshot, SPRINT), "86c0003").updates[0];
  assert.equal(bot.author_source_id, null, "ClickBot is no user");
  const rich = itemOf(boardNamed(snapshot, "Hiring"), "86d0006").updates[0];
  assert.equal(
    rich.body,
    "Rich text",
    "from the comment parts without comment_text",
  );
});
