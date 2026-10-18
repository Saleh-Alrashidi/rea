/**
 * Boards of an import snapshot (SPEC-4 §2 `Board`): members, groups,
 * items with their values (`snapshot-columns.js`), subitem parents and
 * updates. Used by `validateSnapshot`; see `snapshot.js` for what errors
 * and warnings mean. Item and parent references that cannot be resolved
 * are cleared with a warning, and parent cycles are broken.
 */
import { ACCESS_ROLES, ROLE_RANK } from "../access.js";
import { LIMITS } from "../input.js";
import { BOARD_KINDS, GROUP_COLOR } from "../store-state.js";
import { capLabels, readColumns, readValues } from "./snapshot-columns.js";
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
  truncate,
  uniqueSourceId,
} from "./snapshot-rules.js";

export const BOARD_LIMITS = Object.freeze({ members: 1_000, groups: 500 });

// ------------------------------------------------------------------- items

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
  if (body.length > LIMITS.updateBody) {
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
    body: truncate(body, LIMITS.updateBody),
    author_source_id: known ? authorId : null,
    author_name: name,
    created_at: readTime(c, raw.created_at, {
      path: `${path}.created_at`,
      scope,
    }),
  };
}

function readUpdates(c, raw, args) {
  const { path, totals } = args;
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
  const updates = list.map((entry, index) =>
    readUpdate(c, entry, { ...args, path: `${path}[${index}]` }),
  );
  return updates.includes(null) ? null : updates.filter(Boolean);
}

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

function readItems(c, raw, ctx) {
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
  const items = list.map((entry, index) =>
    readItem(c, entry, { ...ctx, path: `${path}[${index}]`, taken }),
  );
  return items.includes(null) ? null : items;
}

const publicColumn = ({ source_id, title, type, original_type, labels }) =>
  type === "status"
    ? { source_id, title, type, original_type, labels }
    : { source_id, title, type, original_type };

const publicItem = ({ path: _path, ...item }) => item;

/**
 * Reads one board at `path`. `users` is the Set of user source IDs and
 * `totals` counts items and updates across boards (`{ items, updates,
 * maxItems, maxUpdates }`). Returns the normalized board or null (errors).
 */
export function readBoard(c, raw, { path, users, totals }) {
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
  const items = readItems(c, raw.items, {
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
  capLabels(c, columns.columns);
  c.flush(scope);
  return {
    ...head,
    members,
    columns: columns.columns.map(publicColumn),
    groups,
    items: items.map(publicItem),
  };
}
