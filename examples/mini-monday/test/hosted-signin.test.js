/**
 * `POST /signin` (SPEC-3 §2): the session it starts, its Origin and type
 * checks, the constant-time password comparison and fixed failure delay,
 * the per-IP failure limit with Retry-After, the MM_TRUST_PROXY client-IP
 * rule (shared with the public-form limiter) and `next` sanitization.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import {
  FAILURE_LIMIT,
  FAILURE_WINDOW_MS,
  SITE_FAILURE_LIMIT,
  createGate,
  sanitizeNext,
} from "../server/routes/gate.js";
import { clientIp, createRateLimiter } from "../server/routes/rate-limit.js";
import {
  HOST,
  JSON_TYPE,
  PASSWORD,
  codeOf,
  cookieOf,
  graphqlVia,
  manualClock,
  startHosted,
} from "./hosted-helpers.js";

test("the site password starts a session for user 1 and answers next", async (t) => {
  const hosted = await startHosted(t);
  const { signIn, as, servers } = hosted;
  const response = await signIn(PASSWORD, { next: "/#/boards/4" });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), { next: "/#/boards/4" });
  assert.equal(response.headers["cache-control"], "no-store");
  const [cookie] = response.headers["set-cookie"];
  assert.match(
    cookie,
    /^mm_session=[\w-]{43}; HttpOnly; SameSite=Strict; Path=\/; Secure$/,
  );
  const me = await graphqlVia(
    hosted,
    "{ me { id role } }",
    as(cookieOf(response)),
  );
  assert.deepEqual(me.body.data.me, { id: "1", role: "admin" });
  // Signing in again ends the session the browser had.
  const again = await signIn(PASSWORD, {
    headers: { Cookie: cookieOf(response) },
  });
  assert.equal(again.status, 200);
  const old = await graphqlVia(hosted, "{ me { id } }", as(cookieOf(response)));
  assert.equal(old.body.errors[0].extensions.code, "SITE_LOCKED");
  assert.equal(servers.hostOrigin, HOST);
});

test("sign-in needs JSON from the host origin and a string password", async (t) => {
  const { request, signIn } = await startHosted(t);
  const foreign = await signIn(PASSWORD, {
    headers: { Origin: "https://evil.example" },
  });
  assert.equal(foreign.status, 403);
  const noOrigin = await request("/signin", {
    method: "POST",
    headers: JSON_TYPE,
    body: { password: PASSWORD },
  });
  assert.equal(noOrigin.status, 403);
  const text = await signIn(PASSWORD, {
    headers: { "Content-Type": "text/plain" },
  });
  assert.equal(text.status, 415);
  const number = await request("/signin", {
    method: "POST",
    headers: { ...JSON_TYPE, Origin: HOST },
    body: { password: 123_456_789_012 },
  });
  assert.equal(number.status, 400);
  assert.equal(number.headers["set-cookie"], undefined);
});

test("a wrong password waits a fixed delay, then answers SITE_PASSWORD_INVALID", async (t) => {
  const { signIn } = await startHosted(t);
  const wrong = [
    "",
    PASSWORD.slice(0, -1),
    `${PASSWORD} `,
    PASSWORD.toUpperCase(),
    "x".repeat(100_000),
  ];
  const timed = await Promise.all(
    wrong.slice(0, 4).map(async (password) => {
      const started = performance.now();
      const response = await signIn(password);
      return { response, ms: performance.now() - started };
    }),
  );
  for (const { response, ms } of timed) {
    assert.equal(response.status, 401);
    assert.equal(codeOf(response), "SITE_PASSWORD_INVALID");
    assert.equal(response.headers["set-cookie"], undefined);
    assert.ok(ms >= 290, `answered after ${ms} ms`);
  }
  // Every password length is compared (and refused) the same way.
  const gate = createGate({ password: PASSWORD, now: Date.now });
  for (const password of wrong) assert.equal(gate.verify(password), false);
  assert.equal(gate.verify(PASSWORD), true);
});

test("passwords are compared as SHA-256 digests with timingSafeEqual", (t) => {
  const spy = t.mock.method(crypto, "timingSafeEqual");
  syncBuiltinESMExports();
  t.after(() => {
    spy.mock.restore();
    syncBuiltinESMExports();
  });
  const gate = createGate({ password: PASSWORD, now: Date.now });
  assert.equal(gate.verify("short"), false);
  assert.equal(gate.verify(PASSWORD), true);
  assert.equal(spy.mock.callCount(), 2);
  const sha256 = (text) => crypto.createHash("sha256").update(text).digest();
  for (const [index, candidate] of ["short", PASSWORD].entries()) {
    const [actual, expected] = spy.mock.calls[index].arguments;
    assert.deepEqual([actual.length, expected.length], [32, 32]);
    assert.deepEqual(actual, sha256(candidate));
    assert.deepEqual(expected, sha256(PASSWORD));
  }
});

test("five failures per client in 15 minutes → 429 with Retry-After; successes do not count", async (t) => {
  const clock = manualClock();
  const { signIn } = await startHosted(t, { now: clock.now });
  const statuses = async (passwords) =>
    (await Promise.all(passwords.map((p) => signIn(p)))).map((r) => r.status);
  // Successes in between are refunded and never count.
  assert.deepEqual(await statuses(["a", "b", "c", "d"]), [401, 401, 401, 401]);
  for (let index = 0; index < 3; index += 1) {
    assert.equal((await signIn(PASSWORD)).status, 200);
  }
  // Attempts count when they start: parallel guesses cannot overtake.
  const burst = await statuses(["e", "f", "g"]);
  assert.deepEqual(burst.toSorted(), [401, 429, 429]);
  const limited = await signIn(PASSWORD);
  assert.equal(limited.status, 429, "even the right password waits");
  assert.equal(codeOf(limited), "RATE_LIMITED");
  assert.equal(
    limited.headers["retry-after"],
    String(FAILURE_WINDOW_MS / 1000),
  );
  clock.advance(10 * 60 * 1000);
  assert.equal((await signIn("h")).headers["retry-after"], "300");
  clock.advance(5 * 60 * 1000);
  assert.equal((await signIn(PASSWORD)).status, 200, "the window has passed");
});

test("MM_TRUST_PROXY: the last X-Forwarded-For hop is the client of every limiter", async (t) => {
  const hosted = await startHosted(t, { trustProxy: true });
  const { signIn, request, store, ids } = hosted;
  const from = (forwarded, password = "wrong") =>
    signIn(password, { headers: { "X-Forwarded-For": forwarded } });
  for (let attempt = 0; attempt < FAILURE_LIMIT; attempt += 1) {
    // Entries before the proxy's own hop are whatever the client sent.
    const spoofed = `203.0.113.${attempt}, 198.51.100.7`;
    assert.equal((await from(spoofed)).status, 401);
  }
  assert.equal((await from("10.0.0.1, 198.51.100.7")).status, 429);
  assert.equal((await from("198.51.100.7, 198.51.100.8")).status, 401);
  assert.equal((await signIn("wrong")).status, 401, "no header: the socket");
  assert.equal((await from("unknown")).status, 401, "not an IP: the socket");
  // The public-form limiter follows the same rule (10 per minute).
  const { token } = store.getForm(ids.forms.feature);
  const submit = (forwarded) =>
    request(`/f/${token}/submit`, {
      method: "POST",
      headers: { ...JSON_TYPE, "X-Forwarded-For": forwarded },
      body: { answers: { q1: "Through the proxy" } },
    });
  for (let index = 0; index < 10; index += 1) {
    assert.equal((await submit(`192.0.2.${index}, 198.51.100.20`)).status, 201);
  }
  assert.equal((await submit("198.51.100.20")).status, 429);
  assert.equal((await submit("198.51.100.21")).status, 201);
});

test("a new X-Forwarded-For per guess still meets the site-wide failure limit", async (t) => {
  // MM_TRUST_PROXY=1 with nothing in front that sets the header: every
  // client names its own IP, so only the site-wide limit holds.
  const clock = manualClock();
  const { signIn } = await startHosted(t, { trustProxy: true, now: clock.now });
  const from = (index, password = "a guess") =>
    signIn(password, { headers: { "X-Forwarded-For": `203.0.113.${index}` } });
  const guesses = Array.from({ length: SITE_FAILURE_LIMIT }, (_, i) => from(i));
  for (const response of await Promise.all(guesses)) {
    assert.equal(response.status, 401);
  }
  const refused = await from(SITE_FAILURE_LIMIT);
  assert.equal(refused.status, 429);
  assert.equal(codeOf(refused), "RATE_LIMITED");
  assert.equal(
    refused.headers["retry-after"],
    String(FAILURE_WINDOW_MS / 1000),
  );
  const right = await from(SITE_FAILURE_LIMIT + 1, PASSWORD);
  assert.equal(right.status, 429, "no answer reveals the password meanwhile");
  clock.advance(FAILURE_WINDOW_MS);
  assert.equal((await from(SITE_FAILURE_LIMIT + 2, PASSWORD)).status, 200);
});

test("site-wide refusals count against no client; successes are refunded", () => {
  const clock = manualClock();
  const { failures } = createGate({ password: PASSWORD, now: clock.now });
  for (let index = 0; index < SITE_FAILURE_LIMIT; index += 1) {
    assert.equal(failures.take(`198.51.100.${index % 40}`).ok, true);
  }
  for (let index = 0; index < FAILURE_LIMIT + 1; index += 1) {
    const refused = failures.take("192.0.2.1");
    assert.deepEqual(refused, { ok: false, retryAfter: 900 });
  }
  failures.refund("198.51.100.0"); // a sign-in that succeeded
  assert.equal(failures.take("192.0.2.1").ok, true, "192.0.2.1 has no count");
  assert.equal(failures.take("192.0.2.2").ok, false);
});

test("without MM_TRUST_PROXY, X-Forwarded-For is ignored", async (t) => {
  const { signIn } = await startHosted(t, { trustProxy: false });
  for (let attempt = 0; attempt < FAILURE_LIMIT; attempt += 1) {
    const headers = { "X-Forwarded-For": `198.51.100.${attempt}` };
    assert.equal((await signIn("wrong", { headers })).status, 401);
  }
  const headers = { "X-Forwarded-For": "198.51.100.200" };
  assert.equal((await signIn("wrong", { headers })).status, 429);
});

test("clientIp: the trusted hop, else the socket address", () => {
  const req = (forwarded) => ({
    socket: { remoteAddress: "::ffff:127.0.0.1" },
    headers: forwarded === undefined ? {} : { "x-forwarded-for": forwarded },
  });
  const trusted = { trustProxy: true };
  assert.equal(clientIp(req("1.1.1.1, 2.2.2.2"), trusted), "2.2.2.2");
  assert.equal(clientIp(req(" 2001:DB8::1 "), trusted), "2001:db8::1");
  assert.equal(clientIp(req("1.1.1.1,"), trusted), "::ffff:127.0.0.1");
  assert.equal(clientIp(req(undefined), trusted), "::ffff:127.0.0.1");
  const direct = { trustProxy: false };
  assert.equal(clientIp(req("2.2.2.2"), direct), "::ffff:127.0.0.1");
});

test("createRateLimiter: take counts, refund undoes the newest hit", () => {
  let now = 0;
  const limiter = createRateLimiter({
    limit: 2,
    windowMs: 1000,
    now: () => now,
  });
  assert.equal(limiter.take("a").ok, true);
  assert.equal(limiter.take("a").ok, true);
  assert.deepEqual(limiter.take("a"), { ok: false, retryAfter: 1 });
  limiter.refund("a");
  assert.equal(limiter.take("a").ok, true);
  limiter.refund("b");
  now = 1000;
  assert.equal(limiter.take("a").ok, true);
  assert.throws(() => createRateLimiter({ limit: 0, windowMs: 1 }), TypeError);
  assert.throws(() => createRateLimiter({ limit: 1 }), TypeError);
});

test("next accepts only same-site paths that start with one slash", () => {
  const kept = [
    "/",
    "/#/boards/4",
    "/#/forms/2?tab=settings",
    "/v2/get_schema?version=2026-01",
    "/f/abcdefghijklmnopqrstuv",
    "/search%20term",
    "/%252F%252Fevil.example",
  ];
  for (const next of kept) assert.equal(sanitizeNext(next), next, next);
  const refused = [
    "//evil.example",
    "//evil.example/path",
    "/\\evil.example",
    "\\\\evil.example",
    "/\\/evil.example",
    "https://evil.example",
    "http:/evil.example",
    "javascript:alert(1)",
    "evil.example",
    "%2F%2Fevil.example",
    "/%2F%2Fevil.example",
    "/%2Fevil.example",
    "/%5Cevil.example",
    "/%5C%5Cevil.example",
    "/\t/evil.example",
    "/\n/evil.example",
    "/ /evil.example",
    "/%09/evil.example",
    "/%00",
    "/%E0%A4%A",
    "/signin",
    "/signin?next=%2F",
    `/${"a".repeat(2048)}`,
    "",
    null,
    undefined,
    42,
    ["/"],
  ];
  for (const next of refused)
    assert.equal(sanitizeNext(next), "/", String(next));
});

test("POST /signin and the redirect sanitize next", async (t) => {
  const { signIn, request } = await startHosted(t);
  for (const next of ["//evil.example", "https://evil.example", "/%2F%2Fx"]) {
    const response = await signIn(PASSWORD, { next });
    assert.deepEqual(JSON.parse(response.body), { next: "/" }, next);
  }
  const missing = await signIn(PASSWORD);
  assert.deepEqual(JSON.parse(missing.body), { next: "/" });
  const page = { "Sec-Fetch-Mode": "navigate" };
  const redirect = await request("/\\evil.example", { headers: page });
  assert.equal(redirect.headers.location, "/signin?next=%2F");
});
