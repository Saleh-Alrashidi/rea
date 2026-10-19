/**
 * Shared primitives of the store modules (`server/store/*.js`): record
 * lookup and replacement, the shared numeric ID counter, input validation,
 * failure results and change commits.
 *
 * State has one shape in memory and on disk (see `store/persistence.js`):
 * an array of frozen records per collection plus `next_id`. Records are
 * replaced, never changed in place. Domain modules receive
 * `ctx = { state, now, log, listeners, persist, reader, pending, revision }`
 * where `now()` returns an ISO timestamp, `reader` is the store-like lookup
 * object handed to `server/access.js`, `pending` holds the extra change
 * events (notifications, member changes) that the next `commit` emits
 * after its own, and
 * `revision` counts commits.
 *
 * Expected failures (input limits, conflicts, rule violations) are results,
 * not exceptions: mutators return `{ ok: false, reason, ...details }`.
 * Records never have an `ok` field, so `result?.ok === false` tells them
 * apart. Arguments of the wrong JavaScript type still throw a TypeError.
 */
import { randomBytes } from "node:crypto";
import { LIMITS, isColor, nameRule, validName } from "./input.js";

export const COLUMN_TYPES = Object.freeze([
  "text",
  "status",
  "people",
  "date",
  "numbers",
]);
/**
 * Column roles (SPEC-5 §1.2): what a column means in its source, set by
 * whoever created it (imports), with the column type each role needs. A
 * board has at most one column per role.
 */
export const COLUMN_ROLES = Object.freeze({
  status: "status",
  assignees: "people",
  due_date: "date",
  start_date: "date",
  priority: "status",
  time_estimate: "numbers",
  tags: "text",
  description: "text",
});
/**
 * Status label types (SPEC-5 §1.3), kept per label index in a status
 * column's `settings.labels_types`; `done` and `closed` mean finished.
 */
export const STATUS_LABEL_TYPES = Object.freeze([
  "open",
  "custom",
  "done",
  "closed",
]);
/**
 * Board view types (SPEC-5 §1.5) in tab order (SPEC-6 §1.1): a board's
 * views are listed in this order, so its List view comes first; `app`
 * views come from app installs.
 */
export const VIEW_TYPES = Object.freeze(["list", "table", "kanban", "app"]);
export const GROUP_COLOR = "#579bfc";
export const SCOPE_KEY = /^(?:install|app):[1-9]\d*$/;
export const BOARD_KINDS = Object.freeze(["public", "private", "share"]);
/** Display names of board kinds (activity texts, search subtitles). */
export const BOARD_KIND_LABELS = Object.freeze({
  public: "Main",
  private: "Private",
  share: "Shareable",
});
export const WORKSPACE_KINDS = Object.freeze(["open", "closed"]);
export const DOC_VISIBILITIES = Object.freeze(["workspace", "private"]);
export const FORM_ACCESS = Object.freeze(["public", "account", "closed"]);
export const USER_STATUSES = Object.freeze(["active", "deactivated"]);
export const TEAM_ROLES = Object.freeze(["owner", "member"]);
export const BLOCK_TYPES = Object.freeze([
  "heading1",
  "heading2",
  "paragraph",
  "bulleted",
  "numbered",
  "todo",
  "quote",
  "code",
  "divider",
  "callout",
]);
export const NOTIFICATION_KINDS = Object.freeze([
  "share",
  "assign",
  "update",
  "form_response",
  "role",
  "import_finished",
]);
/** Where imported boards come from (SPEC-4 §2 `Snapshot.source`). */
export const IMPORT_SOURCES = Object.freeze([
  "monday",
  "clickup",
  "csv",
  "xlsx",
]);

// Record IDs are strings, so lookups with any other type find nothing.
export const byId = (list, id) => list.find((r) => r.id === id) ?? null;
export const forBoard = (list, boardId) =>
  list.filter((r) => r.board_id === boardId);
export const onBoard = (list, boardId, id) => byId(forBoard(list, boardId), id);
export const nextPosition = (list) =>
  list.reduce((max, record) => Math.max(max, record.position), -1) + 1;
export const randomToken = (bytes = 32) =>
  randomBytes(bytes).toString("base64url");
export const nextId = (state) => String(state.next_id++);

export function deepFreeze(value) {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Appends a frozen `record` to `list` and returns it. */
export function push(list, record) {
  list.push(deepFreeze(record));
  return record;
}

/** Puts a frozen `next` where `record` was in `list` and returns it. */
export function replace(list, record, next) {
  list[list.indexOf(record)] = deepFreeze(next);
  return next;
}

export function removeWhere(list, predicate) {
  let kept = 0;
  for (const record of list) if (!predicate(record)) list[kept++] = record;
  list.length = kept;
}

export function uniqueId(base, records) {
  const taken = new Set(records.map((record) => record.id));
  let candidate = base;
  for (let n = 2; taken.has(candidate); n += 1) candidate = `${base}_${n}`;
  return candidate;
}

export function slugify(title) {
  const plain = title.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  const slug = plain.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return slug.replace(/^_+|_+$/g, "").slice(0, 40) || "group";
}

/** Copies `record` with every defined entry of `changes`. */
export function withChanges(record, changes) {
  const defined = Object.entries(changes).filter(([, v]) => v !== undefined);
  return { ...record, ...Object.fromEntries(defined) };
}

// -------------------------------------------------------------- validation

/** Thrown by the readers below; the store API turns it into a failure. */
export class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = "InputError";
  }
}

export function invalid(message) {
  throw new InputError(message);
}

/** Part-1 check: a non-empty string (TypeError otherwise). */
export function requireText(value, label, optional = false) {
  if (optional && (value === undefined || value === null)) return;
  if (typeof value !== "string" || (!optional && value.trim() === "")) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

export function requireCount(value, label, minimum) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${label} must be an integer >= ${minimum}`);
  }
}

function requireString(value, label) {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
}

/** A trimmed name or title of 1-255 characters (`input.js` name rule). */
export function readName(value, label) {
  requireString(value, label);
  return validName(value) ?? invalid(nameRule(label));
}

/** Optional text: null or undefined become null; at most `max` chars. */
export function readText(value, label, max = LIMITS.description) {
  if (value === undefined || value === null) return null;
  requireString(value, label);
  if (value.length > max) invalid(`${label} must be at most ${max} characters`);
  return value;
}

/** Optional short text (user titles): blank becomes null, else 1-255. */
export function readTitle(value, label) {
  if (value === undefined || value === null) return null;
  requireString(value, label);
  return value.trim() === "" ? null : readName(value, label);
}

/** A `#rrggbb` color, stored in lower case. */
export function readColor(value, label) {
  requireString(value, label);
  if (!isColor(value)) invalid(`${label} must look like #rrggbb`);
  return value.toLowerCase();
}

export function readChoice(value, choices, label) {
  if (!choices.includes(value)) {
    invalid(`${label} must be one of ${choices.join(", ")}`);
  }
  return value;
}

export function readBoolean(value, label) {
  if (typeof value !== "boolean") {
    throw new TypeError(`${label} must be a boolean`);
  }
  return value;
}

/** `read(value)` for defined values; undefined stays undefined. */
export const optional = (value, read) =>
  value === undefined ? undefined : read(value);

// ------------------------------------------------------- results, commits

/** An expected failure: `{ ok: false, reason, ...details }` (frozen). */
export function failure(reason, details = {}) {
  return Object.freeze({ ok: false, reason, ...details });
}

/**
 * Wraps every function of `api` so an InputError becomes
 * `{ ok: false, reason: "invalid", message }` and stale queued events from
 * an earlier failed call are dropped.
 */
export function guardApi(ctx, api) {
  const guarded = {};
  for (const [name, method] of Object.entries(api)) {
    guarded[name] = (...args) => {
      ctx.pending.length = 0;
      try {
        return method(...args);
      } catch (error) {
        if (!(error instanceof InputError)) throw error;
        return failure("invalid", { message: error.message });
      }
    };
  }
  return guarded;
}

function emit(ctx, event) {
  for (const entry of Array.from(ctx.listeners)) {
    try {
      entry.listener(event);
    } catch (error) {
      ctx.log.error?.("mini-monday: change listener failed", error);
    }
  }
}

/** The change event `type` of `item` (`extra` adds fields such as `column_id`). */
export function itemEvent(type, item, extra = {}) {
  const { board_id, id: item_id, group_id } = item;
  return { type, board_id, item_id, group_id, ...extra };
}

/**
 * Schedules a save, counts a new revision, emits `event` and then the
 * queued events (one per notified recipient or changed resource), and
 * returns `record`.
 */
export function commit(ctx, event, record) {
  ctx.revision += 1;
  ctx.persist.schedule();
  const events = [event, ...ctx.pending.splice(0)];
  for (const each of events) emit(ctx, Object.freeze(each));
  return record;
}

/** The store-like lookups `server/access.js` reads. */
export function createReader(state) {
  return Object.freeze({
    getUser: (id) => byId(state.users, id),
    getTeam: (id) => byId(state.teams, id),
    getWorkspace: (id) => byId(state.workspaces, id),
    getBoard: (id) => byId(state.boards, id),
    getDoc: (id) => byId(state.docs, id),
    getNote: (id) => byId(state.notes, id),
    getForm: (id) => byId(state.forms, id),
    listUsers: () => [...state.users],
  });
}
