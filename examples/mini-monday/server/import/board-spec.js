/**
 * One snapshot board as a `store.importBoard` spec (SPEC-4 §4, SPEC-5
 * §2): members of mapped users, groups, columns (with their roles and
 * status label types), items in board order with their parents and
 * updates, and the board's views, with people and authors mapped to
 * Worklane users.
 *
 * Items keep their source ID as `key` and name their parent by its key
 * (`parentKey`), so a subitem stays a subitem of its parent whatever its
 * group; validation (`snapshot-board.js`) already cleared unknown parents,
 * broke cycles and capped the depth. An update whose author has no
 * Worklane user names the author in `authorName` and keeps its body as
 * written. ClickUp boards get CLICKUP_VIEWS (List first), other sources
 * DEFAULT_VIEWS. What cannot be mapped (members and people of skipped
 * users) is returned in `notes` for the report.
 */
import { CLICKUP_VIEWS, DEFAULT_VIEWS } from "../store/boards.js";

/**
 * Item indexes in board order: each top-level item in snapshot order,
 * followed by its subitems (depth first) whatever their groups, so within
 * every group a parent comes before its subitems. Validation already
 * broke parent cycles.
 */
export function itemOrder(items) {
  const byId = new Map(items.map((item, index) => [item.source_id, index]));
  const children = new Map();
  const roots = [];
  for (const [index, item] of items.entries()) {
    const parent = byId.get(item.parent_source_id);
    if (parent === undefined) roots.push(index);
    else if (children.has(parent)) children.get(parent).push(index);
    else children.set(parent, [index]);
  }
  const order = [];
  const stack = roots.toReversed();
  while (stack.length > 0) {
    const index = stack.pop();
    order.push(index);
    stack.push(...(children.get(index) ?? []).toReversed());
  }
  return order;
}

/** Notes what a people value lost to skipped users, per column. */
function notePeople(notes, { key, ids, people }) {
  const entry = notes.people.get(key) ?? { names: new Set(), items: 0 };
  notes.people.set(key, entry);
  entry.items += 1;
  for (const id of ids) entry.names.add(people.get(id)?.name ?? id);
}

function itemValues(item, { columns, people, notes }) {
  const entries = [];
  for (const [key, value] of Object.entries(item.values)) {
    if (columns.get(key)?.type !== "people") {
      entries.push([key, value]);
      continue;
    }
    const mapped = value.filter((id) => people.get(id)?.userId);
    const lost = value.filter((id) => !people.get(id)?.userId);
    if (lost.length > 0) notePeople(notes, { key, ids: lost, people });
    if (mapped.length > 0)
      entries.push([key, mapped.map((id) => people.get(id).userId)]);
  }
  return Object.fromEntries(entries);
}

function itemUpdates(item, people) {
  return item.updates.map((update) => {
    const author = people.get(update.author_source_id) ?? null;
    const creatorId = author?.userId ?? null;
    const name = update.author_name ?? author?.name ?? null;
    const spec = { body: update.body, creatorId, createdAt: update.created_at };
    return creatorId === null && name !== null
      ? { ...spec, authorName: name }
      : spec;
  });
}

function specColumn({ source_id, title, type, labels, role }) {
  const column = { key: source_id, title, type, labels };
  return role === undefined ? column : { ...column, role };
}

/**
 * The spec for `board` of a `source` snapshot. `people` maps user source
 * IDs to `{ userId (null when skipped), name }`. Returns `{ spec: {
 * members, groups, columns, items, views }, memberIndex, itemIndex,
 * notes: { members: [names], people: Map(column key → { names: Set,
 * items }) } }`, where `memberIndex[i]` / `itemIndex[i]` is the snapshot
 * index of `spec.members[i]` / `spec.items[i]`.
 */
export function boardSpec(board, { people, source }) {
  const notes = { members: [], people: new Map() };
  const members = [];
  const memberIndex = [];
  for (const [index, member] of board.members.entries()) {
    const person = people.get(member.user_source_id);
    if (!person?.userId) {
      notes.members.push(person?.name ?? member.user_source_id);
      continue;
    }
    members.push({ userId: person.userId, role: member.role });
    memberIndex.push(index);
  }
  const columns = new Map(board.columns.map((c) => [c.source_id, c]));
  const itemIndex = itemOrder(board.items);
  const items = itemIndex.map((index) => {
    const item = board.items[index];
    return {
      key: item.source_id,
      parentKey: item.parent_source_id,
      groupKey: item.group_source_id,
      name: item.name,
      values: itemValues(item, { columns, people, notes }),
      creatorId: people.get(item.creator_source_id)?.userId ?? null,
      createdAt: item.created_at,
      updates: itemUpdates(item, people),
    };
  });
  const groups = board.groups.map(({ source_id, title, color }) => ({
    key: source_id,
    title,
    color,
  }));
  const views = source === "clickup" ? CLICKUP_VIEWS : DEFAULT_VIEWS;
  const spec = {
    members,
    groups,
    columns: board.columns.map(specColumn),
    items,
    views,
  };
  return { spec, memberIndex, itemIndex, notes };
}
