/**
 * Shared test helpers: real host and apps servers over an in-memory store,
 * plus small HTTP clients for GraphQL, browser sessions and raw requests.
 */
import { request as httpRequest } from "node:http";
import { startServers } from "../server/http.js";
import { createStore } from "../server/store.js";

/** A logger that records instead of printing. */
export function recordingLog() {
  const entries = [];
  const record =
    (level) =>
    (...args) =>
      entries.push({ level, args });
  return {
    entries,
    error: record("error"),
    warn: record("warn"),
    info: record("info"),
    log: record("log"),
  };
}

/**
 * A view of `store` that also knows the API token `record`
 * (`{ token, user_id, scopes, label }`), for scopes no seeded token has.
 */
export function storeWithToken(store, record) {
  const findApiToken = (token) =>
    token === record.token ? record : store.findApiToken(token);
  return Object.freeze({ ...store, findApiToken });
}

/**
 * Starts both servers on free ports over a fresh in-memory store (or
 * `options.store`). Other options are passed to `startServers`.
 * @returns {Promise<{ hostUrl, appsUrl, hostOrigin, appsOrigin, store, auth,
 *   tokens: { readWrite, readOnly }, log, close(): Promise<void> }>}
 */
export async function startTestServers(options = {}) {
  const log = options.log ?? recordingLog();
  const store = options.store ?? (await createStore({ file: null, log }));
  const servers = await startServers({
    hostPort: 0,
    appsPort: 0,
    ...options,
    store,
    log,
  });
  const tokens = store.listApiTokens();
  const token = (label) =>
    tokens.find((record) => record.label === label).token;
  return {
    hostUrl: servers.hostOrigin,
    appsUrl: servers.appsOrigin,
    hostOrigin: servers.hostOrigin,
    appsOrigin: servers.appsOrigin,
    store,
    auth: servers.auth,
    tokens: { readWrite: token("read-write"), readOnly: token("read-only") },
    log,
    close: () => servers.close(),
  };
}

async function readResponse(response) {
  const text = await response.text();
  const type = response.headers.get("content-type") ?? "";
  if (!type.startsWith("application/json")) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * POSTs a GraphQL request to `<hostUrl>/v2`. `token` becomes a Bearer
 * Authorization header and `apiVersion` the API-Version header.
 * @returns {Promise<{ status: number, headers: Headers, body: unknown }>}
 */
export async function gql(
  hostUrl,
  { query, variables, operationName, token, apiVersion, headers = {} } = {},
) {
  const sent = { "Content-Type": "application/json" };
  if (token !== undefined) sent.Authorization = `Bearer ${token}`;
  if (apiVersion !== undefined) sent["API-Version"] = apiVersion;
  const response = await fetch(new URL("/v2", hostUrl), {
    method: "POST",
    headers: { ...sent, ...headers },
    body: JSON.stringify({ query, variables, operationName }),
  });
  const body = await readResponse(response);
  return { status: response.status, headers: response.headers, body };
}

/**
 * Opens the boards app (`GET /`) like a new browser and returns headers for
 * same-origin API calls: `{ Cookie, Origin }`.
 */
export async function browserSession(hostUrl) {
  const response = await fetch(new URL("/", hostUrl));
  await response.arrayBuffer();
  const cookie = response.headers.get("set-cookie") ?? "";
  const [pair] = cookie.split(";");
  return { Cookie: pair, Origin: new URL(hostUrl).origin };
}

/**
 * Sends one raw HTTP/1.1 request with node:http, so tests control the exact
 * target (no URL normalization) and headers such as Host.
 * @returns {Promise<{ status: number, headers: object, body: string }>}
 */
export function rawRequest(baseUrl, { method = "GET", path, headers, body }) {
  const url = new URL(baseUrl);
  // The servers listen on 127.0.0.1; "localhost" stays in the Host header.
  const hostname = url.hostname === "localhost" ? "127.0.0.1" : url.hostname;
  const sent = { Host: url.host, ...headers };
  return new Promise((resolve, reject) => {
    const options = { hostname, port: url.port, method, path, headers: sent };
    const req = httpRequest(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode, headers: res.headers, body: text });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  });
}
