/**
 * monday.com-specific parts of the monday connector: monday's JSON text
 * fields (`value`, `settings_str`, block `content`), monday color names,
 * update HTML → text, and doc blocks (delta JSON) → SPEC-2 blocks. What
 * every connector shares (warnings, scopes, limits) is `common.js`.
 */
import { hexColor, isObject, str } from "./common.js";

/**
 * monday doc block types by `nameKey`: reads name them with spaces
 * ("normal text", `DocumentBlock.type` is a free string), the input enum
 * of `create_doc_block` (`DocBlockContentType`) with underscores.
 */
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

/** A monday name as a lookup key: "Normal text" / "normal-text" → "normal_text". */
const nameKey = (value) =>
  str(value)
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

/**
 * A monday color as `#rrggbb`: monday color names map to colors, then as
 * `hexColor` (hex colors, `fallback` when absent, anything else passed
 * through for the snapshot's color check).
 */
export function colorOf(value, fallback) {
  const name = nameKey(value);
  return Object.hasOwn(NAMED_COLORS, name)
    ? NAMED_COLORS[name]
    : hexColor(value, fallback);
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
 * One monday doc block → `{ type, text, checked? }` (either spelling of
 * the type, see BLOCK_TYPES). Unknown monday types keep their name (the
 * snapshot turns them into paragraphs and reports them) with their text,
 * link or "[type]" as text.
 */
function convertBlock(scope, raw) {
  const kind = str(raw.type).trim().slice(0, 40);
  const content = parseJson(raw.content);
  const { text, embeds } = deltaText(content);
  if (embeds > 0) {
    const message = "Mentions and other embedded objects were left out";
    scope.count("embeds_dropped", message);
  }
  const key = nameKey(kind);
  const type = Object.hasOwn(BLOCK_TYPES, key) ? BLOCK_TYPES[key] : null;
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
