/**
 * CSV reading and the column typing every file import shares (SPEC-4
 * §3.3, `server/import/csv.js`): RFC 4180 records, encodings, limits,
 * cancellation, type inference with its override hook, formula-looking
 * values, and the conversion of cells into snapshot values, labels and
 * people.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  FILE_LIMITS,
  columnType,
  convertColumns,
  dateOf,
  decodeText,
  inferType,
  isFormulaLike,
  numberOf,
  parseCsv,
  personOf,
  readOverrides,
  serialText,
} from "../server/import/csv.js";
import { MAX_LABELS } from "../server/import/snapshot-columns.js";

const rowsOf = (text, options) => parseCsv(text, options).rows;

test("CSV records follow RFC 4180: quotes, escaped quotes, line breaks", () => {
  const text = [
    "Name,Notes,Count",
    'Plain,"Quoted, with comma",1',
    '"Escaped ""quotes""","Line one\r\nLine two",2',
    '"",,3',
    "Trailing,comma,",
  ].join("\r\n");
  assert.deepEqual(rowsOf(text), [
    ["Name", "Notes", "Count"],
    ["Plain", "Quoted, with comma", "1"],
    ['Escaped "quotes"', "Line one\r\nLine two", "2"],
    ["", "", "3"],
    ["Trailing", "comma", ""],
  ]);
  // LF, CR and a last record without a line break; blank records skipped.
  assert.deepEqual(rowsOf("a,b\n\n1,2\r\r3,4\n , \n5,6"), [
    ["a", "b"],
    ["1", "2"],
    ["3", "4"],
    ["5", "6"],
  ]);
  // Text after a closing quote is kept as written.
  assert.deepEqual(rowsOf('a\n"x"y z'), [["a"], ["xy z"]]);
  // A quote inside an unquoted field is an ordinary character.
  assert.deepEqual(rowsOf('a\n5" screen'), [["a"], ['5" screen']]);
});

test("a quoted field that never ends is an INVALID_CSV error", () => {
  assert.throws(
    () => parseCsv('Name,Notes\nA,"open\nB,c\n'),
    (error) =>
      error.code === "INVALID_CSV" &&
      /Record 2 opens a quoted field/.test(error.message),
  );
});

test("the delimiter is the one the header uses most: comma, semicolon or tab", () => {
  assert.equal(parseCsv("a,b,c\n1,2,3").delimiter, ",");
  assert.deepEqual(rowsOf("Name;Due;Notes\nA;2026-01-02;x, y"), [
    ["Name", "Due", "Notes"],
    ["A", "2026-01-02", "x, y"],
  ]);
  assert.deepEqual(rowsOf("Name\tNotes\nA\tB"), [
    ["Name", "Notes"],
    ["A", "B"],
  ]);
  // Delimiters inside quotes do not count; ties keep the comma.
  assert.equal(parseCsv('"a;b;c",d\n1,2').delimiter, ",");
  assert.equal(parseCsv("a;b,c\n").delimiter, ",");
});

test("text is decoded from UTF-8 (BOM or not), UTF-16 with a BOM, else Windows-1252", () => {
  const bom = Buffer.from("﻿Namé,B\n", "utf8");
  assert.deepEqual(decodeText(bom), {
    text: "Namé,B\n",
    encoding: "utf-8-bom",
  });
  assert.equal(decodeText(Buffer.from("Ünïcode")).encoding, "utf-8");
  const le = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from("Tâche,1", "utf16le"),
  ]);
  assert.deepEqual(decodeText(le), { text: "Tâche,1", encoding: "utf-16le" });
  const be = Buffer.from([0xfe, 0xff, 0x00, 0x41, 0x00, 0x2c, 0x00, 0x42]);
  assert.deepEqual(decodeText(be), { text: "A,B", encoding: "utf-16be" });
  // 0x93/0x94 are curly quotes in Windows-1252 and invalid UTF-8.
  const ansi = Buffer.from([0x93, 0x48, 0x69, 0x94, 0x2c, 0xe9]);
  assert.deepEqual(decodeText(ansi), {
    text: "“Hi”,é",
    encoding: "windows-1252",
  });
});

test("records past maxRows and fields past maxColumns are counted, not kept", () => {
  const lines = ["Name,A,B,C"];
  for (let n = 1; n <= 12; n += 1)
    lines.push(`Item ${n},1,2,${n % 2 ? "x" : ""}`);
  const parsed = parseCsv(lines.join("\n"), { maxRows: 10, maxColumns: 3 });
  assert.equal(parsed.rows.length, 11, "the header and ten records");
  assert.equal(parsed.extraRows, 2);
  assert.ok(parsed.rows.every((row) => row.length === 3));
  assert.equal(
    parsed.droppedCells,
    6,
    "the non-empty C values of the kept records",
  );
  assert.equal(parsed.width, 4);
  assert.deepEqual(FILE_LIMITS, {
    bytes: 20 * 1024 * 1024,
    rows: 50_000,
    columns: 200,
    statusValues: 30,
    statusLength: 50,
    person: 200,
  });
  // The default limits apply without options.
  const wide = `${Array.from({ length: 205 }, (_, i) => `c${i}`).join(",")}\n`;
  assert.equal(parseCsv(wide).rows[0].length, 200);
  assert.equal(parseCsv(wide).droppedCells, 5);
});

test("parsing stops with ABORTED once the signal fires", () => {
  const controller = new AbortController();
  controller.abort();
  const text = `Name\n${"x\n".repeat(5000)}`;
  assert.throws(() => parseCsv(text, { signal: controller.signal }), {
    code: "ABORTED",
  });
  assert.equal(
    parseCsv("Name\nA", { signal: controller.signal }).rows.length,
    2,
    "short files finish before the first check",
  );
});

test("numbers are plain literals with at most 15 significant digits", () => {
  const cases = {
    0: 0,
    "-0": 0,
    42: 42,
    "-5": -5,
    "+3.5": 3.5,
    "1e5": 100000,
    0.000001: 0.000001,
    123456789012345: 123456789012345,
  };
  for (const [text, value] of Object.entries(cases))
    assert.equal(numberOf(text), value, text);
  for (const text of [
    "007",
    "1,234",
    ".5",
    "12345678901234567",
    "1e999",
    "5 kg",
    "0x10",
    "",
  ])
    assert.equal(numberOf(text), null, text);
  assert.ok(Object.is(numberOf("-0"), 0), "no negative zero");
});

test("dates are real ISO dates, with or without a time", () => {
  assert.deepEqual(dateOf("2024-03-05"), { date: "2024-03-05", time: false });
  assert.deepEqual(dateOf("2024/03/05"), { date: "2024-03-05", time: false });
  assert.deepEqual(dateOf("2024-03-05 00:00:00"), {
    date: "2024-03-05",
    time: false,
  });
  assert.deepEqual(dateOf("2024-03-05T10:30:00.000Z"), {
    date: "2024-03-05",
    time: true,
  });
  assert.deepEqual(dateOf("2024-02-29 23:59"), {
    date: "2024-02-29",
    time: true,
  });
  for (const text of [
    "2023-02-29",
    "2024-13-01",
    "2024-03/05",
    "2024-03-05 24:00",
    "05/03/2024",
    "March 5",
  ])
    assert.equal(dateOf(text), null, text);
});

test("spreadsheet serials become the date text dateOf reads (1900 and 1904 systems)", () => {
  // [serial, 1904 system, kind, text]
  const cases = [
    [45292, false, "date", "2024-01-01"],
    [45356.5, false, "date", "2024-03-05 12:00:00"],
    [43830, true, "date", "2024-01-01"], // 1904 serials are 1,462 smaller
    [0, true, "date", "1904-01-01"],
    [1, false, "date", "1900-01-01"],
    [59, false, "date", "1900-02-28"],
    [60, false, "date", "1900-02-29"], // Excel's day that never was
    [61, false, "date", "1900-03-01"],
    [0.25, false, "date", "06:00:00"], // a time without a day
    [0.1 + 0.2, false, "date", "07:12:00"],
    [0.75, false, "time", "18:00:00"],
    [1.5, false, "time", "1.5"], // durations stay numbers
    [-1, false, "date", "-1"],
    [3_000_000, false, "date", "3000000"],
  ];
  for (const [serial, date1904, kind, text] of cases)
    assert.equal(serialText(serial, { date1904, kind }), text, `${serial}`);
  assert.equal(dateOf("1900-02-29"), null, "which is not a date");
});

test("formula-looking values are those starting with = + - @ that are not numbers", () => {
  for (const text of [
    "=SUM(A1:A3)",
    "+cmd|' /C calc'!A0",
    "-x",
    "@ann",
    '=HYPERLINK("http://x")',
  ])
    assert.equal(isFormulaLike(text), true, text);
  for (const text of ["-5", "+3.5", "-", "+", "=", "a=b", "email@x.test"])
    assert.equal(isFormulaLike(text), false, text);
});

test("people are names, emails or 'Name <email>' entries", () => {
  assert.deepEqual(personOf("Ann Lee <Ann@Acme.test>"), {
    source_id: "email:ann@acme.test",
    name: "Ann Lee",
    email: "Ann@Acme.test",
  });
  assert.deepEqual(personOf("bob@acme.test"), {
    source_id: "email:bob@acme.test",
    name: "bob@acme.test",
    email: "bob@acme.test",
  });
  assert.deepEqual(personOf("<cy@acme.test>").name, "cy@acme.test");
  assert.deepEqual(personOf("Dana Scully"), {
    source_id: "name:dana scully",
    name: "Dana Scully",
    email: null,
  });
  assert.deepEqual(personOf("Eve <nobody>"), {
    source_id: "name:eve <nobody>",
    name: "Eve <nobody>",
    email: null,
  });
  assert.equal(personOf("x".repeat(201)), null, "too long for a source ID");
  assert.equal(personOf(`${"x".repeat(195)}@a.test`), null);
  assert.equal(personOf("=1+1"), null, "formula-looking names are not people");
});

test("column types are inferred in SPEC-4 order", () => {
  const many = Array.from({ length: 31 }, (_, i) => `Label ${i}`);
  const cases = [
    [[], "Anything", "text"],
    [["2024-01-02", "2024-02-03 10:00"], "Due", "date"],
    [["1", "-2.5", "3e2"], "Points", "numbers"],
    [["1", "2024-01-02"], "Mixed", "status"],
    [
      ["ann@acme.test", "Bob <bob@acme.test>, cy@acme.test"],
      "Contacts",
      "people",
    ],
    [["Ann Lee", "Bob, Cy"], "Owner", "people"],
    [["Ann Lee"], "Assignees", "people"],
    [["Ann Lee"], "person", "people"],
    [["Ann Lee"], "Reviewer", "status"],
    [["Done", "Stuck", "done"], "Status", "status"],
    [many.slice(0, 30), "Tags", "status"],
    [many, "Tags", "text"],
    [["x".repeat(51)], "Notes", "text"],
    [["line\nbreak"], "Notes", "text"],
    [["007", "008"], "Codes", "status"],
    [["=SUM(A1:A2)", "4"], "Total", "text"],
    [["2024-01-02", "=TODAY()"], "Due", "text"],
    [["=Ann"], "Owner", "text"],
    [["-5", "+3"], "Delta", "numbers"],
  ];
  for (const [values, title, type] of cases)
    assert.equal(
      inferType(values, title),
      type,
      `${title}: ${JSON.stringify(values)}`,
    );
  assert.equal(
    inferType([`${"x".repeat(201)}`], "Owner"),
    "text",
    "not people when a name is too long",
  );
});

test("column_types overrides win by title, case-insensitively, and record their use", () => {
  const overrides = readOverrides({
    " due ": "text",
    "Status (subitem)": "people",
    Owner: "status",
  });
  const due = { title: "Due", cells: [[0, "2024-01-02"]] };
  assert.equal(columnType(due, overrides), "text");
  assert.equal(due.overridden, true);
  const sub = {
    title: "Status",
    keys: ["Status (subitem)", "Status"],
    cells: [[0, "Ann"]],
  };
  assert.equal(columnType(sub, overrides), "people");
  const plain = { title: "Points", cells: [[0, "4"]] };
  assert.equal(columnType(plain, overrides), "numbers");
  assert.equal(plain.overridden, false);
  assert.deepEqual(
    [...overrides.values()].map(({ title, used }) => [title, used]),
    [
      [" due ", true],
      ["Status (subitem)", true],
      ["Owner", false],
    ],
  );
  assert.equal(readOverrides(undefined).size, 0);
});

/** Converts one typed column of `cells` over `count` items. */
function convert(
  column,
  { count = 3, users = new Map(), maxUsers = 100 } = {},
) {
  const items = Array.from({ length: count }, () => ({ values: {} }));
  const warnings = [];
  const ctx = {
    path: "workspaces[0].boards[0]",
    users,
    maxUsers,
    warn: (path, code, message) => warnings.push({ code, message, path }),
  };
  const [out] = convertColumns(
    [{ source_id: "c1", title: "Column", fills: new Map(), ...column }],
    items,
    ctx,
  );
  return { out, values: items.map((item) => item.values.c1), warnings, users };
}

test("status columns list their labels with fill, known or palette colors", () => {
  const fills = new Map([["stuck", "#e2445c"]]);
  const { out, values, warnings } = convert({
    type: "status",
    fills,
    cells: [
      [0, "Done"],
      [1, "Stuck"],
      [2, "done"],
    ],
  });
  assert.deepEqual(out, {
    source_id: "c1",
    title: "Column",
    type: "status",
    labels: [
      { label: "Done", color: "#00c875" },
      { label: "Stuck", color: "#df2f4a" },
    ],
  });
  assert.deepEqual(
    values,
    ["Done", "Stuck", "done"],
    "the snapshot maps case to labels",
  );
  assert.deepEqual(warnings, []);
  const palette = convert({
    type: "status",
    cells: [
      [0, "Alpha"],
      [1, "Beta"],
    ],
  });
  assert.deepEqual(
    palette.out.labels.map((l) => l.color),
    ["#579bfc", "#a25ddc"],
  );
});

test("a status column with more labels than Worklane keeps becomes text", () => {
  const cells = Array.from({ length: MAX_LABELS + 1 }, (_, i) => [i, `L${i}`]);
  const { out, values, warnings } = convert(
    { type: "status", cells },
    { count: cells.length },
  );
  assert.equal(out.type, "text");
  assert.equal(out.labels, undefined);
  assert.equal(values[7], "L7");
  assert.deepEqual(
    warnings.map((w) => [w.code, w.path]),
    [["too_many_labels", "workspaces[0].boards[0].columns[0]"]],
  );
});

test("people cells become user IDs and join the snapshot's users", () => {
  const users = new Map([
    [
      "name:ann lee",
      { source_id: "name:ann lee", name: "Ann Lee", email: null },
    ],
  ]);
  const { out, values, warnings } = convert(
    {
      type: "people",
      cells: [
        [0, "Ann Lee, Bob <bob@acme.test>"],
        [1, "bob@acme.test; Ann Lee"],
        [2, `${"x".repeat(300)}, =HACK()`],
      ],
    },
    { users },
  );
  assert.equal(out.type, "people");
  assert.deepEqual(values, [
    ["name:ann lee", "email:bob@acme.test"],
    ["email:bob@acme.test", "name:ann lee"],
    undefined,
  ]);
  assert.deepEqual([...users.keys()], ["name:ann lee", "email:bob@acme.test"]);
  assert.equal(users.get("email:bob@acme.test").name, "Bob");
  assert.deepEqual(
    warnings.map((w) => w.code),
    ["invalid_person"],
  );
  assert.match(warnings[0].message, /^2 names in “Column” are not people/);
});

test("a spelled-out name replaces a bare email from an earlier column", () => {
  const bob = {
    source_id: "email:bob@acme.test",
    name: "bob@acme.test",
    email: "bob@acme.test",
  };
  const users = new Map([[bob.source_id, bob]]);
  const cells = [[0, "Bob Ray <bob@acme.test>"]];
  const { out, values } = convert(
    { type: "people", cells },
    { users, maxUsers: 1 },
  );
  assert.equal(
    out.type,
    "people",
    "a known person does not count against the limit",
  );
  assert.deepEqual(values[0], ["email:bob@acme.test"]);
  assert.equal(users.get("email:bob@acme.test").name, "Bob Ray");
  convert({ type: "people", cells: [[0, "bob@acme.test"]] }, { users });
  assert.equal(users.get("email:bob@acme.test").name, "Bob Ray", "and stays");
});

test("a people column that would exceed the user limit becomes text", () => {
  const users = new Map();
  const cells = [
    [0, "a@x.test"],
    [1, "b@x.test, c@x.test"],
  ];
  const { out, values, warnings } = convert(
    { type: "people", cells },
    { users, maxUsers: 2 },
  );
  assert.equal(out.type, "text");
  assert.deepEqual(values, ["a@x.test", "b@x.test, c@x.test", undefined]);
  assert.equal(users.size, 0, "no user is added");
  assert.deepEqual(
    warnings.map((w) => w.code),
    ["too_many_people"],
  );
});

test("numbers and dates convert; text the column cannot hold is passed on for validation", () => {
  const numbers = convert({
    type: "numbers",
    cells: [
      [0, "4.5"],
      [1, "007"],
      [2, "-1"],
    ],
  });
  assert.deepEqual(numbers.values, [4.5, "007", -1]);
  const dates = convert({
    type: "date",
    cells: [
      [0, "2024-03-05 10:00"],
      [1, "soon"],
      [2, "2024/01/02"],
    ],
  });
  assert.deepEqual(dates.values, ["2024-03-05", "soon", "2024-01-02"]);
  assert.deepEqual(
    dates.warnings.map((w) => w.code),
    ["time_dropped"],
  );
  const midnight = convert({
    type: "date",
    cells: [[0, "2024-03-05 00:00:00"]],
  });
  assert.deepEqual(midnight.warnings, [], "midnight loses nothing");
});

test("formula-looking values stay verbatim text and are reported once per column", () => {
  const { out, values, warnings } = convert({
    type: "text",
    cells: [
      [0, "=SUM(A1:A3)"],
      [1, "@ann"],
      [2, "plain"],
    ],
  });
  assert.equal(out.type, "text");
  assert.deepEqual(values, ["=SUM(A1:A3)", "@ann", "plain"]);
  assert.deepEqual(warnings, [
    {
      code: "formula_text",
      message:
        "2 values in “Column” look like spreadsheet formulas; they were kept as plain text and never evaluated",
      path: "workspaces[0].boards[0].columns[0]",
    },
  ]);
});
