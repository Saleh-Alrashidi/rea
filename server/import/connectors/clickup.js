/**
 * ClickUp connector (SPEC-4 §3.2). `scan({ token, options, signal,
 * onProgress })` reads what a ClickUp API token can see through ClickUp's
 * REST API (v2, and v3 for docs) with the shared bounded client
 * (`../upstream.js`: fixed host, no redirects, 10 MiB / 30 s per request,
 * retries honoring `Retry-After` / `X-RateLimit-Reset`, at most 90
 * requests per minute) and returns the normalized snapshot (SPEC-4 §2).
 *
 * Reads, in order: `GET /team` (ClickUp workspaces and their members),
 * `/team/{id}/space`, `/space/{id}/folder`, `/folder/{id}/list` and
 * `/space/{id}/list` (folderless), all with `archived=false`; then per
 * list `/list/{id}` (statuses), `/list/{id}/field` (custom fields) and
 * `/list/{id}/task?page=N&include_closed=true&subtasks=true&archived=false`
 * until `last_page` (or a page of fewer than 100 tasks), with each task's
 * comments; then docs. Each Space becomes a workspace "<Team> / <Space>"
 * (closed when private) and each List a board (`clickup-tasks.js`);
 * columns and values are `clickup-fields.js`, docs `clickup-docs.js`.
 *
 * Options (all optional): `include_comments`, `include_subitems`
 * (subtasks) and `include_docs` (default true), and `limits` `{ boards,
 * items, updates, docs }`, which can only lower CLICKUP_LIMITS (comments
 * are updates). `transport` (`{ env, limits, clock }`) is a test seam for
 * the upstream client; routes never set it. Failures are UpstreamError:
 * INVALID_TOKEN (no token, HTTP 401 other than "Team not authorized"),
 * ABORTED, UPSTREAM_CONFIG,
 * UPSTREAM_ERROR (no ClickUp workspaces in the answer), or the transport
 * code once three requests in a row have failed. Other failures become
 * `read_failed` warnings and the scan continues.
 */
import { SNAPSHOT_LIMITS } from "../snapshot.js";
import { UpstreamError, createUpstream } from "../upstream.js";
import {
  get,
  guarded,
  pathId,
  tokenRejected,
  userOf,
} from "./clickup-common.js";
import { readDocs } from "./clickup-docs.js";
import {
  addDetail,
  addFields,
  addTasks,
  createBoard,
  readComments,
} from "./clickup-tasks.js";
import {
  createProgress,
  createReport,
  idOf,
  isObject,
  itemRoom,
  limitHit,
  listOf,
  str,
} from "./common.js";

/** Default and maximum scan limits (SPEC-4 §1; docs are bounded too). */
export const CLICKUP_LIMITS = Object.freeze({
  boards: 200,
  items: 50_000,
  updates: 5_000,
  docs: 200,
});
/** ClickUp's request budget per minute (SPEC-4 §1). */
export const CLICKUP_PER_MINUTE = 90;
const TASK_PAGE = 100;
const MAX_LABEL = 200;
const ARCHIVED = Object.freeze({ archived: "false" });

/** The ClickUp workspaces ("teams") of the token, with their members. */
async function readTeams(ctx) {
  ctx.progress("account", 0, null, "Connecting to ClickUp");
  const json = await get(ctx, "/v2/team");
  if (!Array.isArray(json?.teams)) {
    const message = "ClickUp did not return the workspaces of this token";
    throw new UpstreamError("UPSTREAM_ERROR", message);
  }
  const teams = [];
  for (const raw of listOf(json.teams)) {
    const id = pathId(raw.id);
    if (id === null) continue;
    const name = str(raw.name).trim() || `Workspace ${id}`;
    teams.push({ id, name, members: listOf(raw.members) });
  }
  return teams;
}

function sourceLabel(teams) {
  const names = teams.map((team) => team.name);
  if (names.length === 0) return "ClickUp";
  const label =
    names.length === 1
      ? `ClickUp workspace ${names[0]}`
      : `ClickUp workspaces ${names.join(", ")}`;
  return label.length > MAX_LABEL ? `${label.slice(0, MAX_LABEL)}…` : label;
}

function readUsers(ctx, teams) {
  ctx.progress("users", 0, null, "Reading people");
  for (const team of teams) {
    for (const member of team.members) {
      const user = isObject(member.user) ? member.user : null;
      const id = idOf(user?.id);
      if (id === null) continue;
      if (ctx.users.size >= SNAPSHOT_LIMITS.users) return;
      ctx.users.set(id, userOf(id, user));
    }
  }
  const count = ctx.users.size;
  ctx.progress("users", count, count, `Found ${count} people`);
}

/** Adds a workspace (`key` → `{ ws, path, team }`); see `ctx.addWorkspace`. */
function addWorkspace(ctx, key, { name, kind, team }) {
  const path = `workspaces[${ctx.workspaces.length}]`;
  const ws = {
    source_id: key,
    name,
    description: null,
    kind,
    boards: [],
    docs: [],
  };
  const entry = { ws, path, team };
  ctx.workspaces.push(ws);
  ctx.spaces.set(key, entry);
  return entry;
}

async function readSpaces(ctx, team) {
  const what = `Spaces of "${team.name}"`;
  const path = `/v2/team/${team.id}/space`;
  const json = await guarded(ctx, "workspaces", what, () =>
    get(ctx, path, ARCHIVED),
  );
  const found = [];
  // Room is left for each team's "Workspace docs" workspace.
  const room = SNAPSHOT_LIMITS.workspaces - ctx.teamCount;
  for (const space of listOf(json?.spaces)) {
    const id = pathId(space.id);
    if (id === null || ctx.spaces.has(id)) continue;
    if (ctx.workspaces.length >= room) {
      const message = `Only the first ${room} spaces were read`;
      ctx.report.add("read_capped", message, "workspaces");
      break;
    }
    const name = `${team.name} / ${str(space.name).trim() || id}`;
    const kind = space.private === true ? "closed" : "open";
    found.push({ space, target: addWorkspace(ctx, id, { name, kind, team }) });
  }
  return found;
}

/**
 * Adds the readable lists of `rows` to `found` (stopping at the board
 * limit) → false once the limit is reached.
 */
function addLists(ctx, found, rows, where) {
  for (const list of listOf(rows)) {
    const id = pathId(list.id);
    if (id === null || ctx.lists.has(id)) continue;
    if (found.length >= ctx.limits.boards) {
      limitHit(ctx, "boards", "workspaces");
      return false;
    }
    ctx.lists.set(id, where.target.ws.source_id);
    found.push({ ...where, list });
  }
  ctx.progress("boards", found.length, null, `Found ${found.length} lists`);
  return true;
}

async function listsOf(ctx, path, what) {
  const run = () => get(ctx, path, ARCHIVED);
  const json = await guarded(ctx, "workspaces", what, run);
  return listOf(json?.lists);
}

/** The lists of one space: in its folders first, then folderless ones. */
async function readSpaceLists(ctx, found, { space, target }) {
  const where = { team: target.team, space, target };
  const spaceId = target.ws.source_id;
  const folderJson = await guarded(
    ctx,
    "workspaces",
    `Folders of "${target.ws.name}"`,
    () => get(ctx, `/v2/space/${spaceId}/folder`, ARCHIVED),
  );
  for (const folder of listOf(folderJson?.folders)) {
    const id = pathId(folder.id);
    if (id === null) continue;
    ctx.folders.set(id, spaceId);
    const what = `Lists of folder "${str(folder.name)}"`;
    const rows = await listsOf(ctx, `/v2/folder/${id}/list`, what);
    if (!addLists(ctx, found, rows, { ...where, folder })) return false;
  }
  const what = `Folderless lists of "${target.ws.name}"`;
  const rows = await listsOf(ctx, `/v2/space/${spaceId}/list`, what);
  return addLists(ctx, found, rows, { ...where, folder: null });
}

async function listBoards(ctx, teams) {
  ctx.progress("workspaces", 0, null, "Reading spaces");
  const spaces = [];
  for (const team of teams) spaces.push(...(await readSpaces(ctx, team)));
  ctx.progress("boards", 0, null, "Listing lists");
  const found = [];
  for (const entry of spaces) {
    if (!(await readSpaceLists(ctx, found, entry))) break;
  }
  return found;
}

async function readTasks(ctx, state) {
  const id = state.board.source_id;
  const what = `Tasks of list "${state.board.name}"`;
  const maxPages = Math.ceil(ctx.limits.items / TASK_PAGE) + 1;
  for (let page = 0; page < maxPages; page += 1) {
    if (!itemRoom(ctx, state.path)) return;
    const query = {
      page: String(page),
      include_closed: "true",
      subtasks: String(ctx.flags.subitems),
      archived: "false",
    };
    const run = () => get(ctx, `/v2/list/${id}/task`, query);
    const json = await guarded(ctx, state.path, what, run);
    if (json === null) return;
    const rows = Array.isArray(json?.tasks) ? json.tasks : [];
    for (const added of addTasks(state, rows)) {
      await readComments(state, added);
    }
    const { index, total } = ctx.at;
    const read = state.board.items.length.toLocaleString("en-US");
    const message = `Reading list "${state.board.name}": ${read} tasks so far`;
    ctx.progress("items", index, total, message);
    if (json.last_page === true || rows.length < TASK_PAGE) return;
  }
  const message = `${what}: stopped after ${maxPages} pages`;
  ctx.report.add("read_capped", message, state.path);
}

/** Reads one list: its statuses, custom fields, tasks and comments. */
async function readList(ctx, state) {
  const id = state.board.source_id;
  const name = `list "${state.board.name}"`;
  const detail = await guarded(ctx, state.path, `The ${name}`, () =>
    get(ctx, `/v2/list/${id}`),
  );
  if (detail === null) return;
  addDetail(state, detail);
  const fields = await guarded(
    ctx,
    state.path,
    `Custom fields of ${name}`,
    () => get(ctx, `/v2/list/${id}/field`),
  );
  addFields(state, fields);
  await readTasks(ctx, state);
}

/** Reads the listed lists in order; the upstream client stops on abort. */
async function readBoards(ctx, found) {
  for (const [index, entry] of found.entries()) {
    if (!itemRoom(ctx, "workspaces")) return;
    const { target } = entry;
    const path = `${target.path}.boards[${target.ws.boards.length}]`;
    const state = createBoard(ctx, entry, path);
    const message = `Reading list "${state.board.name}"`;
    ctx.at = { index, total: found.length };
    ctx.progress("items", index, found.length, message);
    await readList(ctx, state);
    target.ws.boards.push(state.board);
  }
}

function readOptions(options) {
  const source = isObject(options) ? options : {};
  const limits = isObject(source.limits) ? source.limits : {};
  const bound = (key) => {
    const value = limits[key];
    const valid = Number.isInteger(value) && value > 0;
    return valid ? Math.min(value, CLICKUP_LIMITS[key]) : CLICKUP_LIMITS[key];
  };
  const keys = Object.keys(CLICKUP_LIMITS);
  return {
    comments: source.include_comments !== false,
    subitems: source.include_subitems !== false,
    docs: source.include_docs !== false,
    limits: Object.fromEntries(keys.map((key) => [key, bound(key)])),
  };
}

function createContext({ token, signal, onProgress, transport }, settings) {
  const reporter = createProgress(onProgress, "ClickUp");
  const client = createUpstream({
    source: "clickup",
    token,
    signal,
    perMinute: CLICKUP_PER_MINUTE,
    tokenRejected,
    onWait: reporter.wait,
    env: transport?.env,
    limits: transport?.limits,
    clock: transport?.clock,
  });
  const { progress } = reporter;
  const ctx = {
    client,
    report: createReport(),
    limits: settings.limits,
    flags: { updates: settings.comments, subitems: settings.subitems },
    counts: { items: 0, values: 0, updates: 0, docs: 0, commentReads: 0 },
    users: new Map(),
    workspaces: [],
    spaces: new Map(),
    folders: new Map(),
    lists: new Map(),
    teamCount: 0,
    stopped: new Set(),
    failures: 0,
    progress,
  };
  ctx.addWorkspace = (key, spec) => addWorkspace(ctx, key, spec);
  return ctx;
}

/**
 * Scans the ClickUp workspaces of a token into a snapshot.
 * `onProgress({ phase, done, total, message })` reports the phases
 * account, users, workspaces, boards, items (done/total = lists
 * read/listed), docs and done; `total` is null while unknown.
 */
export async function scan(input = {}) {
  const settings = readOptions(input.options);
  const ctx = createContext(input, settings);
  const teams = await readTeams(ctx);
  ctx.teamCount = teams.length;
  readUsers(ctx, teams);
  const found = await listBoards(ctx, teams);
  await readBoards(ctx, found);
  if (settings.docs) await readDocs(ctx, teams);
  ctx.progress("done", found.length, found.length, "Scan finished");
  return {
    source: "clickup",
    source_label: sourceLabel(teams),
    users: [...ctx.users.values()],
    workspaces: ctx.workspaces,
    warnings: ctx.report.finish(),
  };
}
