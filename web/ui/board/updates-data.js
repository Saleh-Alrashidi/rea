/**
 * Updates over GraphQL (SPEC-6 §2.1–§2.3): this module owns the shape of
 * every update request of the task view and decodes the answers once, so
 * views receive `{ id, body, parts, creator, authorName, createdAt,
 * editedAt, pinned, likesCount, likedByMe, likers, canEdit, canDelete,
 * replies, repliesCount }` records in the server's order (pinned first,
 * then newest first; replies oldest first). Their mutations are board
 * mutations (`board-data.js` `mutate`), so the board's refresh rules
 * cover them.
 *
 * Bodies are shown from `body_parts` only (the server renders mentions
 * for the reader); `body` is kept for the author's edit box
 * (`mention-tokens.js decodeBody`).
 *
 * Everything loads in pages that fit the server's field budget, so no
 * update, thread or item can make the pane unloadable:
 *
 * - top-level updates by cursor (`Item.updates_page`), UPDATES_PAGE at a
 *   time, each with its newest SHOWN_REPLIES replies and `replies_count`
 *   (`loadOlderUpdates` loads one more page, which the pane appends);
 * - a whole thread only on demand (`loadThread`: "Show N more replies"),
 *   newest first by `before_id`, THREAD_PAGE replies at a time;
 * - a page over the budget is asked for again with half as many (a page
 *   of one with a single reply at last, which every update fits: bodies
 *   hold at most 50 mentions and 50 links); the size that fit is kept
 *   for the next pages (`pageSize`, growing back after a page that fit),
 *   and what is shown stays.
 *
 * `loadUpdates` reloads what the pane shows (board refreshes) and finds a
 * route's update, `searchTasks` serves the composer's task picker: tasks
 * the author can open, matched by name, with their board and status
 * color.
 */

import { request } from "../../api.js";
import { roleColumns } from "./column-roles.js";
import { SHOWN_REPLIES, findUpdate, withThread } from "./updates-model.js";
import { decodeItem, prepareColumns, statusOption } from "./values.js";

/** Top-level updates the pane loads at first, and per "Show older". */
export const UPDATES_PAGE = 25;
/** How many top-level updates a route's update is looked for among. */
export const MAX_UPDATES = 500;
/** Replies per request when a whole thread loads. */
const THREAD_PAGE = 100;
/** Likers each update names (the count says how many there are). */
const LIKERS_SHOWN = 10;
const BUDGET_ERROR = "COMPLEXITY_BUDGET_EXHAUSTED";
/** Search results read for the task picker (the API's maximum). */
const SEARCH_LIMIT = 50;
const MAX_TASKS = 20;
const ITEM_URL = /^#\/boards\/(\d{1,20})\/items\/(\d{1,20})$/;

const UPDATE_FIELDS = `fragment UpdateFields on Update {
  id body author_name created_at edited_at pinned
  likes_count liked_by_me can_edit can_delete
  creator { id name initials color }
  likers(limit: ${LIKERS_SHOWN}) { id name }
  body_parts { type text user { id } team { id } item_id board_id url }
}`;

const UPDATES_QUERY = `query ItemUpdates($ids: [ID!]!, $limit: Int, $cursor: String,
  $replies: Int = ${SHOWN_REPLIES}) {
  items(ids: $ids) {
    id
    updates_page(limit: $limit, cursor: $cursor) {
      cursor
      updates { ...UpdateFields replies_count replies(limit: $replies) { ...UpdateFields } }
    }
  }
}
${UPDATE_FIELDS}`;

const THREAD_QUERY = `query UpdateThread($ids: [ID!]!, $limit: Int, $before: ID) {
  updates(ids: $ids) {
    id replies_count
    replies(limit: $limit, before_id: $before) { ...UpdateFields }
  }
}
${UPDATE_FIELDS}`;

const TARGET_QUERY = `query UpdateTarget($ids: [ID!]!) {
  updates(ids: $ids) { id parent_update_id }
}`;

const TASK_SEARCH_QUERY = `query TaskPickerSearch($query: String!, $limit: Int) {
  search(query: $query, limit: $limit) { kind id title subtitle url }
}`;

const TASK_BOARDS_QUERY = `query TaskPickerBoards($ids: [ID!], $limit: Int) {
  boards(ids: $ids, limit: $limit) { id columns { id title type role settings_str } }
}`;

const TASK_STATUS_QUERY = `query TaskPickerStatus($ids: [ID!]!, $columns: [String!]) {
  items(ids: $ids) { id column_values(ids: $columns) { id text value } }
}`;

const idOf = (value) =>
  value === null || value === undefined ? null : String(value);

/** One `BodyPart` as `{ type, text, id?, boardId?, url? }`. */
function decodePart(raw) {
  const text = typeof raw.text === "string" ? raw.text : null;
  switch (raw.type) {
    case "user":
      return { type: "user", text, id: idOf(raw.user?.id) };
    case "team":
      return { type: "team", text, id: idOf(raw.team?.id) };
    case "item":
      return {
        type: "item",
        text,
        id: idOf(raw.item_id),
        boardId: idOf(raw.board_id),
      };
    case "link":
      return { type: "link", text: text ?? raw.url, url: raw.url };
    default:
      return { type: "text", text: text ?? "" };
  }
}

/** An API `Update` (with or without `replies`) as the pane's record. */
export function decodeUpdate(raw) {
  const replies = (raw.replies ?? []).map(decodeUpdate);
  const count = raw.replies_count;
  return {
    id: String(raw.id),
    body: String(raw.body ?? ""),
    parts: (raw.body_parts ?? []).map(decodePart),
    creator: raw.creator
      ? { ...raw.creator, id: String(raw.creator.id) }
      : null,
    authorName: raw.author_name ?? null,
    createdAt: raw.created_at,
    editedAt: raw.edited_at ?? null,
    pinned: raw.pinned === true,
    likesCount: Number.isSafeInteger(raw.likes_count) ? raw.likes_count : 0,
    likedByMe: raw.liked_by_me === true,
    likers: (raw.likers ?? []).map((user) => ({
      id: String(user.id),
      name: user.name,
    })),
    canEdit: raw.can_edit === true,
    canDelete: raw.can_delete === true,
    replies,
    repliesCount: Number.isSafeInteger(count) ? count : replies.length,
  };
}

// ------------------------------------------------------------- paging

/**
 * `fetch(shape)` for the first of `shapes` whose answer fits the field
 * budget: `{ shape, value }`. Other failures, and the last shape's, throw.
 */
async function firstFit(shapes, fetch) {
  let failure = null;
  for (const shape of shapes) {
    try {
      return { shape, value: await fetch(shape) };
    } catch (error) {
      if (error?.code !== BUDGET_ERROR) throw error;
      failure = error;
    }
  }
  throw failure;
}

/** `size`, then halves of it down to 1. */
function halvings(size) {
  const sizes = [];
  for (let n = Math.max(1, size); n > 1; n = Math.ceil(n / 2)) sizes.push(n);
  return [...sizes, 1];
}

/**
 * The size of the page after one of `asked` updates that fit at `fit`,
 * when pages were `current`: what fit after a smaller page, else growing
 * back towards UPDATES_PAGE (one heavy update shrinks a few pages only).
 */
export const nextPageSize = (current, asked, fit) =>
  fit < asked ? fit : Math.min(UPDATES_PAGE, Math.max(current, 2 * fit));

/** Page shapes from `size` down: halving, then a single reply at last. */
const pageShapes = (size) => [
  ...halvings(size).map((limit) => ({ limit, replies: SHOWN_REPLIES })),
  { limit: 1, replies: 1 },
];

/**
 * The page of item `itemId`'s top-level updates after `cursor` (null:
 * the first), at most `size`: `{ list, cursor, size }` (`cursor` null at
 * the end, `size` what fit the budget), or null for an unknown item.
 */
export async function loadOlderUpdates(itemId, { cursor = null, size }) {
  const { shape, value } = await firstFit(pageShapes(size), (each) =>
    request(UPDATES_QUERY, { ids: [itemId], cursor, ...each }),
  );
  const item = value.items[0];
  if (!item) return null;
  const page = item.updates_page;
  const list = page.updates.map(decodeUpdate);
  return { list, cursor: page.cursor ?? null, size: shape.limit };
}

/**
 * Every reply of update `id`, oldest first, loaded newest first in pages
 * that fit the budget: `{ replies, count }`, or null when the update is
 * gone or hidden.
 */
export async function loadThread(id) {
  const pages = [];
  let before = null;
  let size = THREAD_PAGE;
  for (;;) {
    const { shape, value } = await firstFit(halvings(size), (limit) =>
      request(THREAD_QUERY, { ids: [id], limit, before }),
    );
    const [update] = value.updates;
    if (!update) return null;
    const page = update.replies.map(decodeUpdate);
    pages.unshift(page);
    size = shape;
    const replies = pages.flat();
    if (page.length < shape || replies.length >= update.replies_count) {
      return { replies, count: Math.max(update.replies_count, replies.length) };
    }
    before = page[0].id;
  }
}

/** The pane's set of threads shown whole, created on first use. */
export function threadsOf(shown) {
  shown.threads ??= new Set();
  return shown.threads;
}

/**
 * Appends pages to `loaded` (`{ list, cursor, size }`) while the item has
 * more and `wanted()` asks for more updates (0: enough); resolves with
 * false when the item went away.
 */
async function loadPages(itemId, loaded, wanted) {
  for (let count = wanted(); count > 0 && loaded.cursor !== null;) {
    const size = Math.min(loaded.size, count);
    const page = await loadOlderUpdates(itemId, {
      cursor: loaded.cursor,
      size,
    });
    if (!page) return false;
    const seen = new Set(loaded.list.map((update) => update.id));
    loaded.list.push(...page.list.filter((update) => !seen.has(update.id)));
    loaded.cursor = page.cursor;
    loaded.size = nextPageSize(loaded.size, size, page.size);
    count = wanted();
  }
  return true;
}

/**
 * Pages further back (to MAX_UPDATES top-level updates) until the thread
 * of update `target` shows; an older reply's thread is then shown whole
 * (`shown.threads`). Resolves with whether pages were added.
 */
async function findTarget(itemId, loaded, { target, shown }) {
  const data = await request(TARGET_QUERY, { ids: [target] });
  const found = data.updates[0];
  if (!found) return false;
  const threadId = idOf(found.parent_update_id) ?? String(found.id);
  const listed = () => loaded.list.some((update) => update.id === threadId);
  const before = loaded.list.length;
  await loadPages(itemId, loaded, () =>
    listed() ? 0 : MAX_UPDATES - loaded.list.length,
  );
  if (threadId !== target && listed() && !findUpdate(loaded.list, target)) {
    threadsOf(shown).add(threadId);
  }
  return loaded.list.length > before;
}

/** `list` with the threads in `threads` (a Set of IDs) loaded whole. */
async function withThreads(list, threads) {
  let result = list;
  for (const update of list) {
    const whole = update.replies.length >= update.repliesCount;
    if (whole || !threads?.has(update.id)) continue;
    const thread = await loadThread(update.id);
    if (thread) result = withThread(result, update.id, thread);
  }
  return result;
}

/**
 * What the pane shows of item `itemId`, loaded again (board refreshes):
 * the first `shown.limit` top-level updates, in pages that fit the
 * budget, with the threads in `shown.threads` whole; for a route's
 * `target` that is not among them, pages further back until its thread
 * shows (`limit` then grows to what was loaded). `shown` is the pane's
 * live state (`{ limit, threads, pageSize }`, see `board-sync.js`): its
 * limit and threads are read as the load goes, so a page "Show older"
 * appends meanwhile is loaded too. Resolves with `{ list, cursor,
 * hasMore, pageSize, limit? }`, or null for an item the user cannot see.
 */
export async function loadUpdates(itemId, { shown = {}, target = null } = {}) {
  const size = shown.pageSize ?? UPDATES_PAGE;
  const first = await loadOlderUpdates(itemId, { size });
  if (!first) return null;
  const loaded = { ...first, size: nextPageSize(size, size, first.size) };
  const wanted = () => (shown.limit ?? UPDATES_PAGE) - loaded.list.length;
  if (!(await loadPages(itemId, loaded, wanted))) return null;
  const found = target === null || findUpdate(loaded.list, target) !== null;
  const hunted = found
    ? false
    : await findTarget(itemId, loaded, { target, shown });
  const list = await withThreads(loaded.list, shown.threads);
  return {
    list,
    cursor: loaded.cursor,
    hasMore: loaded.cursor !== null,
    pageSize: loaded.size,
    ...(hunted ? { limit: list.length } : {}),
  };
}

// ------------------------------------------------------- task picker

/** The status label and color of decoded `item` on `columns`, or nulls. */
function statusOf(columns, item) {
  const column = roleColumns(columns).status;
  const option = column ? statusOption(column, item.values[column.id]) : null;
  return { color: option?.color ?? null, statusLabel: option?.label ?? "" };
}

/**
 * Tasks of `board` (a loaded board) for the empty "@@" query: its first
 * MAX_TASKS items besides `exceptId`, with their status.
 */
export function boardTasks(board, exceptId) {
  return board.items
    .filter((item) => item.id !== exceptId)
    .slice(0, MAX_TASKS)
    .map((item) => ({
      id: item.id,
      name: item.name,
      boardId: board.id,
      boardName: board.name,
      ...statusOf(board.columns, item),
    }));
}

/** The status columns of `boardIds` not yet in `cache` (boardId → columns). */
async function cacheColumns(cache, boardIds) {
  const missing = boardIds.filter((id) => !cache.has(id));
  if (missing.length === 0) return;
  const data = await request(TASK_BOARDS_QUERY, {
    ids: missing,
    limit: missing.length,
  });
  for (const id of missing) cache.set(id, []);
  for (const board of data.boards) {
    const columns = prepareColumns(board.columns);
    const status = roleColumns(columns).status;
    cache.set(String(board.id), status ? [status] : []);
  }
}

/**
 * Tasks whose name matches `query` on boards the user can open (the
 * server's `search`), at most MAX_TASKS, as `{ id, name, boardId,
 * boardName, color, statusLabel }`. `cache` (a Map the caller keeps for
 * one picker session) holds each board's status column.
 */
export async function searchTasks(query, cache) {
  const data = await request(TASK_SEARCH_QUERY, {
    query,
    limit: SEARCH_LIMIT,
  });
  const found = data.search
    .filter((result) => result.kind === "item")
    .map((result) => ({ result, url: ITEM_URL.exec(result.url ?? "") }))
    .filter(({ url }) => url !== null)
    .slice(0, MAX_TASKS)
    .map(({ result, url }) => ({
      id: String(result.id),
      name: result.title,
      boardId: url[1],
      boardName: result.subtitle ?? "",
    }));
  if (found.length === 0) return [];
  const boardIds = [...new Set(found.map((task) => task.boardId))];
  await cacheColumns(cache, boardIds);
  const columnIds = new Set(
    boardIds.flatMap((id) => cache.get(id).map((column) => column.id)),
  );
  if (columnIds.size === 0) {
    return found.map((task) => ({ ...task, color: null, statusLabel: "" }));
  }
  const values = await request(TASK_STATUS_QUERY, {
    ids: found.map((task) => task.id),
    columns: [...columnIds],
  });
  const byId = new Map(values.items.map((raw) => [String(raw.id), raw]));
  return found.map((task) => {
    const own = cache.get(task.boardId);
    const raw = byId.get(task.id);
    const item = raw ? decodeItem(raw, own) : { values: {} };
    return { ...task, ...statusOf(own, item) };
  });
}

/** Documents of this module, for schema validation in tests. */
export const UPDATE_QUERIES = Object.freeze({
  UPDATES_QUERY,
  THREAD_QUERY,
  TARGET_QUERY,
  TASK_SEARCH_QUERY,
  TASK_BOARDS_QUERY,
  TASK_STATUS_QUERY,
});
