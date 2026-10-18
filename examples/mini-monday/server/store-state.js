/**
 * State model behind `server/store.js`: record constructors, seed data,
 * data-file loading and validation, and debounced atomic persistence.
 *
 * State has one shape in memory and on disk: `{ format, next_id, users,
 * boards, … }`, an array of frozen records per collection plus the shared
 * numeric ID counter. Records are replaced, never changed in place.
 * Constructors take `ctx = { state, now }` where `now()` returns an ISO
 * timestamp.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { ALL_SCOPES } from "./auth.js";
import { DEFAULT_STATUS_SETTINGS } from "./column-values.js";
import { isValidStoredValue } from "./column-values.js";

const FORMAT = "mini-monday-store/1";
const SAVE_DELAY_MS = 50;
export const COLUMN_TYPES = ["text", "status", "people", "date", "numbers"];
export const GROUP_COLOR = "#579bfc";
export const SCOPE_KEY = /^(?:install|app):[1-9]\d*$/;

// Seed tables use "|"-separated fields.
const SEED_USERS = [
  "Alex Rivera|alex@example.test|admin",
  "Sam Lee|sam@example.test|",
  "Noa Cohen|noa@example.test|",
];
const ROADMAP_GROUPS = [
  "this_sprint|This sprint|#579bfc",
  "next_up|Next up|#a25ddc",
  "done|Done|#00c875",
];
const ROADMAP_COLUMNS = [
  "name|Name|name",
  "status|Status|status",
  "person|Owner|people",
  "date|Due date|date",
  "estimate|Estimate|numbers",
  "notes|Notes|text",
];
/** Groups and columns of a board made by `createBoard`. */
export const DEFAULT_CONTENT = Object.freeze({
  groups: [`topics|Topics|${GROUP_COLOR}`],
  columns: [
    "name|Name|name",
    "status|Status|status",
    "person|Person|people",
    "date|Date|date",
  ],
});
// group | name | status index | owner IDs | due date | estimate | notes
const ROADMAP_ITEMS = [
  "this_sprint|Design onboarding flow|0|1|2026-10-20|5|Wireframes ready",
  "this_sprint|Set up CI pipeline|1|2|2026-10-14|3|",
  "this_sprint|Fix login timeout bug|2|3|2026-10-16|2|Waiting on auth logs",
  "next_up|Kanban drag and drop||1,2|2026-11-02|8|",
  "next_up|Dark mode polish|0|3||3|Check table contrast",
  "next_up|API rate limits|||2026-11-10|5|Per-token budgets",
  "done|Board sharing|1|2|2026-10-01||",
  "done|Item card comments|1|1,3|2026-10-05|2.5|Shipped in 2026-01",
];
const MARKETING_ITEMS = [
  "topics|Write launch blog post|0|3|2026-10-25||",
  "topics|Prepare demo video|2|2|||",
  "topics|Announce on social|||2026-10-30||",
];
const SEED_UPDATES = [
  "2|Can we review the wireframes on Thursday?",
  "1|Yes, I will share the link before then.",
];

export const isObject = (v) =>
  typeof v === "object" && v !== null && !Array.isArray(v);
// Record IDs are strings, so lookups with any other type find nothing.
export const byId = (list, id) => list.find((r) => r.id === id) ?? null;
export const forBoard = (list, boardId) =>
  list.filter((r) => r.board_id === boardId);
export const onBoard = (list, boardId, id) => byId(forBoard(list, boardId), id);
export const nextPosition = (list) =>
  list.reduce((max, record) => Math.max(max, record.position), -1) + 1;
const randomToken = () => randomBytes(32).toString("base64url");
const nextId = (state) => String(state.next_id++);

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

function uniqueId(base, records) {
  const taken = new Set(records.map((record) => record.id));
  let candidate = base;
  for (let n = 2; taken.has(candidate); n += 1) candidate = `${base}_${n}`;
  return candidate;
}

function slugify(title) {
  const plain = title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  const slug = plain.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return slug.replace(/^_+|_+$/g, "").slice(0, 40) || "group";
}

/** Column record; `settings_str` is derived for GraphQL and not persisted. */
function makeColumn({ id, board_id, title, type, settings }) {
  const copy = deepFreeze(structuredClone(settings));
  const settings_str = JSON.stringify(copy);
  return { id, board_id, title, type, settings: copy, settings_str };
}

export function insertBoard(ctx, { name, description, creatorId }) {
  const board = { id: nextId(ctx.state), name, description, state: "active" };
  return push(ctx.state.boards, { ...board, creator_id: creatorId });
}

/** Group IDs are title slugs made unique per board ("topics", "group_2"). */
export function insertGroup(ctx, boardId, { id, title, color }) {
  const groups = forBoard(ctx.state.groups, boardId);
  const groupId = id ?? uniqueId(slugify(title), groups);
  const position = nextPosition(groups);
  const group = { id: groupId, board_id: boardId, title, color, position };
  return push(ctx.state.groups, group);
}

/** Column IDs are `<type>`, then `<type>_2`, `<type>_3`… per board. */
export function insertColumn(ctx, boardId, { id, title, type }) {
  const columns = forBoard(ctx.state.columns, boardId);
  const settings = type === "status" ? DEFAULT_STATUS_SETTINGS : {};
  const columnId = id ?? uniqueId(type, columns);
  const fields = { id: columnId, board_id: boardId, title, type, settings };
  return push(ctx.state.columns, makeColumn(fields));
}

function insertView(ctx, boardId, { name, type, installId = null }) {
  const view = { id: nextId(ctx.state), board_id: boardId, name, type };
  return push(ctx.state.views, { ...view, app_install_id: installId });
}

/** Adds groups and columns from `|` rows plus the table and kanban views. */
export function insertContent(ctx, boardId, { groups, columns }) {
  for (const [id, title, color] of groups.map((row) => row.split("|"))) {
    insertGroup(ctx, boardId, { id, title, color });
  }
  for (const [id, title, type] of columns.map((row) => row.split("|"))) {
    insertColumn(ctx, boardId, { id, title, type });
  }
  insertView(ctx, boardId, { name: "Main table", type: "table" });
  insertView(ctx, boardId, { name: "Kanban", type: "kanban" });
}

/** Appends a new item at the end of its group. */
export function insertItem(ctx, { boardId, groupId, name, values, creatorId }) {
  const { state } = ctx;
  const inGroup = (r) => r.board_id === boardId && r.group_id === groupId;
  const at = ctx.now();
  return push(state.items, {
    id: nextId(state),
    board_id: boardId,
    group_id: groupId,
    name,
    position: nextPosition(state.items.filter(inGroup)),
    state: "active",
    creator_id: creatorId,
    created_at: at,
    updated_at: at,
    values,
  });
}

export function insertUpdate(ctx, { itemId, body, creatorId }) {
  const update = { id: nextId(ctx.state), item_id: itemId, body };
  const fields = { creator_id: creatorId, created_at: ctx.now() };
  return push(ctx.state.updates, { ...update, ...fields });
}

function seedItems(ctx, boardId, rows) {
  return rows.map((row) => {
    const [groupId, name, status, owners, date, estimate, notes] =
      row.split("|");
    const values = {};
    if (status) values.status = { index: Number(status) };
    if (owners) values.person = owners.split(",");
    if (date) values.date = date;
    if (estimate) values.estimate = Number(estimate);
    if (notes) values.notes = notes;
    return insertItem(ctx, { boardId, groupId, name, values, creatorId: "1" });
  });
}

function seedApp(ctx, boardId) {
  const app = push(ctx.state.apps, {
    id: nextId(ctx.state),
    name: "Status summary",
    client_id: randomBytes(16).toString("hex"),
    client_secret: randomToken(),
    path: "/apps/status-summary/index.html",
    scopes: ["boards:read", "storage:read", "storage:write"],
  });
  const install = { id: nextId(ctx.state), app_id: app.id };
  push(ctx.state.installs, { ...install, board_id: boardId });
  const view = { name: "Status summary", type: "app", installId: install.id };
  insertView(ctx, boardId, view);
}

/** Seeds the demo content (deterministic) with random secrets and tokens. */
export function seedState(ctx) {
  const { state } = ctx;
  for (const [name, email, role] of SEED_USERS.map((r) => r.split("|"))) {
    const user = { id: nextId(state), name, email };
    push(state.users, { ...user, is_admin: role === "admin" });
  }
  const roadmap = insertBoard(ctx, {
    name: "Product roadmap",
    description: "What we are building this quarter",
    creatorId: "1",
  });
  const groups = ROADMAP_GROUPS;
  insertContent(ctx, roadmap.id, { groups, columns: ROADMAP_COLUMNS });
  const [first] = seedItems(ctx, roadmap.id, ROADMAP_ITEMS);
  for (const [creatorId, body] of SEED_UPDATES.map((r) => r.split("|"))) {
    insertUpdate(ctx, { itemId: first.id, body, creatorId });
  }
  const marketing = insertBoard(ctx, {
    name: "Marketing launch",
    description: "Launch checklist for the next release",
    creatorId: "1",
  });
  insertContent(ctx, marketing.id, DEFAULT_CONTENT);
  seedItems(ctx, marketing.id, MARKETING_ITEMS);
  seedApp(ctx, roadmap.id);
  const tokens = [
    ["read-write", ALL_SCOPES],
    ["read-only", ["boards:read", "storage:read"]],
  ];
  for (const [label, scopes] of tokens) {
    const token = { token: randomToken(), user_id: "1" };
    push(state.tokens, { ...token, scopes: [...scopes], label });
  }
}

// ---------------------------------------------------------------- loading

const CHECKS = {
  id: (v) => typeof v === "string" && /^[1-9]\d{0,15}$/.test(v),
  slug: (v) => typeof v === "string" && /^[a-z0-9_]{1,64}$/.test(v),
  str: (v) => typeof v === "string",
  bool: (v) => typeof v === "boolean",
  int: (v) => Number.isSafeInteger(v),
  num: (v) => Number.isFinite(v),
  obj: isObject,
  active: (v) => v === "active",
  type: (v) => v === "name" || COLUMN_TYPES.includes(v),
  scopes: (v) => Array.isArray(v) && v.every((s) => ALL_SCOPES.includes(s)),
  scope: (v) => typeof v === "string" && SCOPE_KEY.test(v),
  token: (v) => typeof v === "string" && /^[\w-]{1,512}$/.test(v),
};
// Persisted fields per collection as "field:check"; "?" also allows null.
// Collections starting with "id:id" take IDs from the shared counter.
const SHAPES = {
  users: "id:id name:str email:str is_admin:bool",
  boards: "id:id name:str description:str? state:active creator_id:id?",
  groups: "id:slug board_id:id title:str color:str position:int",
  columns: "id:slug board_id:id title:str type:type settings:obj",
  apps: "id:id name:str client_id:str client_secret:str path:str scopes:scopes",
  installs: "id:id app_id:id board_id:id",
  views: "id:id board_id:id name:str type:str app_install_id:id?",
  items:
    "id:id board_id:id group_id:slug name:str position:num state:active " +
    "creator_id:id? created_at:str updated_at:str values:obj",
  updates: "id:id item_id:id body:str creator_id:id? created_at:str",
  tokens: "token:token user_id:id scopes:scopes label:str",
  storage: "scope:scope key:str value:str? version:int",
};

function fieldChecks(shape) {
  return shape.split(" ").map((spec) => {
    const [field, name] = spec.split(":");
    const check = CHECKS[name.replace("?", "")];
    return [field, name.endsWith("?") ? (v) => v === null || check(v) : check];
  });
}

export function emptyState() {
  const state = { format: FORMAT, next_id: 1 };
  for (const name of Object.keys(SHAPES)) state[name] = [];
  return state;
}

/**
 * Checks counter IDs, per-board group/column IDs, storage keys, and each
 * item's board, group and stored values. Other references (creators,
 * installs of views) may dangle; consumers already treat them as missing.
 */
function checkIntegrity(state, fail) {
  const numbered = Object.keys(SHAPES).filter((name) =>
    SHAPES[name].startsWith("id:id "),
  );
  const ids = numbered.flatMap((name) => state[name].map((r) => Number(r.id)));
  if (new Set(ids).size !== ids.length || ids.some((id) => id >= state.next_id))
    fail("duplicate or unissued IDs");
  const unique = (list, key) => new Set(list.map(key)).size === list.length;
  if (
    !unique(state.groups, (g) => `${g.board_id}/${g.id}`) ||
    !unique(state.columns, (c) => `${c.board_id}/${c.id}`) ||
    !unique(state.storage, (s) => `${s.scope}\n${s.key}`)
  )
    fail("duplicate group, column or storage keys");
  const getUser = (id) => byId(state.users, id);
  const validValue = (item, [columnId, value]) => {
    const column = onBoard(state.columns, item.board_id, columnId);
    if (!column || column.type === "name" || value === null) return false;
    return isValidStoredValue(column, value, { getUser });
  };
  for (const item of state.items) {
    const valid =
      byId(state.boards, item.board_id) &&
      onBoard(state.groups, item.board_id, item.group_id) &&
      Object.entries(item.values).every((entry) => validValue(item, entry));
    if (!valid) fail(`item ${item.id} has an unknown group or invalid value`);
  }
}

/**
 * Loads and validates the data file; null when it does not exist. Invalid
 * files throw instead of being replaced, so data is never silently lost.
 */
export async function loadState(file) {
  const fail = (detail) => {
    throw new Error(`Invalid mini-monday data file ${file}: ${detail}`);
  };
  let doc;
  try {
    doc = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof SyntaxError) fail(error.message);
    throw error;
  }
  if (!isObject(doc) || doc.format !== FORMAT) fail("unsupported format");
  if (!CHECKS.int(doc.next_id) || doc.next_id < 1) fail("invalid next_id");
  const state = { format: FORMAT, next_id: doc.next_id };
  for (const [name, shape] of Object.entries(SHAPES)) {
    const checks = fieldChecks(shape);
    if (!Array.isArray(doc[name])) fail(`${name} must be an array`);
    state[name] = doc[name].map((record, index) => {
      if (!isObject(record) || !checks.every(([f, ok]) => ok(record[f])))
        fail(`${name}[${index}] is malformed`);
      const fields = checks.map(([field]) => [field, record[field]]);
      return deepFreeze(Object.fromEntries(fields));
    });
  }
  state.columns = state.columns.map((c) => deepFreeze(makeColumn(c)));
  state.groups.sort((a, b) => a.position - b.position);
  checkIntegrity(state, fail);
  return state;
}

// ------------------------------------------------------------ persistence

function serialize(state) {
  const columns = state.columns.map(({ settings_str: _derived, ...c }) => c);
  return `${JSON.stringify({ ...state, columns }, null, 2)}\n`;
}

/** Writes `text` to a synced temp file in the same directory, then renames. */
async function writeAtomic(file, text) {
  const directory = path.dirname(file);
  const temp = path.join(
    directory,
    `.${path.basename(file)}.${randomUUID()}.tmp`,
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    // The file holds tokens and app secrets, so it is private to the user.
    await writeFile(temp, text, { flag: "wx", mode: 0o600, flush: true });
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

/**
 * Debounced saving of `state` to `file` (no-op when `file` is null). The
 * first change starts a timer that later changes join; one write runs at a
 * time and changes made during a write start another. A failed write keeps
 * the changes dirty for the next change or `flush()` to retry; `flush()`
 * rejects with the failure.
 */
export function createPersistence({ file, state, log }) {
  let timer = null;
  let writing = null;
  let dirty = false;
  let failure = null;
  const startTimer = () => {
    timer ??= setTimeout(write, SAVE_DELAY_MS);
  };
  const failed = (error) => {
    dirty = true;
    failure = error;
    log.error?.("mini-monday: saving the data file failed", error);
  };
  function write() {
    clearTimeout(timer);
    timer = null;
    dirty = false;
    writing = writeAtomic(file, serialize(state))
      .then(() => {
        failure = null;
      }, failed)
      .finally(() => {
        writing = null;
        if (dirty && !failure) startTimer();
      });
    return writing;
  }
  return {
    schedule() {
      if (file === null) return;
      dirty = true;
      if (writing === null) startTimer();
    },
    async flush() {
      while (file !== null && (writing !== null || dirty)) {
        await (writing ?? write());
        if (failure) throw failure;
      }
    },
  };
}
