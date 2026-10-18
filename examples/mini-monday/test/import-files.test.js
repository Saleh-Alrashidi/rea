/**
 * The file connector (SPEC-4 §3.3, `server/import/connectors/files.js`):
 * CSV tables, monday.com Excel board exports (groups, headers, items,
 * subitems, colors, 1904 dates), overrides, limits, failures and
 * progress (other workbooks are in `import-xlsx.test.js`). Every snapshot is checked with
 * `validateSnapshot`; the last tests scan through the job registry with
 * the real connector and import the result into a seeded store.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { scan } from "../server/import/connectors/files.js";
import { run } from "../server/import/engine.js";
import { createImportJobs } from "../server/import/jobs.js";
import { validateSnapshot } from "../server/import/snapshot.js";
import {
  mondayRows,
  sampleMondayExport,
  sheetWorkbook,
} from "./fixtures/import/make-xlsx.js";
import { seededStore } from "./import-engine-fixtures.js";

const file = (kind, bytes, name) => ({ name, kind, bytes });
const csvFile = (text, name = "Sprint tasks.csv") =>
  file("csv", Buffer.from(text, "utf8"), name);
const xlsxFile = (bytes, name = "Roadmap.xlsx") => file("xlsx", bytes, name);
const boardOf = (snapshot) => snapshot.workspaces[0].boards[0];
const codes = (snapshot) => snapshot.warnings.map((w) => w.code);
/** "Title:type" of each column, space-separated. */
const typesOf = (board) =>
  board.columns.map((c) => `${c.title}:${c.type}`).join(" ");

/** Scans `file`; the snapshot must validate without new warnings. */
async function scanned(file, options) {
  const progress = [];
  const snapshot = await scan({
    file,
    options,
    onProgress: (p) => progress.push(p),
  });
  const checked = validateSnapshot(snapshot);
  assert.ok(checked.ok, JSON.stringify(checked.errors));
  assert.deepEqual(
    checked.snapshot.warnings,
    snapshot.warnings,
    "validation adds no warnings",
  );
  return { snapshot, board: boardOf(snapshot), progress };
}

const SPRINT = [
  "Task name,Group,Owner,Status,Due,Points,Notes",
  "Write spec,Planning,Sam Lee <sam@example.test>,Done,2026-03-01,3,First draft",
  'Review,Planning,"sam@example.test, Noa Cohen",Working on it,2026-03-02,1.5,',
  'Ship,Release,,Stuck,2026-03-09,,"=HYPERLINK(""http://x.test"")"',
  "Celebrate,,Priya,,,,",
].join("\r\n");

test("a CSV becomes one private board named after the file, in a closed workspace", async () => {
  const { snapshot, board } = await scanned(csvFile(SPRINT));
  assert.equal(snapshot.source, "csv");
  assert.equal(snapshot.source_label, "CSV file Sprint tasks.csv");
  const { boards, ...workspace } = snapshot.workspaces[0];
  assert.deepEqual(workspace, {
    source_id: "file",
    name: "Imported from Sprint tasks.csv",
    description: null,
    kind: "closed",
    docs: [],
  });
  assert.equal(boards.length, 1);
  const { columns, groups, items, members, ...head } = board;
  assert.deepEqual(head, {
    source_id: "file:Sprint tasks.csv",
    name: "Sprint tasks",
    description: null,
    kind: "private",
    source_url: null,
  });
  assert.deepEqual(
    groups.map((g) => [g.source_id, g.title, g.color]),
    [
      ["g1", "Planning", "#579bfc"],
      ["g2", "Release", "#a25ddc"],
      ["g3", "Imported", "#00c875"],
    ],
  );
  assert.equal(
    typesOf(board),
    "Owner:people Status:status Due:date Points:numbers Notes:text",
  );
  assert.deepEqual(columns[1].labels, [
    { label: "Done", color: "#00c875" },
    { label: "Working on it", color: "#fdab3d" },
    { label: "Stuck", color: "#df2f4a" },
  ]);
  assert.deepEqual(
    items.map((i) => [i.name, i.group_source_id, i.values]),
    [
      [
        "Write spec",
        "g1",
        {
          c1: ["email:sam@example.test"],
          c2: "Done",
          c3: "2026-03-01",
          c4: 3,
          c5: "First draft",
        },
      ],
      [
        "Review",
        "g1",
        {
          c1: ["email:sam@example.test", "name:noa cohen"],
          c2: "Working on it",
          c3: "2026-03-02",
          c4: 1.5,
        },
      ],
      [
        "Ship",
        "g2",
        { c2: "Stuck", c3: "2026-03-09", c5: '=HYPERLINK("http://x.test")' },
      ],
      ["Celebrate", "g3", { c1: ["name:priya"] }],
    ],
  );
  assert.ok(
    items.every((i) => i.parent_source_id === null && i.updates.length === 0),
  );
  assert.deepEqual(snapshot.users, [
    {
      source_id: "email:sam@example.test",
      name: "Sam Lee",
      email: "sam@example.test",
    },
    { source_id: "name:noa cohen", name: "Noa Cohen", email: null },
    { source_id: "name:priya", name: "Priya", email: null },
  ]);
  assert.deepEqual(
    members,
    snapshot.users.map((u) => ({
      user_source_id: u.source_id,
      role: "editor",
    })),
  );
  assert.deepEqual(codes(snapshot), ["formula_text"]);
});

test("without a name or group header the first column names items in one group", async () => {
  const { board } = await scanned(
    csvFile("Title,Group name\nA,x\nB,y\n", "plain"),
  );
  assert.equal(board.name, "plain");
  assert.deepEqual(
    board.groups.map((g) => g.title),
    ["x", "y"],
    "Group name is a group header too",
  );
  const { board: flat } = await scanned(csvFile("Title,Size\nA,1\nB,2\n"));
  assert.deepEqual(flat.groups, [
    { source_id: "g1", title: "Imported", color: "#579bfc" },
  ]);
  assert.equal(flat.items.map((i) => i.name).join(), "A,B");
  assert.equal(typesOf(flat), "Size:numbers");
  // A first column that defines groups leaves the name to the next one.
  const { board: grouped } = await scanned(csvFile("List,Thing\nToday,Shop\n"));
  assert.deepEqual(
    [grouped.groups[0].title, grouped.items[0].name],
    ["Today", "Shop"],
  );
});

test("headers are made distinct and extra cells get their own columns", async () => {
  const { board, snapshot } = await scanned(
    csvFile("Name,Notes,notes,\nA,1,2,3,4\n"),
  );
  assert.equal(
    typesOf(board),
    "Notes:numbers notes (2):numbers Column 4:numbers Column 5:numbers",
  );
  assert.deepEqual(board.items[0].values, { c1: 1, c2: 2, c3: 3, c4: 4 });
  assert.deepEqual(codes(snapshot), []);
});

test("column_types override inferred types by title; unknown and special names warn", async () => {
  const options = {
    column_types: {
      due: "text",
      Points: "status",
      "task name": "date",
      Nope: "text",
    },
  };
  const { board, snapshot } = await scanned(csvFile(SPRINT), options);
  assert.equal(
    typesOf(board),
    "Owner:people Status:status Due:text Points:status Notes:text",
  );
  assert.equal(board.items[0].values.c3, "2026-03-01");
  assert.deepEqual(
    snapshot.warnings
      .filter((w) => w.code === "unknown_column")
      .map((w) => w.message),
    [
      'column_types names "task name", which holds item names or groups; its type was not changed',
      'column_types names "Nope", which is not a column of this file; it was ignored',
    ],
  );
  // An override that values do not fit is reported by validation.
  const forced = await scan({
    file: csvFile("Name,When\nA,soon\nB,2026-01-02\n"),
    options: { column_types: { When: "date" } },
  });
  const checked = validateSnapshot(forced);
  assert.deepEqual(
    boardOf(checked.snapshot).items.map((i) => i.values),
    [{}, { c1: "2026-01-02" }],
  );
  assert.deepEqual(
    checked.snapshot.warnings.map((w) => w.code),
    ["invalid_value"],
  );
});

test("item and column limits keep the first rows and columns and report the rest", async () => {
  const lines = [
    "Name,Count",
    ...Array.from({ length: 12 }, (_, i) => `Item ${i},${i}`),
  ];
  const { board, snapshot } = await scanned(csvFile(lines.join("\n")), {
    limits: { items: 10 },
  });
  assert.equal(board.items.length, 10);
  assert.deepEqual(snapshot.warnings, [
    {
      code: "too_many_items",
      message:
        "Only the first 10 items were imported; 2 more rows were left out",
      path: "workspaces[0].boards[0]",
    },
  ]);
  const wide = [
    Array.from({ length: 203 }, (_, i) => `C${i}`),
    Array.from({ length: 203 }, () => "v"),
  ];
  const { board: cut, snapshot: cutSnap } = await scanned(
    csvFile(wide.map((r) => r.join(",")).join("\n")),
  );
  assert.equal(cut.columns.length, 199, "200 columns, one of them the names");
  assert.deepEqual(codes(cutSnap), ["too_many_columns"]);
  assert.match(
    cutSnap.warnings[0].message,
    /^6 values past the first 200 columns/,
  );
  // Asking for more than 50,000 items keeps the default.
  const { board: one } = await scanned(csvFile("Name\nA\n"), {
    limits: { items: 100_000 },
  });
  assert.equal(one.items.length, 1);
});

test("a group column with more than 500 values is a column; more than 1,000 people are not all members", async () => {
  const lines = [
    "Name,Group,Owner",
    ...Array.from({ length: 1_001 }, (_, i) => `I${i},G${i},p${i}@x.test`),
  ];
  const { board, snapshot } = await scanned(csvFile(lines.join("\n")));
  assert.equal(board.groups.length, 1);
  assert.equal(typesOf(board), "Group:text Owner:people");
  assert.equal(board.members.length, 1_000);
  assert.equal(snapshot.users.length, 1_001);
  assert.deepEqual(codes(snapshot), ["too_many_groups", "too_many_members"]);
});

test("a file that is not UTF-8 is read as Windows-1252 with a warning", async () => {
  const bytes = Buffer.from([...Buffer.from("Name\n"), 0x93, 0x51, 0x94, 0x0a]);
  const { board, snapshot } = await scanned(file("csv", bytes, "ansi.csv"));
  assert.equal(board.items[0].name, "“Q”");
  assert.deepEqual(codes(snapshot), ["encoding"]);
});

test("bad files fail with an import error code; progress is reported", async () => {
  const fails = (file, code) => assert.rejects(scan({ file }), { code });
  await fails(null, "INVALID_FILE");
  await fails(file("json", Buffer.from("{}"), "x.json"), "INVALID_FILE");
  await fails(file("csv", "Name\nA", "x.csv"), "INVALID_FILE");
  await fails(csvFile(""), "EMPTY_FILE");
  await fails(csvFile("\n\r\n , \n"), "EMPTY_FILE");
  await fails(xlsxFile(sheetWorkbook([[null], null])), "EMPTY_FILE");
  const big = Buffer.alloc(20 * 1024 * 1024 + 1, 0x41);
  await fails(file("csv", big, "big.csv"), "FILE_TOO_LARGE");
  await fails(csvFile('Name\n"open'), "INVALID_CSV");
  await fails(xlsxFile(Buffer.from("Name\nA\n")), "INVALID_XLSX");
  const controller = new AbortController();
  const pending = scan({
    file: csvFile("Name\nA\n"),
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, { code: "ABORTED" });
  const blank = file("csv", Buffer.from("Name\nA\nB\n"), "  ");
  const { progress, snapshot } = await scanned(blank);
  assert.equal(
    boardOf(snapshot).name,
    "import",
    "a blank name falls back to import.csv",
  );
  assert.deepEqual(progress, [
    { phase: "reading", done: 0, total: 1, message: "Reading import.csv" },
    { phase: "converting", done: 0, total: 3, message: "Reading rows" },
    { phase: "converting", done: 2, total: 2, message: "Read 2 items" },
  ]);
});

const mondayExport = (options) => xlsxFile(sampleMondayExport(options));

test("a monday.com Excel export keeps its board, groups, items and subitems", async () => {
  const { snapshot, board } = await scanned(mondayExport());
  assert.equal(snapshot.source, "xlsx");
  assert.equal(snapshot.source_label, "monday.com Excel export Roadmap.xlsx");
  assert.deepEqual(
    [board.name, board.description, board.source_id],
    ["Product roadmap", "What ships when", "file:Roadmap.xlsx"],
  );
  assert.deepEqual(
    board.groups.map((g) => [g.title, g.color]),
    [
      ["This quarter", "#037f4c"],
      ["Later", "#784bd1"],
      ["Empty group", "#00c875"],
    ],
  );
  assert.equal(
    typesOf(board),
    "Owner:people Status:status Due:date Estimate:numbers Due (subitem):status Notes:text",
  );
  assert.deepEqual(board.columns[1].labels, [
    { label: "Done", color: "#00c875" },
    { label: "Working on it", color: "#fdab3d" },
    { label: "Stuck", color: "#df2f4a" },
  ]);
  const byName = new Map(board.items.map((i) => [i.name, i]));
  assert.deepEqual(
    board.items.map((i) => [
      i.name,
      i.group_source_id,
      i.parent_source_id &&
        byName.get("Launch site").source_id === i.parent_source_id,
    ]),
    [
      ["Launch site", "g1", null],
      ["Copy", "g1", true],
      ["Assets", "g1", true],
      ["Pricing page", "g1", null],
      ["Name only", "g1", null],
      ["Hiring plan", "g2", null],
    ],
  );
  const [owner, status, due, estimate, subDue, notes] = board.columns.map(
    (c) => c.source_id,
  );
  assert.deepEqual(byName.get("Launch site").values, {
    [owner]: ["email:sam@example.test"],
    [status]: "Done",
    [due]: "2026-03-05",
    [estimate]: 3,
  });
  assert.deepEqual(byName.get("Copy").values, {
    [owner]: ["email:noa@example.test"],
    [status]: "Stuck",
    [subDue]: "Friday",
    [notes]: "=1+1",
  });
  assert.deepEqual(byName.get("Pricing page").values, {
    [status]: "Working on it",
    [due]: "2026-04-01",
    [estimate]: 2.5,
  });
  assert.deepEqual(byName.get("Name only").values, {});
  assert.deepEqual(
    snapshot.users.map((u) => u.source_id),
    ["email:sam@example.test", "name:priya", "email:noa@example.test"],
  );
  assert.deepEqual(codes(snapshot), [
    "subitems_column",
    "time_dropped",
    "formula_text",
  ]);
  assert.match(snapshot.warnings[2].message, /^2 values in “Notes”/);
});

test("export dates come out the same in the 1900 and 1904 date systems", async () => {
  const dueOf = ({ board }) => {
    const due = board.columns.find((c) => c.title === "Due").source_id;
    return board.items.map((i) => i.values[due]).filter(Boolean);
  };
  const expected = ["2026-03-05", "2026-04-01"];
  assert.deepEqual(
    dueOf(await scanned(mondayExport({ date1904: true }))),
    expected,
  );
  assert.deepEqual(
    dueOf(await scanned(mondayExport({ date1904: false }))),
    expected,
  );
});

test("subitem columns join item columns of the same type and title; overrides can split them", async () => {
  const { board } = await scanned(mondayExport(), {
    column_types: { "Status (subitem)": "text" },
  });
  assert.match(
    typesOf(board),
    / Status \(subitem\):text Due \(subitem\):status Notes:text$/,
  );
  // The item header's Subitems list stays a column when no subitem rows exist.
  const rows = mondayRows({
    title: "Board",
    groups: [
      {
        title: "G",
        color: null,
        header: ["Task", "Subitems", "Owner"],
        items: [{ cells: ["A", "x, y", "Ann"] }],
      },
    ],
  });
  const { board: listed, snapshot } = await scanned(
    xlsxFile(sheetWorkbook(rows)),
  );
  assert.equal(typesOf(listed), "Subitems:status Owner:people");
  assert.equal(
    listed.items[0].name,
    "A",
    "a renamed first column still names items",
  );
  assert.deepEqual(codes(snapshot), []);
});

async function registry(t) {
  const seeded = await seededStore();
  const jobs = createImportJobs({ store: seeded.store });
  t.after(() => jobs.close());
  return { ...seeded, jobs, admin: seeded.ids.users.alex };
}

async function finished(jobs, id, userId) {
  for (let n = 0; n < 200; n += 1) {
    const job = jobs.get(id, userId);
    if (job.state !== "running") return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("the job did not finish");
}

test("scan jobs load the file connector and preview its snapshot", async (t) => {
  const { jobs, admin } = await registry(t);
  const started = jobs.startScan({
    userId: admin,
    source: "csv",
    file: csvFile(SPRINT),
    options: {},
  });
  const job = await finished(jobs, started.job.id, admin);
  assert.equal(job.state, "done", JSON.stringify(job.error));
  assert.deepEqual(job.preview.totals.boards, 1);
  assert.equal(job.preview.workspaces[0].boards[0].counts.items, 4);
  const proposals = Object.fromEntries(
    job.preview.users.map((u) => [u.source_id, u.action.split(":")[0]]),
  );
  assert.deepEqual(proposals, {
    "email:sam@example.test": "match",
    "name:noa cohen": "skip",
    "name:priya": "skip",
  });
  const xlsx = jobs.startScan({
    userId: admin,
    source: "xlsx",
    file: mondayExport(),
  });
  const done = await finished(jobs, xlsx.job.id, admin);
  assert.equal(done.state, "done", JSON.stringify(done.error));
  assert.equal(done.preview.workspaces[0].boards[0].counts.subitems, 2);
  const broken = jobs.startScan({
    userId: admin,
    source: "xlsx",
    file: xlsxFile(Buffer.from("PK\u0003\u0004")),
  });
  assert.deepEqual((await finished(jobs, broken.job.id, admin)).error, {
    code: "INVALID_XLSX",
    message: "The file is not an .xlsx workbook",
  });
});

test("an imported export keeps statuses, people, dates and subitems", async () => {
  const { store, ids } = await seededStore();
  const snapshot = await scan({ file: mondayExport() });
  const report = await run(snapshot, {}, { store, importerId: ids.users.alex });
  const link = report.links.find((l) => l.kind === "board");
  const board = store.getBoard(link.id);
  assert.equal(board.import.source, "xlsx");
  assert.equal(board.import.source_id, "file:Roadmap.xlsx");
  const columns = new Map(store.listColumns(board.id).map((c) => [c.title, c]));
  const { items } = store.listItems({ boardId: board.id, limit: 20 });
  const launch = items.find((i) => i.name === "Launch site");
  assert.deepEqual(launch.values[columns.get("Owner").id], [ids.users.sam]);
  assert.equal(
    columns.get("Status").settings.labels[
      launch.values[columns.get("Status").id].index
    ],
    "Done",
  );
  assert.equal(launch.values[columns.get("Due").id], "2026-03-05");
  const copy = items.find((i) => i.name === "Copy");
  assert.equal(copy.values[columns.get("Parent item").id], "Launch site");
  assert.equal(copy.values[columns.get("Notes").id], "=1+1");
  assert.deepEqual(
    store.listGroups(board.id).map((g) => g.title),
    ["This quarter", "Later", "Empty group"],
  );
});
