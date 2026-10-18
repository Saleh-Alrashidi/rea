/**
 * Terminal output for the mm CLI: escaping of server text, JSON output and
 * aligned tables. Text that came from the server is escaped before it reaches
 * the terminal so it cannot inject control sequences.
 */

const MAX_CELL_LENGTH = 60;

// C0 controls, DEL, C1 controls, bidi marks, line and paragraph separators,
// bidi embeddings, overrides and isolates. Matching them is the intent here.
const UNSAFE =
  // oxlint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/g;

/**
 * Escapes terminal control characters as `\uXXXX` so server data cannot move
 * the cursor, recolor or reorder output. `keepLayout` keeps `\n` and `\t`.
 */
export function escapeTerminal(text, { keepLayout = false } = {}) {
  return String(text).replace(UNSAFE, (char) => {
    if (keepLayout && (char === "\n" || char === "\t")) return char;
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

/** True for non-null objects (arrays included). */
export const isObject = (value) => typeof value === "object" && value !== null;

/** Parses JSON text; returns undefined when it is not valid JSON. */
export function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** JSON text for stdout; the escapes keep it valid, equivalent JSON. */
export function jsonText(value) {
  const text = JSON.stringify(value, null, 2) ?? "null";
  return `${escapeTerminal(text, { keepLayout: true })}\n`;
}

/** One escaped table cell, cut at 60 characters ("-" for null). */
export function cell(value) {
  const text = escapeTerminal(value ?? "-");
  if (text.length <= MAX_CELL_LENGTH) return text;
  return `${text.slice(0, MAX_CELL_LENGTH - 1)}…`;
}

/** Aligns rows (the first is usually a header) into padded columns. */
export function table(rows) {
  const lines = rows.map((row) => row.map(cell));
  const widths = [];
  for (const line of lines) {
    for (const [i, text] of line.entries()) {
      widths[i] = Math.max(widths[i] ?? 0, text.length);
    }
  }
  const format = (line) =>
    line
      .map((text, i) => text.padEnd(widths[i]))
      .join("  ")
      .trimEnd();
  return `${lines.map(format).join("\n")}\n`;
}
