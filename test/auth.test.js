import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { ALL_SCOPES, createAuth, signJwt, verifyJwt } from "../server/auth.js";
import { createStore } from "../server/store.js";

const SECRET = "test-secret";
const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
const NOW_S = NOW / 1000;
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const decode = (segment) =>
  JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
const hs256 = (input, secret = SECRET) =>
  createHmac("sha256", secret).update(input).digest("base64url");
/** Builds a token by hand so headers can be anything. */
const handMade = (header, payload, secret = SECRET) => {
  const input = `${b64(header)}.${b64(payload)}`;
  return `${input}.${hs256(input, secret)}`;
};
const reason = (token, options = {}) =>
  verifyJwt(token, SECRET, { now: NOW, ...options }).reason;

test("signJwt produces a verifiable HS256 token", () => {
  const payload = { sub: "1", aud: "client", exp: NOW_S + 60 };
  const token = signJwt(payload, SECRET);
  const [header, body, signature] = token.split(".");
  assert.deepEqual(decode(header), { alg: "HS256", typ: "JWT" });
  assert.deepEqual(decode(body), payload);
  assert.equal(signature, hs256(`${header}.${body}`));
  assert.deepEqual(verifyJwt(token, SECRET, { now: NOW, audience: "client" }), {
    ok: true,
    payload,
  });
  assert.throws(() => signJwt("x", SECRET), TypeError);
  assert.throws(() => signJwt({}, ""), TypeError);
  assert.throws(() => verifyJwt(token, ""), TypeError);
});

test("tampered tokens fail the signature check", () => {
  const token = signJwt({ sub: "1", exp: NOW_S + 60 }, SECRET);
  const [header, , signature] = token.split(".");
  const forged = `${header}.${b64({ sub: "2", exp: NOW_S + 60 })}.${signature}`;
  assert.equal(reason(forged), "signature");
  const flipped = signature[0] === "A" ? "B" : "A";
  assert.equal(
    reason(`${header}.${token.split(".")[1]}.${flipped}${signature.slice(1)}`),
    "signature",
  );
  assert.equal(reason(token.slice(0, -1)), "signature");
  assert.equal(
    verifyJwt(token, "other-secret", { now: NOW }).reason,
    "signature",
  );
  assert.equal(
    reason(`${header}.${b64({ sub: "1", exp: NOW_S + 60 })}.`),
    "signature",
  );
});

test("non-canonical signature encodings are rejected", () => {
  const token = signJwt({ exp: NOW_S + 60 }, SECRET);
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const last = token.at(-1);
  const twin = alphabet[alphabet.indexOf(last) ^ 1];
  const variant = `${token.slice(0, -1)}${twin}`;
  const bytes = (t) => Buffer.from(t.split(".")[2], "base64url");
  assert.deepEqual(bytes(variant), bytes(token), "same bytes, different text");
  assert.equal(reason(variant), "signature");
});

test("only HS256 is accepted", () => {
  const payload = { sub: "1", exp: NOW_S + 60 };
  const none = `${b64({ alg: "none", typ: "JWT" })}.${b64(payload)}.`;
  assert.equal(reason(none), "algorithm");
  assert.equal(reason(handMade({ alg: "none" }, payload)), "algorithm");
  assert.equal(
    reason(handMade({ alg: "HS512", typ: "JWT" }, payload)),
    "algorithm",
  );
  assert.equal(reason(handMade({ alg: "hs256" }, payload)), "algorithm");
  assert.equal(reason(handMade({ typ: "JWT" }, payload)), "algorithm");
  assert.equal(reason(handMade({ alg: "HS256" }, payload)), undefined);
});

test("malformed tokens are reported as malformed", () => {
  const valid = signJwt({ exp: NOW_S + 60 }, SECRET);
  const cases = [
    undefined,
    42,
    "",
    "a.b",
    "a.b.c.d",
    `${valid}.`,
    valid.replace(".", ".."),
    `${valid.slice(0, 10)}+${valid.slice(11)}`,
    `${Buffer.from("not json").toString("base64url")}.e30.sig`,
    `${b64([1])}.e30.sig`,
    `${valid}${"A".repeat(9000)}`,
  ];
  for (const token of cases)
    assert.equal(reason(token), "malformed", String(token));
  const noExp = handMade({ alg: "HS256" }, { sub: "1" });
  assert.equal(reason(noExp), "malformed", "exp is required");
  const array = `${b64({ alg: "HS256" })}.${b64([1])}`;
  assert.equal(reason(`${array}.${hs256(array)}`), "malformed");
});

test("expired tokens are rejected at and after exp", () => {
  const token = signJwt({ exp: NOW_S + 60 }, SECRET);
  assert.equal(verifyJwt(token, SECRET, { now: NOW + 59_999 }).ok, true);
  assert.equal(
    verifyJwt(token, SECRET, { now: NOW + 60_000 }).reason,
    "expired",
  );
  assert.equal(
    verifyJwt(token, SECRET, { now: NOW + 3_600_000 }).reason,
    "expired",
  );
  assert.throws(() => verifyJwt(token, SECRET, { now: Number.NaN }), TypeError);
});

test("audience must match when requested", () => {
  const token = signJwt({ aud: "client-a", exp: NOW_S + 60 }, SECRET);
  assert.equal(reason(token, { audience: "client-a" }), undefined);
  assert.equal(reason(token, { audience: "client-b" }), "audience");
  assert.equal(
    reason(token),
    undefined,
    "no audience check when not requested",
  );
  const many = signJwt({ aud: ["x", "client-a"], exp: NOW_S + 60 }, SECRET);
  assert.equal(reason(many, { audience: "client-a" }), undefined);
  const none = signJwt({ exp: NOW_S + 60 }, SECRET);
  assert.equal(reason(none, { audience: "client-a" }), "audience");
});

async function setup() {
  const store = await createStore();
  let now = NOW;
  const auth = createAuth({ store, now: () => now });
  const [readWrite, readOnly] = store.listApiTokens();
  const install = store.listInstalls()[0];
  const app = store.getApp(install.app_id);
  return {
    store,
    auth,
    readWrite,
    readOnly,
    install,
    app,
    advance: (ms) => {
      now += ms;
    },
  };
}

test("API tokens authenticate raw or as Bearer credentials", async () => {
  const { auth, readWrite, readOnly } = await setup();
  const principal = auth.authenticateApiToken(readWrite.token);
  // SPEC-2: principals carry the user's current account role.
  assert.deepEqual(principal, {
    kind: "token",
    userId: "1",
    role: "admin",
    scopes: new Set(ALL_SCOPES),
  });
  assert.deepEqual(
    auth.authenticateApiToken(`Bearer ${readOnly.token}`).scopes,
    new Set(["boards:read", "storage:read"]),
  );
  assert.equal(
    auth.authenticateApiToken(`bearer   ${readOnly.token} `).userId,
    "1",
  );
  for (const bad of [
    undefined,
    "",
    "Bearer",
    "Bearer ",
    `${readWrite.token}x`,
    `Basic ${readWrite.token}`,
    readWrite.token.slice(1),
    `Bearer ${readWrite.token} extra`,
    42,
  ]) {
    assert.equal(auth.authenticateApiToken(bad), null, String(bad));
  }
});

test("browser sessions are random, user bound and expire when idle", async () => {
  const { auth, advance } = await setup();
  const id = auth.createBrowserSession("2");
  assert.match(id, /^[\w-]{43}$/);
  assert.notEqual(auth.createBrowserSession("2"), id);
  assert.deepEqual(auth.getBrowserSession(id), {
    kind: "session",
    userId: "2",
    role: "member",
    scopes: new Set(ALL_SCOPES),
  });
  for (const bad of [
    undefined,
    "",
    "x".repeat(43),
    `${id}x`,
    id.slice(1),
    42,
  ]) {
    assert.equal(auth.getBrowserSession(bad), null);
  }
  assert.throws(() => auth.createBrowserSession("99"), TypeError);
  advance(23 * 3600 * 1000);
  assert.ok(auth.getBrowserSession(id), "use within a day keeps the session");
  advance(23 * 3600 * 1000);
  assert.ok(auth.getBrowserSession(id), "idle time restarts on use");
  advance(24 * 3600 * 1000);
  assert.equal(auth.getBrowserSession(id), null);
});

test("the session table is capped and evicts the least recently used", async () => {
  const { auth } = await setup();
  const oldest = auth.createBrowserSession("1");
  const recent = auth.createBrowserSession("1");
  for (let i = 0; i < 9_998; i += 1) auth.createBrowserSession("3");
  assert.ok(auth.getBrowserSession(recent), "10,000 sessions fit");
  const newest = auth.createBrowserSession("2");
  assert.equal(auth.getBrowserSession(oldest), null, "evicted at capacity");
  assert.ok(auth.getBrowserSession(recent), "recently used survives");
  assert.ok(auth.getBrowserSession(newest));
});

test("app principals take the intersection of user and app scopes", async () => {
  const { auth, readOnly, install, app, store } = await setup();
  const session = auth.getBrowserSession(auth.createBrowserSession("1"));
  assert.deepEqual(auth.appPrincipal(session, install.id), {
    kind: "app",
    userId: "1",
    role: "admin",
    scopes: new Set(app.scopes),
    installId: install.id,
    appId: app.id,
  });
  assert.deepEqual(app.scopes, [
    "boards:read",
    "storage:read",
    "storage:write",
  ]);
  const limited = auth.appPrincipal(
    auth.authenticateApiToken(readOnly.token),
    install.id,
  );
  assert.deepEqual(limited.scopes, new Set(["boards:read", "storage:read"]));
  assert.equal(auth.appPrincipal(session, "999"), null);
  assert.equal(auth.appPrincipal(session, store.listBoards()[0].id), null);
  const appLevel = auth.appPrincipal(session, install.id);
  assert.throws(() => auth.appPrincipal(appLevel, install.id), TypeError);
  assert.throws(() => auth.appPrincipal(null, install.id), TypeError);
});

test("session tokens carry the spec payload and verify with the app secret", async () => {
  const { auth, install, app, advance } = await setup();
  const { token, expires_at } = auth.issueSessionToken({
    userId: "1",
    installId: install.id,
  });
  assert.equal(expires_at, new Date(NOW + 300_000).toISOString());
  const result = verifyJwt(token, app.client_secret, {
    now: NOW,
    audience: app.client_id,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.payload, {
    iss: "mini-monday",
    aud: app.client_id,
    sub: "1",
    iat: NOW_S,
    exp: NOW_S + 300,
    dat: {
      client_id: app.client_id,
      user_id: "1",
      account_id: "1",
      app_id: app.id,
      install_id: install.id,
      board_id: install.board_id,
      is_admin: true,
    },
  });
  assert.equal(verifyJwt(token, SECRET, { now: NOW }).reason, "signature");
  const short = auth.issueSessionToken({
    userId: "2",
    installId: install.id,
    ttlSeconds: 1,
  });
  advance(1000);
  assert.equal(
    verifyJwt(short.token, app.client_secret, { now: NOW + 1000 }).reason,
    "expired",
  );
  assert.equal(decode(short.token.split(".")[1]).dat.is_admin, false);
});

test("issueSessionToken rejects unknown records and bad lifetimes", async () => {
  const { auth, install } = await setup();
  assert.equal(auth.issueSessionToken({ userId: "1", installId: "999" }), null);
  assert.equal(
    auth.issueSessionToken({ userId: "999", installId: install.id }),
    null,
  );
  for (const ttlSeconds of [0, -1, 1.5, 3601, "300"]) {
    assert.throws(
      () =>
        auth.issueSessionToken({
          userId: "1",
          installId: install.id,
          ttlSeconds,
        }),
      TypeError,
    );
  }
  assert.throws(() => createAuth({}), TypeError);
});

test("role changes apply to the next request", async () => {
  const { store, auth, readWrite } = await setup();
  const session = auth.createBrowserSession("2");
  assert.equal(auth.getBrowserSession(session).role, "member");
  store.updateUser("2", { role: "viewer" }, { actorId: "1" });
  assert.equal(auth.getBrowserSession(session).role, "viewer");
  store.updateUser("3", { role: "admin" });
  store.updateUser("1", { role: "member" });
  assert.equal(auth.authenticateApiToken(readWrite.token).role, "member");
});

test("deactivated users lose tokens and sessions at once", async () => {
  const { store, auth, readWrite, install, advance } = await setup();
  store.updateUser("2", { role: "admin" });
  const mine = auth.createBrowserSession("1");
  const other = auth.createBrowserSession("2");
  store.deactivateUser("1");
  assert.equal(auth.authenticateApiToken(readWrite.token), null);
  assert.equal(auth.getBrowserSession(mine), null);
  assert.ok(auth.getBrowserSession(other), "other users keep their sessions");
  assert.throws(() => auth.createBrowserSession("1"), TypeError);
  assert.equal(
    auth.issueSessionToken({ userId: "1", installId: install.id }),
    null,
  );
  store.activateUser("1");
  assert.equal(
    auth.authenticateApiToken(readWrite.token).userId,
    "1",
    "API tokens work again after reactivation",
  );
  assert.equal(
    auth.getBrowserSession(mine),
    null,
    "sessions ended by deactivation stay ended",
  );
  const morgan = store.listUsers().find((u) => u.status === "deactivated");
  assert.throws(() => auth.createBrowserSession(morgan.id), TypeError);
  // Without change events, every request still checks the user's status.
  const { on: _on, ...silent } = store;
  const unaware = createAuth({ store: silent, now: () => NOW });
  const session = unaware.createBrowserSession("1");
  store.deactivateUser("1");
  advance(1000);
  assert.equal(unaware.getBrowserSession(session), null);
});

test("demo user switching rotates the session; sign-out ends it", async () => {
  const { store, auth } = await setup();
  const first = auth.createBrowserSession("1");
  const chris = store.listUsers().find((u) => u.role === "guest");
  const morgan = store.listUsers().find((u) => u.status === "deactivated");
  assert.equal(auth.rotateBrowserSession(first, morgan.id), null);
  assert.equal(auth.rotateBrowserSession(first, "999"), null);
  assert.ok(
    auth.getBrowserSession(first),
    "a refused switch keeps the session",
  );
  const second = auth.rotateBrowserSession(first, chris.id);
  assert.match(second, /^[\w-]{43}$/);
  assert.notEqual(second, first);
  assert.equal(auth.getBrowserSession(first), null, "the old session ends");
  assert.deepEqual(
    [
      auth.getBrowserSession(second).userId,
      auth.getBrowserSession(second).role,
    ],
    [chris.id, "guest"],
  );
  const third = auth.rotateBrowserSession("not-a-session", "2");
  assert.equal(auth.getBrowserSession(third).userId, "2");
  assert.equal(auth.endBrowserSession(second), true);
  assert.equal(auth.getBrowserSession(second), null);
  assert.equal(auth.endBrowserSession(second), false);
  assert.equal(auth.endBrowserSession(undefined), false);
});

test("apps on boards the user cannot see are unknown installs", async () => {
  const { store, auth, install } = await setup();
  const chris = store.listUsers().find((u) => u.role === "guest");
  const guest = auth.getBrowserSession(auth.createBrowserSession(chris.id));
  assert.equal(auth.appPrincipal(guest, install.id), null);
  assert.equal(
    auth.issueSessionToken({ userId: chris.id, installId: install.id }),
    null,
  );
  const roadmap = store.getBoard(install.board_id);
  store.setBoardKind(roadmap.id, "private", { actorId: "1" });
  const sam = auth.getBrowserSession(auth.createBrowserSession("2"));
  assert.equal(auth.appPrincipal(sam, install.id), null, "private now");
  store.share({
    resourceKind: "board",
    resourceId: roadmap.id,
    subjectKind: "user",
    subjectIds: ["2"],
    role: "viewer",
    actorId: "1",
  });
  assert.equal(auth.appPrincipal(sam, install.id).userId, "2");
  assert.ok(auth.issueSessionToken({ userId: "2", installId: install.id }));
});
