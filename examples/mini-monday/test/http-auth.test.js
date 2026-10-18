/**
 * Browser sign-in over HTTP (SPEC-2 §4): demo auto-login on `GET /`, the
 * demo user list and user switching, logout, turning demo mode off
 * (`demoLogin: false`, `MM_DEMO_LOGIN=0`), and session principals that
 * follow role changes and deactivation immediately.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readConfig } from "../server/main.js";
import { apiClient, browserSession, startTestServers } from "./helpers.js";

async function setup(t, options = {}) {
  const servers = await startTestServers(options);
  t.after(() => servers.close());
  const host = (path, init) => fetch(new URL(path, servers.hostUrl), init);
  const post = (path, { headers = {}, body = {} } = {}) =>
    host(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const me = async (headers) =>
    (await apiClient(servers.hostUrl, { headers }).call("{ me { id role } }"))
      .body;
  return { ...servers, host, post, me };
}

const cookieOf = (response) => {
  const header = response.headers.get("set-cookie") ?? "";
  return header.split(";")[0];
};

test("demo users are listed to signed-in browsers only", async (t) => {
  const { host, hostUrl, store } = await setup(t);
  const session = await browserSession(hostUrl);
  const list = await host("/auth/demo-users", { headers: session });
  assert.equal(list.status, 200);
  const { users } = await list.json();
  assert.equal(users.length, store.listUsers().length);
  const morgan = users.find((user) => user.name === "Morgan Diaz");
  assert.deepEqual(Object.keys(morgan).sort(), [
    "color",
    "id",
    "name",
    "role",
    "status",
    "title",
  ]);
  assert.equal(morgan.status, "deactivated");
  const fetchSite = { Cookie: session.Cookie, "Sec-Fetch-Site": "same-origin" };
  assert.equal(
    (await host("/auth/demo-users", { headers: fetchSite })).status,
    200,
  );
  assert.equal((await host("/auth/demo-users")).status, 401);
  const crossSite = { Cookie: session.Cookie, "Sec-Fetch-Site": "cross-site" };
  assert.equal(
    (await host("/auth/demo-users", { headers: crossSite })).status,
    403,
  );
  const posted = await host("/auth/demo-users", { method: "POST" });
  assert.equal(posted.status, 405);
  assert.equal(posted.headers.get("allow"), "GET");
});

test("demo-login rotates the session to another active user", async (t) => {
  const { post, hostUrl, ids, me, hostOrigin } = await setup(t);
  const session = await browserSession(hostUrl);
  assert.equal((await me(session)).data.me.id, ids.users.alex);
  const switched = await post("/auth/demo-login", {
    headers: session,
    body: { user_id: ids.users.chris },
  });
  assert.equal(switched.status, 204);
  assert.match(
    switched.headers.get("set-cookie"),
    /^mm_session=[\w-]{43}; HttpOnly; SameSite=Strict; Path=\/$/,
  );
  const chris = { Cookie: cookieOf(switched), Origin: hostOrigin };
  assert.deepEqual((await me(chris)).data.me, {
    id: ids.users.chris,
    role: "guest",
  });
  const old = await me(session);
  assert.equal(
    old.errors[0].extensions.code,
    "UNAUTHENTICATED",
    "the old session ended",
  );
  // Numeric IDs work too; deactivated, unknown and malformed IDs are 400.
  const back = await post("/auth/demo-login", {
    headers: chris,
    body: { user_id: 1 },
  });
  assert.equal(back.status, 204);
  const alex = { Cookie: cookieOf(back), Origin: hostOrigin };
  for (const user_id of [ids.users.morgan, "999999", "abc", null]) {
    const refused = await post("/auth/demo-login", {
      headers: alex,
      body: { user_id },
    });
    assert.equal(refused.status, 400, String(user_id));
  }
  assert.equal(
    (await me(alex)).data.me.id,
    ids.users.alex,
    "refusals keep the session",
  );
  const noOrigin = { Cookie: alex.Cookie };
  assert.equal(
    (
      await post("/auth/demo-login", {
        headers: noOrigin,
        body: { user_id: "2" },
      })
    ).status,
    403,
  );
  assert.equal(
    (await post("/auth/demo-login", { body: { user_id: "2" } })).status,
    401,
  );
  const text = { ...alex, "Content-Type": "text/plain" };
  assert.equal(
    (await post("/auth/demo-login", { headers: text, body: "{}" })).status,
    415,
  );
});

test("logout ends the session and the next GET / signs in as user 1 again", async (t) => {
  const { post, host, hostUrl, me, auth } = await setup(t);
  const session = await browserSession(hostUrl);
  const foreign = { ...session, Origin: "http://evil.example" };
  assert.equal((await post("/auth/logout", { headers: foreign })).status, 403);
  assert.equal((await me(session)).data.me.id, "1");
  const out = await post("/auth/logout", { headers: session });
  assert.equal(out.status, 204);
  assert.match(out.headers.get("set-cookie"), /^mm_session=; .*Max-Age=0/);
  assert.equal(
    (await me(session)).errors[0].extensions.code,
    "UNAUTHENTICATED",
  );
  const page = await host("/", { headers: { Cookie: session.Cookie } });
  const fresh = cookieOf(page).split("=")[1];
  assert.equal(auth.getBrowserSession(fresh).userId, "1");
  // Logging out without a session still clears the cookie.
  const again = await post("/auth/logout", {
    headers: { Origin: session.Origin },
  });
  assert.equal(again.status, 204);
});

test("with demoLogin false there is no auto-login and no user switching", async (t) => {
  const { host, post, sessionFor, ids, me } = await setup(t, {
    demoLogin: false,
  });
  const page = await host("/");
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("set-cookie"), null);
  const session = sessionFor(ids.users.sam);
  assert.equal(
    (await host("/auth/demo-users", { headers: session })).status,
    404,
  );
  const login = await post("/auth/demo-login", {
    headers: session,
    body: { user_id: "1" },
  });
  assert.equal(login.status, 404);
  assert.equal((await me(session)).data.me.id, ids.users.sam);
  assert.equal((await post("/auth/logout", { headers: session })).status, 204);
  assert.equal(
    (await me(session)).errors[0].extensions.code,
    "UNAUTHENTICATED",
  );
  await assert.rejects(setup(t, { demoLogin: "no" }), TypeError);
});

test("MM_DEMO_LOGIN=0 turns demo mode off; anything else leaves it on", () => {
  assert.equal(readConfig({}).demoLogin, true);
  assert.equal(readConfig({ MM_DEMO_LOGIN: "1" }).demoLogin, true);
  assert.equal(readConfig({ MM_DEMO_LOGIN: "" }).demoLogin, true);
  assert.equal(readConfig({ MM_DEMO_LOGIN: "0" }).demoLogin, false);
});

test("sessions follow role changes and deactivation on the next request", async (t) => {
  const { as, ids, sessionFor, me, host, store } = await setup(t);
  const sam = sessionFor(ids.users.sam);
  const write = `mutation W($b: ID!) { create_item(board_id: $b, item_name: "x") { id } }`;
  const samClient = apiClient(new URL(sam.Origin).origin, { headers: sam });
  assert.equal(await samClient.code(write, { b: ids.boards.roadmap }), null);
  const demote = `mutation D($u: ID!) { update_user(user_id: $u, role: viewer) { role } }`;
  await as(ids.users.alex).data(demote, { u: ids.users.sam });
  assert.equal((await me(sam)).data.me.role, "viewer");
  assert.equal(
    await samClient.code(write, { b: ids.boards.roadmap }),
    "FORBIDDEN",
  );
  const inbox = await samClient.data(
    "{ notifications(limit: 1) { kind text } }",
  );
  assert.deepEqual(inbox.notifications[0], {
    kind: "role",
    text: "Alex Rivera changed your account role to viewer",
  });
  // With user 1 deactivated, GET / serves the page without a session.
  store.updateUser(ids.users.noa, { role: "admin" });
  store.deactivateUser("1");
  const page = await host("/");
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("set-cookie"), null);
});
