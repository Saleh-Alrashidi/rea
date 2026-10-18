/**
 * Import warnings (`{ code, message, path }`, SPEC-4 §2): grouped by code
 * for the review and done steps, their snapshot paths described with the
 * names they point at, and the plain-text list the done step offers as a
 * download. Pure.
 *
 * Paths name snapshot positions ("workspaces[0].boards[2].columns[5]");
 * `locate` turns the workspace, board, doc or user part into names from
 * the Preview (whose entries carry the same paths) and keeps the rest.
 */

const PATH = /^workspaces\[(\d+)\](?:\.(boards|docs)\[(\d+)\])?\.?(.*)$/;
// Warnings that say the scan stopped before it read everything.
const LIMIT_CODES = new Set([
  "too_many_items",
  "too_many_values",
  "too_many_columns",
  "read_capped",
]);
const USER_PATH = /^users\[(\d+)\]\.?(.*)$/;
const SEPARATOR = " › ";

/** "column_as_text" → "Column as text". */
export function humanizeCode(code) {
  const text = String(code ?? "")
    .replace(/[_.:-]+/g, " ")
    .trim();
  return text ? text[0].toUpperCase() + text.slice(1) : "Other";
}

/** Whether warning code `code` says a scan or file limit cut the scan. */
export const isLimitCode = (code) =>
  typeof code === "string" &&
  (code.startsWith("limit_") || LIMIT_CODES.has(code));

/** The warnings of `warnings` that say the scan stopped at a limit. */
export const limitWarnings = (warnings = []) =>
  warnings.filter((warning) => isLimitCode(warning?.code));

/**
 * Warnings grouped by code: groups of limit warnings (`limit: true`, the
 * scan stopped early) first, then the largest group first (then by
 * code): `[{ code, title, count, limit, items: [{ message, path }] }]`.
 */
export function groupWarnings(warnings = []) {
  const groups = new Map();
  for (const warning of warnings) {
    const code = typeof warning?.code === "string" ? warning.code : "other";
    let group = groups.get(code);
    if (!group) {
      const limit = isLimitCode(code);
      group = { code, title: humanizeCode(code), count: 0, limit, items: [] };
      groups.set(code, group);
    }
    group.count += 1;
    group.items.push({
      message: String(warning?.message ?? ""),
      path: typeof warning?.path === "string" ? warning.path : "",
    });
  }
  return [...groups.values()].sort(
    (a, b) =>
      Number(b.limit) - Number(a.limit) ||
      b.count - a.count ||
      a.code.localeCompare(b.code),
  );
}

function entryName(workspace, kind, index) {
  const entry = workspace?.[kind]?.[Number(index)];
  return entry ? (entry.name ?? entry.title ?? null) : null;
}

/**
 * Where `path` points: `{ label, rest }`, e.g. `{ label: "Product ›
 * Roadmap", rest: "columns[3]" }`. Unknown positions keep the raw path
 * as `rest` with an empty label.
 */
export function locate(path, preview) {
  const text = typeof path === "string" ? path : "";
  const user = USER_PATH.exec(text);
  if (user) {
    const person = preview?.users?.[Number(user[1])];
    if (person)
      return { label: `People${SEPARATOR}${person.name}`, rest: user[2] };
  }
  const match = PATH.exec(text);
  const workspace = match ? preview?.workspaces?.[Number(match[1])] : null;
  if (!workspace) return { label: "", rest: text };
  const names = [workspace.name];
  if (match[2]) {
    const name = entryName(workspace, match[2], match[3]);
    if (name === null) return { label: workspace.name, rest: text };
    names.push(name);
  }
  return { label: names.join(SEPARATOR), rest: match[4] };
}

/** One line per warning: "[code] location (path): message". */
function warningLine(item, code, preview) {
  const { label } = locate(item.path, preview);
  const where = [label, item.path ? `(${item.path})` : ""]
    .filter(Boolean)
    .join(" ");
  return `- [${code}] ${where ? `${where}: ` : ""}${item.message}`;
}

/**
 * The downloadable warning list: a title, the time, then each group with
 * its warnings. Every value is plain text (nothing is ever evaluated).
 *
 * @param {{ warnings: object[], preview?: object | null, title: string,
 *   generatedAt?: Date }} options
 */
export function warningsText({ warnings, preview = null, title, generatedAt }) {
  const at = (generatedAt ?? new Date()).toISOString();
  const groups = groupWarnings(warnings);
  const total = groups.reduce((sum, group) => sum + group.count, 0);
  const lines = [title, `Generated ${at}`, `${total} warnings`, ""];
  for (const group of groups) {
    lines.push(`${group.title} (${group.code}): ${group.count}`);
    for (const item of group.items) {
      lines.push(warningLine(item, group.code, preview));
    }
    lines.push("");
  }
  if (total === 0) lines.push("There were no warnings.", "");
  return lines.join("\n");
}

/** A safe file name for the warning list of `label` at `date`. */
export function warningsFileName(label, date = new Date()) {
  const slug = String(label ?? "import")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const day = date.toISOString().slice(0, 10);
  return `worklane-import-warnings-${slug || "import"}-${day}.txt`;
}
