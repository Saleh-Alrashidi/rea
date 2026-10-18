/**
 * What every API connector shares: reading loosely typed JSON (objects,
 * strings, IDs, lists), the scan's warning report (repeats are counted
 * per path and message instead of listed one by one), path scopes, scan
 * limits and hex colors. Source-specific parsing stays with its connector
 * (`monday-common.js`, `clickup-common.js`).
 *
 * Generic normalization (trimming and cutting names and texts to Worklane
 * limits, empty names, unknown users/groups/columns, invalid colors and
 * URLs, unknown block types, status labels used but not listed) belongs to
 * `../snapshot.js`, which validates every connector's output; connectors
 * pass source values through for it and report only what their own
 * conversion loses.
 */
const MAX_WARNINGS = 1000;

export const isObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Strings as is, numbers as text, anything else "". */
export function str(value) {
  if (typeof value === "string") return value;
  return typeof value === "number" ? String(value) : "";
}

/** A non-empty ID string (source IDs are strings; numbers are accepted). */
export const idOf = (value) => (str(value) === "" ? null : str(value));

export const listOf = (value) =>
  Array.isArray(value) ? value.filter(isObject) : [];

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
 * A hex color as `#rrggbb` (3 or 6 digits, any case), `fallback` when
 * absent; anything else passes through for the snapshot's color check to
 * replace and report.
 */
export function hexColor(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const raw = str(value).trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(raw)) return raw;
  if (/^#[0-9a-f]{3}$/.test(raw)) {
    return `#${raw.slice(1).replace(/./g, (digit) => digit + digit)}`;
  }
  return str(value);
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
