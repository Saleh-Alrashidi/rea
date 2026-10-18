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
import { COLUMN_LIMITS } from "../snapshot-columns.js";
import { SNAPSHOT_LIMITS } from "../snapshot.js";

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

/**
 * The progress message while the upstream client waits (`upstream.js`
 * `onWait`), so a long pause never looks like a hang.
 */
export function waitMessage(label, { seconds, reason, status, perMinute }) {
  if (reason === "throttle")
    return `Waiting ${seconds} s: ${label} allows ${perMinute} requests a minute…`;
  if (reason === "retry")
    return `${label} answered HTTP ${status}; trying again in ${seconds} s…`;
  return `${label} asked to wait ${seconds} s (rate limit)…`;
}

/**
 * A connector's progress reporter: `progress(phase, done, total,
 * message)` reports to `onProgress`, and `wait(info)` re-reports the last
 * progress with the wait's message and `wait_seconds`.
 */
export function createProgress(onProgress, label) {
  const last = { phase: "starting", done: null, total: null, message: null };
  const send = (event) => {
    if (typeof onProgress === "function") onProgress(event);
  };
  return {
    progress(phase, done, total, message) {
      Object.assign(last, { phase, done, total, message });
      send({ ...last, wait_seconds: null });
    },
    wait(info) {
      const message = waitMessage(label, info);
      send({ ...last, message, wait_seconds: info.seconds });
    },
  };
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

/**
 * Records reaching scan limit `kind` (`limit`, default `ctx.limits[kind]`)
 * once, and stops reading updates at the update limit.
 */
export function limitHit(ctx, kind, path, limit = ctx.limits[kind]) {
  if (ctx.stopped.has(kind)) return;
  ctx.stopped.add(kind);
  if (kind === "updates") ctx.flags.updates = false;
  const shown = limit.toLocaleString("en-US");
  const message = `Stopped at the scan limit of ${shown} ${kind}; the rest was not read`;
  ctx.report.add(`limit_${kind}`, message, path);
}

/**
 * Whether the scan may read one more item: not past the item limit, and
 * one more item (at most COLUMN_LIMITS.columns values) keeps
 * `ctx.counts.values` within SNAPSHOT_LIMITS.values, what one import can
 * store. Records the limit that stops it.
 */
export function itemRoom(ctx, path) {
  if (ctx.counts.items >= ctx.limits.items) {
    limitHit(ctx, "items", path);
    return false;
  }
  if (ctx.counts.values + COLUMN_LIMITS.columns > SNAPSHOT_LIMITS.values) {
    limitHit(ctx, "values", path, SNAPSHOT_LIMITS.values);
    return false;
  }
  return true;
}

/** Counts item `item`'s values toward the scan's value budget. */
export function countValues(ctx, item) {
  ctx.counts.values += Object.keys(item.values).length;
}
