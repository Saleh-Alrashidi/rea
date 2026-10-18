/**
 * The dependency-free .xlsx reader (SPEC-4 §3.3, `server/import/xlsx.js`)
 * over workbooks built by `fixtures/import/make-xlsx.js`: cell types,
 * strings, dates in both date systems, formulas, styles, sparse rows and
 * limits, and every archive it must refuse (zip bombs, too many entries,
 * unsafe names, encryption, other compression, overlapping entries, bad
 * checksums, OLE files, DOCTYPEs, damaged directories), and how the file
 * connector reads workbooks that are not a monday.com board export
 * (`import-files.test.js` has the export layout).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { scan } from "../server/import/connectors/files.js";
import { validateSnapshot } from "../server/import/snapshot.js";
import {
  XLSX_LIMITS,
  openZip,
  readXlsx,
  walkXml,
} from "../server/import/xlsx.js";
import {
  malicious,
  mondayRows,
  sheetWorkbook,
  workbook,
  workbookParts,
  zip,
} from "./fixtures/import/make-xlsx.js";

const rejects = (bytes, code, pattern, options) =>
  assert.throws(
    () => readXlsx(bytes, options),
    (error) => error.code === code && (!pattern || pattern.test(error.message)),
  );

test("reads strings, numbers, booleans, errors and inline strings from the first sheet", () => {
  const bytes = sheetWorkbook([
    ["Name", "Count", "Done", "Check", "Ratio"],
    ["Alpha & <Beta>", 3, true, { error: "#N/A" }, 0.1 + 0.2],
    [{ inline: "Inline “text”" }, -12.5, false, "", 1e21],
    [
      { rich: ["Rich ", "runs"], phonetic: "ふりがな" },
      { number: 0.25, format: "0%" },
    ],
  ]);
  const book = readXlsx(bytes);
  assert.deepEqual(book.rows, [
    ["Name", "Count", "Done", "Check", "Ratio"],
    ["Alpha & <Beta>", "3", "TRUE", "#N/A", "0.3"],
    ["Inline “text”", "-12.5", "FALSE", "", "1e+21"],
    ["Rich runs", "0.25"],
  ]);
  assert.equal(book.sheet, "Sheet1");
  assert.equal(book.sheets, 1);
  assert.equal(book.formulas, 0);
  assert.equal(book.truncated, false);
  const inline = readXlsx(
    sheetWorkbook([["Only", "inline"]], { inline: true }),
  );
  assert.deepEqual(inline.rows, [["Only", "inline"]]);
});

test("dates use the workbook's 1900 or 1904 date system and its number formats", () => {
  const rows = [
    [
      { date: "2024-03-05" },
      { date: "2024-03-05 10:30:00" },
      { time: "18:15:00" },
      { number: 45356, format: "dd/mm/yyyy" },
      { number: 45356.75, format: 'yyyy-mm-dd h:mm "at" AM/PM' },
      { number: 0.5, format: "[h]:mm:ss" },
      { number: 45356, format: "[Red]#,##0" },
    ],
  ];
  const book1900 = readXlsx(sheetWorkbook(rows));
  assert.deepEqual(book1900.rows[0], [
    "2024-03-05",
    "2024-03-05 10:30:00",
    "18:15:00",
    "2024-03-05",
    "2024-03-05 18:00:00",
    "12:00:00",
    "45356",
  ]);
  const book1904 = readXlsx(
    sheetWorkbook(
      rows.slice(0, 1).map((r) => r.slice(0, 3)),
      { date1904: true },
    ),
  );
  assert.deepEqual(book1904.rows[0], [
    "2024-03-05",
    "2024-03-05 10:30:00",
    "18:15:00",
  ]);
  // The same serial means a different day in the 1904 system.
  const shifted = readXlsx(
    sheetWorkbook([[{ number: 45356, format: "yyyy-mm-dd" }]], {
      date1904: true,
    }),
  );
  assert.deepEqual(shifted.rows, [["2028-03-06"]]);
});

test("formulas are never evaluated: cached values, else the formula text", () => {
  const book = readXlsx(
    sheetWorkbook([
      ["Total", { formula: "SUM(B2:B3)", value: 6 }],
      ["Pending", { formula: 'HYPERLINK("http://x.test","x")' }],
      ["Text", "=1+1"],
    ]),
  );
  assert.deepEqual(book.rows, [
    ["Total", "6"],
    ["Pending", '=HYPERLINK("http://x.test","x")'],
    ["Text", "=1+1"],
  ]);
  assert.equal(book.formulas, 2);
});

test("escapes, entities, CDATA and character references are decoded", () => {
  const parts = workbookParts({ sheets: [{ name: "S", rows: [["x"]] }] }).map(
    (part) =>
      part.name === "xl/sharedStrings.xml"
        ? {
            ...part,
            data: "<sst><si><t>Line_x000D_\nTwo &#169; &#x1F600; &amp;amp;</t></si><si><t><![CDATA[<raw> & ]]></t></si><si><t>_x005F_x0041_</t></si></sst>",
          }
        : part.name.endsWith("sheet1.xml")
          ? {
              ...part,
              data: '<x:worksheet xmlns:x="urn:x"><x:sheetData><x:row r="1"><x:c r="A1" t="s"><x:v>0</x:v></x:c><x:c r="B1" t="s"><x:v>1</x:v></x:c><x:c r="C1" t="s"><x:v>2</x:v></x:c></x:row></x:sheetData></x:worksheet>',
            }
          : part,
  );
  assert.deepEqual(readXlsx(zip(parts)).rows, [
    ["Line\r\nTwo © 😀 &amp;", "<raw> & ", "_x0041_"],
  ]);
});

test("sparse cells are padded, runs of blank or missing rows become one blank row", () => {
  const rows = [
    null,
    null,
    ["Title"],
    null,
    null,
    [null, null, "C"],
    ["", ""],
    ["A", null, null, "D"],
  ];
  const book = readXlsx(sheetWorkbook(rows));
  assert.deepEqual(book.rows, [
    ["Title"],
    [],
    ["", "", "C"],
    [],
    ["A", "", "", "D"],
  ]);
});

test("font and fill colors are reported per row and column", () => {
  const book = readXlsx(
    sheetWorkbook([
      [{ text: "Group", color: "#037f4c" }],
      [
        "Item",
        { text: "Done", fill: "#00C875" },
        { text: "Both", fill: "#ff0000", color: "#0000ff" },
      ],
    ]),
  );
  assert.deepEqual(
    [...book.colors],
    [
      ["0:0", { font: "#037f4c", fill: null }],
      ["1:1", { font: null, fill: "#00c875" }],
      ["1:2", { font: "#0000ff", fill: "#ff0000" }],
    ],
  );
});

test("the first visible sheet is read; the others are only counted", () => {
  const bytes = workbook({
    sheets: [
      { name: "Hidden", state: "hidden", rows: [["secret"]] },
      { name: "Board", rows: [["visible"]] },
      { name: "More", rows: [["other"]] },
    ],
  });
  const book = readXlsx(bytes);
  assert.equal(book.sheet, "Board");
  assert.equal(book.sheets, 3);
  assert.deepEqual(book.rows, [["visible"]]);
});

test("rows past the row limit stop the read and columns past the limit are dropped", () => {
  const rows = Array.from({ length: 30 }, (_, i) => [
    `Row ${i}`,
    ...Array(XLSX_LIMITS.columns).fill("v"),
    "far",
  ]);
  const book = readXlsx(sheetWorkbook(rows), { limits: { rows: 10 } });
  assert.equal(book.rows.length, 10);
  assert.equal(book.truncated, true);
  assert.ok(book.rows.every((row) => row.length === XLSX_LIMITS.columns));
  assert.equal(
    book.droppedCells,
    20,
    "two cells past the limit in each row read",
  );
  // Limits can only be lowered.
  const capped = readXlsx(sheetWorkbook([["a", "b", "c"]]), {
    limits: { columns: 2, rows: 10 ** 9 },
  });
  assert.deepEqual(capped.rows, [["a", "b"]]);
  assert.deepEqual(XLSX_LIMITS, {
    bytes: 20 * 1024 * 1024,
    entries: 2_000,
    totalBytes: 100 * 1024 * 1024,
    rows: 120_000,
    columns: 200,
  });
});

test("reading checks the abort signal between parts", () => {
  const controller = new AbortController();
  controller.abort();
  rejects(sheetWorkbook([["a"]]), "ABORTED", null, {
    signal: controller.signal,
  });
});

test("stored (uncompressed) parts are read like deflated ones", () => {
  const parts = workbookParts({
    sheets: [{ name: "S", rows: [["Stored", 1]] }],
  });
  const stored = parts.map((part) => ({ ...part, method: 0 }));
  assert.deepEqual(readXlsx(zip(stored)).rows, [["Stored", "1"]]);
});

test("zip bombs are refused before or while inflating", () => {
  rejects(
    malicious.zipBomb(),
    "XLSX_TOO_LARGE",
    /expands beyond its declared size/,
  );
  rejects(
    malicious.declaredBomb(),
    "XLSX_TOO_LARGE",
    /more than 104857600 bytes/,
  );
  rejects(sheetWorkbook([["a"]]), "XLSX_TOO_LARGE", /more than 1000 bytes/, {
    limits: { totalBytes: 1000 },
  });
});

test("archives with too many entries are refused from the directory", () => {
  rejects(malicious.tooManyEntries(), "XLSX_TOO_LARGE", /more than 2000 parts/);
  const fine = malicious.tooManyEntries(2_000);
  rejects(fine, "INVALID_XLSX", /no workbook/);
});

test("unsafe part names are refused (traversal, absolute, drive, backslash, control)", () => {
  for (const name of [
    "../evil.xml",
    "xl/../../evil.xml",
    "/etc/passwd",
    "C:/evil.xml",
    "xl\\..\\evil.xml",
    "xl/./sheet.xml",
    "xl//sheet.xml",
    "xl/evil\u0000.xml",
    "xl/evil\n.xml",
    "a".repeat(513),
  ])
    rejects(malicious.named(name), "INVALID_XLSX", /unsafe file name/);
  // A directory entry and an ordinary nested name are fine.
  assert.ok(readXlsx(malicious.named("xl/media/")).rows.length > 0);
  assert.ok(readXlsx(malicious.named("xl/media/image 1.png")).rows.length > 0);
  rejects(
    malicious.named("XL/WORKBOOK.XML"),
    "INVALID_XLSX",
    /lists a part twice/,
  );
});

test("encryption, other compression methods and legacy OLE files are UNSUPPORTED_XLSX", () => {
  rejects(malicious.sheetPart({ flags: 1 }), "UNSUPPORTED_XLSX", /Encrypted/);
  rejects(
    malicious.sheetPart({ flags: 0x40 }),
    "UNSUPPORTED_XLSX",
    /Encrypted/,
  );
  for (const method of [1, 9, 12, 14, 93, 99])
    rejects(
      malicious.sheetPart({ method, packed: Buffer.from("xx") }),
      "UNSUPPORTED_XLSX",
      /stored or deflated/,
    );
  rejects(malicious.ole(), "UNSUPPORTED_XLSX", /password-protected/);
  rejects(
    zip(workbookParts({ sheets: [{ name: "S", rows: [] }] }), {
      end: { disk: 1 },
    }),
    "UNSUPPORTED_XLSX",
    /Multi-part/,
  );
  rejects(
    zip(workbookParts({ sheets: [{ name: "S", rows: [] }] }), {
      end: { cdOffset: 0xffffffff },
    }),
    "UNSUPPORTED_XLSX",
    /ZIP64/,
  );
  rejects(
    malicious.sheetPart({ size: 0xffffffff }),
    "UNSUPPORTED_XLSX",
    /ZIP64/,
  );
});

test("overlapping entries, bad checksums and damaged archives are INVALID_XLSX", () => {
  rejects(malicious.overlapping(), "INVALID_XLSX", /overlap/);
  rejects(malicious.sheetPart({ crc: 1234 }), "INVALID_XLSX", /checksum/);
  rejects(
    malicious.sheetPart({ size: 5 }),
    "XLSX_TOO_LARGE",
    /beyond its declared size/,
  );
  rejects(
    malicious.sheetPart({ packed: Buffer.from([0xff, 0xff, 0xff]) }),
    "INVALID_XLSX",
    /damaged/,
  );
  rejects(
    malicious.sheetPart({ method: 0, packed: Buffer.from("abc") }),
    "INVALID_XLSX",
    /damaged/,
  );
  rejects(
    Buffer.from("Name,Due\nA,2026-01-01\n"),
    "INVALID_XLSX",
    /not an \.xlsx/,
  );
  rejects(Buffer.from("PK"), "INVALID_XLSX", /not an \.xlsx/);
  const bytes = sheetWorkbook([["a"]]);
  rejects(
    bytes.subarray(0, bytes.length - 30),
    "INVALID_XLSX",
    /not an \.xlsx/,
  );
  const directory = bytes.readUInt32LE(bytes.length - 6);
  const broken = Buffer.from(bytes);
  broken.writeUInt32LE(0, directory);
  rejects(broken, "INVALID_XLSX", /directory is damaged/);
  const local = Buffer.from(bytes);
  local.writeUInt32LE(0, 0);
  rejects(local, "INVALID_XLSX", /ZIP data is damaged/);
});

test("XML with a DOCTYPE or broken tags is refused; missing parts are reported", () => {
  rejects(malicious.doctype(), "INVALID_XLSX", /DOCTYPE/);
  assert.throws(() => walkXml("<a><b attr=unquoted></a>", {}), {
    code: "INVALID_XLSX",
  });
  assert.throws(() => walkXml("<a><!-- open", {}), { code: "INVALID_XLSX" });
  const parts = workbookParts({ sheets: [{ name: "S", rows: [["x"]] }] });
  const without = (name) => zip(parts.filter((part) => part.name !== name));
  rejects(
    without("xl/worksheets/sheet1.xml"),
    "INVALID_XLSX",
    /first sheet is missing/,
  );
  rejects(without("xl/workbook.xml"), "INVALID_XLSX", /no workbook/);
  // Without the package relationships the default workbook path is used.
  assert.deepEqual(readXlsx(without("_rels/.rels")).rows, [["x"]]);
  const escape = parts.map((part) =>
    part.name === "xl/_rels/workbook.xml.rels"
      ? {
          ...part,
          data: part.data.replace("worksheets/sheet1.xml", "../../sheet1.xml"),
        }
      : part,
  );
  rejects(zip(escape), "INVALID_XLSX", /leaves the package/);
  const badIndex = parts.map((part) =>
    part.name === "xl/sharedStrings.xml"
      ? { ...part, data: "<sst></sst>" }
      : part,
  );
  rejects(zip(badIndex), "INVALID_XLSX", /shared string/);
});

test("openZip refuses files over the byte limit and reads parts case-insensitively", () => {
  const bytes = sheetWorkbook([["a"]]);
  assert.throws(() => openZip(bytes, { ...XLSX_LIMITS, bytes: 100 }), {
    code: "XLSX_TOO_LARGE",
  });
  const archive = openZip(new Uint8Array(bytes));
  assert.match(archive.text("XL/Workbook.xml"), /<workbook/);
  assert.equal(archive.text("xl/missing.xml"), null);
});

// ------------------------------------------------- through the connector

const xlsxFile = (bytes, name = "Roadmap.xlsx") => ({
  name,
  kind: "xlsx",
  bytes,
});
const codes = (snapshot) => snapshot.warnings.map((w) => w.code);

/** Scans `file`; the snapshot must validate without new warnings. */
async function scanned(file) {
  const snapshot = await scan({ file });
  const checked = validateSnapshot(snapshot);
  assert.ok(checked.ok, JSON.stringify(checked.errors));
  assert.deepEqual(checked.snapshot.warnings, snapshot.warnings);
  return { snapshot, board: snapshot.workspaces[0].boards[0] };
}

test("other workbooks are read as a table from the first sheet", async () => {
  const bytes = workbook({
    sheets: [
      {
        name: "Budget",
        rows: [
          ["Item", "Cost", "Paid on", "Total"],
          [
            "Laptop",
            1200.5,
            { date: "2026-02-01" },
            { formula: "B2*1", value: 1200.5 },
          ],
          null,
          ["Desk", 300, null, { formula: "B4*1" }],
        ],
      },
      { name: "Notes", rows: [["ignored"]] },
    ],
  });
  const { board, snapshot } = await scanned(xlsxFile(bytes, "budget.xlsx"));
  assert.equal(snapshot.source_label, "Excel workbook budget.xlsx");
  assert.equal(board.name, "budget");
  assert.deepEqual(
    board.columns.map((c) => [c.title, c.type]),
    [
      ["Cost", "numbers"],
      ["Paid on", "date"],
      ["Total", "text"],
    ],
  );
  assert.deepEqual(
    board.items.map((i) => [i.name, i.values]),
    [
      ["Laptop", { c1: 1200.5, c2: "2026-02-01", c3: "1200.5" }],
      ["Desk", { c1: 300, c3: "=B4*1" }],
    ],
  );
  assert.deepEqual(codes(snapshot), [
    "other_sheets",
    "formula_values",
    "formula_text",
  ]);
  assert.equal(
    snapshot.warnings[0].message,
    "Only the first sheet “Budget” was imported; 1 other sheets were left out",
  );
});

test("a monday export past 500 groups joins the rest into the last group", async () => {
  const groups = Array.from({ length: 502 }, (_, i) => ({
    title: `G${i}`,
    color: null,
    header: ["Name", "N"],
    items: [{ cells: [`I${i}`, i] }],
  }));
  const { board, snapshot } = await scanned(
    xlsxFile(sheetWorkbook(mondayRows({ title: "Many", groups }))),
  );
  assert.equal(board.groups.length, 500);
  assert.equal(board.items.at(-1).group_source_id, "g500");
  assert.deepEqual(codes(snapshot), ["too_many_groups"]);
  assert.match(
    snapshot.warnings[0].message,
    /2 more groups joined the last one/,
  );
});
