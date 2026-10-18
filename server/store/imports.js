/**
 * Imports (SPEC-4 §4): whole boards written as one batch, and the
 * importer's `import_finished` notification.
 *
 * `importBoard(spec)` checks everything first and only then writes the
 * board with its grants, groups, columns, views, items, updates, activity
 * and `import` metadata in one commit: one save and one `board_imported`
 * event, no per-item events and no notifications (an import must not
 * notify everyone it names). Grants follow `access.canGrant`; refused ones
 * are reported, not applied. People values keep only users who can open
 * the board (`access.canBeAssigned`, as on every write path); the ones
 * left out are reported. Activity entries name the importer as actor with
 * the import's label ("Import from monday.com"). A board that would grow
 * the data past what one save can write (`ctx.maxDataBytes`, at most
 * `persistence.js` MAX_DATA_BYTES, from an estimate of its records) is
 * refused as invalid.
 */
import {
  GRANT_REFUSALS,
  canBeAssigned,
  canGrant,
  isActive,
  maxRole,
} from "../access.js";
import { isValidStoredValue } from "../column-values.js";
import { LIMITS, isPlainObject } from "../input.js";
import {
  BOARD_KINDS,
  COLUMN_TYPES,
  IMPORT_SOURCES,
  byId,
  commit,
  invalid,
  nextId,
  push,
  readChoice,
  readColor,
  readName,
  readText,
  slugify,
} from "../store-state.js";
import { insertNotification, mention, recordActivity } from "./activity.js";
import { insertView, makeColumn } from "./boards.js";

const MAX_SOURCE_ID = 255;
const MAX_URL = 2048;
const MAX_LABELS = 200;
const WEB_URL = /^https?:\/\/\S+$/i;
// Saved characters of an item or update record besides its texts and
// values (IDs, positions, states, timestamps), and of the board's other
// records; estimates a little above what `persistence.js` writes.
const ITEM_BYTES = 240;
const UPDATE_BYTES = 140;
const BOARD_BYTES = 4096;
const COLUMN_BYTES = 200;
const MIB = 1024 * 1024;

/** `base`, else `base_2`, `base_3`… not in `taken` (which it joins). */
function freshId(base, taken) {
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}_${n}`;
  taken.add(id);
  return id;
}

function readList(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

function readUserRef(ctx, id, label) {
  if (id === null || id === undefined) return null;
  return byId(ctx.state.users, id) ? id : invalid(`${label}: unknown user`);
}

function readStamp(value, label) {
  if (value === null || value === undefined) return null;
  const valid = typeof value === "string" && Number.isFinite(Date.parse(value));
  return valid ? new Date(value).toISOString() : invalid(`${label}: bad time`);
}

function readMeta(meta) {
  if (!isPlainObject(meta)) throw new TypeError("meta must be an object");
  const { source, sourceId, sourceUrl = null } = meta;
  const id = typeof sourceId === "string" ? sourceId : "";
  if (id === "" || id.length > MAX_SOURCE_ID)
    invalid(`source_id must be 1-${MAX_SOURCE_ID} characters`);
  const url =
    sourceUrl === null
      ? null
      : typeof sourceUrl === "string" &&
          sourceUrl.length <= MAX_URL &&
          WEB_URL.test(sourceUrl)
        ? sourceUrl
        : invalid("source_url must be an http(s) URL");
  const kind = readChoice(source, IMPORT_SOURCES, "source");
  return { source: kind, source_id: id, source_url: url };
}

/** Status labels `[{ label, color }]` → column settings and a label index. */
function statusSettings(labels, title) {
  if (readList(labels ?? [], "labels").length > MAX_LABELS)
    invalid(`${title}: at most ${MAX_LABELS} status labels`);
  const settings = { labels: {}, labels_colors: {} };
  const indexes = new Map();
  for (const [index, entry] of (labels ?? []).entries()) {
    const label = readName(entry?.label, `${title} label`);
    if (indexes.has(label)) invalid(`${title}: duplicate label ${label}`);
    indexes.set(label, index);
    settings.labels[index] = label;
    settings.labels_colors[index] = readColor(entry.color, `${title} color`);
  }
  return { settings, indexes };
}

function readColumns(columns) {
  const taken = new Set(["name"]);
  const keys = new Map();
  const prepared = readList(columns, "columns").map((raw, index) => {
    const title = readName(raw?.title, "Column title");
    const type = readChoice(raw.type, COLUMN_TYPES, "Column type");
    const { settings, indexes } =
      type === "status"
        ? statusSettings(raw.labels, title)
        : { settings: {}, indexes: null };
    if (keys.has(raw.key)) invalid(`Duplicate column key at ${index}`);
    const id = freshId(type, taken);
    const column = { id, title, type, settings, indexes };
    keys.set(raw.key, column);
    return column;
  });
  return { prepared, keys };
}

function readGroups(groups) {
  const list = readList(groups, "groups");
  if (list.length === 0) invalid("An imported board needs a group");
  const taken = new Set();
  const keys = new Map();
  const prepared = list.map((raw, position) => {
    const title = readName(raw?.title, "Group name");
    const color = readColor(raw.color, "Group color");
    if (keys.has(raw.key)) invalid(`Duplicate group key at ${position}`);
    const group = {
      id: freshId(slugify(title), taken),
      title,
      color,
      position,
    };
    keys.set(raw.key, group);
    return group;
  });
  return { prepared, keys };
}

/**
 * The board's grants: the importer as owner, then each requested member
 * that `canGrant` accepts (a user listed twice keeps the higher role);
 * refusals are listed with their index in `members`.
 */
function readMembers(ctx, { draft, members, importerId }) {
  const owner = { kind: "user", id: importerId, role: "owner" };
  let board = { ...draft, members: [owner] };
  const refused = [];
  const roles = new Map();
  for (const [index, raw] of readList(members, "members").entries()) {
    const { userId, role } = raw ?? {};
    if (userId === importerId) continue;
    const subject = { kind: "user", id: userId };
    const verdict = canGrant({
      resourceKind: "board",
      resource: board,
      subject,
      role,
      store: ctx.reader,
    });
    if (!verdict.ok) {
      const message = GRANT_REFUSALS[verdict.reason] ?? verdict.reason;
      refused.push({ index, userId, reason: verdict.reason, message });
      continue;
    }
    roles.set(userId, maxRole(roles.get(userId) ?? null, role));
    const grants = [...roles].map(([id, best]) => ({
      kind: "user",
      id,
      role: best,
    }));
    board = { ...board, members: [owner, ...grants] };
  }
  const added = [...roles].map(([userId, role]) => ({ userId, role }));
  return { board, refused, added };
}

/** A stored value for `column`; people limited by `assignable(id)`. */
function storedValue(ctx, { column, value, assignable }) {
  let stored = value;
  let left = [];
  if (column.type === "status") {
    if (!column.indexes.has(value)) invalid(`Unknown status label ${value}`);
    stored = { index: column.indexes.get(value) };
  } else if (column.type === "people") {
    const ids = [...new Set(readList(value, "people value"))];
    stored = ids.filter(assignable);
    left = ids.filter((id) => !assignable(id));
    if (stored.length === 0) stored = null;
  }
  const getUser = (id) => byId(ctx.state.users, id);
  if (stored !== null && !isValidStoredValue(column, stored, { getUser }))
    invalid(`Invalid value for column ${column.title}`);
  return { stored, left };
}

function readUpdates(ctx, updates) {
  return readList(updates ?? [], "updates").map((raw) => {
    const body = typeof raw?.body === "string" ? raw.body.trim() : "";
    if (body === "" || body.length > LIMITS.updateBody)
      invalid(`Update bodies must be 1-${LIMITS.updateBody} characters`);
    return {
      body,
      creator_id: readUserRef(ctx, raw.creatorId, "Update author"),
      created_at: readStamp(raw.createdAt, "Update time"),
    };
  });
}

function readItems(ctx, { items, groups, columns, assignable }) {
  const unassigned = [];
  const prepared = readList(items, "items").map((raw, index) => {
    const group = groups.get(raw?.groupKey);
    if (!group) invalid(`Item ${index} names an unknown group`);
    if (!isPlainObject(raw.values)) throw new TypeError("values: object");
    const values = {};
    for (const [key, value] of Object.entries(raw.values)) {
      const column = columns.get(key);
      if (!column) invalid(`Item ${index} names an unknown column`);
      const converted = storedValue(ctx, { column, value, assignable });
      if (converted.stored !== null) values[column.id] = converted.stored;
      if (converted.left.length > 0)
        unassigned.push({ index, columnKey: key, userIds: converted.left });
    }
    return {
      group_id: group.id,
      name: readName(raw.name, "Item name"),
      values,
      creator_id: readUserRef(ctx, raw.creatorId, "Item creator"),
      created_at: readStamp(raw.createdAt, "Item time"),
      updates: readUpdates(ctx, raw.updates),
    };
  });
  return { prepared, unassigned };
}

/** About how many characters stored value `value` adds to the data file. */
function valueBytes(key, value) {
  let size = key.length + 4;
  if (typeof value === "string") size += value.length + 2;
  else if (Array.isArray(value))
    for (const id of value) size += String(id).length + 3;
  else size += 24; // numbers and `{ index }` labels
  return size;
}

/** About how many characters `prepared`'s records add to the data file. */
function estimateBytes(prepared) {
  let size = BOARD_BYTES;
  size += prepared.columns.prepared.length * COLUMN_BYTES;
  size += prepared.groups.prepared.length * COLUMN_BYTES;
  for (const item of prepared.items.prepared) {
    size += ITEM_BYTES + item.name.length;
    for (const key in item.values) size += valueBytes(key, item.values[key]);
    for (const update of item.updates)
      size += UPDATE_BYTES + update.body.length;
  }
  return size;
}

/** Refuses a board the data file could not hold (see the module comment). */
function checkCapacity(ctx, bytes) {
  const now = ctx.persist.size();
  const max = ctx.maxDataBytes;
  if (now + bytes <= max) return;
  const shown = (n) => Math.ceil(n / MIB).toLocaleString("en-US");
  invalid(
    `the data would grow past ${shown(max)} MiB (it holds about ${shown(now)} MiB and this board adds about ${shown(bytes)} MiB)`,
  );
}

/** Checks a whole `importBoard` spec; nothing is written yet. */
function prepareBoard(ctx, spec) {
  const { state } = ctx;
  const importer = byId(state.users, spec.importerId);
  const workspace = byId(state.workspaces, spec.workspaceId);
  if (!isActive(importer) || !workspace) return null;
  const draft = {
    name: readName(spec.name, "Board name"),
    description: readText(spec.description, "Description"),
    board_kind: readChoice(spec.boardKind, BOARD_KINDS, "board_kind"),
    workspace_id: workspace.id,
  };
  const meta = readMeta(spec.meta);
  const label = readName(spec.label, "Import label");
  const access = readMembers(ctx, { ...spec, draft });
  const memo = new Map();
  const assignable = (id) => {
    if (!memo.has(id)) {
      const user = byId(state.users, id);
      memo.set(id, canBeAssigned(ctx.reader, user, access.board));
    }
    return memo.get(id);
  };
  const groups = readGroups(spec.groups);
  const columns = readColumns(spec.columns);
  const items = readItems(ctx, {
    items: spec.items,
    groups: groups.keys,
    columns: columns.keys,
    assignable,
  });
  const summary = readText(spec.summary ?? null, "Summary", LIMITS.name);
  const prepared = { ...access, meta, label, groups, columns, items, summary };
  prepared.bytes = estimateBytes(prepared);
  checkCapacity(ctx, prepared.bytes);
  return prepared;
}

function insertRecords(ctx, board, prepared) {
  const { state } = ctx;
  const at = ctx.now();
  const boardId = board.id;
  for (const group of prepared.groups.prepared) {
    const { id, title, color, position } = group;
    push(state.groups, { id, board_id: boardId, title, color, position });
  }
  const name = { id: "name", title: "Name", type: "name", settings: {} };
  for (const { id, title, type, settings } of [
    name,
    ...prepared.columns.prepared,
  ]) {
    push(
      state.columns,
      makeColumn({ id, board_id: boardId, title, type, settings }),
    );
  }
  insertView(ctx, boardId, { name: "Main table", type: "table" });
  insertView(ctx, boardId, { name: "Kanban", type: "kanban" });
  const positions = new Map();
  let updates = 0;
  for (const item of prepared.items.prepared) {
    const position = positions.get(item.group_id) ?? 0;
    positions.set(item.group_id, position + 1);
    const { updates: list, created_at, ...fields } = item;
    const record = push(state.items, {
      id: nextId(state),
      board_id: boardId,
      ...fields,
      position,
      state: "active",
      created_at: created_at ?? at,
      updated_at: at,
    });
    for (const { body, creator_id, created_at: posted } of list) {
      const update = { body, creator_id, created_at: posted ?? at };
      push(state.updates, { id: nextId(state), item_id: record.id, ...update });
      updates += 1;
    }
  }
  return updates;
}

function logImport(ctx, { board, prepared, importerId }) {
  const actor = { boardId: board.id, actorId: importerId };
  recordActivity(ctx, {
    ...actor,
    actorLabel: prepared.label,
    kind: "board_imported",
    toText: prepared.summary,
  });
  for (const { userId, role } of prepared.added) {
    recordActivity(ctx, {
      ...actor,
      actorLabel: prepared.label,
      kind: "member_added",
      toText: [mention(userId), { text: ` (${role})` }],
    });
  }
}

/**
 * Writes a checked board. Returns the result `importBoard` documents;
 * nothing here can fail, so the batch is all or nothing.
 */
function writeBoard(ctx, prepared, importerId) {
  const { state } = ctx;
  const board = push(state.boards, {
    id: nextId(state),
    ...prepared.board,
    state: "active",
    creator_id: importerId,
    import: {
      ...prepared.meta,
      imported_at: ctx.now(),
      imported_by: importerId,
    },
  });
  const updates = insertRecords(ctx, board, prepared);
  logImport(ctx, { board, prepared, importerId });
  ctx.persist.grow(prepared.bytes);
  const result = Object.freeze({
    board,
    counts: Object.freeze({
      groups: prepared.groups.prepared.length,
      columns: prepared.columns.prepared.length,
      items: prepared.items.prepared.length,
      updates,
    }),
    refused: Object.freeze(prepared.refused),
    unassigned: Object.freeze(prepared.items.unassigned),
  });
  const event = { type: "board_imported", board_id: board.id };
  return commit(
    ctx,
    { ...event, resource_kind: "board", resource_id: board.id },
    result,
  );
}

export function importApi(ctx) {
  const { state } = ctx;
  return {
    /**
     * Imports one board in one batch. `spec` = `{ workspaceId, importerId,
     * name, description, boardKind, meta: { source, sourceId, sourceUrl },
     * label, summary, members: [{ userId, role }], groups: [{ key, title,
     * color }], columns: [{ key, title, type, labels? }], items: [{
     * groupKey, name, values: { [columnKey]: value }, creatorId,
     * createdAt, updates: [{ body, creatorId, createdAt }] }] }` with
     * status values as labels and people values as user IDs. Returns `{
     * board, counts: { groups, columns, items, updates }, refused: [{
     * index, userId, reason, message }], unassigned: [{ index, columnKey,
     * userIds }] }`; null for an unknown workspace or an inactive
     * importer; a failure (nothing written) for invalid input.
     */
    importBoard(spec = {}) {
      if (!isPlainObject(spec)) throw new TypeError("spec must be an object");
      const prepared = prepareBoard(ctx, spec);
      return prepared && writeBoard(ctx, prepared, spec.importerId);
    },
    /** Boards imported from `source` record `sourceId` (re-imports). */
    listImportedBoards: (source, sourceId) =>
      state.boards.filter(
        (b) => b.import?.source === source && b.import.source_id === sourceId,
      ),
    /**
     * Tells `userId` that an import ended: one `import_finished`
     * notification (the importer is its actor, so `notify` would skip it).
     */
    recordImportFinished({ userId, text, url } = {}) {
      if (!byId(state.users, userId)) return null;
      const message = readName(text, "Notification text");
      if (typeof url !== "string" || !url.startsWith("#/"))
        invalid("url must be an app link like #/boards/1");
      const fields = { userId, kind: "import_finished", text: message, url };
      const record = insertNotification(ctx, fields);
      const event = {
        type: "notification_created",
        user_ids: [userId],
        resource_kind: "notification",
        resource_id: record.id,
      };
      return commit(ctx, event, record);
    },
  };
}
