/**
 * The import wizard's texts and checks (SPEC-4 §6, `web/ui/import/`):
 * warnings grouped by code with their places and the downloadable list,
 * file checks and scan options (accepted by the route's own option
 * reader), progress text, the done step's model and the board badge.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { MAX_FILE_BYTES, readOptions } from "../server/routes/import.js";
import { importBadgeInfo, sourceHref } from "../web/ui/import/import-badge.js";
import { progressView } from "../web/ui/import/progress.js";
import * as R from "../web/ui/import/report-model.js";
import * as S from "../web/ui/import/sources.js";
import * as G from "../web/ui/import/warnings.js";
import { PREVIEW } from "./web-import-fixtures.js";

// ----------------------------------------------------------- warnings

const WARNINGS = [
  {
    code: "column_as_text",
    message: "Files became text",
    path: "workspaces[0].boards[0].columns[4]",
  },
  { code: "truncated", message: "Name cut", path: "users[2]" },
  {
    code: "column_as_text",
    message: '=HYPERLINK("x")',
    path: "workspaces[1].boards[0]",
  },
  { code: 5, message: null, path: 7 },
];

test("warnings are grouped by code, largest group first", () => {
  const groups = G.groupWarnings(WARNINGS);
  assert.deepEqual(
    groups.map((group) => [group.code, group.title, group.count]),
    [
      ["column_as_text", "Column as text", 2],
      ["other", "Other", 1],
      ["truncated", "Truncated", 1],
    ],
  );
  assert.deepEqual(groups[1].items, [{ message: "", path: "" }]);
  assert.equal(G.humanizeCode("unknown-block.type"), "Unknown block type");
  assert.deepEqual(G.groupWarnings(), []);
  const sized = G.groupWarnings([{ code: "b" }, { code: "z" }, { code: "z" }]);
  assert.deepEqual(
    sized.map((group) => group.code),
    ["z", "b"],
    "count before code",
  );
});

test("warning paths are described with the names they point at", () => {
  assert.deepEqual(G.locate("workspaces[0].boards[1].columns[2]", PREVIEW), {
    label: "Acme › Hiring",
    rest: "columns[2]",
  });
  assert.deepEqual(G.locate("workspaces[0].docs[0].blocks[3]", PREVIEW), {
    label: "Acme › Handbook",
    rest: "blocks[3]",
  });
  assert.deepEqual(G.locate("workspaces[1]", PREVIEW), {
    label: "Archive",
    rest: "",
  });
  assert.deepEqual(G.locate("users[2]", PREVIEW), {
    label: "People › Anon",
    rest: "",
  });
  assert.deepEqual(G.locate("workspaces[0].boards[9].x", PREVIEW), {
    label: "Acme",
    rest: "workspaces[0].boards[9].x",
  });
  assert.deepEqual(G.locate("workspaces[5]", PREVIEW), {
    label: "",
    rest: "workspaces[5]",
  });
  assert.deepEqual(G.locate(null, PREVIEW), { label: "", rest: "" });
});

test("the warning download is plain text with every warning and its path", () => {
  const generatedAt = new Date("2026-10-18T12:00:00Z");
  const text = G.warningsText({
    warnings: WARNINGS,
    preview: PREVIEW,
    title: "Import",
    generatedAt,
  });
  assert.equal(
    text,
    [
      "Import",
      "Generated 2026-10-18T12:00:00.000Z",
      "4 warnings",
      "",
      "Column as text (column_as_text): 2",
      "- [column_as_text] Acme › Roadmap (workspaces[0].boards[0].columns[4]): Files became text",
      '- [column_as_text] Archive › Old (workspaces[1].boards[0]): =HYPERLINK("x")',
      "",
      "Other (other): 1",
      "- [other] ",
      "",
      "Truncated (truncated): 1",
      "- [truncated] People › Anon (users[2]): Name cut",
      "",
    ].join("\n"),
  );
  const none = G.warningsText({ warnings: [], title: "T", generatedAt });
  assert.ok(none.endsWith("0 warnings\n\nThere were no warnings.\n"));
  assert.equal(
    G.warningsFileName("monday.com account Acme Corp!", generatedAt),
    "worklane-import-warnings-monday-com-account-acme-corp-2026-10-18.txt",
  );
  assert.equal(
    G.warningsFileName("✓✓", generatedAt),
    "worklane-import-warnings-import-2026-10-18.txt",
  );
});

// ------------------------------------------------------------ sources

test("files are checked for size first, then emptiness and type", () => {
  assert.equal(S.MAX_FILE_BYTES, MAX_FILE_BYTES, "the route's upload limit");
  const big = { name: "huge.pdf", size: MAX_FILE_BYTES + 1 };
  assert.equal(
    S.checkFile(big, "csv"),
    "huge.pdf is over the 20 MB limit for imports.",
  );
  assert.equal(
    S.checkFile({ name: "a.csv", size: 31 * 1024 * 1024 }, "csv"),
    "a.csv (31 MB) is over the 20 MB limit for imports.",
  );
  assert.equal(
    S.checkFile({ name: "a.csv", size: MAX_FILE_BYTES }, "csv"),
    null,
  );
  assert.equal(
    S.checkFile({ name: "a.csv", size: 0 }, "csv"),
    "a.csv is empty.",
  );
  assert.equal(
    S.checkFile({ name: "a.pdf", size: 9 }, "csv"),
    "Choose a .csv or .txt file.",
  );
  assert.equal(S.checkFile({ name: "BOARD.XLSX", size: 9 }, "xlsx"), null);
  assert.equal(
    S.checkFile({ name: "a.csv", size: 9 }, "xlsx"),
    "Choose a .xlsx file.",
  );
  assert.equal(S.checkFile(null, "csv"), "Choose a file to import.");
  assert.equal(
    S.checkFile({ name: "a.csv", size: 9 }, "monday"),
    "Choose a file source first.",
  );
  assert.deepEqual([0, 1536, MAX_FILE_BYTES, -1].map(S.formatBytes), [
    "0 B",
    "1.5 KB",
    "20 MB",
    "",
  ]);
  assert.deepEqual(S.SOURCE_IDS, ["monday", "clickup", "csv", "xlsx"]);
  assert.equal(S.sourceOf("toString"), null);
});

test("scan options carry only turned-off flags and lowered limits", () => {
  assert.deepEqual(
    S.scanOptions("monday", {
      flags: {
        include_docs: false,
        include_updates: true,
        include_comments: false,
      },
      limits: { boards: " 10 ", items: "", updates: "5000" },
    }),
    { include_docs: false, limits: { boards: 10, updates: 5000 } },
    "a limit at its maximum is sent as asked",
  );
  assert.deepEqual(
    S.scanOptions("clickup", {
      limits: { boards: "1.5", items: "-3", updates: "abc" },
    }),
    {},
  );
  assert.deepEqual(
    S.scanOptions("csv", { flags: { include_docs: false } }),
    {},
  );
  assert.deepEqual(S.limitProblems({ boards: "", items: " 50000 " }), {});
  const problems = S.limitProblems({
    boards: "0",
    items: "999999",
    updates: "2.5",
  });
  assert.deepEqual(Object.keys(problems), ["boards", "items", "updates"]);
  assert.equal(
    problems.items,
    "Enter a whole number from 1 to 50,000, or leave it empty for 50,000.",
  );
  // The route accepts whatever the form can send.
  for (const source of ["monday", "clickup"]) {
    const flags = Object.fromEntries(
      S.sourceOf(source).options.map((option) => [option.key, false]),
    );
    const limits = { boards: "1", items: "50000", updates: "4999" };
    const options = S.scanOptions(source, { flags, limits });
    assert.deepEqual(readOptions(options, { file: false }), options);
    assert.equal(Object.keys(options).length, 4, source);
  }
});

// ----------------------------------------------- progress, done, badge

test("progress shows a phase, a bar when the total is known and a count", () => {
  const items = progressView(
    { phase: "items", done: 2, total: 8, message: "Reading list “A”" },
    { kind: "scan", source: "clickup" },
  );
  assert.deepEqual(items, {
    title: "Reading items",
    percent: 25,
    countText: "2 of 8 lists",
    message: "Reading list “A”",
    valueText: "Reading items: 2 of 8 lists",
    announcement: "Reading items",
    waiting: false,
  });
  const waiting = progressView(
    {
      phase: "items",
      done: 2,
      total: 8,
      message: "Waiting 57 s…",
      wait_seconds: 57,
    },
    { kind: "scan", source: "clickup" },
  );
  assert.equal(waiting.waiting, true);
  assert.equal(waiting.message, "Waiting 57 s…");
  assert.equal(
    waiting.announcement,
    "Reading items: waiting 57 seconds for the source",
    "a wait is announced once",
  );
  const rows = progressView(
    { phase: "converting", done: 40, total: null },
    { kind: "scan", source: "csv" },
  );
  assert.equal(rows.percent, null);
  assert.equal(rows.countText, "40 rows so far");
  const start = progressView(null, { kind: "import" });
  assert.deepEqual(
    [start.title, start.percent, start.countText],
    ["Starting", null, ""],
  );
  const boards = progressView(
    { phase: "boards", done: 5, total: 4 },
    { kind: "import" },
  );
  assert.deepEqual(
    [boards.title, boards.percent, boards.countText],
    ["Importing boards", 100, "5 of 4 boards and docs"],
  );
  assert.equal(
    progressView({ phase: "odd_phase" }, { kind: "scan" }).title,
    "Odd phase",
  );
});

test("the done step's tiles, safe links and skipped entries", () => {
  const tiles = R.createdTiles({ boards: 2, items: -1, docs: 1.5 });
  assert.deepEqual(
    tiles.slice(0, 5).map((tile) => [tile.key, tile.value]),
    [
      ["workspaces", 0],
      ["boards", 2],
      ["items", 0],
      ["updates", 0],
      ["docs", 0],
    ],
  );
  const labels = R.createdTiles({ workspaces: 1, users: 1, boards: 2 });
  assert.deepEqual(
    labels.slice(0, 2).map((tile) => tile.label),
    ["Workspace", "Boards"],
    "one is singular",
  );
  assert.equal(
    labels.find((tile) => tile.key === "users").label,
    "Person invited",
  );
  const sections = R.linkSections([
    { kind: "board", id: "1", url: "#/boards/1", title: "Roadmap" },
    { kind: "board", id: "2", url: "https://evil.test/#/boards/2", title: "X" },
    { kind: "doc", id: "3", url: "javascript:alert(1)", title: "Y" },
    { kind: "workspace", id: "4", url: "#/workspaces/4", title: "Acme" },
    { kind: "note", id: "5", url: "#/notes", title: "Z" },
  ]);
  assert.deepEqual(
    sections.map((section) => [section.kind, section.links]),
    [
      ["workspace", [{ title: "Acme", href: "#/workspaces/4" }]],
      ["board", [{ title: "Roadmap", href: "#/boards/1" }]],
    ],
  );
  const skipped = R.skippedSections([
    { kind: "user", name: "Nia", reason: "skipped" },
    { kind: "board", name: "Hiring", reason: "cancelled" },
    { kind: "doc", name: "Odd", reason: "mystery" },
  ]);
  assert.deepEqual(
    skipped.map((section) => [section.reason, section.entries[0].kindName]),
    [
      ["cancelled", "Board"],
      ["skipped", "Person"],
    ],
  );
  assert.deepEqual(
    R.doneSummary({ created: { boards: 1, items: 2, docs: 0 } }),
    {
      title: "Import finished",
      text: "Created 1 board, 2 items and 0 docs.",
    },
  );
  assert.equal(
    R.doneSummary({ created: {}, cancelled: true }).title,
    "Import stopped",
  );
});

test("the board badge names the source and links only to http(s) URLs", () => {
  assert.equal(
    sourceHref("https://acme.monday.com/boards/1"),
    "https://acme.monday.com/boards/1",
  );
  for (const url of [
    "javascript:alert(1)",
    "ftp://x.test/a",
    "/boards/1",
    "",
    5,
  ]) {
    assert.equal(sourceHref(url), null, String(url));
  }
  const info = importBadgeInfo({
    source: "clickup",
    source_url: "https://app.clickup.com/t/1",
    imported_at: "2026-10-01T10:00:00Z",
    imported_by: { id: "1", name: "Alex Rivera" },
  });
  assert.equal(info.label, "Imported from ClickUp");
  assert.equal(info.href, "https://app.clickup.com/t/1");
  assert.match(
    info.title,
    /^Imported from ClickUp on .+ by Alex Rivera\. Opens the original\.$/,
  );
  const plain = importBadgeInfo({
    source: "csv",
    source_url: "data:text/html,x",
    imported_at: null,
  });
  assert.equal(
    info.name,
    "Imported from ClickUp, open the original board (new tab)",
  );
  assert.deepEqual(plain, {
    label: "Imported from a CSV file",
    href: null,
    title: "Imported from a CSV file",
    name: "Imported from a CSV file",
  });
  assert.equal(
    importBadgeInfo({ source: "zz" }).label,
    "Imported from another tool",
  );
  assert.equal(importBadgeInfo(null), null);
});
