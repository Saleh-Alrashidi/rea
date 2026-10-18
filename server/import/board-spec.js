/**
 * One snapshot board as a `store.importBoard` spec (SPEC-4 §4): members
 * of mapped users, groups, columns (plus a "Parent item" text column when
 * the board has subitems), and items in board order, each followed by its
 * subitems, with people and authors mapped to Worklane users.
 *
 * Worklane items have no parent, so a subitem becomes an item of its group
 * right after its parent, and the parent's name is kept in the "Parent
 * item" column. An update whose author has no Worklane user keeps the
 * author's name in its first line. What cannot be mapped (members and
 * people of skipped users) is returned in `notes` for the report.
 */
import { LIMITS } from "../input.js";
import { truncate } from "./snapshot-rules.js";

const PARENT_TITLE = "Parent item";

/** A key that no column of `columns` uses. */
function freshKey(base, columns) {
  const taken = new Set(columns.map((column) => column.source_id));
  let key = base;
  for (let n = 2; taken.has(key); n += 1) key = `${base}#${n}`;
  return key;
}

function parentColumn(board) {
  if (!board.items.some((item) => item.parent_source_id !== null)) return null;
  const titles = new Set(board.columns.map((c) => c.title.toLowerCase()));
  const title = titles.has(PARENT_TITLE.toLowerCase())
    ? `${PARENT_TITLE} (imported)`
    : PARENT_TITLE;
  return { key: freshKey("parent", board.columns), title, type: "text" };
}

/**
 * Item indexes in board order: every item whose parent is in the same
 * group comes right after its parent (depth first), the rest in snapshot
 * order. Validation already broke parent cycles.
 */
export function itemOrder(items) {
  const byId = new Map(items.map((item, index) => [item.source_id, index]));
  const children = new Map();
  const roots = [];
  for (const [index, item] of items.entries()) {
    const parent = byId.get(item.parent_source_id);
    const nested =
      parent !== undefined &&
      items[parent].group_source_id === item.group_source_id;
    if (!nested) {
      roots.push(index);
      continue;
    }
    children.set(parent, [...(children.get(parent) ?? []), index]);
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

function itemValues(item, ctx) {
  const { columns, people, notes, parent, parentName } = ctx;
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
  if (parent && parentName) entries.push([parent.key, parentName]);
  return Object.fromEntries(entries);
}

function itemUpdates(item, { people, sourceName }) {
  return item.updates.map((update) => {
    const author = people.get(update.author_source_id) ?? null;
    const creatorId = author?.userId ?? null;
    const name = update.author_name ?? author?.name ?? null;
    const body =
      creatorId === null && name !== null
        ? truncate(
            `${name} wrote on ${sourceName}:\n${update.body}`,
            LIMITS.updateBody,
          )
        : update.body;
    return { body, creatorId, createdAt: update.created_at };
  });
}

/**
 * The spec for `board`. `people` maps user source IDs to `{ userId (null
 * when skipped), name }`. Returns `{ spec: { members, groups, columns,
 * items }, memberIndex, itemIndex, notes: { members: [names], people:
 * Map(column key → { names: Set, items }) } }`, where `memberIndex[i]` /
 * `itemIndex[i]` is the snapshot index of `spec.members[i]` /
 * `spec.items[i]`.
 */
export function boardSpec(board, { people, sourceName }) {
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
  const parent = parentColumn(board);
  const columns = new Map(board.columns.map((c) => [c.source_id, c]));
  const names = new Map(board.items.map((item) => [item.source_id, item.name]));
  const itemIndex = itemOrder(board.items);
  const ctx = { columns, people, notes, parent, sourceName };
  const items = itemIndex.map((index) => {
    const item = board.items[index];
    const parentName = names.get(item.parent_source_id) ?? null;
    return {
      groupKey: item.group_source_id,
      name: item.name,
      values: itemValues(item, { ...ctx, parentName }),
      creatorId: people.get(item.creator_source_id)?.userId ?? null,
      createdAt: item.created_at,
      updates: itemUpdates(item, ctx),
    };
  });
  const groups = board.groups.map(({ source_id, title, color }) => ({
    key: source_id,
    title,
    color,
  }));
  const specColumns = board.columns.map((c) => ({
    key: c.source_id,
    title: c.title,
    type: c.type,
    labels: c.labels,
  }));
  if (parent) specColumns.push(parent);
  const spec = { members, groups, columns: specColumns, items };
  return { spec, memberIndex, itemIndex, notes };
}
