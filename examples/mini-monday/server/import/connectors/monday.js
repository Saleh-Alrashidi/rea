/**
 * monday.com connector (SPEC-4 §3.1). `scan({ token, options, signal,
 * onProgress })` reads an account through monday's GraphQL API
 * (`API-Version: 2025-10`, shapes of `@mondaydotcomorg/api`) with the shared
 * bounded client (`../upstream.js`) and returns the normalized snapshot
 * (SPEC-4 §2). Conversion lives in `monday-board.js` (boards, items,
 * updates), `monday-columns.js` (columns and values) and
 * `monday-common.js` (monday's JSON fields, colors, HTML, doc blocks), with
 * the warnings and limits every connector shares from `common.js`.
 *
 * Board metadata is listed 25 boards per page; items are then read per
 * board (`items_page` + `next_items_page`, 200 per page) so a failing board
 * only adds a warning, and subitem and doc boards (`type` sub_items_board,
 * document) are never paged: subitems come with their parents and docs
 * with `docs`. Boards and docs without a workspace go to "Main workspace".
 *
 * Options (all optional): `include_updates`, `include_subitems`,
 * `include_docs` (default true) and `limits` `{ boards, items, updates,
 * docs }`, which can only lower MONDAY_LIMITS. `transport` (`{ env, limits,
 * clock }`) is a test seam for the upstream client; routes never set it.
 * Failures are UpstreamError: INVALID_TOKEN (no token, HTTP 401/403),
 * ABORTED, UPSTREAM_CONFIG, UPSTREAM_ERROR (account unreadable), or the
 * transport code once three requests in a row have failed. Other failures
 * become READ_FAILED warnings and the scan continues.
 */
import { UpstreamError, createUpstream, throwIfAborted } from "../upstream.js";
import { UPDATES_PER_ITEM, addItems, createBoard } from "./monday-board.js";
import {
  createProgress,
  createReport,
  idOf,
  isObject,
  itemRoom,
  limitHit,
  listOf,
  scopeAt,
  str,
} from "./common.js";
import { convertBlocks } from "./monday-common.js";
import { LIMITS } from "../../input.js";
import { SNAPSHOT_LIMITS } from "../snapshot.js";

export const MONDAY_API_VERSION = "2025-10";

/** Default and maximum scan limits (SPEC-4 §1; docs are bounded too). */
export const MONDAY_LIMITS = Object.freeze({
  boards: 200,
  items: 50_000,
  updates: 5_000,
  docs: 200,
});

const PAGE = Object.freeze({
  boards: 25,
  items: 200,
  users: 100,
  workspaces: 100,
  docs: 25,
  blocks: 100,
});
const MAX_PAGES = 400;
// monday may answer fewer doc blocks per page than asked for (a community
// report says 25): a first page of at least this many blocks is paged on,
// with its own length as the page size, until a shorter page.
const MIN_BLOCK_PAGE = 25;
const MAX_FAILURES = 3;
const FATAL = new Set(["INVALID_TOKEN", "ABORTED", "UPSTREAM_CONFIG"]);
const RETRY_CODES = new Set([
  "ComplexityException",
  "COMPLEXITY_BUDGET_EXHAUSTED",
  "RATE_LIMIT_EXCEEDED",
  "IP_RATE_LIMIT_EXCEEDED",
  "maxConcurrencyExceeded",
  "FIELD_LIMIT_EXCEEDED",
]);
const SKIPPED_BOARDS = new Set(["sub_items_board", "document"]);
const MAIN = "";

const ACCOUNT_QUERY = "query WorklaneAccount { me { account { name } } }";
const USERS_QUERY = `query WorklaneUsers($limit: Int!, $page: Int!) {
  users(limit: $limit, page: $page) { id name email } }`;
const WORKSPACES_QUERY = `query WorklaneWorkspaces($limit: Int!, $page: Int!) {
  workspaces(limit: $limit, page: $page) { id name kind description } }`;
const BOARDS_QUERY = `query WorklaneBoards($limit: Int!, $page: Int!) {
  boards(limit: $limit, page: $page, state: active) {
    id name description board_kind type url workspace { id }
    owners { id } subscribers { id }
    columns { id title type settings_str } groups { id title color } } }`;
const ITEM_FRAGMENTS = `
fragment WorklaneValue on ColumnValue {
  id type text value
  ... on MirrorValue { display_value }
  ... on BoardRelationValue { display_value }
  ... on DependencyValue { display_value } }
fragment WorklaneUpdate on Update {
  body text_body created_at creator { id name }
  replies { body text_body created_at creator { id name } } }
fragment WorklaneItem on Item {
  id name created_at creator { id } group { id }
  column_values { ...WorklaneValue }
  updates(limit: ${UPDATES_PER_ITEM}) @include(if: $updates) {
    ...WorklaneUpdate }
  subitems @include(if: $subitems) {
    id name created_at creator { id }
    column_values { ...WorklaneValue column { title settings_str } }
    updates(limit: ${UPDATES_PER_ITEM}) @include(if: $updates) {
      ...WorklaneUpdate } } }`;
const ITEM_VARIABLES = "$limit: Int!, $updates: Boolean!, $subitems: Boolean!";
const FIRST_ITEMS_QUERY = `query WorklaneItems($board: ID!, ${ITEM_VARIABLES}) {
  boards(ids: [$board]) {
    items_page(limit: $limit) { cursor items { ...WorklaneItem } } } }
${ITEM_FRAGMENTS}`;
const NEXT_ITEMS_QUERY = `query WorklaneNextItems($cursor: String!, ${ITEM_VARIABLES}) {
  next_items_page(cursor: $cursor, limit: $limit) {
    cursor items { ...WorklaneItem } } }
${ITEM_FRAGMENTS}`;
const DOCS_QUERY = `query WorklaneDocs($limit: Int!, $page: Int!, $blocks: Int!) {
  docs(limit: $limit, page: $page) {
    id name doc_kind workspace_id blocks(limit: $blocks) { type content } } }`;
const BLOCKS_QUERY = `query WorklaneDocBlocks($doc: ID!, $limit: Int!, $page: Int!) {
  docs(ids: [$doc]) { blocks(limit: $limit, page: $page) { type content } } }`;

function graphqlErrors(json) {
  if (Array.isArray(json?.errors)) {
    return json.errors.map((error) => {
      if (typeof error === "string") return { message: error };
      return isObject(error) ? error : {};
    });
  }
  const legacy =
    typeof json?.error_code === "string" ||
    typeof json?.error_message === "string";
  if (!legacy) return [];
  const data = isObject(json.error_data) ? json.error_data : {};
  const extensions = { ...data, code: json.error_code };
  return [{ message: json.error_message, extensions }];
}

/**
 * Retry hint for monday's rate-limit and complexity errors: the current
 * `extensions.code` + `retry_in_seconds`, or the legacy `error_code`
 * ComplexityException with "reset in N seconds"; null for anything else.
 */
export function mondayRetryHint({ json }) {
  for (const error of graphqlErrors(json)) {
    const ext = isObject(error.extensions) ? error.extensions : {};
    if (!RETRY_CODES.has(ext.code)) continue;
    const said = /reset in (\d+) seconds?/.exec(str(error.message))?.[1];
    const seconds =
      ext.retry_in_seconds ?? ext.error_data?.retry_in_seconds ?? Number(said);
    const valid = Number.isFinite(seconds) && seconds >= 0;
    return { afterSeconds: valid ? seconds : null };
  }
  return null;
}

async function gql(ctx, query, variables) {
  const { json } = await ctx.client.request({
    method: "POST",
    headers: { "API-Version": MONDAY_API_VERSION },
    body: { query, variables },
    retryHint: mondayRetryHint,
  });
  ctx.failures = 0;
  const errors = graphqlErrors(json).map((error) =>
    ctx.client.safeMessage(str(error.message) || "GraphQL error"),
  );
  return { data: isObject(json?.data) ? json.data : null, errors };
}

/** Runs one read; a non-fatal upstream failure becomes a warning (null). */
async function guarded(ctx, path, what, run) {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof UpstreamError) || FATAL.has(error.code)) throw error;
    ctx.failures += 1;
    if (ctx.failures >= MAX_FAILURES) throw error;
    const message = `${what} could not be read: ${error.message}`;
    ctx.report.add("read_failed", message, path);
    return null;
  }
}

function partial(ctx, result, what, path) {
  if (result.errors.length === 0) return;
  const detail = result.errors.slice(0, 3).join("; ");
  const message = `${what} could not be fully read: ${detail}`;
  ctx.report.add("read_failed", message, path);
}

/** Calls `onRows(rows)` per page of a `limit`/`page` list until done. */
async function eachPage(ctx, spec, onRows) {
  for (let page = 1; page <= spec.maxPages; page += 1) {
    const variables = { ...spec.variables, limit: spec.size, page };
    const result = await guarded(ctx, spec.path, spec.what, () =>
      gql(ctx, spec.query, variables),
    );
    if (result === null) return;
    partial(ctx, result, spec.what, spec.path);
    const rows = result.data?.[spec.field];
    if (!Array.isArray(rows)) return;
    if ((await onRows(rows.filter(isObject))) === false) return;
    if (rows.length < spec.size) return;
  }
  const message = `${spec.what}: stopped after ${spec.maxPages} pages`;
  ctx.report.add("read_capped", message, spec.path);
}

async function readAccount(ctx) {
  ctx.progress("account", 0, null, "Connecting to monday.com");
  const result = await gql(ctx, ACCOUNT_QUERY, {});
  if (!isObject(result.data?.me)) {
    const detail = result.errors.length > 0 ? `: ${result.errors[0]}` : "";
    const message = `monday.com did not return the account${detail}`;
    throw new UpstreamError("UPSTREAM_ERROR", message);
  }
  const name = str(result.data.me.account?.name).trim().slice(0, 200);
  return name === "" ? "monday.com account" : `monday.com account ${name}`;
}

function addUser(ctx, row) {
  const id = idOf(row.id);
  if (id === null || ctx.users.has(id)) return;
  const name = typeof row.name === "string" ? row.name : null;
  const email = str(row.email).trim() || null;
  ctx.users.set(id, { source_id: id, name, email });
}

async function readUsers(ctx) {
  ctx.progress("users", 0, null, "Reading people");
  const spec = { query: USERS_QUERY, field: "users", size: PAGE.users };
  const maxPages = Math.floor(SNAPSHOT_LIMITS.users / PAGE.users);
  const where = { maxPages, path: "users", what: "People" };
  await eachPage(ctx, { ...spec, ...where }, (rows) => {
    for (const row of rows) addUser(ctx, row);
  });
}

function addWorkspace(ctx, key, row) {
  const path = `workspaces[${ctx.workspaces.length}]`;
  const ws = {
    source_id: key === MAIN ? "main" : key,
    name: str(row.name),
    description: typeof row.description === "string" ? row.description : null,
    kind: row.kind === "closed" ? "closed" : "open",
    boards: [],
    docs: [],
  };
  const entry = { ws, path };
  ctx.workspaces.push(ws);
  ctx.workspaceIndex.set(key, entry);
  return entry;
}

async function readWorkspaces(ctx) {
  ctx.progress("workspaces", 0, null, "Reading workspaces");
  // Room is left for Main and unlisted workspaces of boards and docs.
  const spec = { query: WORKSPACES_QUERY, field: "workspaces", maxPages: 5 };
  const where = {
    size: PAGE.workspaces,
    path: "workspaces",
    what: "Workspaces",
  };
  await eachPage(ctx, { ...spec, ...where }, (rows) => {
    for (const row of rows) {
      const id = idOf(row.id);
      if (id !== null && !ctx.workspaceIndex.has(id))
        addWorkspace(ctx, id, row);
    }
  });
}

/** The workspace of a board/doc: listed, Main, or a closed placeholder. */
function workspaceFor(ctx, rawId) {
  const key = idOf(rawId) ?? MAIN;
  const known = ctx.workspaceIndex.get(key);
  if (known) return known;
  if (key === MAIN) {
    return addWorkspace(ctx, MAIN, { name: "Main workspace", kind: "open" });
  }
  const name = `monday.com workspace ${key}`;
  const entry = addWorkspace(ctx, key, { name, kind: "closed" });
  const message = `Workspace ${key} is not listed for this token; its boards and docs go to a closed workspace with a generic name`;
  ctx.report.add("unknown_workspace", message, entry.path);
  return entry;
}

async function listBoards(ctx) {
  const found = [];
  ctx.progress("boards", 0, null, "Listing boards");
  const spec = { query: BOARDS_QUERY, field: "boards", size: PAGE.boards };
  const where = { maxPages: MAX_PAGES, path: "workspaces", what: "Boards" };
  await eachPage(ctx, { ...spec, ...where }, (rows) => {
    for (const row of rows) {
      if (SKIPPED_BOARDS.has(row.type) || idOf(row.id) === null) continue;
      if (found.length >= ctx.limits.boards) {
        limitHit(ctx, "boards", "workspaces");
        return false;
      }
      found.push(row);
    }
    ctx.progress("boards", found.length, null, `Found ${found.length} boards`);
    return true;
  });
  return found;
}

function itemsRequest(ctx, state, cursor) {
  const room = ctx.limits.items - ctx.counts.items;
  const { updates, subitems } = ctx.flags;
  const variables = { limit: Math.min(PAGE.items, room), updates, subitems };
  if (cursor === null) {
    const board = state.board.source_id;
    return () => gql(ctx, FIRST_ITEMS_QUERY, { ...variables, board });
  }
  return () => gql(ctx, NEXT_ITEMS_QUERY, { ...variables, cursor });
}

async function readItems(ctx, state) {
  const what = `Items of board "${state.board.name}"`;
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    if (!itemRoom(ctx, state.path)) return;
    const first = cursor === null;
    const run = itemsRequest(ctx, state, cursor);
    const result = await guarded(ctx, state.path, what, run);
    if (result === null) return;
    partial(ctx, result, what, state.path);
    const data = first
      ? result.data?.boards?.[0]?.items_page
      : result.data?.next_items_page;
    if (!isObject(data)) return;
    addItems(ctx, state, data.items);
    const { index, total } = ctx.at;
    const read = state.board.items.length.toLocaleString("en-US");
    const message = `Reading board "${state.board.name}": ${read} items so far`;
    ctx.progress("items", index, total, message);
    cursor = idOf(data.cursor);
    if (cursor === null) return;
  }
  const message = `${what}: stopped after ${MAX_PAGES} pages`;
  ctx.report.add("read_capped", message, state.path);
}

async function readBoards(ctx, boards, signal) {
  for (const [index, raw] of boards.entries()) {
    throwIfAborted(signal);
    if (!itemRoom(ctx, "workspaces")) return;
    const target = workspaceFor(ctx, raw.workspace?.id);
    const path = `${target.path}.boards[${target.ws.boards.length}]`;
    const state = createBoard(ctx, raw, path);
    const message = `Reading board "${state.board.name}"`;
    ctx.at = { index, total: boards.length };
    ctx.progress("items", index, boards.length, message);
    await readItems(ctx, state);
    target.ws.boards.push(state.board);
  }
}

/**
 * The blocks after the first `size` of doc `id`, `size` per page; one page
 * past LIMITS.blocks at most, so the snapshot reports a longer doc.
 */
async function moreBlocks(ctx, { id, path, size }) {
  const blocks = [];
  const lastPage = Math.ceil(LIMITS.blocks / size) + 1;
  for (let page = 2; page <= lastPage; page += 1) {
    const variables = { doc: id, limit: size, page };
    const result = await guarded(ctx, path, "Doc blocks", () =>
      gql(ctx, BLOCKS_QUERY, variables),
    );
    if (result === null) return blocks;
    partial(ctx, result, "Doc blocks", path);
    const rows = result.data?.docs?.[0]?.blocks;
    if (!Array.isArray(rows)) return blocks;
    blocks.push(...rows.filter(isObject));
    if (rows.length < size) return blocks;
  }
  return blocks;
}

async function addDoc(ctx, raw) {
  const id = idOf(raw.id);
  if (id === null) return;
  const target = workspaceFor(ctx, raw.workspace_id);
  const scope = scopeAt(
    ctx.report,
    `${target.path}.docs[${target.ws.docs.length}]`,
  );
  let blocks = listOf(raw.blocks);
  if (blocks.length >= MIN_BLOCK_PAGE) {
    const size = Math.min(blocks.length, PAGE.blocks);
    const more = await moreBlocks(ctx, { id, path: scope.path, size });
    blocks = blocks.concat(more);
  }
  // Public monday docs are open to their workspace; others stay private.
  const visibility = raw.doc_kind === "public" ? "workspace" : "private";
  const blocksOut = convertBlocks(scope, blocks);
  const doc = { source_id: id, title: str(raw.name), visibility };
  target.ws.docs.push({ ...doc, blocks: blocksOut });
  ctx.counts.docs += 1;
}

async function readDocs(ctx) {
  ctx.progress("docs", 0, null, "Reading docs");
  const spec = { query: DOCS_QUERY, field: "docs", size: PAGE.docs };
  const where = { maxPages: MAX_PAGES, path: "workspaces", what: "Docs" };
  const variables = { blocks: PAGE.blocks };
  await eachPage(ctx, { ...spec, ...where, variables }, async (rows) => {
    for (const row of rows) {
      if (ctx.counts.docs >= ctx.limits.docs) {
        limitHit(ctx, "docs", "workspaces");
        return false;
      }
      await addDoc(ctx, row);
    }
    ctx.progress("docs", ctx.counts.docs, null, `Read ${ctx.counts.docs} docs`);
    return true;
  });
}

function readOptions(options) {
  const source = isObject(options) ? options : {};
  const limits = isObject(source.limits) ? source.limits : {};
  const bound = (key) => {
    const value = limits[key];
    const valid = Number.isInteger(value) && value > 0;
    return valid ? Math.min(value, MONDAY_LIMITS[key]) : MONDAY_LIMITS[key];
  };
  const keys = Object.keys(MONDAY_LIMITS);
  return {
    updates: source.include_updates !== false,
    subitems: source.include_subitems !== false,
    docs: source.include_docs !== false,
    limits: Object.fromEntries(keys.map((key) => [key, bound(key)])),
  };
}

function createContext({ token, signal, onProgress, transport }, settings) {
  const reporter = createProgress(onProgress, "monday.com");
  const client = createUpstream({
    source: "monday",
    token,
    signal,
    tokenRejected: ({ status }) => status === 401 || status === 403,
    onWait: reporter.wait,
    env: transport?.env,
    limits: transport?.limits,
    clock: transport?.clock,
  });
  const report = reporter.progress;
  return {
    client,
    report: createReport(),
    limits: settings.limits,
    flags: { updates: settings.updates, subitems: settings.subitems },
    counts: { items: 0, values: 0, updates: 0, docs: 0 },
    users: new Map(),
    workspaces: [],
    workspaceIndex: new Map(),
    stopped: new Set(),
    failures: 0,
    progress: report,
  };
}

/**
 * Scans a monday.com account into a snapshot. `onProgress({ phase, done,
 * total, message })` reports the phases account, users, workspaces,
 * boards, items (done/total = boards read/listed), docs and done; `total`
 * is null while unknown.
 */
export async function scan(input = {}) {
  const settings = readOptions(input.options);
  const ctx = createContext(input, settings);
  const sourceLabel = await readAccount(ctx);
  await readUsers(ctx);
  await readWorkspaces(ctx);
  const boards = await listBoards(ctx);
  await readBoards(ctx, boards, input.signal);
  if (settings.docs) await readDocs(ctx);
  ctx.progress("done", boards.length, boards.length, "Scan finished");
  return {
    source: "monday",
    source_label: sourceLabel,
    users: [...ctx.users.values()],
    workspaces: ctx.workspaces,
    warnings: ctx.report.finish(),
  };
}
