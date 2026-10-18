/**
 * Boards of the ClickUp connector (SPEC-4 §3.2): one board per List,
 * named "<Folder> / <List>" (or "<List>" when folderless), private when
 * its space, folder or list is; two groups, Open (`#579bfc`) and Closed
 * (`#00c875`), chosen by the status type (closed and done → Closed);
 * tasks and subtasks (subtasks keep `parent_source_id`); and comments
 * with their threaded replies as updates (plain `comment_text`, oldest
 * first).
 *
 * `createBoard` builds a board from its listing entry, `addDetail` and
 * `addFields` add what `GET /list/{id}` and `/list/{id}/field` say,
 * `addTasks` converts each page of tasks as it arrives and `readComments`
 * reads one task's comments (`GET /task/{id}/comment`, 25 per page,
 * newest first, older pages by `start` + `start_id`; replies from
 * `GET /comment/{id}/reply`).
 *
 * Comments count against the scan's update limit, and so do the requests
 * that read them: ClickUp has no comment count per task, so every task
 * costs a request, and a scan reads comments for at most as many tasks
 * as its update limit (at 90 requests a minute).
 */
import { get, guarded, noteUser, pathId, timeOf } from "./clickup-common.js";
import {
  addStandardColumns,
  addStatuses,
  fieldPlan,
  readValues,
} from "./clickup-fields.js";
import { idOf, isObject, limitHit, listOf, scopeAt, str } from "./common.js";

export const GROUPS = Object.freeze([
  Object.freeze({ source_id: "open", title: "Open", color: "#579bfc" }),
  Object.freeze({ source_id: "closed", title: "Closed", color: "#00c875" }),
]);
const CLOSED_TYPES = new Set(["closed", "done"]);
const COMMENT_PAGE = 25;
/** Comment pages read per task (its latest 250 comments). */
export const MAX_COMMENT_PAGES = 10;
const APP_URL = "https://app.clickup.com";

const textOrNull = (value) =>
  typeof value === "string" && value.trim() !== "" ? value : null;

/**
 * The board of listing entry `{ team, space, folder, list }` (folder null
 * when folderless) at snapshot `path`, without tasks, and the conversion
 * state the other functions need.
 */
export function createBoard(ctx, entry, path) {
  const { team, space, folder, list } = entry;
  const scope = scopeAt(ctx.report, path);
  const id = pathId(list.id);
  const name = folder
    ? `${str(folder.name)} / ${str(list.name)}`
    : str(list.name);
  const restricted = [space, folder, list].some((x) => x?.private === true);
  const board = {
    source_id: id,
    name,
    description: textOrNull(list.content),
    kind: restricted ? "private" : "public",
    source_url: `${APP_URL}/${team.id}/v/li/${id}`,
    members: [],
    columns: [],
    groups: GROUPS.map((group) => ({ ...group })),
    items: [],
  };
  if (restricted) {
    const message =
      "ClickUp does not say who may open a private list here, so its members were not imported: only the importer can open this board until it is shared";
    scope.add("members_not_imported", message);
  }
  const state = {
    ctx,
    board,
    path,
    scope,
    standard: [],
    statusPlan: null,
    pointsPlan: undefined,
    fields: new Map(),
    statusTypes: new Map(),
    seen: new Set(),
  };
  addStandardColumns(state);
  return state;
}

/** Adds the statuses (in order) of `GET /list/{id}` to the board. */
export function addDetail(state, detail) {
  if (isObject(detail)) addStatuses(state, detail.statuses);
}

/** Adds the custom fields of `GET /list/{id}/field` as columns. */
export function addFields(state, json) {
  for (const field of listOf(json?.fields)) fieldPlan(state, field);
}

function groupOf(state, raw) {
  const status = isObject(raw.status) ? raw.status : {};
  const label = str(status.status).trim().toLowerCase();
  const type = status.type ?? state.statusTypes.get(label);
  return CLOSED_TYPES.has(type) ? "closed" : "open";
}

function checklistWarning(state, raw) {
  const items = listOf(raw.checklists).flatMap((list) => listOf(list.items));
  if (items.length === 0) return;
  const message =
    "Checklist items were not imported (Worklane items have no checklists); tasks with checklists";
  state.scope.count("checklists_dropped", message);
}

/**
 * Converts one page of ClickUp tasks onto the board; → `[{ item, taskId }]`
 * of the items added (for their comments). Stops at the item limit.
 */
export function addTasks(state, raws) {
  const { ctx } = state;
  const added = [];
  for (const raw of listOf(raws)) {
    const id = idOf(raw.id);
    if (id === null || state.seen.has(id)) continue;
    if (ctx.counts.items >= ctx.limits.items) {
      limitHit(ctx, "items", state.path);
      break;
    }
    ctx.counts.items += 1;
    state.seen.add(id);
    const item = {
      source_id: id,
      name: str(raw.name),
      group_source_id: groupOf(state, raw),
      parent_source_id: idOf(raw.parent),
      values: readValues(state, raw),
      created_at: timeOf(raw.date_created),
      creator_source_id: noteUser(ctx, raw.creator),
      updates: [],
    };
    checklistWarning(state, raw);
    state.board.items.push(item);
    added.push({ item, taskId: pathId(raw.id) });
  }
  return added;
}

// ------------------------------------------------------------ comments

function commentText(raw) {
  if (typeof raw.comment_text === "string") return raw.comment_text.trim();
  return listOf(raw.comment)
    .map((part) => str(part.text))
    .join("")
    .trim();
}

function addUpdate(state, item, raw, reply) {
  const { ctx } = state;
  if (ctx.counts.updates >= ctx.limits.updates) {
    limitHit(ctx, "updates", state.path);
    return false;
  }
  ctx.counts.updates += 1;
  const text = commentText(raw);
  const user = isObject(raw.user) ? raw.user : {};
  const name = str(user.username).trim();
  item.updates.push({
    body: text !== "" && reply ? `Reply: ${text}` : text,
    author_source_id: idOf(user.id),
    author_name: name === "" ? null : name,
    created_at: timeOf(raw.date),
  });
  return true;
}

/**
 * Whether one more comment request fits the scan: comments are wanted
 * and the update limit (comments and requests) is not reached.
 */
function mayRead(state) {
  const { ctx } = state;
  if (!ctx.flags.updates) return false;
  if (ctx.counts.commentReads < ctx.limits.updates) {
    ctx.counts.commentReads += 1;
    return true;
  }
  ctx.flags.updates = false;
  ctx.stopped.add("updates");
  const limit = ctx.limits.updates.toLocaleString("en-US");
  const message = `Stopped reading comments after ${limit} requests (the scan's update limit); later tasks were imported without comments`;
  ctx.report.add("limit_updates", message, state.path);
  return false;
}

const timeKey = (update) => {
  const time = Date.parse(update.created_at ?? "");
  return Number.isFinite(time) ? time : Number.MAX_VALUE;
};

/** The task's top-level comments, newest first, page by page. */
async function topComments(state, item, taskId) {
  const what = `Comments of task "${item.name}"`;
  const comments = [];
  let query = null;
  for (let page = 0; page < MAX_COMMENT_PAGES; page += 1) {
    if (!mayRead(state)) return comments;
    const path = `/v2/task/${taskId}/comment`;
    const run = () => get(state.ctx, path, query);
    const json = await guarded(state.ctx, state.path, what, run);
    const rows = listOf(json?.comments);
    comments.push(...rows);
    const oldest = rows.at(-1);
    const start = str(oldest?.date).trim();
    const startId = pathId(oldest?.id);
    if (rows.length < COMMENT_PAGE || !start || !startId) return comments;
    query = { start, start_id: startId };
  }
  const message = `Tasks with more than ${MAX_COMMENT_PAGES * COMMENT_PAGE} comments kept only their latest ${MAX_COMMENT_PAGES * COMMENT_PAGE}`;
  state.scope.count("updates_capped", message);
  return comments;
}

async function replies(state, item, raw) {
  const id = pathId(raw.id);
  const count = Number(raw.reply_count);
  if (id === null || !(count > 0) || !mayRead(state)) return [];
  const what = `Replies to a comment on task "${item.name}"`;
  const run = () => get(state.ctx, `/v2/comment/${id}/reply`);
  const json = await guarded(state.ctx, state.path, what, run);
  return listOf(json?.comments);
}

/** Reads the comments (and replies) of one added task into its updates. */
export async function readComments(state, { item, taskId }) {
  if (taskId === null) return;
  for (const raw of await topComments(state, item, taskId)) {
    if (!addUpdate(state, item, raw, false)) break;
    for (const reply of await replies(state, item, raw)) {
      if (!addUpdate(state, item, reply, true)) break;
    }
  }
  // ClickUp lists comments newest first; Worklane keeps them in time order.
  item.updates.sort((a, b) => timeKey(a) - timeKey(b));
}
