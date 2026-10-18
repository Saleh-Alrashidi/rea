/**
 * HTTP behavior of both servers: headers and CSP, static file safety,
 * authentication paths and status codes, app principals, get_schema,
 * session tokens and their verification, and the entry point.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { signJwt } from "../server/auth.js";
import {
  browserSession,
  gql,
  rawRequest,
  startTestServers,
} from "./helpers.js";

const MAIN = fileURLToPath(new URL("../server/main.js", import.meta.url));
const JSON_TYPE = "application/json; charset=utf-8";

async function setup(t) {
  const servers = await startTestServers();
  t.after(() => servers.close());
  const { store } = servers;
  const roadmap = store.listBoards().find((b) => b.name === "Product roadmap");
  const [install] = store.listInstalls({ boardId: roadmap.id });
  const host = (path, init) => fetch(new URL(path, servers.hostUrl), init);
  const apps = (path, init) => fetch(new URL(path, servers.appsUrl), init);
  return { ...servers, roadmap, install, host, apps };
}

/** Asserts the status and `{ errors }` code of a response (or promise). */
async function assertError(pending, status, code) {
  const response = await pending;
  assert.equal(response.status, status);
  assert.equal(response.headers.get("content-type"), JSON_TYPE);
  const body = await response.json();
  assert.equal(body.errors[0].extensions.code, code);
  assert.equal(typeof body.errors[0].message, "string");
}

const postJson = (body, headers = {}) => ({
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

test("GET / serves the app with CSP, security headers and a session", async (t) => {
  const { host, hostOrigin, appsOrigin, auth } = await setup(t);
  const response = await host("/");
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("content-type"),
    "text/html; charset=utf-8",
  );
  assert.match(await response.text(), /<script type="module" src="\/main.js">/);
  assert.equal(
    response.headers.get("content-security-policy"),
    "default-src 'self'; script-src 'self'; style-src 'self'; " +
      "img-src 'self' data:; connect-src 'self'; " +
      `frame-src ${appsOrigin}; frame-ancestors 'none'; base-uri 'none'; ` +
      "form-action 'self'; object-src 'none'",
  );
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(
    response.headers.get("cross-origin-opener-policy"),
    "same-origin",
  );
  const cookie = response.headers.get("set-cookie");
  const match = /^mm_session=([\w-]{43}); HttpOnly; SameSite=Strict; Path=\/$/;
  assert.match(cookie, match);
  const sessionId = match.exec(cookie)[1];
  assert.equal(auth.getBrowserSession(sessionId).userId, "1");
  const again = await host("/", {
    headers: { Cookie: `mm_session=${sessionId}` },
  });
  assert.equal(
    again.headers.get("set-cookie"),
    null,
    "known sessions are kept",
  );
  const stale = await host("/", { headers: { Cookie: "mm_session=unknown" } });
  assert.match(stale.headers.get("set-cookie"), /^mm_session=/);
  const head = await host("/", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.ok(hostOrigin.startsWith("http://localhost:"));
});

test("static files: types, 404, 405 and traversal attempts", async (t) => {
  const { host, hostUrl } = await setup(t);
  const script = await host("/main.js");
  assert.equal(script.status, 200);
  const jsType = "text/javascript; charset=utf-8";
  assert.equal(script.headers.get("content-type"), jsType);
  assert.equal(script.headers.get("x-content-type-options"), "nosniff");
  const nested = await host("/styles/base.css");
  assert.equal(nested.headers.get("content-type"), "text/css; charset=utf-8");
  await assertError(host("/missing.js"), 404, "NOT_FOUND");
  await assertError(host("/index.txt"), 404, "NOT_FOUND");
  const post = await host("/main.js", { method: "POST" });
  assert.equal(post.headers.get("allow"), "GET, HEAD");
  await assertError(post, 405, "METHOD_NOT_ALLOWED");
  const remove = await host("/", { method: "DELETE" });
  await assertError(remove, 405, "METHOD_NOT_ALLOWED");
  const attempts = [
    "/../server/auth.js",
    "/%2e%2e/server/auth.js",
    "/ui/..%2f..%2fserver%2fauth.js",
    "/ui%2f..%2f..%2fpackage.json",
    "/%5c..%5cpackage.json",
    "/ui\\..\\..\\package.json",
    "/main.js%00.css",
    "/.data/mini-monday.json",
    "/%2edata/mini-monday.json",
    "/%252e%252e/package.json",
    "//etc/passwd",
    "/styles/./base.css",
    "/styles/",
    "/package.json",
  ];
  for (const path of attempts) {
    const response = await rawRequest(hostUrl, { path });
    assert.equal(response.status, 404, path);
    assert.equal(
      JSON.parse(response.body).errors[0].extensions.code,
      "NOT_FOUND",
    );
  }
  const malformed = await rawRequest(hostUrl, { path: "/%E0%A4%A.js" });
  assert.equal(malformed.status, 400);
  const target = await rawRequest(hostUrl, { method: "OPTIONS", path: "*" });
  assert.equal(target.status, 400);
});

test("Host headers other than the origin, localhost or an IP are refused", async (t) => {
  const { hostUrl, appsUrl } = await setup(t);
  const port = new URL(hostUrl).port;
  const evil = await rawRequest(hostUrl, {
    path: "/",
    headers: { Host: `rebind.example:${port}` },
  });
  assert.equal(evil.status, 400);
  assert.equal(evil.headers["set-cookie"], undefined);
  for (const name of ["127.0.0.1", "[::1]", "LOCALHOST"]) {
    const ok = await rawRequest(hostUrl, {
      path: "/main.js",
      headers: { Host: `${name}:${port}` },
    });
    assert.equal(ok.status, 200, name);
  }
  const apps = await rawRequest(appsUrl, {
    path: "/apps/config.js",
    headers: { Host: "evil.example" },
  });
  assert.equal(apps.status, 400);
});

test("POST /v2 authentication: tokens, cookies, Origin and X-App-Install", async (t) => {
  const { hostUrl, hostOrigin, tokens, install } = await setup(t);
  const query = "{ me { id } }";
  const status = async (options) => await gql(hostUrl, { query, ...options });
  const none = await status({});
  assert.equal(none.status, 401);
  assert.equal(none.body.errors[0].extensions.code, "UNAUTHENTICATED");
  assert.equal(none.headers.get("api-version"), "2026-01");
  assert.equal((await status({ token: "wrong" })).status, 401);
  const raw = { headers: { Authorization: tokens.readOnly } };
  assert.equal((await status(raw)).status, 200, "raw tokens work");
  assert.equal((await status({ headers: { Authorization: "" } })).status, 401);
  const session = await browserSession(hostUrl);
  const cookieOnly = await status({ headers: { Cookie: session.Cookie } });
  assert.equal(cookieOnly.status, 403);
  assert.equal(cookieOnly.body.errors[0].extensions.code, "FORBIDDEN");
  const foreign = { ...session, Origin: "http://127.0.0.1:1" };
  assert.equal((await status({ headers: foreign })).status, 403);
  const signedIn = await status({ headers: session });
  assert.equal(signedIn.status, 200);
  assert.equal(signedIn.body.data.me.id, "1");
  const unknown = { Cookie: "mm_session=nope", Origin: hostOrigin };
  assert.equal((await status({ headers: unknown })).status, 401);
  for (const id of ["999999", "abc", ""]) {
    const app = { ...session, "X-App-Install": id };
    const refused = await status({ headers: app });
    assert.equal(refused.status, 403, id);
  }
  const app = { ...session, "X-App-Install": install.id };
  assert.equal((await status({ headers: app })).status, 200);
  const mixed = await status({
    token: tokens.readWrite,
    headers: { "X-App-Install": install.id },
  });
  assert.equal(mixed.status, 400);
  assert.equal(mixed.body.errors[0].extensions.code, "BAD_REQUEST");
});

/**
 * Sends headers declaring a `length`-byte body plus only a few bytes, and
 * resolves with the status (rejects if no response comes within 2 s).
 */
function declaredOnly(baseUrl, length, headers) {
  const { port } = new URL(baseUrl);
  const sent = { ...headers, "Content-Type": "application/json" };
  sent["Content-Length"] = String(length);
  return new Promise((resolve, reject) => {
    const options = { host: "127.0.0.1", port, method: "POST", path: "/v2" };
    const req = request({ ...options, headers: sent }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.setTimeout(2000, () => req.destroy(new Error("no early response")));
    req.on("error", reject);
    req.write("{}");
  });
}

test("POST /v2 status paths: 415, 413, 400, 405 and API-Version", async (t) => {
  const { host, hostUrl, tokens } = await setup(t);
  const auth = { Authorization: `Bearer ${tokens.readWrite}` };
  const send = (body, headers = {}) =>
    host("/v2", postJson(body, { ...auth, ...headers }));
  const query = { query: "{ me { id } }" };
  const text = await send(query, { "Content-Type": "text/plain" });
  await assertError(text, 415, "UNSUPPORTED_MEDIA_TYPE");
  const latin = { "Content-Type": "application/json; charset=latin1" };
  await assertError(send(query, latin), 415, "UNSUPPORTED_MEDIA_TYPE");
  const upper = { "Content-Type": "Application/JSON; charset=UTF-8" };
  assert.equal((await send(query, upper)).status, 200);
  const exact = JSON.stringify(query);
  const limit = 1024 * 1024;
  const padded = exact + " ".repeat(limit - Buffer.byteLength(exact));
  assert.equal((await send(padded)).status, 200, "exactly 1 MiB is allowed");
  await assertError(send(`${padded} `), 413, "PAYLOAD_TOO_LARGE");
  const chunked = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`${padded}  `));
      controller.close();
    },
  });
  const streamed = await host("/v2", {
    ...postJson("", auth),
    body: chunked,
    duplex: "half",
  });
  await assertError(streamed, 413, "PAYLOAD_TOO_LARGE");
  // A declared oversize body is refused before any of it is read.
  const early = await declaredOnly(hostUrl, 2 * limit, auth);
  assert.equal(early, 413);
  const invalid = ["{", "[]", '"x"', "{}", '{"query":""}'];
  invalid.push('{"query":"{ me { id } }","variables":[1]}');
  invalid.push('{"query":"{ me { id } }","operationName":3}');
  for (const body of invalid) {
    await assertError(send(body), 400, "BAD_REQUEST");
  }
  const utf8 = await host("/v2", {
    ...postJson("", auth),
    body: new Uint8Array([0x7b, 0xff, 0x7d]),
  });
  await assertError(utf8, 400, "BAD_REQUEST");
  const parseError = await send({ query: "{ me {" });
  await assertError(parseError, 400, "GRAPHQL_PARSE_FAILED");
  await assertError(
    send({ query: "{ nope }" }),
    400,
    "GRAPHQL_VALIDATION_FAILED",
  );
  const get = await host("/v2");
  assert.equal(get.headers.get("allow"), "POST");
  await assertError(get, 405, "METHOD_NOT_ALLOWED");
  const rc = await send(query, { "API-Version": " 2026-04 " });
  assert.equal(rc.headers.get("api-version"), "2026-04");
  assert.equal(rc.headers.get("content-type"), JSON_TYPE);
  assert.equal(rc.headers.get("cache-control"), "no-store");
  const old = await send(query, { "API-Version": "2024-01" });
  assert.equal(old.headers.get("api-version"), null);
  await assertError(old, 400, "UNSUPPORTED_API_VERSION");
  const named = await send({
    query: "query A { me { id } } query B { version { value } }",
    operationName: "B",
  });
  assert.deepEqual((await named.json()).data, {
    version: { value: "2026-01" },
  });
});

test("app principals: scope intersection and their own storage only", async (t) => {
  const { hostUrl, store, install } = await setup(t);
  const session = await browserSession(hostUrl);
  const headers = { ...session, "X-App-Install": install.id };
  const app = async (query, variables) =>
    (await gql(hostUrl, { query, variables, headers })).body;
  const read = await app("{ boards(limit: 1) { name } }");
  assert.equal(read.data.boards[0].name, "Product roadmap");
  const boards = store.listBoards({ limit: 100 }).length;
  const write = await app('mutation { create_board(board_name: "No") { id } }');
  assert.equal(write.errors[0].extensions.code, "FORBIDDEN");
  assert.equal(store.listBoards({ limit: 100 }).length, boards);
  const args = "install_id: $i, segment: $s, key: $k";
  const vars = "$i: ID!, $s: StorageSegment!, $k: String!";
  const result = "{ success version reason }";
  const set = `mutation S(${vars}, $v: String!, $p: Int) {
    set_app_storage(${args}, value: $v, previous_version: $p) ${result} }`;
  const get = `query G(${vars}) {
    app_storage(${args}) { key value version } }`;
  const del = `mutation D(${vars}) { delete_app_storage(${args}) ${result} }`;
  const note = { i: install.id, s: "instance", k: "note" };
  const saved = await app(set, { ...note, v: "first" });
  const first = { success: true, version: 1, reason: null };
  assert.deepEqual(saved.data.set_app_storage, first);
  const stale = await app(set, { ...note, v: "second", p: 0 });
  const conflict = { success: false, version: 1, reason: "version_conflict" };
  assert.deepEqual(stale.data.set_app_storage, conflict);
  await app(set, { ...note, v: "second", p: 1 });
  const value = await app(get, note);
  const second = { key: "note", value: "second", version: 2 };
  assert.deepEqual(value.data.app_storage, second);
  const global = await app(get, { ...note, s: "global" });
  assert.equal(global.data.app_storage, null, "segments are separate");
  await app(set, { ...note, s: "global", v: "shared" });
  const scope = `app:${install.app_id}`;
  assert.deepEqual(store.getAppStorage(scope, "note").value, "shared");
  const removed = await app(del, note);
  const cleared = { success: true, version: null, reason: null };
  assert.deepEqual(removed.data.delete_app_storage, cleared);
  assert.equal((await app(get, note)).data.app_storage, null);
  const code = async (query, variables) =>
    (await app(query, variables)).errors[0].extensions.code;
  // Another install's storage is refused, even for an ID that exists.
  const other = { ...note, i: install.app_id, v: "x" };
  for (const query of [set, get, del]) {
    assert.equal(await code(query, other), "FORBIDDEN");
  }
  for (const k of ["", "bad\u0001key", "bad\u007fkey", "k".repeat(257)]) {
    assert.equal(await code(set, { ...note, k, v: "x" }), "BAD_USER_INPUT");
  }
  const big = { ...note, v: "v".repeat(65_537) };
  assert.equal(await code(set, big), "BAD_USER_INPUT");
  assert.equal(await code(set, { ...note, v: "x", p: -1 }), "BAD_USER_INPUT");
  const max = { ...note, k: "k".repeat(256), v: "v".repeat(65_536) };
  assert.equal((await app(set, max)).data.set_app_storage.success, true);
});

test("GET /v2/get_schema prints SDL per version, publicly", async (t) => {
  const { host } = await setup(t);
  const current = await host("/v2/get_schema?format=sdl");
  assert.equal(current.status, 200);
  assert.equal(
    current.headers.get("content-type"),
    "text/plain; charset=utf-8",
  );
  assert.equal(current.headers.get("api-version"), "2026-01");
  const sdl = await current.text();
  assert.match(sdl, /^type Query \{$/m);
  assert.match(
    sdl,
    /items_page\(limit: Int = 25, cursor: String\): ItemsPage!/,
  );
  assert.match(sdl, /^type Mutation \{$/m);
  assert.match(sdl, /^enum StorageSegment \{$/m);
  const old = await (await host("/v2/get_schema?version=2025-10")).text();
  assert.match(old, /items\(limit: Int = 25\): \[Item!\]! @deprecated/);
  const next = await (await host("/v2/get_schema?version=2026-04")).text();
  assert.doesNotMatch(next, /@deprecated/);
  // Item.url is added in 2026-04; Board.url exists in every version.
  const block = (text, type) =>
    new RegExp(`^type ${type} \\{\\n([^}]*)^\\}`, "m").exec(text)[1];
  assert.match(block(next, "Item"), /^ {2}url: String!$/m);
  assert.doesNotMatch(block(sdl, "Item"), /url:/);
  assert.match(block(sdl, "Board"), /^ {2}url: String!$/m);
  const unsupported = await host("/v2/get_schema?version=1999-01");
  await assertError(unsupported, 400, "UNSUPPORTED_API_VERSION");
  await assertError(host("/v2/get_schema?format=json"), 400, "BAD_REQUEST");
  const post = await host("/v2/get_schema", { method: "POST" });
  await assertError(post, 405, "METHOD_NOT_ALLOWED");
});

test("session tokens are issued to sessions and verified by the app backend", async (t) => {
  const { host, apps, hostUrl, store, install, roadmap } = await setup(t);
  const session = await browserSession(hostUrl);
  const issue = (body, headers = session) =>
    host("/apps/session-token", postJson(body, headers));
  const issued = await issue({ install_id: install.id });
  assert.equal(issued.status, 200);
  const { token, expires_at } = await issued.json();
  const lifetime = Date.parse(expires_at) - Date.now();
  assert.ok(lifetime > 250_000 && lifetime <= 300_000, String(lifetime));
  const verify = (sessionToken) =>
    apps("/apps/status-summary/api/verify", postJson({ sessionToken }));
  const verified = await verify(token);
  assert.equal(verified.status, 200);
  const { ok, claims } = await verified.json();
  assert.equal(ok, true);
  const { exp, ...ids } = claims;
  const expected = {
    user_id: "1",
    board_id: roadmap.id,
    install_id: install.id,
  };
  assert.deepEqual(ids, expected);
  assert.equal(exp * 1000, Date.parse(expires_at));
  const rejected = async (sessionToken, reason) => {
    const response = await verify(sessionToken);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { ok: false, reason });
  };
  const [header, payload, signature] = token.split(".");
  const flipped = signature.at(-1) === "A" ? "B" : "A";
  const tampered = `${signature.slice(0, -1)}${flipped}`;
  await rejected(`${header}.${payload}.${tampered}`, "signature");
  const claimsJson = JSON.parse(Buffer.from(payload, "base64url").toString());
  const forged = { ...claimsJson, sub: "2" };
  const swapped = Buffer.from(JSON.stringify(forged)).toString("base64url");
  await rejected(`${header}.${swapped}.${signature}`, "signature");
  const app = store.getApp(install.app_id);
  const expired = { ...claimsJson, exp: Math.floor(Date.now() / 1000) - 1 };
  await rejected(signJwt(expired, app.client_secret), "expired");
  const otherAudience = { ...claimsJson, aud: "someone-else" };
  await rejected(signJwt(otherAudience, app.client_secret), "audience");
  await rejected("not-a-jwt", "malformed");
  const badBody = await apps("/apps/status-summary/api/verify", postJson({}));
  await assertError(badBody, 400, "BAD_REQUEST");
  const get = await apps("/apps/status-summary/api/verify");
  await assertError(get, 405, "METHOD_NOT_ALLOWED");
  await assertError(issue({ install_id: "999999" }), 404, "NOT_FOUND");
  await assertError(issue({ install_id: "../1" }), 400, "BAD_REQUEST");
  const mine = { install_id: install.id };
  const noOrigin = { Cookie: session.Cookie };
  await assertError(issue(mine, noOrigin), 403, "FORBIDDEN");
  await assertError(issue(mine, {}), 401, "UNAUTHENTICATED");
  const text = { ...session, "Content-Type": "text/plain" };
  await assertError(issue(mine, text), 415, "UNSUPPORTED_MEDIA_TYPE");
});

test("apps server: config, SDK, app files with CSP, no cookies and no API", async (t) => {
  const { apps, appsUrl, hostOrigin } = await setup(t);
  const config = await apps("/apps/config.js");
  assert.equal(
    config.headers.get("content-type"),
    "text/javascript; charset=utf-8",
  );
  assert.equal(config.headers.get("cache-control"), "no-store");
  assert.equal(
    await config.text(),
    `export const HOST_ORIGIN = "${hostOrigin}";\n`,
  );
  const sdk = await apps("/sdk/mini-monday-sdk.js");
  assert.equal(sdk.status, 200);
  assert.match(await sdk.text(), /export const PROTOCOL = "mini-monday\/1"/);
  const page = await apps("/apps/status-summary/index.html");
  assert.equal(page.status, 200);
  assert.equal(
    page.headers.get("content-security-policy"),
    "default-src 'self'; script-src 'self'; style-src 'self'; " +
      "connect-src 'self'; img-src 'self' data:; " +
      `frame-ancestors ${hostOrigin}; base-uri 'none'; object-src 'none'`,
  );
  assert.equal(page.headers.get("cross-origin-opener-policy"), null);
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  assert.equal(page.headers.get("set-cookie"), null);
  assert.equal((await apps("/apps/status-summary/app.js")).status, 200);
  for (const path of ["/", "/v2", "/apps/index.html", "/sdk/other.js"]) {
    await assertError(apps(path), 404, "NOT_FOUND");
  }
  await assertError(
    apps("/v2", postJson({ query: "{ me { id } }" })),
    404,
    "NOT_FOUND",
  );
  for (const path of [
    "/apps/../server/auth.js",
    "/apps/status-summary/%2e%2e/%2e%2e/server/auth.js",
    "/apps/status-summary/..%2f..%2fpackage.json",
    "/apps/%2e%2e/package.json",
  ]) {
    assert.equal((await rawRequest(appsUrl, { path })).status, 404, path);
  }
});

/** Runs server/main.js until it prints its banner; returns the child. */
function startMain(env) {
  const child = spawn(process.execPath, [MAIN], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => (output.stdout += chunk));
  child.stderr.on("data", (chunk) => (output.stderr += chunk));
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const ready = new Promise((resolve, reject) => {
    child.stdout.on("data", () => {
      if (output.stdout.includes("Token (read-only)")) resolve();
    });
    child.once("exit", () => reject(new Error(output.stderr)));
  });
  return { child, output, exited, ready };
}

test("server/main.js prints URLs and tokens and exits 0 on SIGTERM", async (t) => {
  const env = {
    MM_HOST_PORT: "0",
    MM_APPS_PORT: "0",
    MM_DATA_FILE: ":memory:",
  };
  const run = startMain(env);
  t.after(() => run.child.kill("SIGKILL"));
  await run.ready;
  const lines = run.output.stdout.trimEnd().split("\n");
  assert.equal(lines[0], "mini-monday is running");
  const [, hostUrl] = /^ {2}Boards app {3}(http:\/\/localhost:\d+)$/.exec(
    lines[1],
  );
  assert.match(lines[2], /^ {2}Apps origin {2}http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(lines[3], `  GraphQL API  ${hostUrl}/v2`);
  const [, token] = /^ {2}Token \(read-write\) {2}([\w-]{43})$/.exec(lines[4]);
  assert.match(lines[5], /^ {2}Token \(read-only\) {3}[\w-]{43}$/);
  const me = await gql(hostUrl, { query: "{ me { name } }", token });
  assert.equal(me.body.data.me.name, "Alex Rivera");
  run.child.kill("SIGTERM");
  assert.equal(await run.exited, 0);
  const bad = startMain({ ...env, MM_HOST_PORT: "http" });
  await assert.rejects(bad.ready, /MM_HOST_PORT/);
  assert.equal(await bad.exited, 1);
});
