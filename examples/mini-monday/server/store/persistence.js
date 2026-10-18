/**
 * Data-file loading, validation and debounced atomic saving.
 *
 * The file holds the state as is: `{ format, next_id, users, teams, … }`.
 * Loading checks every record's fields (unknown fields are dropped), nested
 * grants, team members, doc blocks and form questions, the shared ID
 * counter and cross-record references. Invalid files throw and are never
 * overwritten, so data is never silently lost. Part-1 files
 * (`mini-monday-store/1`) are rejected as an unsupported format.
 * `mini-monday-store/2` files, which wrote people's names into texts, are
 * upgraded once (`legacy-texts.js`): the store keeps a copy of the old file
 * (`keepLegacyCopy`) and saves the result in the current format, which
 * older versions refuse as unsupported. Temp files of interrupted saves
 * are removed before loading.
 */
import {
  chmod,
  constants,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { ACCESS_ROLES, ACCOUNT_ROLES, RESOURCE_KINDS } from "../access.js";
import { ALL_SCOPES } from "../auth.js";
import { isValidStoredValue } from "../column-values.js";
import { ID_PATTERN, isColor, isPlainObject } from "../input.js";
import {
  BLOCK_TYPES,
  BOARD_KINDS,
  COLUMN_TYPES,
  DOC_VISIBILITIES,
  FORM_ACCESS,
  NOTIFICATION_KINDS,
  SCOPE_KEY,
  TEAM_ROLES,
  USER_STATUSES,
  WORKSPACE_KINDS,
  byId,
  deepFreeze,
  onBoard,
} from "../store-state.js";
import { makeColumn } from "./boards.js";
import { LEGACY_FORMAT, upgradeLegacyTexts } from "./legacy-texts.js";

export const FORMAT = "mini-monday-store/3";
const SAVE_DELAY_MS = 50;

const oneOf = (list) => (v) => list.includes(v);
const exact = (keys, check) => (v) =>
  isPlainObject(v) &&
  Object.keys(v).every((key) => keys.includes(key)) &&
  check(v);
const listOf = (check) => (v) => Array.isArray(v) && v.every(check);
const isId = (v) => typeof v === "string" && ID_PATTERN.test(v);
const isStr = (v) => typeof v === "string";
const isSlug = (v) => typeof v === "string" && /^[a-z0-9_]{1,64}$/.test(v);
const isKey = (v) => typeof v === "string" && /^[\w-]{1,64}$/.test(v);
const grant = (roles) =>
  exact(
    ["kind", "id", "role"],
    (g) =>
      (g.kind === "user" || g.kind === "team") &&
      isId(g.id) &&
      roles.includes(g.role),
  );

const CHECKS = {
  id: isId,
  slug: isSlug,
  str: isStr,
  bool: (v) => typeof v === "boolean",
  int: (v) => Number.isSafeInteger(v) && v >= 0,
  num: (v) => Number.isFinite(v),
  obj: isPlainObject,
  active: (v) => v === "active",
  type: (v) => v === "name" || COLUMN_TYPES.includes(v),
  scopes: (v) => Array.isArray(v) && v.every((s) => ALL_SCOPES.includes(s)),
  scope: (v) => typeof v === "string" && SCOPE_KEY.test(v),
  token: (v) => typeof v === "string" && /^[\w-]{1,512}$/.test(v),
  color: isColor,
  // Rich text (`store/activity.js`): a string or parts { text } / { user_id };
  // version 2 kept names in strings (`legacy-texts.js` converts them).
  rich: (v) =>
    isStr(v) ||
    (Array.isArray(v) &&
      v.length > 0 &&
      v.every(
        (part) =>
          exact(["text"], (p) => isStr(p.text))(part) ||
          exact(["user_id"], (p) => isId(p.user_id))(part),
      )),
  accountRole: oneOf(ACCOUNT_ROLES),
  userStatus: oneOf(USER_STATUSES),
  workspaceKind: oneOf(WORKSPACE_KINDS),
  boardKind: oneOf(BOARD_KINDS),
  docVisibility: oneOf(DOC_VISIBILITIES),
  formAccess: oneOf(FORM_ACCESS),
  notificationKind: oneOf(NOTIFICATION_KINDS),
  resourceKind: oneOf(RESOURCE_KINDS),
  grants: listOf(grant(ACCESS_ROLES)),
  noteShares: listOf(grant(["editor", "viewer"])),
  teamMembers: listOf(
    exact(
      ["user_id", "role"],
      (m) => isId(m.user_id) && TEAM_ROLES.includes(m.role),
    ),
  ),
  blocks: listOf(
    exact(
      ["id", "type", "text", "checked"],
      (b) =>
        isKey(b.id) &&
        BLOCK_TYPES.includes(b.type) &&
        isStr(b.text) &&
        (b.type === "todo"
          ? typeof b.checked === "boolean"
          : b.checked === undefined),
    ),
  ),
  questions: listOf(
    exact(
      ["id", "column_id", "label", "help", "required"],
      (q) =>
        isKey(q.id) &&
        isSlug(q.column_id) &&
        isStr(q.label) &&
        isStr(q.help) &&
        typeof q.required === "boolean",
    ),
  ),
};

// Persisted fields per collection as "field:check"; "?" also allows null.
// Collections starting with "id:id" take IDs from the shared counter.
const SHAPES = {
  users:
    "id:id name:str email:str role:accountRole title:str? status:userStatus color:color created_at:str",
  teams: "id:id name:str description:str? members:teamMembers created_at:str",
  workspaces:
    "id:id name:str description:str? kind:workspaceKind color:color members:grants created_by:id? created_at:str",
  boards:
    "id:id name:str description:str? state:active creator_id:id? workspace_id:id board_kind:boardKind members:grants",
  groups: "id:slug board_id:id title:str color:str position:int",
  columns: "id:slug board_id:id title:str type:type settings:obj",
  apps: "id:id name:str client_id:str client_secret:str path:str scopes:scopes",
  installs: "id:id app_id:id board_id:id",
  views: "id:id board_id:id name:str type:str app_install_id:id?",
  items:
    "id:id board_id:id group_id:slug name:str position:num state:active " +
    "creator_id:id? created_at:str updated_at:str values:obj",
  updates: "id:id item_id:id body:str creator_id:id? created_at:str",
  docs:
    "id:id workspace_id:id title:str visibility:docVisibility members:grants blocks:blocks version:int " +
    "created_by:id? updated_by:id? created_at:str updated_at:str",
  notes:
    "id:id owner_id:id title:str body:str color:color pinned:bool shares:noteShares version:int " +
    "created_at:str updated_at:str",
  forms:
    "id:id board_id:id title:str description:str? accent_color:color questions:questions " +
    "target_group_id:slug? access:formAccess token:token submit_message:str? response_count:int " +
    "created_by:id? created_at:str updated_at:str",
  notifications:
    "id:id user_id:id kind:notificationKind text:rich url:str read:bool actor_id:id? " +
    "resource_kind:resourceKind? resource_id:id? created_at:str",
  activity:
    "id:id board_id:id actor_id:id? actor_label:str? kind:str item_id:id? item_name:str? " +
    "column_id:slug? from_text:rich? to_text:rich? created_at:str",
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

const unique = (list, key) => new Set(list.map(key)).size === list.length;

function checkCounters(state, fail) {
  const numbered = Object.keys(SHAPES).filter((name) =>
    SHAPES[name].startsWith("id:id "),
  );
  const ids = numbered.flatMap((name) => state[name].map((r) => Number(r.id)));
  if (!unique(ids, (id) => id) || ids.some((id) => id >= state.next_id)) {
    fail("duplicate or unissued IDs");
  }
  const keys = [
    unique(state.groups, (g) => `${g.board_id}/${g.id}`),
    unique(state.columns, (c) => `${c.board_id}/${c.id}`),
    unique(state.storage, (s) => `${s.scope}\n${s.key}`),
    unique(state.users, (u) => u.email.toLowerCase()),
    unique(state.forms, (f) => f.token),
    state.docs.every((d) => unique(d.blocks, (b) => b.id)),
    state.forms.every((f) => unique(f.questions, (q) => q.id)),
    state.teams.every((t) => unique(t.members, (m) => m.user_id)),
  ];
  if (keys.includes(false))
    fail("duplicate keys, emails, tokens or nested IDs");
}

function checkItems(state, fail) {
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

/** References consumers rely on; others (creators, grants) may dangle. */
function checkReferences(state, fail) {
  const refs = [
    ["boards", "workspace_id", "workspaces"],
    ["docs", "workspace_id", "workspaces"],
    ["forms", "board_id", "boards"],
    ["notes", "owner_id", "users"],
    ["notifications", "user_id", "users"],
    ["activity", "board_id", "boards"],
  ];
  for (const [name, field, target] of refs) {
    const missing = state[name].find((r) => !byId(state[target], r[field]));
    if (missing) fail(`${name} ${missing.id} points at a missing ${field}`);
  }
  for (const form of state.forms) {
    const columns = form.questions.map((q) =>
      onBoard(state.columns, form.board_id, q.column_id),
    );
    if (
      columns.some((c) => !c || c.type === "people") ||
      columns[0]?.id !== "name"
    ) {
      fail(`form ${form.id} has invalid questions`);
    }
  }
}

function readCollections(doc, fail) {
  const state = { format: FORMAT, next_id: doc.next_id };
  for (const [name, shape] of Object.entries(SHAPES)) {
    const checks = fieldChecks(shape);
    if (!Array.isArray(doc[name])) fail(`${name} must be an array`);
    state[name] = doc[name].map((record, index) => {
      if (!isPlainObject(record) || !checks.every(([f, ok]) => ok(record[f])))
        fail(`${name}[${index}] is malformed`);
      const fields = checks.map(([field]) => [field, record[field]]);
      return deepFreeze(Object.fromEntries(fields));
    });
  }
  return state;
}

/**
 * Loads and validates the data file: null when it does not exist, else
 * `{ state, upgraded }` where `upgraded` is true for a converted /2 file
 * (not yet saved). Invalid files throw instead of being replaced.
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
  const upgraded = isPlainObject(doc) && doc.format === LEGACY_FORMAT;
  if (!isPlainObject(doc) || (doc.format !== FORMAT && !upgraded)) {
    fail(
      `unsupported format (expected ${FORMAT}; move the old file away to reseed)`,
    );
  }
  if (!Number.isSafeInteger(doc.next_id) || doc.next_id < 1)
    fail("invalid next_id");
  const state = readCollections(doc, fail);
  state.columns = state.columns.map((c) => deepFreeze(makeColumn(c)));
  state.groups.sort((a, b) => a.position - b.position);
  checkCounters(state, fail);
  checkItems(state, fail);
  checkReferences(state, fail);
  if (upgraded) upgradeLegacyTexts(state);
  return { state, upgraded };
}

/**
 * Copies a /2 `file` to `<file>.v2.bak` (private, like the data file)
 * before its first save in the current format, so a rollback can still
 * use it. An existing copy is kept. Returns the copy's path.
 */
export async function keepLegacyCopy(file) {
  const copy = `${file}.v2.bak`;
  try {
    await copyFile(file, copy, constants.COPYFILE_EXCL);
  } catch (error) {
    if (error?.code === "EEXIST") return copy;
    throw error;
  }
  await chmod(copy, 0o600);
  return copy;
}

function serialize(state) {
  const columns = state.columns.map(({ settings_str: _derived, ...c }) => c);
  return `${JSON.stringify({ ...state, columns }, null, 2)}\n`;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const TEMP_NAME = new RegExp(`^\\.(.+)\\.${UUID}\\.tmp$`);

/**
 * Deletes the temp files that interrupted saves of `file` left behind (a
 * process killed mid-write): each is a full or partial copy of the data,
 * tokens and app secrets included. Run before loading; one store process
 * owns a data file, so no live writer can still own them. Returns the
 * removed names.
 */
export async function removeStaleTemps(file) {
  const directory = path.dirname(file);
  const base = path.basename(file);
  let names;
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const stale = names.filter((name) => TEMP_NAME.exec(name)?.[1] === base);
  const remove = (name) =>
    unlink(path.join(directory, name)).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  await Promise.all(stale.map(remove));
  return stale;
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
