/**
 * Helpers of the hosted-mode suites (`test/hosted-*.test.js`, SPEC-3):
 * hosted servers behind made-up public `https:` origins, reached over
 * plain HTTP on a free port the way the platform's proxy reaches them,
 * with a hand-moved clock and small clients for the site gate.
 */
import { startServers } from "../server/http.js";
import { createStore } from "../server/store.js";
import { rawRequest, recordingLog, seedIds } from "./helpers.js";

export const HOST = "https://worklane.example";
export const APPS = "https://apps-worklane.example";
export const PASSWORD = "correct horse battery staple";
export const HOUR = 60 * 60 * 1000;
export const JSON_TYPE = { "Content-Type": "application/json" };

/** A clock the test moves: `now()` and `advance(ms)`. */
export function manualClock(start = Date.UTC(2026, 9, 18, 9)) {
  let at = start;
  return {
    now: () => at,
    advance: (ms) => {
      at += ms;
    },
  };
}

/** The `name=value` pair of a response's first Set-Cookie, or null. */
export const cookieOf = (response) =>
  response.headers["set-cookie"]?.[0]?.split(";")[0] ?? null;

/** The first error code of a JSON error response. */
export const codeOf = (response) =>
  JSON.parse(response.body).errors?.[0]?.extensions?.code ?? null;

/**
 * Hosted-mode servers (`startServers({ mode: "hosted" })`) on a free
 * port over a fresh in-memory store, closed after `t`. Defaults: host
 * origin HOST, site password PASSWORD, no apps origin; `options` override
 * them (`sitePassword: null` turns the gate off).
 *
 * `request(path, { method, host, headers, body })` sends one raw request
 * with `Host: host` (default HOST's host) and a JSON `body`;
 * `signIn(password, { next, headers })` posts to `/signin` from HOST;
 * `session()` signs in and returns the cookie pair; `as(cookie)` gives
 * same-origin headers for cookie calls.
 */
export async function startHosted(t, options = {}) {
  const log = recordingLog();
  const store = await createStore({ file: null, log });
  const servers = await startServers({
    mode: "hosted",
    port: 0,
    hostOrigin: HOST,
    sitePassword: PASSWORD,
    store,
    log,
    ...options,
  });
  t.after(() => servers.close());
  const base = `http://127.0.0.1:${servers.hostServer.address().port}`;
  const hostHeader = new URL(servers.hostOrigin).host;
  const request = (path, { method = "GET", host, headers = {}, body } = {}) =>
    rawRequest(base, {
      method,
      path,
      headers: { Host: host ?? hostHeader, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const signIn = (password = PASSWORD, { next, headers = {} } = {}) =>
    request("/signin", {
      method: "POST",
      headers: { ...JSON_TYPE, Origin: servers.hostOrigin, ...headers },
      body: { password, next },
    });
  const session = async () => cookieOf(await signIn());
  const as = (cookie) => ({ Cookie: cookie, Origin: servers.hostOrigin });
  const token = (label) =>
    store.listApiTokens().find((record) => record.label === label).token;
  return {
    servers,
    store,
    log,
    base,
    request,
    signIn,
    session,
    as,
    ids: seedIds(store),
    tokens: { readWrite: token("read-write"), readOnly: token("read-only") },
  };
}

/** POST /v2 `query` with `headers` (JSON type added); `{ status, body }`. */
export async function graphqlVia(hosted, query, headers = {}) {
  const response = await hosted.request("/v2", {
    method: "POST",
    headers: { ...JSON_TYPE, ...headers },
    body: { query },
  });
  return { status: response.status, body: JSON.parse(response.body) };
}
