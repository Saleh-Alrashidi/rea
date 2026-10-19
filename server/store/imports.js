/**
 * Imports (SPEC-4 §4, SPEC-5 §2): whole boards written as one batch, and
 * the importer's `import_finished` notification.
 *
 * `importBoard(spec)` checks everything first (`import-spec.js` reads the
 * columns, groups, items and views) and only then writes the board with
 * its grants, groups, columns, views, items (subitems with their
 * `parent_id`), updates (replies with their `parent_update_id`), activity
 * and `import` metadata in one commit: one save and one `board_imported`
 * event, no per-item events and no notifications (an import must not
 * notify everyone it names). Grants
 * follow `access.canGrant`; refused ones are reported, not applied. People
 * values keep only users who can open the board (`access.canBeAssigned`,
 * as on every write path); the ones left out are reported. Activity
 * entries name the importer as actor with the import's label ("Import
 * from monday.com"). The board's `import` record keeps the source record
 * and, when the spec's `meta` has them, the source `folder` and the
 * board's own `source_name` (for placing it in folders later). A board
 * that would grow the data past what one save can write
 * (`ctx.maxDataBytes`, at most `persistence.js` MAX_DATA_BYTES, from an
 * estimate of its records) is refused as invalid.
 */
import {
  GRANT_REFUSALS,
  canBeAssigned,
  canGrant,
  isActive,
  maxRole,
} from "../access.js";
import { LIMITS, isPlainObject } from "../input.js";
import {
  BOARD_KINDS,
  IMPORT_SOURCES,
  byId,
  commit,
  invalid,
  nextId,
  push,
  readChoice,
  readName,
  readText,
} from "../store-state.js";
import { insertNotification, mention, recordActivity } from "./activity.js";
import { insertView, makeColumn } from "./boards.js";
import {
  readColumns,
  readGroups,
  readItems,
  readList,
  readViews,
} from "./import-spec.js";
import { POSITION_SPACING, nextItemPosition } from "./positions.js";
import { insertUpdate } from "./updates.js";

const MAX_SOURCE_ID = 255;
const MAX_URL = 2048;
const WEB_URL = /^https?:\/\/\S+$/i;
// Saved characters of an item or update record besides its texts and
// values (IDs, positions, states, timestamps), and of the board's other
// records; estimates a little above what `persistence.js` writes.
const ITEM_BYTES = 260;
const UPDATE_BYTES = 160;
const BOARD_BYTES = 4096;
const COLUMN_BYTES = 200;
const LABEL_BYTES = 48;
const MIB = 1024 * 1024;

function readSourceId(value, label) {
  const id = typeof value === "string" ? value : "";
  if (id === "" || id.length > MAX_SOURCE_ID)
    invalid(`${label} must be 1-${MAX_SOURCE_ID} characters`);
  return id;
}

/**
 * The optional `folder` (`{ sourceId, name }`) and `sourceName` of `meta`
 * as `import` keys; absent (never null) when not given.
 */
function readPlacement({ folder = null, sourceName = null }) {
  const placement = {};
  if (folder !== null) {
    if (!isPlainObject(folder))
      throw new TypeError("meta.folder must be an object");
    placement.folder = {
      source_id: readSourceId(folder.sourceId, "folder source_id"),
      name: readName(folder.name, "Folder name"),
    };
  }
  if (sourceName !== null)
    placement.source_name = readName(sourceName, "Source name");
  return placement;
}

function readMeta(meta) {
  if (!isPlainObject(meta)) throw new TypeError("meta must be an object");
  const { source, sourceId, sourceUrl = null } = meta;
  const id = readSourceId(sourceId, "source_id");
  const url =
    sourceUrl === null
      ? null
      : typeof sourceUrl === "string" &&
          sourceUrl.length <= MAX_URL &&
          WEB_URL.test(sourceUrl)
        ? sourceUrl
        : invalid("source_url must be an http(s) URL");
  const kind = readChoice(source, IMPORT_SOURCES, "source");
  const placement = readPlacement(meta);
  return { source: kind, source_id: id, source_url: url, ...placement };
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
  // Plus the board's `import` record (source, folder, names) as written.
  let size = BOARD_BYTES + JSON.stringify(prepared.meta).length;
  size += prepared.groups.prepared.length * COLUMN_BYTES;
  for (const { settings } of prepared.columns.prepared) {
    size += COLUMN_BYTES;
    for (const label of Object.values(settings.labels ?? {}))
      size += LABEL_BYTES + label.length;
  }
  for (const item of prepared.items.prepared) {
    size += ITEM_BYTES + item.name.length;
    for (const key in item.values) size += valueBytes(key, item.values[key]);
    for (const update of item.updates.flatMap((u) => [u, ...u.replies]))
      size +=
        UPDATE_BYTES + update.body.length + (update.author_name ?? "").length;
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
  const views = readViews(spec.views);
  const summary = readText(spec.summary ?? null, "Summary", LIMITS.name);
  const parts = { meta, label, groups, columns, items, views, summary };
  const prepared = { ...access, ...parts };
  prepared.bytes = estimateBytes(prepared);
  checkCapacity(ctx, prepared.bytes);
  return prepared;
}

/** `insertUpdate` fields of a prepared update (`import-spec.js`). */
const updateFields = (itemId, update, at) => ({
  itemId,
  body: update.body,
  creatorId: update.creator_id,
  authorName: update.author_name ?? null,
  createdAt: update.created_at ?? at,
});

/**
 * Writes the items with their updates (replies under their update): every
 * item gets its ID first, so a subitem may come before its parent or sit
 * in another group. Items take board-wide positions in spec order, each
 * after the one before (SPEC-6 §1.2), so every group keeps the spec's
 * order.
 */
function insertItems(ctx, board, items) {
  const { state } = ctx;
  const at = ctx.now();
  const ids = items.map(() => nextId(state));
  const first = nextItemPosition(state.items, board.id);
  let updates = 0;
  for (const [index, item] of items.entries()) {
    const position = first + index * POSITION_SPACING;
    const { updates: list, created_at, parent, ...fields } = item;
    push(state.items, {
      id: ids[index],
      board_id: board.id,
      ...fields,
      ...(parent === null ? {} : { parent_id: ids[parent] }),
      position,
      state: "active",
      created_at: created_at ?? at,
      updated_at: at,
    });
    for (const { replies, ...update } of list) {
      const itemId = ids[index];
      const parent = insertUpdate(ctx, updateFields(itemId, update, at));
      for (const reply of replies) {
        const fields = updateFields(itemId, reply, at);
        insertUpdate(ctx, { ...fields, parentId: parent.id });
      }
      updates += 1 + replies.length;
    }
  }
  return updates;
}

function insertRecords(ctx, board, prepared) {
  const { state } = ctx;
  const boardId = board.id;
  for (const group of prepared.groups.prepared) {
    const { id, title, color, position } = group;
    push(state.groups, { id, board_id: boardId, title, color, position });
  }
  const name = { id: "name", title: "Name", type: "name", settings: {} };
  for (const column of [name, ...prepared.columns.prepared]) {
    const { id, title, type, settings, role } = column;
    const fields = { id, board_id: boardId, title, type, settings, role };
    push(state.columns, makeColumn(fields));
  }
  for (const view of prepared.views) insertView(ctx, boardId, view);
  return insertItems(ctx, board, prepared.items.prepared);
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
     * name, description, boardKind, meta: { source, sourceId, sourceUrl,
     * folder?: { sourceId, name }, sourceName? }, label, summary, members:
     * [{ userId, role }], groups: [{ key, title, color }], columns: [{
     * key, title, type, labels?: [{ label, color, type? }], role? }],
     * items: [{ key?, parentKey?, groupKey, name, values: { [columnKey]:
     * value }, creatorId, createdAt, updates: [{ body, creatorId,
     * createdAt, authorName?, replies? }] }], views?: [{ type, name }] }`
     * with status values as labels and people values as user IDs
     * (`import-spec.js` has the rules; replies count as updates). Returns
     * `{ board, counts: {
     * groups, columns, items, updates }, refused: [{ index, userId,
     * reason, message }], unassigned: [{ index, columnKey, userIds }] }`;
     * null for an unknown workspace or an inactive importer; a failure
     * (nothing written) for invalid input.
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
