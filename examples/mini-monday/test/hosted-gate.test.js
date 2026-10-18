/**
 * The site gate (SPEC-3 §2) by route class: what is open (sign-in,
 * health, robots, the sign-in and form pages' assets, public forms, API
 * tokens on `/v2` and `/v2/events`), what needs a site session, and how a
 * locked request is answered (redirect for page loads, 401 SITE_LOCKED
 * otherwise). Sessions: 12 h sliding expiry, sign-out without auto-login,
 * demo switching that stays signed in.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createAuth } from "../server/auth.js";
import { FORM_ASSETS, SIGNIN_ASSETS } from "../server/routes/gate.js";
import { createStore } from "../server/store.js";
import { openStream } from "./helpers.js";
import {
  HOUR,
  JSON_TYPE,
  codeOf,
  cookieOf,
  graphqlVia,
  manualClock,
  startHosted,
} from "./hosted-helpers.js";

const WEB = fileURLToPath(new URL("../web/", import.meta.url));
const PAGE = { Accept: "text/html,application/xhtml+xml" };
const NAVIGATE = { "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" };
const FETCH = { "Sec-Fetch-Mode": "cors", Accept: "application/json" };

function assertLocked(response, label) {
  assert.equal(response.status, 401, label);
  assert.equal(codeOf(response), "SITE_LOCKED", label);
}

function assertRedirect(response, next, label) {
  assert.equal(response.status, 302, label);
  assert.equal(response.headers.location, `/signin?next=${next}`, label);
  assert.equal(response.headers["cache-control"], "no-store", label);
  assert.equal(response.body, "", label);
}

test("locked page loads redirect to /signin; everything else is 401 SITE_LOCKED", async (t) => {
  const { request } = await startHosted(t);
  assertRedirect(await request("/", { headers: PAGE }), "%2F", "Accept");
  assertRedirect(
    await request("/", { headers: NAVIGATE }),
    "%2F",
    "Sec-Fetch-Mode navigate",
  );
  const deep = await request("/index.html?x=1", { headers: NAVIGATE });
  assertRedirect(deep, "%2Findex.html%3Fx%3D1", "path and query kept");
  const head = await request("/", { method: "HEAD", headers: PAGE });
  assertRedirect(head, "%2F", "HEAD");
  // Sec-Fetch-Mode wins over Accept: a fetch for HTML is not a page load.
  assertLocked(await request("/", { headers: { ...PAGE, ...FETCH } }), "/");
  for (const [method, target] of [
    ["GET", "/main.js"],
    ["GET", "/styles/layout.css"],
    ["GET", "/v2/get_schema"],
    ["GET", "/v2/events?stream=me"],
    ["POST", "/v2"],
    ["POST", "/apps/session-token"],
    ["GET", "/auth/demo-users"],
    ["POST", "/auth/demo-login"],
    ["POST", "/auth/logout"],
    ["PUT", "/"],
    ["GET", "/no-such-page"],
  ]) {
    assertLocked(await request(target, { method }), `${method} ${target}`);
  }
  // A page load of an unsafe target still redirects with a safe next.
  assertRedirect(await request("//evil.example/x", { headers: PAGE }), "%2F");
});

test("open: /signin, /healthz, /robots.txt and the sign-in assets", async (t) => {
  const { request } = await startHosted(t);
  const page = await request("/signin", { headers: NAVIGATE });
  assert.equal(page.status, 200);
  assert.equal(page.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(page.headers["cache-control"], "no-store");
  assert.match(page.body, /<form id="signin-form"/);
  assert.match(page.body, /type="password"/);
  const health = await request("/healthz");
  assert.deepEqual(
    [health.status, health.headers["content-type"], health.body],
    [200, "text/plain; charset=utf-8", "ok"],
  );
  assert.equal(health.headers["set-cookie"], undefined);
  const robots = await request("/robots.txt");
  assert.equal(robots.body, "User-agent: *\nDisallow: /\n");
  for (const asset of [...SIGNIN_ASSETS, ...FORM_ASSETS]) {
    for (const method of ["GET", "HEAD"]) {
      const response = await request(asset, { method });
      assert.equal(response.status, 200, `${method} ${asset}`);
    }
  }
  // Raw paths: another spelling of an open asset is not open.
  assertLocked(await request("/styles/%74okens.css"), "encoded asset");
  assertLocked(await request("/signin.js", { method: "POST" }), "POST asset");
  assertLocked(await request("/healthz", { method: "POST" }), "POST healthz");
});

/** Local stylesheets and scripts an HTML page loads. */
function pageAssets(file) {
  const html = readFileSync(path.join(WEB, file), "utf8");
  const refs = [
    ...html.matchAll(
      /<(?:link rel="stylesheet"|script[^>]*?) (?:href|src)="(\/[^"]+)"/g,
    ),
  ];
  return refs.map((match) => match[1]);
}

/** The module graph of `entry` (a `/…` path under web/), by static imports. */
function moduleGraph(entry) {
  const seen = new Set();
  const visit = (url) => {
    if (seen.has(url)) return;
    seen.add(url);
    const source = readFileSync(path.join(WEB, url), "utf8");
    for (const [, spec] of source.matchAll(
      /^(?:import|export)\s[^;]*?\sfrom\s+"(\.[^"]+)"/gms,
    )) {
      visit(path.posix.join(path.posix.dirname(url), spec));
    }
  };
  visit(entry);
  return seen;
}

test("the open assets are exactly what signin.html and form.html load", () => {
  const signin = pageAssets("signin.html");
  assert.deepEqual(new Set(signin), new Set(SIGNIN_ASSETS));
  // signin.js imports nothing: only it and the stylesheets are open.
  assert.deepEqual([...moduleGraph("/signin.js")], ["/signin.js"]);
  const form = pageAssets("form.html");
  const scripts = form.filter((asset) => asset.endsWith(".js"));
  const loaded = new Set(form.filter((asset) => asset.endsWith(".css")));
  for (const script of scripts) {
    for (const module of moduleGraph(script)) loaded.add(module);
  }
  assert.deepEqual(new Set(FORM_ASSETS), loaded);
});

test("public forms keep their own public / account / closed rules", async (t) => {
  const { request, store, ids, session, as, servers } = await startHosted(t);
  const feature = store.getForm(ids.forms.feature);
  const campaign = store.getForm(ids.forms.campaign);
  const page = await request(`/f/${feature.token}`, { headers: NAVIGATE });
  assert.equal(page.status, 200);
  assert.match(page.body, /form-page\.js/);
  const unknown = await request(`/f/${"x".repeat(22)}`, { headers: NAVIGATE });
  assert.equal(unknown.status, 404, "the form page's own not-found state");
  const definition = await request(`/f/${feature.token}/definition`);
  assert.equal(definition.status, 200);
  const submit = (token, headers = {}) =>
    request(`/f/${token}/submit`, {
      method: "POST",
      headers: { ...JSON_TYPE, Origin: servers.hostOrigin, ...headers },
      body: { answers: { q1: "Behind the gate" } },
    });
  assert.equal((await submit(feature.token)).status, 201);
  // An account form still needs a signed-in member: 401, not SITE_LOCKED.
  const signedOut = await request(`/f/${campaign.token}/definition`);
  assert.equal(signedOut.status, 401);
  assert.equal(codeOf(signedOut), "UNAUTHENTICATED");
  assert.equal(codeOf(await submit(campaign.token)), "UNAUTHENTICATED");
  const cookie = await session();
  const signedIn = await request(`/f/${campaign.token}/definition`, {
    headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin" },
  });
  assert.equal(signedIn.status, 200);
  assert.equal((await submit(campaign.token, as(cookie))).status, 201);
  store.updateForm(feature.id, { access: "closed" });
  assert.equal(codeOf(await submit(feature.token)), "FORM_CLOSED");
  const bad = await request(`/f/${feature.token}/submit`, { method: "GET" });
  assert.equal(bad.status, 405, "the form route answers its own methods");
});

test("API tokens open POST /v2 and GET /v2/events, nothing else", async (t) => {
  const hosted = await startHosted(t);
  const { request, tokens, base } = hosted;
  const bearer = { Authorization: `Bearer ${tokens.readWrite}` };
  const me = await graphqlVia(hosted, "{ me { id } }", bearer);
  assert.equal(me.status, 200);
  assert.equal(me.body.data.me.id, "1");
  const wrong = { Authorization: "Bearer not-a-token" };
  assertLocked(await request("/v2", { method: "POST", headers: wrong }));
  for (const target of ["/v2/get_schema", "/", "/main.js"]) {
    assertLocked(await request(target, { headers: bearer }), target);
  }
  assertLocked(await request("/v2/events?stream=me", { headers: wrong }));
  const stream = await openStream(`${base}/v2/events?stream=me`, bearer);
  t.after(() => stream.close());
  assert.equal(stream.response.status, 200);
  assert.match(stream.response.headers.get("content-type"), /event-stream/);
});

test("site sessions slide for 12 hours and end at sign-out without auto-login", async (t) => {
  const clock = manualClock();
  const hosted = await startHosted(t, { now: clock.now });
  const { request, signIn, as } = hosted;
  const cookie = cookieOf(await signIn());
  const open = () => request("/", { headers: { ...PAGE, Cookie: cookie } });
  const index = await open();
  assert.equal(index.status, 200);
  assert.equal(index.headers["set-cookie"], undefined);
  for (let step = 0; step < 3; step += 1) {
    clock.advance(12 * HOUR - 1);
    assert.equal((await open()).status, 200, `use ${step} slides the expiry`);
  }
  clock.advance(12 * HOUR);
  assertRedirect(await open(), "%2F", "12 idle hours end the session");
  assertLocked(
    await request("/v2/get_schema", { headers: { Cookie: cookie } }),
  );
  // Sign out: the session ends at once and nothing signs the browser in.
  const fresh = cookieOf(await signIn());
  const out = await request("/auth/logout", {
    method: "POST",
    headers: as(fresh),
  });
  assert.equal(out.status, 204);
  assert.match(out.headers["set-cookie"][0], /^mm_session=; .*Max-Age=0/);
  const after = await request("/", { headers: { ...PAGE, Cookie: fresh } });
  assertRedirect(after, "%2F");
  assert.equal(after.headers["set-cookie"], undefined, "no auto-login");
  const api = await graphqlVia(hosted, "{ me { id } }", as(fresh));
  assert.equal(api.body.errors[0].extensions.code, "SITE_LOCKED");
});

test("GET /signin with a live session goes to next", async (t) => {
  const { request, session } = await startHosted(t);
  const cookie = await session();
  const go = (query) =>
    request(`/signin${query}`, { headers: { ...NAVIGATE, Cookie: cookie } });
  const back = await go("?next=%2F%23%2Fboards%2F4");
  assert.equal(back.status, 302);
  assert.equal(back.headers.location, "/#/boards/4");
  assert.equal(
    (await go("?next=https%3A%2F%2Fevil.example")).headers.location,
    "/",
  );
  assert.equal((await go("")).headers.location, "/");
});

test("demo user switching rotates the site session and stays signed in", async (t) => {
  const hosted = await startHosted(t);
  const { request, session, as, ids } = hosted;
  const cookie = await session();
  const switched = await request("/auth/demo-login", {
    method: "POST",
    headers: { ...JSON_TYPE, ...as(cookie) },
    body: { user_id: ids.users.sam },
  });
  assert.equal(switched.status, 204);
  const sam = cookieOf(switched);
  assert.notEqual(sam, cookie);
  const me = await graphqlVia(hosted, "{ me { id } }", as(sam));
  assert.equal(me.body.data.me.id, ids.users.sam);
  const index = await request("/", { headers: { ...PAGE, Cookie: sam } });
  assert.equal(index.status, 200);
  assertRedirect(
    await request("/", { headers: { ...PAGE, Cookie: cookie } }),
    "%2F",
  );
});

test("without a site password (public demo) nothing is gated", async (t) => {
  const { request } = await startHosted(t, { sitePassword: null });
  const index = await request("/", { headers: PAGE });
  assert.equal(index.status, 200);
  assert.match(cookieOf(index), /^mm_session=/, "demo sign-in as before");
  assert.equal((await request("/signin")).status, 404);
  assert.equal((await request("/healthz")).status, 200);
});

test("createAuth takes the site session idle time and refuses a bad one", async () => {
  const store = await createStore({ file: null, log: { error() {} } });
  for (const sessionIdleMs of [0, -1, 1.5, "12h", Number.NaN]) {
    assert.throws(() => createAuth({ store, sessionIdleMs }), TypeError);
  }
  let now = 0;
  const auth = createAuth({ store, now: () => now, sessionIdleMs: 10 });
  const id = auth.createBrowserSession("1");
  now = 9;
  assert.equal(auth.getBrowserSession(id).userId, "1");
  now = 19;
  assert.equal(auth.getBrowserSession(id), null);
  auth.close();
});
