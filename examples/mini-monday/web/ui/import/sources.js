/**
 * The import sources of the wizard's first step (SPEC-4 §6.1): monday.com
 * and ClickUp read an account through the source's API with a personal
 * token; CSV and monday's Excel export read one uploaded file. Each source
 * says where its token or export is found, which scan options it offers
 * (the connector option names `routes/import.js` accepts) and, for files,
 * what may be picked.
 *
 * Pure: `scanOptions` and `checkFile` decide what is sent and refused
 * before any request, so the server's limits are never the first check a
 * user meets (the server checks everything again).
 */

/** The upload limit of `POST /import/scan` (20 MiB). */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

/**
 * Scan limits a token source may lower (the connectors' defaults are the
 * maximum: they only ever lower them, SPEC-4 §1).
 */
export const SCAN_LIMITS = Object.freeze([
  { key: "boards", label: "Boards or lists", max: 200 },
  { key: "items", label: "Items or tasks", max: 50_000 },
  { key: "updates", label: "Updates or comments", max: 5_000 },
]);

const OPTION_LABELS = Object.freeze({
  include_subitems: "Subitems",
  include_updates: "Updates",
  include_comments: "Comments",
  include_docs: "Docs",
});

const flag = (key, hint) => ({ key, label: OPTION_LABELS[key], hint });

export const IMPORT_SOURCES = Object.freeze({
  monday: Object.freeze({
    id: "monday",
    label: "monday.com",
    icon: "board",
    input: "token",
    description:
      "Workspaces, boards, groups, items, subitems, people, updates and docs.",
    where:
      "In monday.com, open your avatar → Developers → My access tokens and copy the token.",
    tokenLabel: "monday.com API token",
    options: Object.freeze([
      flag("include_subitems", "Subitems become items under their parent"),
      flag("include_updates", "Item updates and their authors"),
      flag("include_docs", "Workspace docs, as plain text blocks"),
    ]),
  }),
  clickup: Object.freeze({
    id: "clickup",
    label: "ClickUp",
    icon: "myWork",
    input: "token",
    description:
      "Spaces, folders and lists with tasks, subtasks, fields, comments and docs.",
    where:
      "In ClickUp, open Settings → Apps → API Token and copy your personal token (pk_…).",
    tokenLabel: "ClickUp API token",
    options: Object.freeze([
      flag("include_subitems", "Subtasks become items under their parent"),
      flag("include_comments", "Task comments and their authors"),
      flag("include_docs", "Docs and their pages"),
    ]),
  }),
  csv: Object.freeze({
    id: "csv",
    label: "CSV file",
    icon: "table",
    input: "file",
    kind: "csv",
    description:
      "One board from a spreadsheet; the first row names the columns.",
    where:
      "Export a sheet as CSV (UTF-8) from Excel, Google Sheets or any other tool.",
    accept: ".csv,.txt,text/csv,text/plain",
    extensions: Object.freeze([".csv", ".txt"]),
    options: Object.freeze([]),
  }),
  xlsx: Object.freeze({
    id: "xlsx",
    label: "monday Excel export",
    icon: "grid",
    input: "file",
    kind: "xlsx",
    description:
      "A board exported from monday.com, with its groups and subitems.",
    where:
      "In monday.com, open the board’s menu (…) → More actions → Export board to Excel.",
    accept:
      ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extensions: Object.freeze([".xlsx"]),
    options: Object.freeze([]),
  }),
});

export const SOURCE_IDS = Object.freeze(Object.keys(IMPORT_SOURCES));

/** The source record for `id` (unknown IDs get null). */
export const sourceOf = (id) =>
  Object.hasOwn(IMPORT_SOURCES, id) ? IMPORT_SOURCES[id] : null;

/** "1.5 MB" style sizes (binary units, as the limits are). */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

/**
 * Why `file` (`{ name, size }`) cannot be scanned as `source`, or null.
 * The size check comes first: a 2 GB file must not be read at all.
 */
export function checkFile(file, source) {
  const info = sourceOf(source);
  if (info?.input !== "file") return "Choose a file source first.";
  if (!file) return "Choose a file to import.";
  if (file.size > MAX_FILE_BYTES) {
    const size = formatBytes(file.size);
    const max = formatBytes(MAX_FILE_BYTES);
    // Just over the limit both read "20 MB".
    const what = size === max ? file.name : `${file.name} (${size})`;
    return `${what} is over the ${max} limit for imports.`;
  }
  if (file.size === 0) return `${file.name} is empty.`;
  const name = String(file.name ?? "").toLowerCase();
  if (!info.extensions.some((extension) => name.endsWith(extension))) {
    return `Choose a ${orList(info.extensions)} file.`;
  }
  return null;
}

/** "a", "a or b", "a, b or c". */
const orList = (parts) =>
  parts.length <= 1
    ? parts.join("")
    : `${parts.slice(0, -1).join(", ")} or ${parts.at(-1)}`;

/** A limit field's text as the limit it asks for: null when empty. */
const limitValue = (raw) => {
  const text = typeof raw === "string" ? raw.trim() : raw;
  return text === "" || text === null || text === undefined
    ? null
    : Number(text);
};

/**
 * Why each scan limit field cannot be sent, by limit key: an empty field
 * is the default; anything else must be a whole number from 1 to the
 * limit's max. `{}` when every field is fine.
 */
export function limitProblems(limits = {}) {
  const problems = {};
  for (const limit of SCAN_LIMITS) {
    const value = limitValue(limits[limit.key]);
    if (value === null) continue;
    if (!Number.isSafeInteger(value) || value < 1 || value > limit.max) {
      const max = limit.max.toLocaleString("en-US");
      problems[limit.key] =
        `Enter a whole number from 1 to ${max}, or leave it empty for ${max}.`;
    }
  }
  return problems;
}

/**
 * The connector options of a scan: flags the user turned off (connectors
 * default every flag to on) and the limits filled in (1…max; check them
 * with `limitProblems` first: other values are left out, the default).
 *
 * @param {string} source
 * @param {{ flags?: Record<string, boolean>, limits?: Record<string, unknown> }} choices
 * @returns {object}
 */
export function scanOptions(source, { flags = {}, limits = {} } = {}) {
  const info = sourceOf(source);
  if (info?.input !== "token") return {};
  const options = {};
  for (const option of info.options) {
    if (flags[option.key] === false) options[option.key] = false;
  }
  const lowered = {};
  for (const limit of SCAN_LIMITS) {
    const value = limitValue(limits[limit.key]);
    if (Number.isSafeInteger(value) && value >= 1 && value <= limit.max) {
      lowered[limit.key] = value;
    }
  }
  if (Object.keys(lowered).length > 0) options.limits = lowered;
  return options;
}
