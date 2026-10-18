/**
 * Boards of the monday.com connector (SPEC-4 §3.1): board fields, members
 * (owners → owner, subscribers → editor), groups, items and subitems
 * (subitems follow their parent, in the parent's group, with
 * `parent_source_id`), and updates with their replies (plain text, oldest
 * first; HTML is never kept). `createBoard` builds a board from its listing
 * row; `addItems` converts each page of items as it arrives. Lists are kept
 * within the snapshot's limits, with a warning for what is left out.
 */
import { BOARD_LIMITS } from "../snapshot-board.js";
import { addColumn, readOther, subitemPlan } from "./monday-columns.js";
import {
  colorOf,
  htmlText,
  idOf,
  limitHit,
  listOf,
  scopeAt,
  str,
} from "./monday-common.js";

const BOARD_KINDS = new Set(["public", "private", "share"]);
const GROUP_COLOR = "#579bfc";
/** monday returns at most this many updates per item in one request. */
export const UPDATES_PER_ITEM = 100;

function boardMembers(raw, scope) {
  const roles = new Map();
  const add = (users, role) => {
    for (const user of listOf(users)) {
      const id = idOf(user.id);
      if (id === null || roles.has(id)) continue;
      if (roles.size >= BOARD_LIMITS.members) {
        const message = `Only the first ${BOARD_LIMITS.members} board members were imported`;
        scope.count("members_capped", message);
        continue;
      }
      roles.set(id, role);
    }
  };
  add(raw.owners, "owner");
  add(raw.subscribers, "editor");
  return [...roles].map(([user_source_id, role]) => ({ user_source_id, role }));
}

function addGroup(state, raw) {
  const id = idOf(raw.id);
  if (id === null || state.groupIds.has(id)) return;
  if (state.board.groups.length >= BOARD_LIMITS.groups) {
    const message = `Only the first ${BOARD_LIMITS.groups} groups were imported; items of the others went to the first group`;
    state.scope.count("groups_capped", message);
    return;
  }
  const color = colorOf(raw.color, GROUP_COLOR);
  state.board.groups.push({ source_id: id, title: str(raw.title), color });
  state.groupIds.add(id);
}

/**
 * The board of listing row `raw` at snapshot `path`, without items, and
 * the conversion state `addItems` needs.
 */
export function createBoard(ctx, raw, path) {
  const scope = scopeAt(ctx.report, path);
  const board = {
    source_id: idOf(raw.id),
    name: str(raw.name),
    description: typeof raw.description === "string" ? raw.description : null,
    kind: BOARD_KINDS.has(raw.board_kind) ? raw.board_kind : "private",
    source_url: idOf(raw.url),
    members: boardMembers(raw, scope),
    columns: [],
    groups: [],
    items: [],
  };
  const state = {
    board,
    path,
    scope,
    plans: new Map(),
    subPlans: new Map(),
    groupIds: new Set(),
  };
  for (const column of listOf(raw.columns)) addColumn(ctx, state, column);
  for (const group of listOf(raw.groups)) addGroup(state, group);
  return state;
}

function updateText(raw) {
  if (typeof raw.text_body === "string") return raw.text_body.trim();
  return htmlText(raw.body);
}

function addUpdate(ctx, state, updates, raw) {
  if (ctx.counts.updates >= ctx.limits.updates) {
    limitHit(ctx, "updates", state.path);
    return;
  }
  ctx.counts.updates += 1;
  const text = updateText(raw);
  const name = str(raw.creator?.name).trim();
  updates.push({
    body: text !== "" && raw.reply ? `Reply: ${text}` : text,
    author_source_id: idOf(raw.creator?.id),
    author_name: name === "" ? null : name,
    created_at: idOf(raw.created_at),
  });
}

const timeOf = (update) => {
  const time = Date.parse(update.created_at ?? "");
  return Number.isFinite(time) ? time : Number.MAX_VALUE;
};

function readUpdates(ctx, state, raws) {
  if (!Array.isArray(raws)) return [];
  if (raws.length >= UPDATES_PER_ITEM) {
    const message = `Items with ${UPDATES_PER_ITEM} or more updates kept only their latest ${UPDATES_PER_ITEM}`;
    state.scope.count("updates_capped", message);
  }
  const updates = [];
  for (const raw of listOf(raws)) {
    addUpdate(ctx, state, updates, raw);
    for (const reply of listOf(raw.replies)) {
      addUpdate(ctx, state, updates, { ...reply, reply: true });
    }
  }
  // monday lists updates newest first; Worklane keeps them in time order.
  return updates.sort((a, b) => timeOf(a) - timeOf(b));
}

function addValues(ctx, state, item, raw) {
  const subitem = item.parent_source_id !== null;
  for (const cv of listOf(raw.column_values)) {
    const id = str(cv.id);
    const plan = subitem ? subitemPlan(ctx, state, cv) : state.plans.get(id);
    // A column the board does not list: its text goes to the snapshot,
    // which reports the unknown column.
    const value = plan ? plan.read(plan, cv) : undefined;
    if (value !== undefined) item.values[plan.column.source_id] = value;
    else if (plan === undefined && readOther(null, cv) !== undefined) {
      item.values[id] = readOther(null, cv);
    }
  }
}

function addItem(ctx, state, raw, parent) {
  const id = idOf(raw.id);
  if (id === null) return;
  if (ctx.counts.items >= ctx.limits.items) {
    limitHit(ctx, "items", state.path);
    return;
  }
  ctx.counts.items += 1;
  const item = {
    source_id: id,
    name: str(raw.name),
    group_source_id: parent ? parent.group_source_id : idOf(raw.group?.id),
    parent_source_id: parent ? parent.source_id : null,
    values: {},
    created_at: idOf(raw.created_at),
    creator_source_id: idOf(raw.creator?.id),
    updates: readUpdates(ctx, state, raw.updates),
  };
  addValues(ctx, state, item, raw);
  state.board.items.push(item);
  if (parent) return;
  for (const subitem of listOf(raw.subitems))
    addItem(ctx, state, subitem, item);
}

/** Converts one page of monday items (with subitems) onto the board. */
export function addItems(ctx, state, rawItems) {
  for (const raw of listOf(rawItems)) addItem(ctx, state, raw, null);
}
