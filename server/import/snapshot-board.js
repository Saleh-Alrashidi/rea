/**
 * Boards of an import snapshot (SPEC-4 §2 `Board`): members, groups,
 * items with their values (`snapshot-columns.js`), subitem parents and
 * updates. Used by `validateSnapshot`; see `snapshot.js` for what errors
 * and warnings mean. Item and parent references that cannot be resolved
 * are cleared with a warning, parent cycles are broken, and an item
 * nested deeper than Worklane's MAX_SUBITEM_DEPTH becomes a subitem of
 * its deepest ancestor that is allowed to have one (`subitems_flattened`).
 * Beyond SPEC-4 §2, an update may carry its `replies` (updates, one level;
 * SPEC-6 §2.1), absent when it has none. `readBoard` is a generator that yields every ITEMS_PER_STEP items
 * (`slices.js`).
 *
 * Beyond SPEC-4 §2, a Board may say where it sits in its source: `folder`
 * (`{ source_id, name }`, or null when it is in none) and `source_name`
 * (its own name, where `name` may also name the folder). Both are
 * optional for every source; an invalid one is left out with a warning
 * (unknown, not "in no folder").
 */
import { ACCESS_ROLES, ROLE_RANK } from "../access.js";
import { LIMITS, isPlainObject } from "../input.js";
import { BOARD_KINDS, GROUP_COLOR, deepFreeze } from "../store-state.js";
import { fitText } from "../mentions.js";
import { MAX_SUBITEM_DEPTH } from "../store/subitems.js";
import {
  capLabels,
  checkRoles,
  readColumns,
  readValues,
} from "./snapshot-columns.js";
import {
  readArray,
  readChoice,
  readColor,
  readName,
  readObject,
  readOptionalText,
  readSourceId,
  readTime,
  readUrl,
  shown,
  sourceIdText,
  truncate,
  uniqueSourceId,
} from "./snapshot-rules.js";

export const BOARD_LIMITS = Object.freeze({ members: 1_000, groups: 500 });
const ITEMS_PER_STEP = 64;

// ------------------------------------------------------------------- items

/**
 * One update without its replies: null on an error, undefined when it is
 * left out (empty). The body is cut so that its stored form (mention
 * tokens escaped, `mentions.fitText`) fits LIMITS.updateBody.
 */
function readUpdate(c, raw, { path, users, scope }) {
  if (!readObject(c, raw, path)) return null;
  if (typeof raw.body !== "string") {
    c.error(`${path}.body`, "invalid_type", "Expected a string");
    return null;
  }
  const body = raw.body.trim();
  if (body === "") {
    c.repeat(scope, "empty_update", path, "An empty update was left out");
    return undefined;
  }
  const fitted = fitText(body, LIMITS.updateBody);
  if (fitted !== body) {
    const message = `An update longer than ${LIMITS.updateBody} characters was cut`;
    c.repeat(scope, "truncated", path, message);
  }
  const authorId = refId(raw.author_source_id);
  const name =
    typeof raw.author_name === "string" && raw.author_name.trim() !== ""
      ? truncate(raw.author_name.trim(), LIMITS.name)
      : null;
  const known = authorId !== null && users.has(authorId);
  if (authorId !== null && !known && name === null)
    c.repeat(
      scope,
      "unknown_user",
      path,
      "An unknown update author was left out",
    );
  return {
    body: fitted,
    author_source_id: known ? authorId : null,
    author_name: name,
    created_at: readTime(c, raw.created_at, {
      path: `${path}.created_at`,
      scope,
    }),
  };
}

/**
 * The `replies` of update `raw` at `args.path`, read as replies (one
 * level: replies of a reply join its thread, `replies_flattened`).
 */
function readReplies(c, raw, args) {
  const { path, scope } = args;
  const list = raw.replies;
  if (args.reply && Array.isArray(list) && list.length > 0) {
    const message = "Replies to a reply joined its thread";
    c.repeat(scope, "replies_flattened", `${path}.replies`, message);
  }
  const at = `${path}.replies`;
  return readUpdates(c, list, { ...args, path: at, reply: true });
}

/**
 * Updates (`args.reply`: a thread's replies), each top-level one with its
 * `replies` when it has any. The replies of an empty update that was left
 * out become updates (`replies_promoted`).
 */
function readUpdates(c, raw, args) {
  const { path, totals, scope, reply = false } = args;
  const list = readArray(c, raw, {
    path,
    max: totals.maxUpdates,
    optional: true,
  });
  if (list === null) return null;
  totals.updates += list.length;
  if (totals.updates > totals.maxUpdates) {
    c.error(path, "too_large", `At most ${totals.maxUpdates} updates in all`);
    return null;
  }
  let failed = false;
  const updates = [];
  for (const [index, entry] of list.entries()) {
    const at = `${path}[${index}]`;
    const update = readUpdate(c, entry, { ...args, path: at });
    const thread =
      update === null ? null : readReplies(c, entry, { ...args, path: at });
    if (thread === null) failed = true;
    else if (reply) updates.push(...(update ? [update] : []), ...thread);
    else if (update) {
      updates.push(thread.length > 0 ? { ...update, replies: thread } : update);
    } else if (thread.length > 0) {
      const message = "Replies to an empty update became updates";
      c.repeat(scope, "replies_promoted", at, message);
      updates.push(...thread);
    }
  }
  return failed ? null : updates;
}

/** How many updates `item` (a snapshot item) has, replies included. */
export const updateCount = (item) =>
  item.updates.reduce((n, update) => n + 1 + (update.replies?.length ?? 0), 0);

/** A reference ID (string or safe integer) as text, else null. */
function refId(value) {
  if (Number.isSafeInteger(value)) return String(value);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function readItem(c, raw, ctx) {
  const { path, scope, groups, users, taken } = ctx;
  if (!readObject(c, raw, path)) return null;
  const id = readSourceId(c, raw.source_id, `${path}.source_id`);
  const name = readName(c, raw.name, {
    path: `${path}.name`,
    fallback: "Untitled item",
    repeat: scope,
  });
  const values = readValues(c, raw.values, { ...ctx, path: `${path}.values` });
  const updates = readUpdates(c, raw.updates, {
    ...ctx,
    path: `${path}.updates`,
  });
  if (id === null || name === undefined || values === null || updates === null)
    return null;
  let group = refId(raw.group_source_id);
  if (!groups.has(group)) {
    const [first] = groups.keys();
    c.repeat(
      scope,
      "unknown_group",
      `${path}.group_source_id`,
      `The item's group ${shown(raw.group_source_id)} is unknown; it went to the first group`,
    );
    group = first;
  }
  let creator = refId(raw.creator_source_id);
  if (creator !== null && !users.has(creator)) {
    c.repeat(
      scope,
      "unknown_user",
      `${path}.creator_source_id`,
      `Unknown creator ${shown(creator)} was left out`,
    );
    creator = null;
  }
  return {
    path,
    source_id: uniqueSourceId(c, { id, taken, path, scope }),
    name,
    group_source_id: group,
    parent_source_id: refId(raw.parent_source_id),
    values,
    created_at: readTime(c, raw.created_at, {
      path: `${path}.created_at`,
      scope,
    }),
    creator_source_id: creator,
    updates,
  };
}

/** Clears unknown parents and breaks parent cycles (each item walked once). */
function resolveParents(c, items, scope) {
  const byId = new Map(items.map((item) => [item.source_id, item]));
  for (const item of items) {
    if (item.parent_source_id === null || byId.has(item.parent_source_id))
      continue;
    const message = `Parent ${shown(item.parent_source_id)} is unknown; the item was imported without one`;
    c.repeat(scope, "unknown_parent", `${item.path}.parent_source_id`, message);
    item.parent_source_id = null;
  }
  const done = new Set();
  for (const item of items) {
    const trail = new Set();
    let current = item;
    while (current && !done.has(current)) {
      trail.add(current);
      const parent = current.parent_source_id;
      let next = parent === null ? null : byId.get(parent);
      if (next && trail.has(next)) {
        // The cycle's first item on this walk becomes a top-level item.
        const path = `${next.path}.parent_source_id`;
        const message =
          "Items name each other as parents; this link was dropped";
        c.repeat(scope, "parent_cycle", path, message);
        next.parent_source_id = null;
        next = null;
      }
      current = next;
    }
    for (const each of trail) done.add(each);
  }
}

/**
 * Re-parents every item nested deeper than MAX_SUBITEM_DEPTH to its
 * ancestor at depth MAX_SUBITEM_DEPTH - 1 (top-level items have depth 0);
 * runs after `resolveParents`, so every item descends from a top-level one.
 */
function capDepth(c, items, scope) {
  const children = Map.groupBy(
    items.filter((item) => item.parent_source_id !== null),
    (item) => item.parent_source_id,
  );
  const stack = items
    .filter((item) => item.parent_source_id === null)
    .map((item) => ({ item, ancestors: [] }));
  while (stack.length > 0) {
    const entry = stack.pop();
    const { item } = entry;
    let { ancestors } = entry;
    if (ancestors.length > MAX_SUBITEM_DEPTH) {
      ancestors = ancestors.slice(0, MAX_SUBITEM_DEPTH);
      const parent = ancestors.at(-1);
      item.parent_source_id = parent.source_id;
      const message = `${shown(item.name)} was nested more than ${MAX_SUBITEM_DEPTH} levels deep; it became a subitem of ${shown(parent.name)}`;
      c.repeat(
        scope,
        "subitems_flattened",
        `${item.path}.parent_source_id`,
        message,
      );
    }
    const next = [...ancestors, item];
    for (const child of children.get(item.source_id) ?? [])
      stack.push({ item: child, ancestors: next });
  }
}

// ------------------------------------------------------------------ boards

function readGroups(c, raw, { path, scope }) {
  const list = readArray(c, raw, {
    path,
    max: BOARD_LIMITS.groups,
    optional: true,
  });
  if (list === null) return null;
  const taken = new Set();
  const groups = list.map((entry, index) => {
    const at = `${path}[${index}]`;
    if (!readObject(c, entry, at)) return null;
    const id = readSourceId(c, entry.source_id, `${at}.source_id`);
    const title = readName(c, entry.title, {
      path: `${at}.title`,
      fallback: "Untitled group",
    });
    if (id === null || title === undefined) return null;
    const color = readColor(c, entry.color, {
      path: `${at}.color`,
      fallback: GROUP_COLOR,
    });
    return {
      source_id: uniqueSourceId(c, { id, taken, path: at, scope }),
      title,
      color,
    };
  });
  if (groups.includes(null)) return null;
  // A board always has a group (SPEC-4 §3.3 names it "Imported").
  return groups.length > 0
    ? groups
    : [{ source_id: "imported", title: "Imported", color: GROUP_COLOR }];
}

function readMembers(c, raw, { path, users, scope }) {
  const list = readArray(c, raw, {
    path,
    max: BOARD_LIMITS.members,
    optional: true,
  });
  if (list === null) return null;
  const roles = new Map();
  for (const [index, entry] of list.entries()) {
    const at = `${path}[${index}]`;
    if (!readObject(c, entry, at)) return null;
    const id = readSourceId(c, entry.user_source_id, `${at}.user_source_id`);
    const role = readChoice(c, entry.role, {
      path: `${at}.role`,
      choices: ACCESS_ROLES,
    });
    if (id === null || role === null) return null;
    if (!users.has(id)) {
      c.repeat(
        scope,
        "unknown_user",
        at,
        `Unknown member ${shown(id)} was left out`,
      );
      continue;
    }
    if (ROLE_RANK[role] > (ROLE_RANK[roles.get(id)] ?? 0)) roles.set(id, role);
  }
  return [...roles].map(([user_source_id, role]) => ({ user_source_id, role }));
}

function* readItems(c, raw, ctx) {
  const { path, totals } = ctx;
  const list = readArray(c, raw, {
    path,
    max: totals.maxItems,
    optional: true,
  });
  if (list === null) return null;
  totals.items += list.length;
  if (totals.items > totals.maxItems) {
    c.error(path, "too_large", `At most ${totals.maxItems} items in all`);
    return null;
  }
  const taken = new Set();
  const items = [];
  for (const [index, entry] of list.entries()) {
    if (index % ITEMS_PER_STEP === ITEMS_PER_STEP - 1) yield;
    const item = readItem(c, entry, {
      ...ctx,
      path: `${path}[${index}]`,
      taken,
    });
    items.push(item);
    if (item === null) continue;
    // Frozen here, in steps, so freezing the whole snapshot is quick.
    deepFreeze(item.values);
    deepFreeze(item.updates);
    // What one import can store (snapshot.js SNAPSHOT_LIMITS.values).
    totals.values += Object.keys(item.values).length;
    if (totals.values > totals.maxValues) {
      const limit = totals.maxValues.toLocaleString("en-US");
      c.error(path, "too_large", `At most ${limit} values in all`);
      return null;
    }
  }
  return items.includes(null) ? null : items;
}

// --------------------------------------------------------------- placement

/** The board's `folder`: null when in none, undefined when absent or bad. */
function readFolder(c, raw, path) {
  if (raw === undefined || raw === null) return raw;
  const id = isPlainObject(raw) ? sourceIdText(raw.source_id) : null;
  if (id === null || typeof raw.name !== "string") {
    const message = `Folder ${shown(raw)} is not { source_id, name }; it was left out`;
    c.warn(path, "invalid_folder", message);
    return undefined;
  }
  const name = readName(c, raw.name, {
    path: `${path}.name`,
    fallback: "Untitled folder",
  });
  return { source_id: id, name };
}

/** The board's `source_name` (trimmed, cut); undefined when absent or bad. */
function readSourceName(c, value, path) {
  if (value === undefined || value === null) return undefined;
  // Non-blank, so readName only trims and cuts (its fallback is unused).
  if (typeof value === "string" && value.trim() !== "")
    return readName(c, value, { path, fallback: "" });
  const message = `Source name ${shown(value)} is not a name; it was left out`;
  c.warn(path, "invalid_source_name", message);
  return undefined;
}

/** `{ folder?, source_name? }`: only what the snapshot validly says. */
function readPlacement(c, raw, path) {
  const placement = {};
  const folder = readFolder(c, raw.folder, `${path}.folder`);
  if (folder !== undefined) placement.folder = folder;
  const name = readSourceName(c, raw.source_name, `${path}.source_name`);
  if (name !== undefined) placement.source_name = name;
  return placement;
}

function publicColumn({ source_id, title, type, original_type, ...rest }) {
  const column = { source_id, title, type, original_type };
  if (rest.role !== undefined) column.role = rest.role;
  if (type === "status") column.labels = rest.labels;
  return column;
}

const publicItem = ({ path: _path, ...item }) => item;

/**
 * Reads one board at `path` (a generator, see the module comment). `users`
 * is the Set of user source IDs and `totals` counts items, values and
 * updates across boards (`{ items, values, updates, maxItems, maxValues,
 * maxUpdates }`). Returns the normalized board or null (errors).
 */
export function* readBoard(c, raw, { path, users, totals }) {
  if (!readObject(c, raw, path)) return null;
  const head = {
    source_id: readSourceId(c, raw.source_id, `${path}.source_id`),
    name: readName(c, raw.name, {
      path: `${path}.name`,
      fallback: "Untitled board",
    }),
    description: readOptionalText(c, raw.description, {
      path: `${path}.description`,
      max: LIMITS.description,
    }),
    kind: readChoice(c, raw.kind, {
      path: `${path}.kind`,
      choices: BOARD_KINDS,
    }),
    source_url: readUrl(c, raw.source_url, `${path}.source_url`),
    ...readPlacement(c, raw, path),
  };
  const scope = { path, label: `board “${head.name ?? "?"}”` };
  const members = readMembers(c, raw.members, {
    path: `${path}.members`,
    users,
    scope,
  });
  const columns = readColumns(c, raw.columns, {
    path: `${path}.columns`,
    scope,
  });
  const groups = readGroups(c, raw.groups, { path: `${path}.groups`, scope });
  const byColumn = new Map();
  for (const column of columns.columns) {
    if (!byColumn.has(column.source_id)) byColumn.set(column.source_id, column);
  }
  const byGroup = new Map((groups ?? []).map((g) => [g.source_id, g]));
  const itemPath = `${path}.items`;
  const items = yield* readItems(c, raw.items, {
    path: itemPath,
    scope,
    columns: byColumn,
    groups: byGroup,
    users,
    totals,
  });
  const broken =
    head.source_id === null ||
    head.name === undefined ||
    head.kind === null ||
    head.description === undefined;
  const parts = [items, groups, members].includes(null) || !columns.ok;
  if (parts || broken) return null;
  resolveParents(c, items, scope);
  capDepth(c, items, scope);
  capLabels(c, columns.columns);
  checkRoles(c, columns.columns);
  c.flush(scope);
  return {
    ...head,
    members,
    columns: columns.columns.map(publicColumn),
    groups,
    items: items.map(publicItem),
  };
}
