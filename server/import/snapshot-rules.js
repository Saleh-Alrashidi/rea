/**
 * The checking context and field readers `snapshot.js` and
 * `snapshot-board.js` share: path-precise errors and warnings, bounded
 * repetition, names and texts cut to Worklane limits, IDs and colors.
 *
 * Errors (`{ code, message, path }`) are structural and make a snapshot
 * unusable; warnings report every normalization that changes or loses
 * information. A problem that repeats (one per item or value) is listed
 * with its exact path REPEAT_LIMIT times per board and kind, then counted
 * in one summary warning, so a broken column cannot flood the report.
 */
import { LIMITS, isColor, isPlainObject } from "../input.js";

export const MAX_ERRORS = 50;
export const MAX_WARNINGS = 5_000;
/** Exact-path warnings per board (or snapshot) and kind before a summary. */
export const REPEAT_LIMIT = 20;
export const MAX_ID_LENGTH = 255;
export const MAX_URL_LENGTH = 2048;
const WEB_URL = /^https?:\/\/\S+$/i;
const PLAIN_KEY = /^[A-Za-z_$][\w$]*$/;

/** Worklane's group and status colors (`nearestColor` picks from them). */
export const WORKLANE_COLORS = Object.freeze([
  "#579bfc",
  "#a25ddc",
  "#00c875",
  "#fdab3d",
  "#df2f4a",
  "#ff158a",
  "#ffcb00",
  "#9cd326",
  "#66ccff",
  "#037f4c",
  "#784bd1",
  "#7f5347",
  "#c4c4c4",
]);
export const LABEL_COLOR = "#c4c4c4";

const rgb = (hex) =>
  [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));

/**
 * The Worklane color closest to `hex` (`#rrggbb`), for connectors that map
 * source colors; anything that is not a color maps to LABEL_COLOR.
 */
export function nearestColor(hex) {
  if (!isColor(hex)) return LABEL_COLOR;
  const [r, g, b] = rgb(hex.toLowerCase());
  let best = LABEL_COLOR;
  let distance = Number.POSITIVE_INFINITY;
  for (const candidate of WORKLANE_COLORS) {
    const [cr, cg, cb] = rgb(candidate);
    const d = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
    if (d < distance) [best, distance] = [candidate, d];
  }
  return best;
}

/** `text` cut to `max` UTF-16 units without splitting a surrogate pair. */
export function truncate(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** `base.key`, or `base["key"]` for keys that are not identifiers. */
export const keyPath = (base, key) =>
  PLAIN_KEY.test(key) ? `${base}.${key}` : `${base}[${JSON.stringify(key)}]`;

/** A short quoted rendering of a source value for messages. */
export function shown(value) {
  let text;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return JSON.stringify(truncate(String(text), 40));
}

/**
 * The checking context: `error`, `warn` and `repeat(scope, code, path,
 * message)` (exact warnings up to REPEAT_LIMIT per scope and code, the
 * rest counted until `flush(scope)` writes one summary per code).
 */
export function createChecker() {
  const errors = [];
  const warnings = [];
  const repeats = new Map();
  let omitted = 0;
  const warn = (path, code, message) => {
    if (warnings.length < MAX_WARNINGS) warnings.push({ code, message, path });
    else omitted += 1;
  };
  return {
    errors,
    warnings,
    error(path, code, message) {
      if (errors.length < MAX_ERRORS) errors.push({ code, message, path });
    },
    warn,
    repeat(scope, code, path, message) {
      const key = `${scope.path}\u0000${code}`;
      const entry = repeats.get(key) ?? { scope, code, count: 0 };
      repeats.set(key, entry);
      entry.count += 1;
      if (entry.count <= REPEAT_LIMIT) warn(path, code, message);
    },
    /** Summarizes the repeats of `scope` past REPEAT_LIMIT. */
    flush(scope) {
      for (const [key, entry] of repeats) {
        if (entry.scope !== scope) continue;
        repeats.delete(key);
        const more = entry.count - REPEAT_LIMIT;
        if (more <= 0) continue;
        const message = `${more} more like this (${entry.code}) in ${scope.label}`;
        warn(scope.path, entry.code, message);
      }
    },
    /** The final warning list (with a count of any beyond MAX_WARNINGS). */
    result() {
      if (omitted === 0) return warnings;
      const message = `${omitted} more warnings were not listed`;
      return [...warnings, { code: "warnings_omitted", message, path: "" }];
    },
  };
}

// ------------------------------------------------------------- readers

export function readObject(c, value, path) {
  if (isPlainObject(value)) return value;
  c.error(path, "invalid_type", "Expected an object");
  return null;
}

/** An array of at most `max` entries; absent → `[]` when `optional`. */
export function readArray(c, value, { path, max, optional = false }) {
  if (optional && (value === undefined || value === null)) return [];
  if (!Array.isArray(value)) {
    c.error(path, "invalid_type", "Expected an array");
    return null;
  }
  if (value.length <= max) return value;
  c.error(path, "too_large", `At most ${max} entries are supported`);
  return null;
}

/**
 * A source ID as text: a non-empty string (trimmed) of at most
 * MAX_ID_LENGTH characters or a safe integer; anything else → null.
 */
export function sourceIdText(value) {
  const text = Number.isSafeInteger(value)
    ? String(value)
    : typeof value === "string"
      ? value.trim()
      : "";
  return text !== "" && text.length <= MAX_ID_LENGTH ? text : null;
}

/** A source ID (`sourceIdText`), else an error. */
export function readSourceId(c, value, path) {
  const text = sourceIdText(value);
  if (text !== null) return text;
  c.error(
    path,
    "invalid_id",
    `Expected an ID of 1-${MAX_ID_LENGTH} characters`,
  );
  return null;
}

/** One of `choices`, else an error. */
export function readChoice(c, value, { path, choices }) {
  if (choices.includes(value)) return value;
  c.error(path, "invalid_value", `Expected one of ${choices.join(", ")}`);
  return null;
}

/**
 * A name or title: trimmed, `fallback` (with a warning) when empty, cut to
 * LIMITS.name with a warning. Non-strings are errors (undefined → null).
 */
export function readName(c, value, { path, fallback, repeat = null }) {
  if (typeof value !== "string") {
    c.error(path, "invalid_type", "Expected a string");
    return undefined;
  }
  const note = (code, message) =>
    repeat
      ? c.repeat(repeat, code, path, message)
      : c.warn(path, code, message);
  const name = value.trim();
  if (name === "") {
    note("empty_name", `An empty name was replaced with “${fallback}”`);
    return fallback;
  }
  if (name.length <= LIMITS.name) return name;
  note("truncated", `A name longer than ${LIMITS.name} characters was cut`);
  return truncate(name, LIMITS.name);
}

/** Optional text (null when absent or blank), cut to `max` with a warning. */
export function readOptionalText(c, value, { path, max }) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    c.error(path, "invalid_type", "Expected a string or null");
    return undefined;
  }
  if (value.trim() === "") return null;
  if (value.length <= max) return value;
  c.warn(path, "truncated", `Text longer than ${max} characters was cut`);
  return truncate(value, max);
}

/** A `#rrggbb` color in lower case; anything else → `fallback`, warned. */
export function readColor(c, value, { path, fallback }) {
  if (isColor(value)) return value.toLowerCase();
  c.warn(
    path,
    "invalid_color",
    `Color ${shown(value)} was replaced with ${fallback}`,
  );
  return fallback;
}

/** An http(s) URL or null; anything else → null with a warning. */
export function readUrl(c, value, path) {
  if (value === undefined || value === null) return null;
  const valid =
    typeof value === "string" &&
    value.length <= MAX_URL_LENGTH &&
    WEB_URL.test(value) &&
    URL.canParse(value);
  if (valid) return value;
  c.warn(
    path,
    "invalid_url",
    "Only http(s) links are kept; this one was left out",
  );
  return null;
}

/** An ISO time (normalized) or null; unparsable values → null, repeated. */
export function readTime(c, value, { path, scope }) {
  if (value === undefined || value === null) return null;
  const time = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (Number.isFinite(time)) return new Date(time).toISOString();
  c.repeat(scope, "invalid_time", path, `Time ${shown(value)} was left out`);
  return null;
}

/**
 * `id`, or `id#2`, `id#3`… when `taken` already holds it (with a warning),
 * added to `taken`.
 */
export function uniqueSourceId(c, { id, taken, path, scope }) {
  let unique = id;
  for (let n = 2; taken.has(unique); n += 1) unique = `${id}#${n}`;
  if (unique !== id) {
    const message = `Duplicate ID ${shown(id)} was renamed ${shown(unique)}`;
    c.repeat(scope, "duplicate_id", path, message);
  }
  taken.add(unique);
  return unique;
}
