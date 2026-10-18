/**
 * Shared parts of the monday.com connector: the warning report (repeats
 * are counted per path and message instead of listed one by one), path
 * scopes, scan limits, monday's JSON text fields (`value`, `settings_str`,
 * block `content`), monday color names, update HTML → text, and doc blocks
 * (delta JSON) → SPEC-2 blocks.
 *
 * Generic normalization (trimming and cutting names and texts to Worklane
 * limits, empty names, unknown users/groups/columns, invalid colors and
 * URLs, unknown block types, status labels used but not listed) belongs to
 * `../snapshot.js`, which validates every connector's output; this
 * connector passes source values through for it and reports only what
 * monday-specific conversion loses.
 */
const MAX_WARNINGS = 1000;
const BLOCK_TYPES = Object.freeze({
  normal_text: "paragraph",
  large_title: "heading1",
  medium_title: "heading2",
  small_title: "heading2",
  bulleted_list: "bulleted",
  numbered_list: "numbered",
  check_list: "todo",
  quote: "quote",
  code: "code",
  divider: "divider",
  notice_box: "callout",
});
/** monday color names (`var_name`, legacy group colors) → Worklane colors. */
const NAMED_COLORS = Object.freeze({
  green: "#00c875",
  done_green: "#00c875",
  green_shadow: "#00c875",
  grass_green: "#037f4c",
  orange: "#fdab3d",
  working_orange: "#fdab3d",
  red: "#df2f4a",
  stuck_red: "#df2f4a",
  red_shadow: "#df2f4a",
  purple: "#a25ddc",
  pink: "#ff158a",
  yellow: "#ffcb00",
  egg_yolk: "#ffcb00",
  lime: "#9cd326",
  sky: "#66ccff",
  blue: "#579bfc",
  bright_blue: "#579bfc",
  violet: "#784bd1",
  brown: "#7f5347",
  grey: "#c4c4c4",
  gray: "#c4c4c4",
  american_gray: "#c4c4c4",
});
const ENTITIES = Object.freeze({
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
});

export const isObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Strings as is, numbers as text, anything else "". */
export function str(value) {
  if (typeof value === "string") return value;
  return typeof value === "number" ? String(value) : "";
}

/** A non-empty ID string (monday IDs are strings; numbers are accepted). */
export const idOf = (value) => (str(value) === "" ? null : str(value));

export const listOf = (value) =>
  Array.isArray(value) ? value.filter(isObject) : [];

/** monday's JSON text (`value`, `settings_str`, `content`) → value or null. */
export function parseJson(text) {
  if (typeof text !== "string") return isObject(text) ? text : null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function settingsOf(text) {
  const value = parseJson(text);
  return isObject(value) ? value : {};
}

/**
 * The scan's warnings. `add(code, message, path)` lists one; `count(code,
 * message, path)` folds repeats into one "message: n" warning. `finish()`
 * returns the list (at most 1,000 plus a warnings_omitted entry).
 */
export function createReport() {
  const list = [];
  const counters = new Map();
  let hidden = 0;
  const add = (code, message, path) => {
    if (list.length < MAX_WARNINGS) list.push({ code, message, path });
    else hidden += 1;
  };
  const count = (code, message, path) => {
    const key = JSON.stringify([code, message, path]);
    const entry = counters.get(key) ?? { code, message, path, n: 0 };
    entry.n += 1;
    counters.set(key, entry);
  };
  const finish = () => {
    for (const { code, message, path, n } of counters.values()) {
      add(code, `${message}: ${n}`, path);
    }
    if (hidden > 0) {
      const message = `${hidden} more warnings were not listed`;
      list.push({ code: "warnings_omitted", message, path: "warnings" });
    }
    return list;
  };
  return { add, count, finish };
}

/** `add`/`count` bound to one snapshot path. */
export function scopeAt(report, path) {
  return {
    path,
    add: (code, message) => report.add(code, message, path),
    count: (code, message) => report.count(code, message, path),
  };
}

/**
 * A monday color as `#rrggbb`: hex colors (3 or 6 digits) and monday color
 * names map to colors, absent ones to `fallback`; anything else passes
 * through for the snapshot's color check to replace and report.
 */
export function colorOf(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const raw = str(value).trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(raw)) return raw;
  if (/^#[0-9a-f]{3}$/.test(raw)) {
    return `#${raw.slice(1).replace(/./g, (digit) => digit + digit)}`;
  }
  return NAMED_COLORS[raw.replace(/[\s-]+/g, "_")] ?? str(value);
}

/** Records reaching scan limit `kind` once (and stops reading updates). */
export function limitHit(ctx, kind, path) {
  if (ctx.stopped.has(kind)) return;
  ctx.stopped.add(kind);
  if (kind === "updates") ctx.flags.updates = false;
  const limit = ctx.limits[kind].toLocaleString("en-US");
  const message = `Stopped at the scan limit of ${limit} ${kind}; the rest was not read`;
  ctx.report.add(`limit_${kind}`, message, path);
}

function decodeEntity(match, name) {
  if (name[0] !== "#") return ENTITIES[name.toLowerCase()] ?? match;
  const hex = name[1] === "x" || name[1] === "X";
  const code = hex ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
}

/** Plain text of update HTML (used only when `text_body` is missing). */
export function htmlText(html) {
  return str(html)
    .replace(/<br\s*\/?>|<\/(?:p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, decodeEntity)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function deltaText(content) {
  let text = "";
  let embeds = 0;
  const ops = Array.isArray(content?.deltaFormat) ? content.deltaFormat : [];
  for (const op of ops) {
    if (typeof op?.insert === "string") text += op.insert;
    else if (op?.insert !== undefined) embeds += 1;
  }
  return { text: text.replace(/\n+$/, ""), embeds };
}

/**
 * One monday doc block → `{ type, text, checked? }`. Unknown monday types
 * keep their name (the snapshot turns them into paragraphs and reports
 * them) with their text, link or "[type]" as text.
 */
function convertBlock(scope, raw) {
  const kind = str(raw.type).slice(0, 40);
  const content = parseJson(raw.content);
  const { text, embeds } = deltaText(content);
  if (embeds > 0) {
    const message = "Mentions and other embedded objects were left out";
    scope.count("embeds_dropped", message);
  }
  const type = BLOCK_TYPES[kind];
  if (!type) {
    const url = str(content?.url);
    const link = /^https?:\/\//i.test(url) ? url : `[${kind || "block"}]`;
    return { type: kind || "unknown", text: text || link };
  }
  const block = { type, text: type === "divider" ? "" : text };
  if (type === "todo") {
    block.checked = content?.checked === true || content?.checked === "true";
  }
  return block;
}

export function convertBlocks(scope, raws) {
  return raws.map((raw) => convertBlock(scope, raw));
}
