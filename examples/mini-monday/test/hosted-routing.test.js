/**
 * Hosted mode's single listener (SPEC-3 §3–4): Host routing with and
 * without an apps origin, the app platform turned off without one, the
 * hosted headers (X-Robots-Tag, HSTS, Secure cookies), configured origins
 * for CSP, cookies and Origin checks whatever Host arrives, and local
 * mode unchanged.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { startServers } from "../server/http.js";
import { createStore } from "../server/store.js";
import { rawRequest, recordingLog, startTestServers } from "./helpers.js";
import {
  APPS,
  HOST,
  JSON_TYPE,
  PASSWORD,
  codeOf,
  graphqlVia,
  startHosted,
} from "./hosted-helpers.js";

const APPS_HOST = new URL(APPS).host;
const PAGE = { "Sec-Fetch-Mode": "navigate" };
const VIEWS =
  "query V($id: ID!) { boards(ids: [$id]) { views { type app_url } } }";
const hostCsp = (frames) =>
  "default-src 'self'; script-src 'self'; style-src 'self'; " +
  "img-src 'self' data:; connect-src 'self'; " +
  `${frames}frame-ancestors 'none'; base-uri 'none'; ` +
  "form-action 'self'; object-src 'none'";

async function viewsOf(hosted, headers) {
  const { status, body } = await hosted.request("/v2", {
    method: "POST",
    headers: { ...JSON_TYPE, ...headers },
    body: { query: VIEWS, variables: { id: hosted.ids.boards.roadmap } },
  });
  assert.equal(status, 200, JSON.stringify(body));
  return JSON.parse(body).data.boards[0].views;
}

const installOf = (hosted) =>
  hosted.store.listInstalls({ boardId: hosted.ids.boards.roadmap })[0];

test("with MM_APPS_ORIGIN, its Host reaches the apps handler", async (t) => {
  const hosted = await startHosted(t, { appsOrigin: APPS });
  const { request, session, as } = hosted;
  for (const host of [APPS_HOST, `${APPS_HOST}:443`, APPS_HOST.toUpperCase()]) {
    const sdk = await request("/sdk/mini-monday-sdk.js", { host });
    assert.equal(sdk.status, 200, host);
    assert.equal(
      sdk.headers["content-security-policy"],
      "default-src 'self'; script-src 'self'; style-src 'self'; " +
        `connect-src 'self'; img-src 'self' data:; frame-ancestors ${HOST}; ` +
        "base-uri 'none'; object-src 'none'",
    );
    assert.equal(sdk.headers["set-cookie"], undefined);
  }
  const config = await request("/apps/config.js", { host: APPS_HOST });
  assert.equal(
    config.body,
    `export const HOST_ORIGIN = ${JSON.stringify(HOST)};\n`,
  );
  assert.equal(
    (await request("/v2", { method: "POST", host: APPS_HOST })).status,
    404,
  );
  assert.equal((await request("/signin", { host: APPS_HOST })).status, 404);
  // The host's Host goes to the gated host handler, which has no SDK.
  assert.equal(codeOf(await request("/sdk/mini-monday-sdk.js")), "SITE_LOCKED");
  const cookie = await session();
  const index = await request("/", { headers: { ...PAGE, Cookie: cookie } });
  assert.equal(
    index.headers["content-security-policy"],
    hostCsp(`frame-src ${APPS}; `),
  );
  const [app] = (await viewsOf(hosted, as(cookie))).filter(
    (v) => v.type === "app",
  );
  const install = installOf(hosted);
  assert.equal(
    app.app_url,
    `${APPS}/apps/status-summary/index.html?install_id=${install.id}`,
  );
  const token = await request("/apps/session-token", {
    method: "POST",
    headers: { ...JSON_TYPE, ...as(cookie) },
    body: { install_id: install.id },
  });
  assert.equal(token.status, 200);
});

test("without MM_APPS_ORIGIN the app platform is off", async (t) => {
  const hosted = await startHosted(t);
  const { request, session, as, servers } = hosted;
  assert.equal(servers.appsOrigin, null);
  assert.equal(servers.appsServer, null);
  // Every Host reaches the host handler, the gate included.
  const sdk = await request("/sdk/mini-monday-sdk.js", { host: APPS_HOST });
  assert.equal(codeOf(sdk), "SITE_LOCKED");
  const cookie = await session();
  const views = await viewsOf(hosted, as(cookie));
  assert.deepEqual(
    views.map((view) => view.type),
    ["table", "kanban"],
  );
  assert.ok(views.every((view) => view.app_url === null));
  const install = installOf(hosted);
  const token = await request("/apps/session-token", {
    method: "POST",
    headers: { ...JSON_TYPE, ...as(cookie) },
    body: { install_id: install.id },
  });
  assert.equal(token.status, 404);
  const app = await graphqlVia(hosted, "{ me { id } }", {
    ...as(cookie),
    "X-App-Install": install.id,
  });
  assert.equal(app.status, 403);
  const index = await request("/", { headers: { ...PAGE, Cookie: cookie } });
  const signin = await request("/signin", { headers: PAGE });
  for (const page of [index, signin]) {
    assert.equal(page.status, 200);
    assert.equal(page.headers["content-security-policy"], hostCsp(""));
  }
});

test("any Host reaches the host handler; origins come from the configuration", async (t) => {
  const hosted = await startHosted(t);
  const { request, signIn, as } = hosted;
  const internal = "worklane.internal:8080";
  const health = await request("/healthz", { host: internal });
  assert.equal(health.status, 200);
  const noHost = await request("/healthz", { host: "" });
  assert.equal(noHost.status, 200);
  // Origin checks use MM_HOST_ORIGIN, never the Host that arrived.
  const fromInternal = await signIn(PASSWORD, {
    headers: { Origin: `http://${internal}` },
  });
  assert.equal(fromInternal.status, 403);
  const signedIn = await signIn(PASSWORD);
  const [cookie] = signedIn.headers["set-cookie"];
  assert.match(cookie, /; Secure$/, "https: host origin → Secure cookie");
  const pair = cookie.split(";")[0];
  const api = await request("/v2", {
    method: "POST",
    host: internal,
    headers: { ...JSON_TYPE, Cookie: pair, Origin: `http://${internal}` },
    body: { query: "{ me { id } }" },
  });
  assert.equal(api.status, 403);
  const ok = await graphqlVia(hosted, "{ me { id } }", as(pair));
  assert.equal(ok.body.data.me.id, "1");
});

test("hosted responses carry X-Robots-Tag and, for https:, HSTS", async (t) => {
  const hosted = await startHosted(t, { appsOrigin: APPS });
  const { request } = hosted;
  const responses = [
    await request("/healthz"),
    await request("/robots.txt"),
    await request("/signin"),
    await request("/", { headers: PAGE }),
    await request("/v2", { method: "POST" }),
    await request("/sdk/mini-monday-sdk.js", { host: APPS_HOST }),
    await request("/apps/nope/x.js", { host: APPS_HOST }),
  ];
  for (const response of responses) {
    const { headers, status } = response;
    assert.equal(headers["x-robots-tag"], "noindex, nofollow", String(status));
    assert.equal(headers["strict-transport-security"], "max-age=31536000");
    assert.equal(headers["x-content-type-options"], "nosniff");
    assert.equal(headers["referrer-policy"], "no-referrer");
  }
  assert.equal(
    responses[2].headers["cross-origin-opener-policy"],
    "same-origin",
  );
});

test("an http: loopback host origin gets no HSTS and no Secure cookies", async (t) => {
  const hosted = await startHosted(t, { hostOrigin: "http://localhost:4199" });
  const response = await hosted.signIn();
  assert.equal(response.status, 200);
  assert.equal(response.headers["strict-transport-security"], undefined);
  assert.equal(response.headers["x-robots-tag"], "noindex, nofollow");
  assert.doesNotMatch(response.headers["set-cookie"][0], /Secure/);
});

test("local mode is unchanged: two listeners, Host check, no hosted routes or headers", async (t) => {
  const servers = await startTestServers();
  t.after(() => servers.close());
  const host = (path) => fetch(new URL(path, servers.hostUrl));
  const index = await host("/");
  assert.equal(index.status, 200);
  assert.match(index.headers.get("set-cookie"), /^mm_session=/);
  assert.equal(index.headers.get("x-robots-tag"), null);
  assert.equal(index.headers.get("strict-transport-security"), null);
  for (const path of ["/healthz", "/robots.txt", "/signin"]) {
    const response = await host(path);
    await response.arrayBuffer();
    assert.equal(response.status, 404, path);
  }
  const foreign = await rawRequest(servers.hostUrl, {
    path: "/",
    headers: { Host: "evil.example" },
  });
  assert.equal(foreign.status, 400);
  assert.notEqual(servers.appsUrl, servers.hostUrl);
});

test("startServers checks the hosted options", async (t) => {
  const log = recordingLog();
  const store = await createStore({ file: null, log });
  const start = (options) =>
    startServers({ store, log, mode: "hosted", port: 0, ...options });
  const cases = [
    [{ mode: "cloud" }, /mode/],
    [{}, /hostOrigin/],
    [{ hostOrigin: `${HOST}/` }, /hostOrigin/],
    [{ hostOrigin: HOST, appsOrigin: `${HOST}:8443` }, /different hosts/],
    [{ hostOrigin: HOST, port: 70_000 }, /port/],
    [{ hostOrigin: HOST, sitePassword: "too short" }, /12 characters/],
    [{ hostOrigin: HOST, trustProxy: "1" }, /trustProxy/],
  ];
  for (const [options, message] of cases) {
    await assert.rejects(start(options), message, JSON.stringify(options));
  }
  const servers = await start({ hostOrigin: HOST, sitePassword: PASSWORD });
  t.after(() => servers.close());
  assert.equal(servers.hostOrigin, HOST);
});
