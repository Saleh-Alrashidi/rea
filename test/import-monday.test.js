/**
 * The monday.com connector (SPEC-4 §3.1) against the fake monday GraphQL
 * API: queries and pagination, workspaces and board kinds, members, every
 * column type, subitem merging, updates and docs. Each scan is also
 * checked with `validateSnapshot`, the engine's only entry point; errors,
 * retries, limits and options are in `import-monday-errors.test.js`.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { MONDAY_API_VERSION } from "../server/import/connectors/monday.js";
import {
  boardNamed,
  boards,
  codes,
  fullScan,
  itemOf,
  operations,
} from "./fixtures/import/monday-scan.js";

test("scans through monday's GraphQL API with its pagination", async () => {
  const { server, snapshot, valid } = await fullScan();
  assert.deepEqual(
    server.errors,
    [],
    "every query is valid for the fake schema",
  );
  assert.ok(valid.ok, JSON.stringify(valid.errors));
  for (const request of server.requests) {
    assert.equal(request.method, "POST");
    assert.equal(request.path, "/v2");
    assert.equal(request.authorization, server.token);
    assert.equal(request.apiVersion, MONDAY_API_VERSION);
    assert.equal(request.contentType, "application/json");
  }
  assert.equal(MONDAY_API_VERSION, "2025-10");
  const count = (name) => operations(server).filter((op) => op === name).length;
  assert.equal(count("WorklaneAccount"), 1);
  assert.equal(count("WorklaneUsers"), 2, "120 users = two pages of 100");
  assert.equal(count("WorklaneBoards"), 2, "33 boards = two pages of 25");
  assert.equal(
    count("WorklaneNextItems"),
    2,
    "453 Roadmap items = three pages",
  );
  assert.equal(count("WorklaneDocBlocks"), 2, "230 blocks = three pages");
  const boardItems = server.requests.filter(
    (r) => r.operationName === "WorklaneItems",
  );
  assert.ok(boardItems.every((r) => r.variables.limit === 200));
  const skipped = ["102", "105", "106"];
  assert.ok(boardItems.every((r) => !skipped.includes(r.variables.board)));
  assert.equal(snapshot.source, "monday");
  assert.equal(snapshot.source_label, "monday.com account Acme Corp");
  assert.equal(snapshot.users.length, 120);
  assert.deepEqual(snapshot.users[0], {
    source_id: "1",
    name: "Dana Scully",
    email: "dana@acme.test",
  });
  assert.equal(snapshot.users[4].email, null);
});

test("workspaces, Main workspace, unlisted workspaces and board kinds", async () => {
  const { snapshot } = await fullScan();
  const summary = snapshot.workspaces.map((ws) => [
    ws.source_id,
    ws.name,
    ws.kind,
  ]);
  assert.deepEqual(summary, [
    ["11", "Product", "open"],
    ["12", "Leadership", "closed"],
    ["main", "Main workspace", "open"],
    ["99", "monday.com workspace 99", "closed"],
  ]);
  const [product, leadership, main, unlisted] = snapshot.workspaces;
  assert.equal(product.description, "Product team");
  assert.equal(product.boards.length, 26, "Roadmap, Broken board, 24 teams");
  assert.deepEqual(
    leadership.boards.map((b) => [b.name, b.kind]),
    [["Hiring", "private"]],
  );
  assert.deepEqual(
    main.boards.map((b) => [b.name, b.kind]),
    [["Launch plan", "share"]],
  );
  assert.deepEqual(
    unlisted.boards.map((b) => b.name),
    ["Orphan board"],
  );
  const [warning] = codes(snapshot, "unknown_workspace");
  assert.equal(warning.path, "workspaces[3]");
  const roadmap = product.boards[0];
  assert.equal(roadmap.kind, "public");
  assert.equal(roadmap.description, "What we ship next");
  assert.equal(roadmap.source_url, "https://acme.monday.com/boards/101");
  const names = boards(snapshot).map((board) => board.name);
  for (const skipped of [
    "Subitems of Roadmap",
    "Product vision",
    "Old board",
  ]) {
    assert.ok(!names.includes(skipped), skipped);
  }
});

test("owners and subscribers become members", async () => {
  const { snapshot, valid } = await fullScan();
  assert.deepEqual(boardNamed(snapshot, "Hiring").members, [
    { user_source_id: "1", role: "owner" },
    { user_source_id: "2", role: "editor" },
    { user_source_id: "4", role: "editor" },
  ]);
  const roadmap = boardNamed(valid.snapshot, "Roadmap");
  assert.deepEqual(
    roadmap.members.map((m) => m.user_source_id),
    ["1", "2"],
  );
  assert.ok(
    valid.snapshot.warnings.some(
      (w) => w.code === "unknown_user" && w.path.endsWith("members[2]"),
    ),
    "the unlisted subscriber is reported by the snapshot",
  );
});

test("every column type maps to a Worklane type, lossy ones with a warning", async () => {
  const { snapshot } = await fullScan();
  const roadmap = boardNamed(snapshot, "Roadmap");
  const byId = Object.fromEntries(roadmap.columns.map((c) => [c.source_id, c]));
  assert.ok(!byId.name && !byId.subitems, "name and subtasks are structure");
  const native = { status: "status", person: "people", date4: "date" };
  Object.assign(native, {
    numbers: "numbers",
    text: "text",
    long_text: "text",
  });
  for (const [id, type] of Object.entries(native))
    assert.equal(byId[id].type, type);
  assert.deepEqual(byId.status.labels, [
    { label: "Working on it", color: "#fdab3d" },
    { label: "Stuck", color: "#df2f4a" },
    { label: "Done", color: "#00c875" },
    { label: "Blocked", color: "#7f5347" },
  ]);
  const asText = codes(snapshot, "column_as_text").filter((w) =>
    w.path.startsWith("workspaces[0].boards[0].columns"),
  );
  const lossy = roadmap.columns.filter(
    (c) =>
      !["status", "people", "date", "numbers", "text", "long_text"].includes(
        c.original_type,
      ),
  );
  assert.equal(lossy.length, 33);
  assert.equal(asText.length, lossy.length, "one warning per lossy column");
  for (const column of lossy) {
    assert.equal(column.type, "text");
    const index = roadmap.columns.indexOf(column);
    const warning = asText.find((w) => w.path.endsWith(`.columns[${index}]`));
    assert.match(warning.message, new RegExp(`\\(${column.original_type}\\)`));
  }
  const [unit] = codes(snapshot, "unit_dropped");
  assert.match(unit.message, /"Budget" shows the unit "\$"/);
  const legacy = boardNamed(snapshot, "Launch plan").columns;
  assert.deepEqual(
    legacy.map((c) => [c.title, c.type, c.original_type]),
    [
      ["Stage", "status", "color"],
      ["Lead", "people", "person"],
    ],
  );
  assert.deepEqual(legacy[0].labels, [
    { label: "Draft", color: "#ff158a" },
    { label: "Live", color: "#aabbcc" },
  ]);
});

test("values follow monday's value formats", async () => {
  const { snapshot, valid } = await fullScan();
  const launch = itemOf(boardNamed(snapshot, "Roadmap"), "1001");
  const expected = {
    status: "Done",
    person: ["1", "2"],
    date4: "2025-04-30",
    numbers: "1250.5",
    text: "Ship the first version",
    long_text: "Line one\nLine two",
    dropdown: "Backend, Frontend",
    tags: "launch, q2",
    mirror: "Globex, Initech",
    board_relation: "Globex",
    dependency: "Fix login bug",
    formula: "2501",
    checkbox: "v",
    location: "1 Main St, Springfield",
  };
  for (const [id, value] of Object.entries(expected)) {
    assert.deepEqual(launch.values[id], value, id);
  }
  assert.ok(!("button" in launch.values) && !("subitems" in launch.values));
  const checked = itemOf(boardNamed(valid.snapshot, "Roadmap"), "1001");
  assert.equal(checked.values.numbers, 1250.5, "the snapshot parses numbers");
  const bug = itemOf(boardNamed(snapshot, "Roadmap"), "1002");
  assert.deepEqual(bug.values.person, ["1", "900"], "teams are not people");
  assert.equal(bug.values.date4, "2025-05-03", "the day the user saw");
  const [teams] = codes(snapshot, "teams_dropped");
  assert.match(teams.message, /column "Owner".*: 1$/);
  const [time] = codes(snapshot, "time_dropped");
  assert.match(
    time.message,
    /column "Due".* the day shown in the token user's time zone: 1$/,
  );
  const press = boardNamed(snapshot, "Launch plan").items[0];
  assert.deepEqual(press.values, { color: "Live", person: ["3"] });
});

test("subitems follow their parent; their columns merge by title and type", async () => {
  const { snapshot } = await fullScan();
  const roadmap = boardNamed(snapshot, "Roadmap");
  assert.deepEqual(
    roadmap.items
      .slice(0, 4)
      .map((i) => [i.source_id, i.parent_source_id, i.group_source_id]),
    [
      ["1001", null, "this_sprint"],
      ["2001", "1001", "this_sprint"],
      ["2002", "1001", "this_sprint"],
      ["1002", null, "this_sprint"],
    ],
  );
  const added = roadmap.columns.filter((c) =>
    c.source_id.startsWith("subitem:"),
  );
  assert.deepEqual(
    added.map((c) => [c.source_id, c.title, c.type]),
    [
      ["subitem:numbers", "Estimate (subitem)", "numbers"],
      ["subitem:text", "Notes (subitem)", "text"],
    ],
  );
  assert.deepEqual(itemOf(roadmap, "2001").values, {
    status: "Blocked",
    person: ["2"],
    "subitem:numbers": "3",
    "subitem:text": "Needs review",
  });
  assert.deepEqual(itemOf(roadmap, "2002").values, { status: "Done" });
  assert.equal(itemOf(roadmap, "2001").creator_source_id, "2");
  assert.equal(roadmap.items.length, 455);
  assert.ok(
    roadmap.columns.every((c) => c.role === undefined),
    "monday columns have no roles",
  );
});

test("updates are plain text, oldest first, with their replies", async () => {
  const { snapshot, valid } = await fullScan();
  const roadmap = boardNamed(snapshot, "Roadmap");
  const updates = itemOf(roadmap, "1001").updates;
  assert.deepEqual(
    updates.map((u) => [
      u.body,
      u.author_source_id,
      u.author_name,
      u.created_at,
    ]),
    [
      ["Planning started", "1", "Dana Scully", "2025-03-02T12:00:00Z"],
      ["Kickoff done", "900", "Former Employee", "2025-03-03T12:00:00Z"],
      [
        "Fish & chips <3\nSecond line ☺",
        "1",
        "Dana Scully",
        "2025-03-04T12:00:00Z",
      ],
      ["", "1", "Dana Scully", "2025-03-05T08:00:00Z"],
    ],
  );
  // SPEC-6 §2.1: replies stay replies of their update, as written.
  assert.deepEqual(
    updates[2].replies.map((u) => [u.body, u.author_name, u.created_at]),
    [["Thanks!", "Fox Mulder", "2025-03-04T12:30:00Z"]],
  );
  assert.ok(updates.every((u, i) => i === 2 || u.replies === undefined));
  const bodies = boards(snapshot).flatMap((b) =>
    b.items.flatMap((i) => i.updates.map((u) => u.body)),
  );
  assert.ok(
    bodies.every((body) => !/<\/?[a-z]/i.test(body)),
    "no HTML kept",
  );
  assert.deepEqual(
    itemOf(roadmap, "2001").updates.map((u) => u.body),
    ["Draft attached"],
  );
  assert.equal(itemOf(roadmap, "1003").updates[0].body, "Note 1");
  const [capped] = codes(snapshot, "updates_capped");
  assert.equal(capped.path, "workspaces[0].boards[0]");
  const kept = itemOf(boardNamed(valid.snapshot, "Roadmap"), "1001").updates;
  assert.equal(kept.length, 3, "the snapshot drops the empty update");
  assert.equal(kept[2].replies[0].body, "Thanks!");
  assert.equal(kept[1].author_source_id, null);
  assert.equal(kept[1].author_name, "Former Employee");
});

test("docs: delta JSON becomes Worklane blocks", async () => {
  const { snapshot, valid } = await fullScan();
  const [vision] = snapshot.workspaces[0].docs;
  assert.equal(vision.title, "Product vision");
  assert.equal(vision.visibility, "workspace");
  assert.deepEqual(vision.blocks, [
    { type: "heading1", text: "Product vision" },
    { type: "paragraph", text: "We build calm tools." },
    { type: "heading2", text: "Goals" },
    { type: "heading2", text: "Details" },
    { type: "bulleted", text: "Fast" },
    { type: "numbered", text: "First" },
    { type: "todo", text: "Write brief", checked: true },
    { type: "todo", text: "Review brief", checked: false },
    { type: "quote", text: "Less is more" },
    { type: "code", text: "npm start\nnpm test" },
    { type: "divider", text: "" },
    { type: "callout", text: "Heads up" },
    { type: "image", text: "https://files.acme.test/hero.png" },
    { type: "table", text: "[table]" },
    { type: "paragraph", text: "Ask  first" },
  ]);
  const [embeds] = codes(snapshot, "embeds_dropped");
  assert.equal(embeds.path, "workspaces[0].docs[0]");
  const checked = valid.snapshot.workspaces[0].docs[0].blocks;
  assert.deepEqual(
    checked.slice(12, 14).map((b) => b.type),
    ["paragraph", "paragraph"],
  );
  const [handbook] = snapshot.workspaces[2].docs;
  assert.equal(handbook.visibility, "private");
  assert.equal(handbook.blocks.length, 230);
  assert.equal(handbook.blocks.at(-1).text, "Paragraph 230");
});
