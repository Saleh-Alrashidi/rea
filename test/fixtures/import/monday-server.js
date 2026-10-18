/**
 * A fake monday.com GraphQL API (node:http) for the importer tests and the
 * import e2e. `POST /v2` takes `{ query, variables, operationName }` with
 * the fixture token in `Authorization`. Queries are validated against a
 * monday-shaped type table (`@mondaydotcomorg/api` field names and
 * arguments) by `fake-graphql.js` and run over `mondayFixture()` with
 * monday's pagination: `limit`/`page` lists, `items_page` cursors continued
 * by `next_items_page`, and doc block pages.
 *
 * `server.fail({ operation, match, kind, times, seconds, ms, bytes,
 * message })` queues a fault for requests whose operation name (and
 * `match` variables) fit, in the shapes monday documents: `budget` (429,
 * COMPLEXITY_BUDGET_EXHAUSTED with `retry_in_seconds` and the budget
 * fields, API 2025-04 and later), `complexity_legacy` (200, top-level
 * `error_code` ComplexityException and "reset in N seconds"),
 * `rate_limit` (429 with `Retry-After`), `unauthorized` (401),
 * `forbidden` (403), `user_unauthorized` (200, UserUnauthorizedException
 * with `status_code` 403 and no data), `graphql_error` (200, errors and
 * no data), `server_error` (500), `oversized` (a streamed body of `bytes`,
 * default 10 MiB + 1 KiB), `slow` (answers after `ms`), `redirect` (302)
 * and `html`. `requests` records every request; `errors` records rejected
 * queries (tests expect none).
 */
import { createServer } from "node:http";
import { executeFake } from "./fake-graphql.js";
import { MONDAY_TOKEN, mondayFixture } from "./monday-data.js";

const S = "String";
const VALUE = { id: S, type: S, text: S, value: S, column: "Column" };
const LINKED = { ...VALUE, display_value: S };
const scalars = (names) => Object.fromEntries(names.map((name) => [name, S]));

/** monday's types as the connector may query them (subset of the API). */
const TYPES = {
  Query: {
    me: "User",
    users: "[User] ids limit page kind emails name newest_first non_active",
    workspaces: "[Workspace] ids limit page kind state order_by",
    boards: "[Board] ids limit page state board_kind workspace_ids order_by",
    next_items_page: "ItemsResponse cursor! limit",
    docs: "[Document] ids limit page object_ids workspace_ids order_by",
  },
  Account: scalars(["id", "name", "slug"]),
  User: { ...scalars(["id", "name", "email", "is_guest"]), account: "Account" },
  Workspace: scalars(["id", "name", "kind", "description", "state"]),
  Board: {
    ...scalars(["id", "name", "description", "board_kind", "type", "state"]),
    ...scalars(["url", "workspace_id"]),
    workspace: "Workspace",
    owners: "[User]",
    subscribers: "[User]",
    columns: "[Column] ids types",
    groups: "[Group] ids",
    items_page: "ItemsResponse limit cursor query_params",
  },
  Column: scalars(["id", "title", "type", "settings_str", "archived"]),
  Group: scalars(["id", "title", "color", "position", "archived"]),
  ItemsResponse: { cursor: S, items: "[Item]" },
  Item: {
    ...scalars(["id", "name", "created_at", "state"]),
    creator: "User",
    group: "Group",
    column_values: "[ColumnValue] ids types",
    subitems: "[Item]",
    updates: "[Update] ids limit page",
  },
  ColumnValue: VALUE,
  MirrorValue: LINKED,
  BoardRelationValue: LINKED,
  DependencyValue: LINKED,
  SubtasksValue: LINKED,
  Update: {
    ...scalars(["id", "body", "text_body", "created_at"]),
    creator: "User",
    replies: "[Reply]",
  },
  Reply: {
    ...scalars(["id", "body", "text_body", "created_at"]),
    creator: "User",
  },
  Document: {
    ...scalars(["id", "name", "object_id", "workspace_id", "doc_kind", "url"]),
    blocks: "[DocumentBlock] limit page",
  },
  DocumentBlock: scalars(["id", "type", "content", "parent_block_id"]),
};

const page = (list, { limit = 25, page: number = 1 }) => {
  const start = (Math.max(1, number) - 1) * limit;
  return list.slice(start, start + limit);
};
const byIds = (list, ids) => {
  if (!ids) return list;
  const wanted = ids.map(String);
  return list.filter((row) => wanted.includes(String(row.id)));
};

function itemsPage(state, items, offset, limit) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("items_page limit must be 1-500");
  }
  const end = offset + limit;
  let cursor = null;
  if (end < items.length) {
    cursor = `cursor-${state.cursors.size + 1}`;
    state.cursors.set(cursor, { items, offset: end });
  }
  return { cursor, items: items.slice(offset, end) };
}

const RESOLVERS = {
  "Query.me": (state) => state.data.me,
  "Query.users": (state, _, args) =>
    page(byIds(state.data.users, args.ids), { limit: 50, ...args }),
  "Query.workspaces": (state, _, args) =>
    page(byIds(state.data.workspaces, args.ids), args),
  "Query.boards": (state, _, args) => {
    const wanted = args.state ?? "active";
    const boards = state.data.boards.filter(
      (board) => wanted === "all" || board.state === wanted,
    );
    return page(byIds(boards, args.ids), args);
  },
  "Query.next_items_page": (state, _, args) => {
    const entry = state.cursors.get(args.cursor);
    if (!entry) throw new Error("CursorException: cursor has expired");
    return itemsPage(state, entry.items, entry.offset, args.limit ?? 25);
  },
  "Query.docs": (state, _, args) => {
    const ws = args.workspace_ids?.map(String);
    const docs = state.data.docs.filter(
      (doc) => !ws || ws.includes(String(doc.workspace_id)),
    );
    return page(byIds(docs, args.ids), args);
  },
  "Board.items_page": (state, board, args) =>
    itemsPage(state, board.items, 0, args.limit ?? 25),
  "Board.columns": (_, board, args) => byIds(board.columns, args.ids),
  "Item.updates": (_, item, args) =>
    page(item.updates ?? [], { limit: 25, ...args }),
  // `blockPageCap` (an option) answers fewer blocks per page than asked.
  "Document.blocks": (state, doc, args) =>
    page(doc.blocks, {
      ...args,
      limit: Math.min(args.limit ?? 25, state.blockPageCap),
    }),
};

const errorBody = (message, extensions) => ({
  errors: [{ message, extensions }],
  account_id: 77,
});

function runQuery(state, body) {
  try {
    return executeFake({ types: TYPES, resolvers: RESOLVERS }, state, body);
  } catch (error) {
    const code = error.code ?? "INTERNAL_SERVER_ERROR";
    state.errors.push({ message: error.message, code, query: body.query });
    return errorBody(error.message, { code });
  }
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function streamOversized(res, bytes) {
  res.writeHead(200, { "Content-Type": "application/json" });
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  let left = bytes;
  const pump = () => {
    while (left > 0 && !res.destroyed) {
      const size = Math.min(left, chunk.length);
      left -= size;
      if (!res.write(chunk.subarray(0, size))) return res.once("drain", pump);
    }
    return res.end();
  };
  res.write('{"data":{"pad":"');
  pump();
}

const legacyComplexity = (seconds) => ({
  error_code: "ComplexityException",
  status_code: 429,
  error_message: `Complexity budget exhausted, query cost 30001 budget remaining 6895 out of 1000000 reset in ${seconds} seconds`,
});

const FAULTS = {
  complexity_legacy: (res, { seconds }) =>
    sendJson(res, 200, legacyComplexity(seconds)),
  budget: (res, { seconds }) => {
    const ext = {
      code: "COMPLEXITY_BUDGET_EXHAUSTED",
      complexity: 30_001,
      complexity_budget_left: 6_895,
      complexity_budget_limit: 1_000_000,
      retry_in_seconds: seconds,
      status_code: 429,
    };
    sendJson(res, 429, errorBody("Complexity budget exhausted", ext));
  },
  user_unauthorized: (res) => {
    const ext = { code: "UserUnauthorizedException", status_code: 403 };
    const body = errorBody("User unauthorized to perform action", ext);
    sendJson(res, 200, { data: null, ...body });
  },
  rate_limit: (res, { seconds }) => {
    const body = errorBody("Rate limit exceeded", {
      code: "RATE_LIMIT_EXCEEDED",
    });
    sendJson(res, 429, body, { "Retry-After": String(seconds) });
  },
  unauthorized: (res) =>
    sendJson(
      res,
      401,
      errorBody("Not Authenticated", { code: "UNAUTHENTICATED" }),
    ),
  forbidden: (res) =>
    sendJson(
      res,
      403,
      errorBody("User unauthorized", { code: "USER_UNAUTHORIZED" }),
    ),
  graphql_error: (res, fault) => {
    const message = fault.message ?? "Internal server error on this board";
    const body = errorBody(message, { code: "INTERNAL_SERVER_ERROR" });
    sendJson(res, 200, { data: null, ...body });
  },
  server_error: (res) =>
    sendJson(res, 500, errorBody("Internal server error", {})),
  oversized: (res, fault) =>
    streamOversized(res, fault.bytes ?? 10 * 1024 * 1024 + 1024),
  redirect: (res, fault, state) => {
    res.writeHead(302, { Location: `${state.origin}/elsewhere` });
    res.end();
  },
  html: (res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html>Bad gateway</html>");
  },
};

function sendFault(state, fault, res, body) {
  const options = { ...fault, seconds: fault.seconds ?? 1 };
  if (fault.kind !== "slow") return FAULTS[fault.kind](res, options, state);
  const answer = () => {
    if (!res.destroyed) sendJson(res, 200, runQuery(state, body));
  };
  return setTimeout(answer, fault.ms ?? 1000).unref();
}

function takeFault(state, body) {
  const fits = (fault) =>
    (!fault.operation || fault.operation === body.operationName) &&
    Object.entries(fault.match ?? {}).every(
      ([key, value]) => String(body.variables?.[key]) === String(value),
    );
  const index = state.faults.findIndex(fits);
  if (index === -1) return null;
  const fault = state.faults[index];
  fault.times = (fault.times ?? 1) - 1;
  if (fault.times <= 0) state.faults.splice(index, 1);
  return fault;
}

const operationName = (query) =>
  /^\s*(?:query|mutation)\s+([_A-Za-z]\w*)/.exec(query ?? "")?.[1] ?? null;

function parseBody(chunks) {
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

async function handle(state, req, res) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const path = new URL(req.url, state.origin).pathname;
  const body = parseBody(chunks);
  const record = {
    path,
    method: req.method,
    authorization: req.headers.authorization ?? null,
    apiVersion: req.headers["api-version"] ?? null,
    contentType: req.headers["content-type"] ?? null,
    operationName: body?.operationName ?? operationName(body?.query),
    variables: body?.variables ?? null,
  };
  state.requests.push(record);
  if (req.method !== "POST" || path !== "/v2") {
    return sendJson(res, 404, { error: "Not found" });
  }
  if (record.authorization !== state.token) return FAULTS.unauthorized(res);
  const json = record.contentType?.startsWith("application/json");
  if (!json || typeof body?.query !== "string") {
    return sendJson(
      res,
      400,
      errorBody("Bad request", { code: "BAD_REQUEST" }),
    );
  }
  const request = { ...body, operationName: record.operationName };
  const fault = takeFault(state, request);
  if (fault) return sendFault(state, fault, res, request);
  return sendJson(res, 200, runQuery(state, request));
}

/**
 * Starts the fake on 127.0.0.1 (options: `data`, `token`, `blockPageCap`).
 * Resolves to `{ endpoint, origin, token,
 * data, requests, errors, faults, fail(fault), close() }`; `endpoint` is
 * the value for `MM_IMPORT_MONDAY_URL`.
 */
export async function startMondayServer(options = {}) {
  const state = {
    data: options.data ?? mondayFixture(),
    token: options.token ?? MONDAY_TOKEN,
    requests: [],
    errors: [],
    faults: [],
    cursors: new Map(),
    blockPageCap: options.blockPageCap ?? Number.POSITIVE_INFINITY,
  };
  const http = createServer((req, res) => {
    handle(state, req, res).catch((error) => {
      if (!res.headersSent) sendJson(res, 500, errorBody(error.message, {}));
    });
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  state.origin = `http://127.0.0.1:${http.address().port}`;
  state.endpoint = `${state.origin}/v2`;
  state.fail = (fault) => state.faults.push({ ...fault });
  state.close = () =>
    new Promise((resolve) => {
      http.closeAllConnections();
      http.close(() => resolve());
    });
  return state;
}
