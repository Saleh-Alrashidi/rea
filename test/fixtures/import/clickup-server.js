/**
 * A fake ClickUp REST API (node:http) for the importer tests and the
 * import e2e, serving `clickupFixture()` under `/api` in ClickUp's shapes:
 *
 * - v2 `GET /team`, `/team/{id}/space`, `/space/{id}/folder`,
 *   `/folder/{id}/list`, `/space/{id}/list` (each with `archived=false`),
 *   `/list/{id}` (with statuses), `/list/{id}/field`,
 *   `/list/{id}/task?page&include_closed&subtasks&archived` (100 tasks
 *   per 0-based page, `last_page`), `/task/{id}/comment` (25 per page,
 *   newest first, older pages by `start` + `start_id`) and
 *   `/comment/{id}/reply`;
 * - v3 `GET /workspaces/{team}/docs?limit&deleted&archived&cursor` (the
 *   answer's `next_cursor` is the next request's `cursor`)
 *   and `/workspaces/{team}/docs/{doc}/pages?max_page_depth&content_format`.
 *
 * Routes, query checks and shapes are `clickup-api.js`. The token must be
 * the `Authorization` header (else 401 `{ err, ECODE }`).
 * Requests with unknown routes, methods or query parameters are answered
 * 400/404 and recorded in `errors` (tests expect none). `requests`
 * records each request (`route`, `params`, `query`, `at` from the `now`
 * option, so tests with a fake clock can check the request rate).
 *
 * `server.fail({ route, match, kind, times, seconds, ms, bytes })` queues
 * a fault for requests of `route` whose params and query fit `match`:
 * `rate_limit` (429 with `X-RateLimit-Reset`, epoch seconds), `retry_after`
 * (429 with `Retry-After`), `unauthorized` (401 "Token invalid"),
 * `team_unauthorized` (401 OAUTH_027 "Team not authorized", which ClickUp
 * also answers for a list or task the token's user may not read),
 * `not_found` (404),
 * `server_error` (500), `echo_token` (400 quoting the token), `empty`
 * (200 `{}`), `edit` (200 with `fault.edit(body, record)` of the normal
 * answer),
 * `slow` (answers after `ms`), `oversized` (a streamed body of `bytes`, default
 * 10 MiB + 1 KiB), `redirect` (302) and `html` (200, not JSON).
 */
import { createServer } from "node:http";
import {
  FakeError,
  HANDLERS,
  matchRoute,
  queryProblem,
} from "./clickup-api.js";
import { CLICKUP_TOKEN, clickupFixture } from "./clickup-data.js";

// ------------------------------------------------------------ faults

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
  res.write('{"pad":"');
  pump();
}

const FAULTS = {
  rate_limit: (state, res, fault) => {
    const reset = Math.ceil((state.now() + fault.seconds * 1000) / 1000);
    const headers = {
      "X-RateLimit-Limit": "100",
      "X-RateLimit-Remaining": "0",
      "X-RateLimit-Reset": String(reset),
    };
    sendJson(
      res,
      429,
      { err: "Rate limit reached", ECODE: "APP_002" },
      headers,
    );
  },
  retry_after: (state, res, fault) =>
    sendJson(
      res,
      429,
      { err: "Rate limit reached", ECODE: "APP_002" },
      { "Retry-After": String(fault.seconds) },
    ),
  unauthorized: (state, res) =>
    sendJson(res, 401, { err: "Token invalid", ECODE: "OAUTH_025" }),
  team_unauthorized: (state, res) =>
    sendJson(res, 401, { err: "Team not authorized", ECODE: "OAUTH_027" }),
  not_found: (state, res) =>
    sendJson(res, 404, { err: "List not found", ECODE: "ITEM_013" }),
  server_error: (state, res) =>
    sendJson(res, 500, { err: "Internal server error", ECODE: "APP_001" }),
  empty: (state, res) => sendJson(res, 200, {}),
  echo_token: (state, res) =>
    sendJson(res, 400, {
      err: `Bad request for ${state.token}`,
      ECODE: "APP_003",
    }),
  oversized: (state, res, fault) =>
    streamOversized(res, fault.bytes ?? 10 * 1024 * 1024 + 1024),
  redirect: (state, res) => {
    res.writeHead(302, { Location: `${state.origin}/elsewhere` });
    res.end();
  },
  html: (state, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html>Bad gateway</html>");
  },
};

function takeFault(state, record) {
  const fields = { ...record.params, ...record.query };
  const fits = (fault) =>
    fault.route === record.route &&
    Object.entries(fault.match ?? {}).every(
      ([key, value]) => fields[key] === String(value),
    );
  const index = state.faults.findIndex(fits);
  if (index === -1) return null;
  const fault = state.faults[index];
  fault.times = (fault.times ?? 1) - 1;
  if (fault.times <= 0) state.faults.splice(index, 1);
  return fault;
}

function answer(state, record, res) {
  const fault = takeFault(state, record);
  if (fault && !["slow", "edit"].includes(fault.kind)) {
    return FAULTS[fault.kind](state, res, {
      ...fault,
      seconds: fault.seconds ?? 1,
    });
  }
  const send = () => {
    if (res.destroyed) return;
    try {
      const body = HANDLERS[record.route](
        state.data,
        record.params,
        record.query,
      );
      const edited = fault?.kind === "edit" ? fault.edit(body, record) : body;
      sendJson(res, 200, edited);
    } catch (error) {
      if (!(error instanceof FakeError)) throw error;
      sendJson(res, error.status, { err: error.message, ECODE: error.ecode });
    }
  };
  if (fault?.kind === "slow") {
    return setTimeout(send, fault.ms ?? 1000).unref();
  }
  return send();
}

function handle(state, req, res) {
  const url = new URL(req.url, state.origin);
  const found = matchRoute(url.pathname);
  const query = Object.fromEntries(url.searchParams);
  const record = {
    method: req.method,
    path: url.pathname,
    route: found?.route ?? null,
    params: found?.params ?? {},
    query,
    authorization: req.headers.authorization ?? null,
    accept: req.headers.accept ?? null,
    at: state.now(),
  };
  state.requests.push(record);
  const problem = !found
    ? "unknown route"
    : req.method !== "GET"
      ? `method ${req.method}`
      : queryProblem(found.spec, query);
  if (problem) {
    state.errors.push({ problem, path: url.pathname, query });
    return sendJson(res, found ? 400 : 404, {
      err: problem,
      ECODE: "FAKE_400",
    });
  }
  if (record.authorization !== state.token)
    return FAULTS.unauthorized(state, res);
  return answer(state, record, res);
}

/**
 * Starts the fake on 127.0.0.1. Options: `data` (default
 * `clickupFixture()`), `token`, `now` (a clock for `requests[].at` and
 * `X-RateLimit-Reset`). Resolves to `{ endpoint, origin, token, data,
 * requests, errors, faults, fail(fault), close() }`; `endpoint` is the
 * value for `MM_IMPORT_CLICKUP_URL`.
 */
export async function startClickUpServer(options = {}) {
  const state = {
    data: options.data ?? clickupFixture(),
    token: options.token ?? CLICKUP_TOKEN,
    now: options.now ?? Date.now,
    requests: [],
    errors: [],
    faults: [],
  };
  const http = createServer((req, res) => {
    try {
      handle(state, req, res);
    } catch (error) {
      if (!res.headersSent)
        sendJson(res, 500, { err: error.message, ECODE: "FAKE_500" });
    }
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  state.origin = `http://127.0.0.1:${http.address().port}`;
  state.endpoint = `${state.origin}/api`;
  state.fail = (fault) => state.faults.push({ ...fault });
  state.close = () =>
    new Promise((resolve) => {
      http.closeAllConnections();
      http.close(() => resolve());
    });
  return state;
}
