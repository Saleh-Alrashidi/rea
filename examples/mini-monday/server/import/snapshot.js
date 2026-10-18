/**
 * The normalized import snapshot (SPEC-4 §2). Every connector produces
 * this shape and the engine reads only what `validateSnapshot` returns, so
 * this module (with `snapshot-board.js` and `snapshot-rules.js`) is the
 * one place that decides what a snapshot may hold.
 *
 * `validateSnapshot(snapshot)` → `{ ok, snapshot, errors }`:
 *
 * - `errors` (`{ code, message, path }`, path like
 *   `workspaces[0].boards[2].columns[5].type`) are structural: a wrong
 *   type, an unknown enum value, a missing or duplicate workspace, board
 *   or doc ID, or more than SNAPSHOT_LIMITS allow. Any error makes `ok`
 *   false and `snapshot` null.
 * - Otherwise `snapshot` is a normalized copy: names trimmed (empty ones
 *   become "Untitled …") and cut to Worklane limits, colors and links
 *   checked, values in their column's format, references to users,
 *   groups, parents and columns resolved, duplicate user, column, group
 *   and item IDs merged or renamed, and doc blocks mapped to Worklane
 *   block types. Every change that loses or alters information adds a
 *   warning `{ code, message, path }` after the connector's own
 *   `warnings`. The normalized snapshot is frozen, and validating it
 *   again returns it as it is (preview and run do not check it twice).
 *
 * Beyond SPEC-4 §2, a Doc may say `visibility: "workspace" | "private"`;
 * it defaults to "private" (only the importer), because a source doc's
 * audience is unknown unless the connector knows it.
 */
import { LIMITS } from "../input.js";
import {
  BLOCK_TYPES,
  DOC_VISIBILITIES,
  IMPORT_SOURCES,
  InputError,
  WORKSPACE_KINDS,
  deepFreeze,
} from "../store-state.js";
import { readEmail } from "../store/people.js";
import { readBoard } from "./snapshot-board.js";
import {
  createChecker,
  readArray,
  readChoice,
  readName,
  readObject,
  readOptionalText,
  readSourceId,
  shown,
  truncate,
} from "./snapshot-rules.js";

export { WORKLANE_COLORS, nearestColor } from "./snapshot-rules.js";

export const SNAPSHOT_LIMITS = Object.freeze({
  users: 10_000,
  workspaces: 1_000,
  boards: 1_000,
  docs: 1_000,
  items: 100_000,
  updates: 50_000,
  // Blocks a source doc may list (Worklane keeps LIMITS.blocks of them).
  blocks: 20_000,
  // Connector warnings, including those of an earlier validation.
  warnings: 20_000,
});
/** How the importer names each source (activity labels, reports). */
export const SOURCE_NAMES = Object.freeze({
  monday: "monday.com",
  clickup: "ClickUp",
  csv: "CSV",
  xlsx: "Excel",
});
const WARNING_CODE = /^[\w.:-]{1,64}$/;
const MAX_WARNING_MESSAGE = 2000;
const MAX_WARNING_PATH = 1000;

// ------------------------------------------------------------------- users

function readUserEmail(c, value, { path, scope }) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    c.error(path, "invalid_type", "Expected a string or null");
    return undefined;
  }
  try {
    return readEmail(value);
  } catch (error) {
    if (!(error instanceof InputError)) throw error;
    c.repeat(
      scope,
      "invalid_email",
      path,
      `Email ${shown(value)} is not valid and was left out`,
    );
    return null;
  }
}

function readUser(c, entry, { path, scope }) {
  if (!readObject(c, entry, path)) return null;
  const id = readSourceId(c, entry.source_id, `${path}.source_id`);
  const email = readUserEmail(c, entry.email, { path: `${path}.email`, scope });
  const fallback = email?.split("@")[0] ?? "Unknown user";
  const missing = entry.name === undefined || entry.name === null;
  if (missing)
    c.repeat(
      scope,
      "empty_name",
      `${path}.name`,
      `A user without a name is called “${fallback}”`,
    );
  const name = missing
    ? fallback
    : readName(c, entry.name, {
        path: `${path}.name`,
        fallback,
        repeat: scope,
      });
  if (id === null || email === undefined || name === undefined) return null;
  return { source_id: id, name, email };
}

function readUsers(c, raw) {
  const list = readArray(c, raw, { path: "users", max: SNAPSHOT_LIMITS.users });
  if (list === null) return null;
  const scope = { path: "users", label: "users" };
  const users = [];
  const ids = new Set();
  let broken = false;
  for (const [index, entry] of list.entries()) {
    const path = `users[${index}]`;
    const user = readUser(c, entry, { path, scope });
    if (user === null) {
      broken = true;
      continue;
    }
    if (ids.has(user.source_id)) {
      c.repeat(
        scope,
        "duplicate_user",
        path,
        `User ${shown(user.source_id)} is listed twice; the first entry is used`,
      );
      continue;
    }
    ids.add(user.source_id);
    users.push(user);
  }
  c.flush(scope);
  return broken ? null : { users, ids };
}

// -------------------------------------------------------------------- docs

function readBlock(c, entry, { path, scope }) {
  if (!readObject(c, entry, path)) return null;
  let type = entry.type;
  if (!BLOCK_TYPES.includes(type)) {
    c.repeat(
      scope,
      "unknown_block",
      `${path}.type`,
      `Block type ${shown(type)} became a paragraph`,
    );
    type = "paragraph";
  }
  const raw = entry.text ?? "";
  if (typeof raw !== "string") {
    c.error(`${path}.text`, "invalid_type", "Expected a string");
    return null;
  }
  if (raw.length > LIMITS.blockText)
    c.repeat(
      scope,
      "truncated",
      `${path}.text`,
      `Block text longer than ${LIMITS.blockText} characters was cut`,
    );
  const block = {
    type,
    text: type === "divider" ? "" : truncate(raw, LIMITS.blockText),
  };
  return type === "todo"
    ? { ...block, checked: entry.checked === true }
    : block;
}

function readDoc(c, entry, { path, seen }) {
  if (!readObject(c, entry, path)) return null;
  const id = readSourceId(c, entry.source_id, `${path}.source_id`);
  const title = readName(c, entry.title, {
    path: `${path}.title`,
    fallback: "Untitled doc",
  });
  const visibility =
    entry.visibility === undefined || entry.visibility === null
      ? "private"
      : readChoice(c, entry.visibility, {
          path: `${path}.visibility`,
          choices: DOC_VISIBILITIES,
        });
  const blocksPath = `${path}.blocks`;
  const list = readArray(c, entry.blocks, {
    path: blocksPath,
    max: SNAPSHOT_LIMITS.blocks,
    optional: true,
  });
  if (
    id === null ||
    title === undefined ||
    visibility === null ||
    list === null
  )
    return null;
  if (seen.has(id)) {
    c.error(
      `${path}.source_id`,
      "duplicate_id",
      `Doc ${shown(id)} appears twice`,
    );
    return null;
  }
  seen.add(id);
  if (list.length > LIMITS.blocks)
    c.warn(
      blocksPath,
      "truncated",
      `Only the first ${LIMITS.blocks} of ${list.length} blocks were kept`,
    );
  const scope = { path, label: `doc “${title}”` };
  const blocks = list
    .slice(0, LIMITS.blocks)
    .map((block, index) =>
      readBlock(c, block, { path: `${blocksPath}[${index}]`, scope }),
    );
  c.flush(scope);
  return blocks.includes(null)
    ? null
    : { source_id: id, title, visibility, blocks };
}

// -------------------------------------------------------------- workspaces

/** Reads `raw` entries with `read(entry, path)`; null when any fails. */
function readEach(raw, path, read) {
  const list = raw.map((entry, index) => read(entry, `${path}[${index}]`));
  return list.includes(null) ? null : list;
}

function readContent(c, raw, { path, ctx }) {
  const { totals, seen, users } = ctx;
  const boardList = readArray(c, raw.boards, {
    path: `${path}.boards`,
    max: SNAPSHOT_LIMITS.boards,
    optional: true,
  });
  const docList = readArray(c, raw.docs, {
    path: `${path}.docs`,
    max: SNAPSHOT_LIMITS.docs,
    optional: true,
  });
  if (boardList === null || docList === null) return null;
  totals.boards += boardList.length;
  totals.docs += docList.length;
  if (
    totals.boards > SNAPSHOT_LIMITS.boards ||
    totals.docs > SNAPSHOT_LIMITS.docs
  ) {
    c.error(
      path,
      "too_large",
      `At most ${SNAPSHOT_LIMITS.boards} boards and ${SNAPSHOT_LIMITS.docs} docs in all`,
    );
    return null;
  }
  const boards = readEach(boardList, `${path}.boards`, (entry, at) => {
    const board = readBoard(c, entry, { path: at, users, totals });
    if (board === null) return null;
    if (seen.boards.has(board.source_id)) {
      c.error(
        `${at}.source_id`,
        "duplicate_id",
        `Board ${shown(board.source_id)} appears twice`,
      );
      return null;
    }
    seen.boards.add(board.source_id);
    return board;
  });
  const docs = readEach(docList, `${path}.docs`, (entry, at) =>
    readDoc(c, entry, { path: at, seen: seen.docs }),
  );
  return boards === null || docs === null ? null : { boards, docs };
}

function readWorkspace(c, raw, { path, ctx }) {
  if (!readObject(c, raw, path)) return null;
  const id = readSourceId(c, raw.source_id, `${path}.source_id`);
  const name = readName(c, raw.name, {
    path: `${path}.name`,
    fallback: "Imported workspace",
  });
  const description = readOptionalText(c, raw.description, {
    path: `${path}.description`,
    max: LIMITS.description,
  });
  const kind = readChoice(c, raw.kind, {
    path: `${path}.kind`,
    choices: WORKSPACE_KINDS,
  });
  const content = readContent(c, raw, { path, ctx });
  if (id === null || name === undefined || description === undefined)
    return null;
  if (kind === null || content === null) return null;
  if (ctx.seen.workspaces.has(id)) {
    c.error(
      `${path}.source_id`,
      "duplicate_id",
      `Workspace ${shown(id)} appears twice`,
    );
    return null;
  }
  ctx.seen.workspaces.add(id);
  return { source_id: id, name, description, kind, ...content };
}

// ---------------------------------------------------------------- warnings

function readWarning(c, entry, path) {
  if (!readObject(c, entry, path)) return null;
  const { code, message, path: where } = entry;
  const valid =
    typeof code === "string" &&
    WARNING_CODE.test(code) &&
    typeof message === "string" &&
    typeof where === "string" &&
    where.length <= MAX_WARNING_PATH;
  if (valid)
    return {
      code,
      message: truncate(message, MAX_WARNING_MESSAGE),
      path: where,
    };
  c.error(
    path,
    "invalid_warning",
    "Warnings are { code, message, path } with a short word code",
  );
  return null;
}

// ------------------------------------------------------------------- entry

/** Snapshots this module returned (frozen, so they stay normalized). */
const NORMALIZED = new WeakSet();

/** Checks and normalizes `snapshot` (see the module comment). */
export function validateSnapshot(snapshot) {
  if (NORMALIZED.has(snapshot)) return { ok: true, snapshot, errors: [] };
  const c = createChecker();
  const failed = () => ({ ok: false, snapshot: null, errors: c.errors });
  if (!readObject(c, snapshot, "")) return failed();
  const source = readChoice(c, snapshot.source, {
    path: "source",
    choices: IMPORT_SOURCES,
  });
  const fallback = SOURCE_NAMES[source] ?? "Import";
  const label = readName(c, snapshot.source_label, {
    path: "source_label",
    fallback,
  });
  const rawWarnings = readArray(c, snapshot.warnings, {
    path: "warnings",
    max: SNAPSHOT_LIMITS.warnings,
    optional: true,
  });
  const incoming =
    rawWarnings &&
    readEach(rawWarnings, "warnings", (entry, at) => readWarning(c, entry, at));
  const people = readUsers(c, snapshot.users);
  const spaces = readArray(c, snapshot.workspaces, {
    path: "workspaces",
    max: SNAPSHOT_LIMITS.workspaces,
  });
  if (spaces === null) return failed();
  const totals = { boards: 0, docs: 0, items: 0, updates: 0 };
  Object.assign(totals, {
    maxItems: SNAPSHOT_LIMITS.items,
    maxUpdates: SNAPSHOT_LIMITS.updates,
  });
  const seen = { workspaces: new Set(), boards: new Set(), docs: new Set() };
  // Without users, boards are still checked (for their own errors).
  const ctx = { totals, seen, users: people?.ids ?? new Set() };
  const workspaces = readEach(spaces, "workspaces", (entry, path) =>
    readWorkspace(c, entry, { path, ctx }),
  );
  const broken = [workspaces, incoming, people].includes(null);
  if (c.errors.length > 0 || broken) return failed();
  const warnings = [...incoming, ...c.result()];
  const normalized = {
    source,
    source_label: label,
    users: people.users,
    workspaces,
    warnings,
  };
  NORMALIZED.add(deepFreeze(normalized));
  return { ok: true, snapshot: normalized, errors: [] };
}
