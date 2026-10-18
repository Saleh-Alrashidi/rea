/**
 * A tiny dependency-free XLSX writer for the import tests (SPEC-4 §3.3,
 * §7): ZIP archives with stored or deflated parts, SpreadsheetML
 * workbooks (shared and inline strings, numbers, booleans, errors, dates
 * in the 1900 or 1904 system, formulas, rich text, fonts and fills), the
 * monday.com board export layout, and malicious archives (zip bombs, too
 * many entries, unsafe names, encryption, other compression methods,
 * overlapping entries, bad checksums, legacy OLE files, DOCTYPEs), and a
 * sample monday.com export (`sampleMondayExport`).
 *
 * Cells: a string (shared string, or inline with `inline: true`), a
 * number, a boolean, null (no cell), or an object: `{ date: "YYYY-MM-DD"
 * [+ " HH:MM:SS"] }`, `{ time: "HH:MM:SS" }`, `{ number, format }` (a
 * custom number format code), `{ text, fill, color }` (`#rrggbb` fill and
 * font colors), `{ formula, value? }`, `{ error }`, `{ inline }` or
 * `{ rich: [runs], phonetic }`. A null row is left out of the sheet.
 */
import { crc32, deflateRawSync } from "node:zlib";

const UTF8_NAMES = 0x800;
const DAY_MS = 86_400_000;
const NS =
  'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_RELS =
  "http://schemas.openxmlformats.org/package/2006/relationships";

const escapeXml = (text) =>
  String(text).replace(
    /[&<>"]/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char],
  );

// --------------------------------------------------------------------- zip

function localHeader({ name, flags, method, crc, packed, size }) {
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(20, 4);
  head.writeUInt16LE(flags, 6);
  head.writeUInt16LE(method, 8);
  head.writeUInt32LE(crc, 14);
  head.writeUInt32LE(packed.length, 18);
  head.writeUInt32LE(size, 22);
  head.writeUInt16LE(name.length, 26);
  return head;
}

function centralHeader({ name, flags, method, crc, packed, size }, offset) {
  const head = Buffer.alloc(46);
  head.writeUInt32LE(0x02014b50, 0);
  head.writeUInt16LE(20, 4);
  head.writeUInt16LE(20, 6);
  head.writeUInt16LE(flags, 8);
  head.writeUInt16LE(method, 10);
  head.writeUInt32LE(crc, 16);
  head.writeUInt32LE(packed.length, 20);
  head.writeUInt32LE(size, 24);
  head.writeUInt16LE(name.length, 28);
  head.writeUInt32LE(offset, 42);
  return head;
}

/**
 * A ZIP archive of `entries` `{ name, data, method = 8, flags, size,
 * crc, packed, sameAs }`: `size`, `crc` and `packed` (the stored bytes)
 * override the honest values, and `sameAs: n` makes the entry's directory
 * record point at entry n's data. `end` overrides end-record fields
 * (`{ disk, total, cdOffset }`).
 */
export function zip(entries, { end = {} } = {}) {
  const parts = [];
  const central = [];
  const offsets = [];
  let offset = 0;
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(entry.data ?? "", "utf8");
    const method = entry.method ?? 8;
    const record = {
      name: Buffer.from(entry.name, "utf8"),
      flags: (entry.flags ?? 0) | UTF8_NAMES,
      method,
      crc: entry.crc ?? crc32(data),
      packed: entry.packed ?? (method === 8 ? deflateRawSync(data) : data),
      size: entry.size ?? data.length,
    };
    const at = entry.sameAs === undefined ? offset : offsets[entry.sameAs];
    offsets.push(at);
    if (entry.sameAs === undefined) {
      parts.push(localHeader(record), record.name, record.packed);
      offset += 30 + record.name.length + record.packed.length;
    }
    central.push(centralHeader(record, at), record.name);
  }
  const directory = Buffer.concat(central);
  const tail = Buffer.alloc(22);
  tail.writeUInt32LE(0x06054b50, 0);
  tail.writeUInt16LE(end.disk ?? 0, 4);
  tail.writeUInt16LE(end.total ?? entries.length, 8);
  tail.writeUInt16LE(end.total ?? entries.length, 10);
  tail.writeUInt32LE(directory.length, 12);
  tail.writeUInt32LE(end.cdOffset ?? offset, 16);
  return Buffer.concat([...parts, directory, tail]);
}

// ---------------------------------------------------------------- workbook

/** The serial of a date ("YYYY-MM-DD[ HH:MM:SS]") or a time ("HH:MM:SS"). */
export function serialOf(text, { date1904 = false } = {}) {
  if (/^\d{2}:\d{2}:\d{2}$/.test(text)) {
    const [h, m, s] = text.split(":").map(Number);
    return (h * 3600 + m * 60 + s) / 86_400;
  }
  const [day, time = "00:00:00"] = text.split(" ");
  const [y, mo, d] = day.split("-").map(Number);
  const [h, mi, s] = time.split(":").map(Number);
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  return (Date.UTC(y, mo - 1, d, h, mi, s) - epoch) / DAY_MS;
}

const columnName = (index) => {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26))
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
};

/** Shared strings, styles (`xf` indexes by format, font and fill) and cells. */
function createBook({ date1904, inline }) {
  const strings = [];
  const stringIndex = new Map();
  const formats = [];
  const fonts = [null];
  const fills = [null, null];
  const xfs = [{ numFmtId: 0, font: 0, fill: 0 }];
  const xfIndex = new Map([["0|0|0", 0]]);
  const listIndex = (list, value) => {
    if (!value) return 0;
    const found = list.indexOf(value);
    if (found !== -1) return found;
    list.push(value);
    return list.length - 1;
  };
  const style = ({ numFmtId = 0, format, color, fill }) => {
    const id = format ? 164 + listIndex(formats, format) : numFmtId;
    const key = `${id}|${listIndex(fonts, color)}|${listIndex(fills, fill)}`;
    if (!xfIndex.has(key)) {
      const [, font, fillId] = key.split("|").map(Number);
      xfIndex.set(key, xfs.length);
      xfs.push({ numFmtId: id, font, fill: fillId });
    }
    return xfIndex.get(key);
  };
  const shared = (xml) => {
    if (!stringIndex.has(xml)) {
      stringIndex.set(xml, strings.length);
      strings.push(xml);
    }
    return stringIndex.get(xml);
  };
  return {
    date1904,
    inline,
    strings,
    formats,
    fonts,
    fills,
    xfs,
    style,
    shared,
  };
}

function stringCell(book, ref, text, attrs = "") {
  if (book.inline)
    return `<c r="${ref}" t="inlineStr"${attrs}><is><t>${escapeXml(text)}</t></is></c>`;
  const index = book.shared(`<t xml:space="preserve">${escapeXml(text)}</t>`);
  return `<c r="${ref}" t="s"${attrs}><v>${index}</v></c>`;
}

function objectCell(book, ref, cell) {
  const s = (options) => ` s="${book.style(options)}"`;
  if (cell.date !== undefined) {
    const numFmtId = cell.date.includes(" ") ? 22 : 14;
    const serial = serialOf(cell.date, book);
    return `<c r="${ref}"${s({ numFmtId })}><v>${serial}</v></c>`;
  }
  if (cell.time !== undefined)
    return `<c r="${ref}"${s({ numFmtId: 21 })}><v>${serialOf(cell.time)}</v></c>`;
  if (cell.number !== undefined)
    return `<c r="${ref}"${s({ format: cell.format })}><v>${cell.number}</v></c>`;
  if (cell.formula !== undefined) {
    const value = cell.value === undefined ? "" : `<v>${cell.value}</v>`;
    return `<c r="${ref}"><f>${escapeXml(cell.formula)}</f>${value}</c>`;
  }
  if (cell.error !== undefined)
    return `<c r="${ref}" t="e"><v>${escapeXml(cell.error)}</v></c>`;
  if (cell.inline !== undefined)
    return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(cell.inline)}</t></is></c>`;
  if (cell.rich !== undefined) {
    const runs = cell.rich.map((run) => `<r><t>${escapeXml(run)}</t></r>`);
    const phonetic = cell.phonetic
      ? `<rPh sb="0" eb="1"><t>${escapeXml(cell.phonetic)}</t></rPh>`
      : "";
    const index = book.shared(`${runs.join("")}${phonetic}`);
    return `<c r="${ref}" t="s"><v>${index}</v></c>`;
  }
  return stringCell(
    book,
    ref,
    cell.text,
    s({ color: cell.color, fill: cell.fill }),
  );
}

function cellXml(book, ref, cell) {
  if (cell === null || cell === undefined) return "";
  if (typeof cell === "string") return stringCell(book, ref, cell);
  if (typeof cell === "number") return `<c r="${ref}"><v>${cell}</v></c>`;
  if (typeof cell === "boolean")
    return `<c r="${ref}" t="b"><v>${cell ? 1 : 0}</v></c>`;
  return objectCell(book, ref, cell);
}

function sheetXml(book, rows) {
  const body = rows.map((cells, index) => {
    if (cells === null) return "";
    const xml = cells.map((cell, col) =>
      cellXml(book, `${columnName(col)}${index + 1}`, cell),
    );
    return `<row r="${index + 1}">${xml.join("")}</row>`;
  });
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet ${NS}><sheetData>${body.join("")}</sheetData></worksheet>`;
}

const argb = (color) => `FF${color.slice(1).toUpperCase()}`;

function stylesXml(book) {
  const formats = book.formats.map(
    (code, index) =>
      `<numFmt numFmtId="${164 + index}" formatCode="${escapeXml(code)}"/>`,
  );
  const fonts = book.fonts.map((color) =>
    color ? `<font><color rgb="${argb(color)}"/></font>` : "<font/>",
  );
  const fills = book.fills.map((color, index) =>
    color
      ? `<fill><patternFill patternType="solid"><fgColor rgb="${argb(color)}"/></patternFill></fill>`
      : `<fill><patternFill patternType="${index === 0 ? "none" : "gray125"}"/></fill>`,
  );
  const xfs = book.xfs.map(
    (xf) =>
      `<xf numFmtId="${xf.numFmtId}" fontId="${xf.font}" fillId="${xf.fill}"/>`,
  );
  return [
    `<?xml version="1.0" encoding="UTF-8"?><styleSheet ${NS}>`,
    `<numFmts count="${formats.length}">${formats.join("")}</numFmts>`,
    `<fonts>${fonts.join("")}</fonts><fills>${fills.join("")}</fills>`,
    '<cellStyleXfs><xf numFmtId="14"/></cellStyleXfs>',
    `<cellXfs>${xfs.join("")}</cellXfs>`,
    '<dxfs><dxf><font><color rgb="FFFF0000"/></font></dxf></dxfs>',
    "</styleSheet>",
  ].join("");
}

/**
 * The parts of a workbook (`{ name, data }` ZIP entries): `sheets` `[{
 * name, rows, state }]`, the 1904 date system, inline strings.
 */
export function workbookParts({ sheets, date1904 = false, inline = false }) {
  const book = createBook({ date1904, inline });
  const sheetParts = sheets.map((sheet, index) => ({
    name: `xl/worksheets/sheet${index + 1}.xml`,
    data: sheetXml(book, sheet.rows),
  }));
  const sheetList = sheets.map(
    (sheet, index) =>
      `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}"${sheet.state ? ` state="${sheet.state}"` : ""} r:id="rId${index + 1}"/>`,
  );
  const rels = sheets.map(
    (_, index) =>
      `<Relationship Id="rId${index + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
  );
  const n = sheets.length;
  rels.push(
    `<Relationship Id="rId${n + 1}" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>`,
    `<Relationship Id="rId${n + 2}" Type="${REL}/styles" Target="/xl/styles.xml"/>`,
    `<Relationship Id="rId${n + 3}" Type="${REL}/hyperlink" Target="https://example.test/" TargetMode="External"/>`,
  );
  const strings = book.strings.map((xml) => `<si>${xml}</si>`).join("");
  return [
    {
      name: "[Content_Types].xml",
      data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0"?><Relationships xmlns="${PACKAGE_RELS}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: "xl/workbook.xml",
      data: `<?xml version="1.0"?><workbook ${NS}><workbookPr${date1904 ? ' date1904="1"' : ""}/><sheets>${sheetList.join("")}</sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `<?xml version="1.0"?><Relationships xmlns="${PACKAGE_RELS}">${rels.join("")}</Relationships>`,
    },
    ...sheetParts,
    {
      name: "xl/sharedStrings.xml",
      data: `<?xml version="1.0"?><sst ${NS} count="${book.strings.length}">${strings}</sst>`,
    },
    { name: "xl/styles.xml", data: stylesXml(book) },
  ];
}

/** A workbook (see `workbookParts`) as .xlsx bytes. */
export const workbook = (options) => zip(workbookParts(options));

/** A workbook of one sheet "Sheet1" with `rows`. */
export const sheetWorkbook = (rows, options = {}) =>
  workbook({ ...options, sheets: [{ name: "Sheet1", rows }] });

// ------------------------------------------------------- monday export

/**
 * The rows of a monday.com board export: the title (and description) row,
 * a blank row, then per group `{ title, color, header, items: [{ cells,
 * subitems?: { header, rows } }] }` a title row in the group color, the
 * header, item rows and subitem sections one column in, and a blank row.
 */
export function mondayRows({ title, description = null, groups }) {
  const rows = [[title]];
  if (description) rows.push([description]);
  rows.push(null);
  for (const group of groups) {
    rows.push([{ text: group.title, color: group.color }], group.header);
    for (const item of group.items) {
      rows.push(item.cells);
      if (!item.subitems) continue;
      rows.push(["", ...item.subitems.header]);
      for (const sub of item.subitems.rows) rows.push(["", ...sub]);
    }
    rows.push(null);
  }
  return rows;
}

const ROADMAP_HEADER = [
  "Name",
  "Subitems",
  "Owner",
  "Status",
  "Due",
  "Estimate",
];
const done = { text: "Done", fill: "#00c875" };

/**
 * A sample monday.com board export: two groups with colors, status fills,
 * people, dates (1904 system by default), a name-only item, subitems with
 * a column of another type ("Due" text) and formula-looking notes, and an
 * empty group.
 */
export function sampleMondayExport({ date1904 = true } = {}) {
  const launch = {
    cells: [
      "Launch site",
      "Copy, Assets",
      "Sam Lee <sam@example.test>",
      done,
      { date: "2026-03-05" },
      3,
    ],
    subitems: {
      header: ["Subitems", "Owner", "Status", "Due", "Notes"],
      rows: [
        [
          "Copy",
          "noa@example.test",
          { text: "Stuck", fill: "#e2445c" },
          "Friday",
          "=1+1",
        ],
        ["Assets", "", done, "next week", "@design"],
      ],
    },
  };
  const pricing = {
    cells: [
      "Pricing page",
      "",
      "",
      { text: "Working on it", fill: "#fdab3d" },
      { date: "2026-04-01 10:30:00" },
      2.5,
    ],
  };
  const groups = [
    {
      title: "This quarter",
      color: "#037f4c",
      items: [launch, pricing, { cells: ["Name only"] }],
    },
    {
      title: "Later",
      color: "#784bd1",
      items: [{ cells: ["Hiring plan", "", "Priya", done] }],
    },
    { title: "Empty group", color: null, items: [] },
  ].map((group) => ({ ...group, header: ROADMAP_HEADER }));
  const rows = mondayRows({
    title: "Product roadmap",
    description: "What ships when",
    groups,
  });
  return workbook({ sheets: [{ name: "Product roadmap", rows }], date1904 });
}

// ------------------------------------------------------------- malicious

const small = () =>
  workbookParts({ sheets: [{ name: "S", rows: [["Name"], ["A"]] }] });

/** Archives the reader must refuse, by name. */
export const malicious = Object.freeze({
  /** A sheet that inflates far beyond the size its directory declares. */
  zipBomb: () =>
    zip(
      small().map((part) =>
        part.name.endsWith("sheet1.xml")
          ? { ...part, data: Buffer.alloc(8 * 1024 * 1024, 0x20), size: 1024 }
          : part,
      ),
    ),
  /** Parts whose declared sizes add up to more than 100 MiB. */
  declaredBomb: () =>
    zip([
      ...small(),
      { name: "xl/media/a.bin", data: "x", size: 60 * 1024 * 1024 },
      { name: "xl/media/b.bin", data: "x", size: 60 * 1024 * 1024 },
    ]),
  tooManyEntries: (count = 2_001) =>
    zip(
      Array.from({ length: count }, (_, i) => ({
        name: `xl/media/${i}.txt`,
        data: "",
        method: 0,
      })),
    ),
  /** A valid workbook plus one part named `name`. */
  named: (name) => zip([...small(), { name, data: "x", method: 0 }]),
  /** The sheet part with `flags` (1 = encrypted) or another `method`. */
  sheetPart: (override) =>
    zip(
      small().map((part) =>
        part.name.endsWith("sheet1.xml") ? { ...part, ...override } : part,
      ),
    ),
  /** Two directory records for the same data. */
  overlapping: () =>
    zip([...small(), { name: "xl/copy.xml", data: "x", sameAs: 0 }]),
  /** A legacy (or password-protected) OLE compound file. */
  ole: () =>
    Buffer.concat([Buffer.from("d0cf11e0a1b11ae1", "hex"), Buffer.alloc(512)]),
  /** The workbook part with a DOCTYPE declaring entities. */
  doctype: () =>
    zip(
      small().map((part) =>
        part.name === "xl/workbook.xml"
          ? {
              ...part,
              data: `<?xml version="1.0"?><!DOCTYPE lol [<!ENTITY lol "lol">]><workbook ${NS}/>`,
            }
          : part,
      ),
    ),
});
