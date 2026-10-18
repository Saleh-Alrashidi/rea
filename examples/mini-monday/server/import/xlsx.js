/**
 * A dependency-free `.xlsx` reader for imports (SPEC-4 §3.3).
 *
 * ZIP: the archive is read from its central directory only. It must be a
 * single-disk, non-ZIP64 archive of at most XLSX_LIMITS.entries entries
 * with safe, distinct names (no absolute paths, `..`, backslashes, drive
 * letters or control characters), stored or deflated (no encryption),
 * whose local data ranges neither overlap nor run into the directory.
 * Declared sizes may total at most XLSX_LIMITS.totalBytes; each part is
 * inflated with `inflateRawSync({ maxOutputLength })` set to its declared
 * size and must match that size and its CRC-32. Legacy or
 * password-protected workbooks (OLE files) are UNSUPPORTED_XLSX.
 *
 * XML: the small event reader of `xml.js` (no DOCTYPE, so nothing can
 * declare entities).
 *
 * Workbook: the first visible sheet of `xl/workbook.xml` (found through
 * the package relationships), shared and inline strings (rich text runs
 * joined, phonetic runs skipped, `_xHHHH_` escapes decoded), booleans,
 * errors, and numbers (15 significant digits, as Excel shows them).
 * Numbers in date or time formats become "YYYY-MM-DD", "YYYY-MM-DD
 * HH:MM:SS" or "HH:MM:SS" text in the workbook's 1900 or 1904 date
 * system (`serialText` in `csv.js`, which owns the text `dateOf` reads). Formulas are never evaluated: a cell keeps its last calculated
 * value, or the formula text ("=…") when the file has none.
 *
 * `readXlsx(bytes, { limits, signal })` → `{ sheet, sheets, rows,
 * colors, formulas, truncated, droppedCells }`: `rows` are arrays of cell
 * texts (at most `limits.columns` cells, "" when empty) in sheet order,
 * with each run of blank or missing rows as one empty row; `colors` maps
 * "row:column" to the cell's `{ font, fill }` RGB colors (`#rrggbb`) when
 * it has any; `truncated` says rows past `limits.rows` were not read.
 * Failures are ImportError INVALID_XLSX, UNSUPPORTED_XLSX, XLSX_TOO_LARGE
 * or ABORTED. `readXlsxSteps` is the same reader as a generator that
 * yields every TAGS_PER_STEP tags of the shared strings and the sheet
 * (`slices.js`); unpacking the ZIP parts is not sliced.
 */
import { crc32, inflateRawSync } from "node:zlib";
import { numberText, serialText } from "./csv.js";
import { ImportError } from "./engine.js";
import { drain, throwIfAborted } from "./slices.js";
import { walkXml, walkXmlSteps } from "./xml.js";

export const XLSX_LIMITS = Object.freeze({
  bytes: 20 * 1024 * 1024,
  entries: 2_000,
  totalBytes: 100 * 1024 * 1024,
  // Non-blank rows read from the sheet.
  rows: 120_000,
  columns: 200,
});
const SIGNATURE = Object.freeze({
  end: 0x06054b50,
  central: 0x02014b50,
  local: 0x04034b50,
  ole: 0xe011cfd0,
});
const END_SIZE = 22;
const MAX_COMMENT = 0xffff;
const MAX_NAME = 512;
const UNSAFE_NAME = /[\p{Cc}\\:*?"<>|]/u;
const UTF8_NAMES = 0x800;
const ENCRYPTED = 0x41;
// Built-in number formats (ECMA-376 §18.8.30, with the East Asian ones).
const BUILTIN_DATES = new Set([
  14, 15, 16, 17, 22, 27, 28, 29, 30, 31, 36, 50, 51, 52, 53, 54, 55, 56, 57,
  58,
]);
const BUILTIN_TIMES = new Set([18, 19, 20, 21, 32, 33, 34, 35, 45, 46, 47]);
const ESCAPE = /_x([\da-f]{4})_/gi;
const CELL_REF = /^([A-Z]{1,3})(\d*)$/;
const HIDDEN = new Set(["hidden", "veryHidden"]);

const OLE_MESSAGE =
  "Legacy .xls and password-protected workbooks are not supported; save it as an unprotected .xlsx";

const invalid = (message) => new ImportError("INVALID_XLSX", message);
const unsupported = (message) => new ImportError("UNSUPPORTED_XLSX", message);
const tooLarge = (message) => new ImportError("XLSX_TOO_LARGE", message);

// --------------------------------------------------------------------- zip

function findEnd(buf) {
  const lowest = Math.max(0, buf.length - END_SIZE - MAX_COMMENT);
  for (let at = buf.length - END_SIZE; at >= lowest; at -= 1) {
    const fits = buf.readUInt16LE(at + 20) === buf.length - at - END_SIZE;
    if (buf.readUInt32LE(at) === SIGNATURE.end && fits) return at;
  }
  throw invalid("The file is not an .xlsx workbook (no ZIP directory)");
}

const safeName = (name) =>
  name !== "" &&
  name.length <= MAX_NAME &&
  !UNSAFE_NAME.test(name) &&
  !name.startsWith("/") &&
  name
    .replace(/\/$/, "")
    .split("/")
    .every((part) => part !== "" && part !== "." && part !== "..");

function readEntry(buf, at, cdEnd) {
  if (at + 46 > cdEnd || buf.readUInt32LE(at) !== SIGNATURE.central)
    throw invalid("The ZIP directory is damaged");
  const flags = buf.readUInt16LE(at + 8);
  const lengths = [28, 30, 32].map((offset) => buf.readUInt16LE(at + offset));
  const end = at + 46 + lengths[0] + lengths[1] + lengths[2];
  if (end > cdEnd) throw invalid("The ZIP directory is damaged");
  const raw = buf.subarray(at + 46, at + 46 + lengths[0]);
  const entry = {
    name: raw.toString(flags & UTF8_NAMES ? "utf8" : "latin1"),
    flags,
    method: buf.readUInt16LE(at + 10),
    crc: buf.readUInt32LE(at + 16),
    packed: buf.readUInt32LE(at + 20),
    size: buf.readUInt32LE(at + 24),
    offset: buf.readUInt32LE(at + 42),
  };
  if (flags & ENCRYPTED) throw unsupported("Encrypted files are not supported");
  if (entry.method !== 0 && entry.method !== 8)
    throw unsupported("Only stored or deflated parts are supported");
  if ([entry.packed, entry.size, entry.offset].includes(0xffffffff))
    throw unsupported("ZIP64 workbooks are not supported");
  if (!safeName(entry.name)) throw invalid("A part has an unsafe file name");
  if (entry.method === 0 && entry.packed !== entry.size)
    throw invalid("The ZIP directory is damaged");
  return { entry, next: end };
}

/** Local headers: each entry's data range, inside the file, not overlapping. */
function placeEntries(buf, entries, cdOffset) {
  const sorted = entries.toSorted((a, b) => a.offset - b.offset);
  for (const [index, entry] of sorted.entries()) {
    const at = entry.offset;
    const valid =
      at + 30 <= cdOffset &&
      buf.readUInt32LE(at) === SIGNATURE.local &&
      buf.readUInt16LE(at + 8) === entry.method;
    if (!valid) throw invalid("The ZIP data is damaged");
    entry.start =
      at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
    entry.end = entry.start + entry.packed;
    const limit = sorted[index + 1]?.offset ?? cdOffset;
    if (entry.end > limit) throw invalid("ZIP entries overlap or are damaged");
  }
}

function readDirectory(buf, max) {
  const at = findEnd(buf);
  const [disk, cdDisk, onDisk, total] = [4, 6, 8, 10].map((o) =>
    buf.readUInt16LE(at + o),
  );
  const cdSize = buf.readUInt32LE(at + 12);
  const cdOffset = buf.readUInt32LE(at + 16);
  if (disk !== 0 || cdDisk !== 0 || onDisk !== total)
    throw unsupported("Multi-part ZIP files are not supported");
  if (total === 0xffff || cdOffset === 0xffffffff)
    throw unsupported("ZIP64 workbooks are not supported");
  if (total > max.entries)
    throw tooLarge(`The workbook has more than ${max.entries} parts`);
  if (cdOffset + cdSize > at) throw invalid("The ZIP directory is damaged");
  const byName = new Map();
  let declared = 0;
  for (let index = 0, next = cdOffset; index < total; index += 1) {
    const { entry, next: after } = readEntry(buf, next, cdOffset + cdSize);
    next = after;
    const key = entry.name.toLowerCase();
    if (byName.has(key)) throw invalid("The workbook lists a part twice");
    byName.set(key, entry);
    declared += entry.size;
    if (declared > max.totalBytes)
      throw tooLarge(`The parts total more than ${max.totalBytes} bytes`);
  }
  placeEntries(buf, [...byName.values()], cdOffset);
  return byName;
}

/** The archive in `bytes` → `{ text(name) }` (null for missing parts). */
export function openZip(bytes, max = XLSX_LIMITS) {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length > max.bytes)
    throw tooLarge(`Files are limited to ${max.bytes} bytes`);
  // OLE files: legacy .xls, or a password-protected (encrypted) workbook.
  const ole = buf.length >= 4 && buf.readUInt32LE(0) === SIGNATURE.ole;
  if (ole) throw unsupported(OLE_MESSAGE);
  if (buf.length < END_SIZE) throw invalid("The file is not an .xlsx workbook");
  const entries = readDirectory(buf, max);
  const read = (entry) => {
    const data = buf.subarray(entry.start, entry.end);
    if (entry.method === 0) return data;
    try {
      return inflateRawSync(data, { maxOutputLength: Math.max(1, entry.size) });
    } catch (error) {
      if (error?.code === "ERR_BUFFER_TOO_LARGE")
        throw tooLarge("A workbook part expands beyond its declared size");
      throw invalid("A workbook part is damaged");
    }
  };
  return {
    text(name) {
      const entry = entries.get(name.toLowerCase());
      if (!entry) return null;
      const out = read(entry);
      if (out.length !== entry.size || crc32(out) !== entry.crc)
        throw invalid("A workbook part is damaged (size or checksum)");
      const utf16 = out[0] === 0xff && out[1] === 0xfe;
      return new TextDecoder(utf16 ? "utf-16le" : "utf-8").decode(out);
    },
  };
}

// --------------------------------------------------------------------- xml

/** Decodes OOXML `_xHHHH_` escapes (`_x000D_` is a carriage return). */
const unescapeText = (text) =>
  text.includes("_x")
    ? text.replace(ESCAPE, (_, hex) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      )
    : text;

// ---------------------------------------------------------------- workbook

/** A part name `target` resolves to from part directory `base`. */
function resolvePart(base, target) {
  const parts = [];
  const path = target.startsWith("/") ? target.slice(1) : `${base}${target}`;
  for (const part of path.split("/")) {
    if (part === "..") {
      if (parts.length === 0)
        throw invalid("A workbook link leaves the package");
      parts.pop();
    } else if (part !== "." && part !== "") parts.push(part);
  }
  return parts.join("/");
}

/** Relationships of `part` ("" for the package) → Map(Id → { target, type }). */
function readRels(zip, part) {
  const cut = part.lastIndexOf("/") + 1;
  const base = part.slice(0, cut);
  const xml = zip.text(`${base}_rels/${part.slice(cut)}.rels`);
  const rels = new Map();
  if (xml === null) return rels;
  walkXml(xml, {
    open(name, attrs) {
      if (name !== "Relationship" || attrs.TargetMode === "External") return;
      if (typeof attrs.Target !== "string") return;
      const target = resolvePart(base, attrs.Target);
      rels.set(attrs.Id, { target, type: attrs.Type ?? "" });
    },
  });
  return rels;
}

const relOfType = (rels, type) =>
  [...rels.values()].find((rel) => rel.type.endsWith(`/${type}`))?.target;

function readWorkbook(zip) {
  const path =
    relOfType(readRels(zip, ""), "officeDocument") ?? "xl/workbook.xml";
  const xml = zip.text(path);
  if (xml === null) throw invalid("The file has no workbook (xl/workbook.xml)");
  const rels = readRels(zip, path);
  const book = { date1904: false, sheets: [] };
  walkXml(xml, {
    open(name, attrs) {
      if (name === "workbookPr")
        book.date1904 = ["1", "true"].includes(attrs.date1904);
      if (name !== "sheet") return;
      const target = rels.get(attrs.id)?.target ?? null;
      const { name: title = "Sheet", state } = attrs;
      book.sheets.push({ name: title, state, target });
    },
  });
  return {
    ...book,
    strings: relOfType(rels, "sharedStrings"),
    styles: relOfType(rels, "styles"),
  };
}

/** Collects the text of `<t>` runs inside `container`, skipping `<rPh>`. */
function textCollector(container, done) {
  let text = null;
  let inside = 0;
  let phonetic = 0;
  return {
    open(name) {
      if (name === container) [text, inside] = ["", 0];
      else if (name === "rPh") phonetic += 1;
      else if (name === "t" && text !== null && phonetic === 0) inside += 1;
    },
    close(name) {
      if (name === "rPh") phonetic -= 1;
      else if (name === "t" && inside > 0) inside -= 1;
      else if (name === container && text !== null) {
        done(unescapeText(text));
        text = null;
      }
    },
    text(chunk) {
      if (inside > 0) text += chunk;
    },
  };
}

function* readStrings(xml) {
  const strings = [];
  const collect = textCollector("si", (text) => strings.push(text));
  if (xml) yield* walkXmlSteps(xml, collect);
  return strings;
}

/** "date", "time" or null for number format `code`. */
function formatKind(code) {
  const bare = code
    .replace(/"[^"]*"|\\.|_.|\*./g, "")
    .replace(/\[(?![hms]+\])[^\]]*\]/gi, "");
  if (/[dy]/i.test(bare) || (/m/i.test(bare) && !/[hs]/i.test(bare)))
    return "date";
  return /[hms]/i.test(bare) ? "time" : null;
}

const colorOf = (rgb) =>
  typeof rgb === "string" && /^(?:[\da-f]{2})?[\da-f]{6}$/i.test(rgb)
    ? `#${rgb.slice(-6).toLowerCase()}`
    : null;

const STYLE_SECTIONS = new Set(
  "numFmts fonts fills cellXfs cellStyleXfs dxfs".split(" "),
);

function builtinKind(id) {
  if (BUILTIN_DATES.has(id)) return "date";
  return BUILTIN_TIMES.has(id) ? "time" : null;
}

/** Styles → per cell format (`xf`) index: `{ kind, font, fill }`. */
function readStyles(xml) {
  const formats = new Map();
  const fonts = [];
  const fills = [];
  const xfs = [];
  const setLast = (list, rgb) => {
    if (list.length > 0) list[list.length - 1] = colorOf(rgb);
  };
  // Elements read per section (`cellStyleXfs`, `dxfs` and others are not).
  const read = {
    numFmts: {
      numFmt: (a) =>
        formats.set(Number(a.numFmtId), formatKind(a.formatCode ?? "")),
    },
    fonts: {
      font: () => fonts.push(null),
      color: (a) => setLast(fonts, a.rgb),
    },
    fills: {
      fill: () => fills.push(null),
      fgColor: (a) => setLast(fills, a.rgb),
    },
    cellXfs: {
      xf(a) {
        const id = Number(a.numFmtId ?? 0);
        xfs.push({
          kind: formats.has(id) ? formats.get(id) : builtinKind(id),
          font: fonts[Number(a.fontId ?? 0)] ?? null,
          fill: fills[Number(a.fillId ?? 0)] ?? null,
        });
      },
    },
  };
  let section = null;
  if (xml)
    walkXml(xml, {
      open(name, attrs) {
        if (STYLE_SECTIONS.has(name)) section = name;
        else read[section]?.[name]?.(attrs);
      },
      close(name) {
        if (name === section) section = null;
      },
    });
  return xfs;
}

// ------------------------------------------------------------------- cells

function cellText(cell, book) {
  const { type, value, formula, inline } = cell;
  if (type === "inlineStr") return inline;
  if (value === "") return formula ? `=${formula}` : "";
  if (type === "s") {
    const text = book.strings[Number(value)];
    if (text === undefined)
      throw invalid("A cell names a shared string that does not exist");
    return text;
  }
  if (type === "b") return { 1: "TRUE", 0: "FALSE" }[value] ?? value;
  if (["str", "e", "d"].includes(type)) return value;
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  const kind = book.xfs[Number(cell.style ?? 0)]?.kind;
  const { date1904 } = book;
  return kind ? serialText(number, { date1904, kind }) : numberText(number);
}

function columnIndex(ref, fallback) {
  const letters = CELL_REF.exec(ref ?? "")?.[1];
  if (!letters) return fallback;
  let index = 0;
  for (const letter of letters) index = index * 26 + letter.charCodeAt(0) - 64;
  return index - 1;
}

/** Sheet reading state: the current row, cell and value field. */
function createSheetReader({ book, max }) {
  const out = { rows: [], colors: new Map(), formulas: 0, droppedCells: 0 };
  out.truncated = false;
  const state = { row: null, cell: null, field: null, lastRow: 0, kept: 0 };
  const styleOf = (cell) => book.xfs[Number(cell.style ?? 0)] ?? {};
  const commit = (row, cell) => {
    const text = cellText(cell, book);
    if (cell.formula !== null) out.formulas += 1;
    if (text === "") return;
    if (cell.col >= max.columns) {
      out.droppedCells += 1;
      return;
    }
    while (row.cells.length < cell.col) row.cells.push("");
    row.cells[cell.col] = text;
    const { font = null, fill = null } = styleOf(cell);
    if (font || fill) row.colors.set(cell.col, { font, fill });
  };
  const endRow = (row) => {
    const gap = row.number > state.lastRow + 1 || row.cells.length === 0;
    if (gap && out.rows.at(-1)?.length > 0) out.rows.push([]);
    state.lastRow = row.number;
    if (row.cells.length === 0) return;
    for (const [col, color] of row.colors)
      out.colors.set(`${out.rows.length}:${col}`, color);
    out.rows.push(row.cells);
    state.kept += 1;
  };
  const startRow = (attrs) => {
    if (state.kept >= max.rows) {
      out.truncated = true;
      return false;
    }
    const number = Number(attrs.r);
    const next = number > state.lastRow ? number : state.lastRow + 1;
    state.row = { number: next, cells: [], colors: new Map() };
    return true;
  };
  return { out, state, commit, endRow, startRow };
}

/** The sheet's rows (see the module comment). */
function* readSheet(xml, { book, max }) {
  const { out, state, commit, endRow, startRow } = createSheetReader({
    book,
    max,
  });
  const inline = textCollector("is", (text) => {
    if (state.cell) state.cell.inline = text;
  });
  yield* walkXmlSteps(xml, {
    open(name, attrs) {
      inline.open(name);
      if (name === "row") return startRow(attrs);
      const { row, cell } = state;
      if (name === "c" && row) {
        const col = columnIndex(attrs.r, row.cells.length);
        const { t: type, s: style } = attrs;
        state.cell = { col, type, style, value: "", formula: null, inline: "" };
      } else if (cell && (name === "v" || name === "f")) {
        state.field = name;
        if (name === "f") cell.formula = "";
      }
      return true;
    },
    close(name) {
      inline.close(name);
      const { row, cell } = state;
      if (name === "v" || name === "f") state.field = null;
      else if (name === "c" && cell && row) {
        commit(row, cell);
        state.cell = null;
      } else if (name === "row" && row) {
        endRow(row);
        state.row = null;
      }
    },
    text(chunk) {
      inline.text(chunk);
      if (state.field === "v") state.cell.value += chunk;
      else if (state.field === "f") state.cell.formula += chunk;
    },
  });
  if (out.rows.at(-1)?.length === 0) out.rows.pop();
  return out;
}

/** Reads the workbook in `bytes` (see the module comment). */
export function* readXlsxSteps(bytes, { limits = {}, signal = null } = {}) {
  const max = { ...XLSX_LIMITS };
  for (const [key, value] of Object.entries(limits))
    if (Number.isSafeInteger(value) && value > 0 && value < max[key])
      max[key] = value;
  const zip = openZip(bytes, max);
  const book = readWorkbook(zip);
  const sheet = book.sheets.find((s) => !HIDDEN.has(s.state)) ?? book.sheets[0];
  if (!sheet?.target) throw invalid("The workbook has no sheet");
  throwIfAborted(signal);
  const strings = yield* readStrings(book.strings && zip.text(book.strings));
  const xfs = readStyles(book.styles && zip.text(book.styles));
  const xml = zip.text(sheet.target);
  if (xml === null) throw invalid("The workbook's first sheet is missing");
  throwIfAborted(signal);
  const read = yield* readSheet(xml, { book: { ...book, strings, xfs }, max });
  return { sheet: sheet.name, sheets: book.sheets.length, ...read };
}

/** `readXlsxSteps` run to its end. */
export const readXlsx = (bytes, options) =>
  drain(readXlsxSteps(bytes, options));
