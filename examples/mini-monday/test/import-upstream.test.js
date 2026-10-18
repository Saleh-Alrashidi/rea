/**
 * The importers' bounded upstream client (SPEC-4 §1): fixed bases with
 * validated test overrides, token handling and redaction, no redirects,
 * the 10 MiB cap, timeouts, Retry-After / X-RateLimit-Reset / backoff
 * retries (at most 5 attempts), retry hints, aborts, the per-minute budget
 * and transport errors — against real local HTTP servers.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  UPSTREAM_DEFAULTS,
  UpstreamError,
  createUpstream,
  headerDelaySeconds,
  redact,
  upstreamBase,
  upstreamUrl,
} from "../server/import/upstream.js";

const TOKEN = "tok-upstream-test-5b8e2c";
const MIB = 1024 * 1024;

/** A local server; `handler(req, res, body)` answers, `requests` records. */
async function serve(t, handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    requests.push({
      url: req.url,
      method: req.method,
      headers: req.headers,
      body,
    });
    handler(req, res, requests.length);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { origin, requests, env: { MM_IMPORT_MONDAY_URL: `${origin}/v2` } };
}

/** A clock whose sleeps are recorded and advance time instantly. */
function fakeClock(start = 1_700_000_000_000) {
  const clock = { time: start, sleeps: [] };
  clock.now = () => clock.time;
  clock.sleep = async (ms) => {
    clock.sleeps.push(ms);
    clock.time += ms;
  };
  return clock;
}

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

function client(server, options = {}) {
  return createUpstream({
    source: "monday",
    token: TOKEN,
    env: server.env,
    clock: options.clock ?? fakeClock(),
    ...options,
  });
}

async function rejectsWith(promise, code) {
  const error = await promise.then(
    () => assert.fail(`expected ${code}`),
    (caught) => caught,
  );
  assert.ok(error instanceof UpstreamError, String(error));
  assert.equal(error.code, code, error.message);
  for (const text of [error.message, error.stack, JSON.stringify(error)]) {
    assert.ok(!text.includes(TOKEN), "the token never appears in errors");
  }
  return error;
}

test("bases are fixed; overrides must be https or loopback http", () => {
  assert.equal(upstreamBase("monday", {}).href, "https://api.monday.com/v2");
  assert.equal(upstreamBase("clickup", {}).href, "https://api.clickup.com/api");
  const ok = (env) =>
    upstreamBase("monday", { MM_IMPORT_MONDAY_URL: env }).href;
  assert.equal(ok("http://127.0.0.1:4555/v2"), "http://127.0.0.1:4555/v2");
  assert.equal(ok("http://localhost:9/v2"), "http://localhost:9/v2");
  assert.equal(ok("http://[::1]:9/v2"), "http://[::1]:9/v2");
  assert.equal(ok("https://mirror.test/v2"), "https://mirror.test/v2");
  const clickup = { MM_IMPORT_CLICKUP_URL: "http://127.0.0.1:7/api" };
  assert.equal(upstreamBase("clickup", clickup).href, "http://127.0.0.1:7/api");
  for (const bad of [
    "http://example.test/v2",
    "ftp://127.0.0.1/v2",
    "https://user:pw@mirror.test/v2",
    "https://mirror.test/v2?x=1",
    "https://mirror.test/v2#x",
    "not a url",
  ]) {
    assert.throws(
      () => upstreamBase("monday", { MM_IMPORT_MONDAY_URL: bad }),
      (error) => error.code === "UPSTREAM_CONFIG",
      bad,
    );
  }
  assert.throws(() => upstreamBase("jira", {}), { code: "UPSTREAM_CONFIG" });
});

test("paths stay under the base path", () => {
  const base = new URL("https://api.clickup.com/api");
  assert.equal(
    upstreamUrl(base, "/v2/list/7/task?page=0&archived=false").href,
    "https://api.clickup.com/api/v2/list/7/task?page=0&archived=false",
  );
  assert.equal(upstreamUrl(base).href, "https://api.clickup.com/api");
  for (const bad of [
    "//evil.test/x",
    "/../x",
    "/v2/%2e%2e/%2e%2e/x",
    "/v2/a%2fb",
    "https://evil.test/",
    "v2/team",
    "/v2/team#x",
    "/v2\\team",
    "/v2/ team",
  ]) {
    assert.throws(
      () => upstreamUrl(base, bad),
      { code: "UPSTREAM_CONFIG" },
      bad,
    );
  }
});

test("requests carry the token and JSON and return parsed JSON", async (t) => {
  const server = await serve(t, (req, res) =>
    json(res, 200, { data: { ok: 1 } }),
  );
  const upstream = client(server);
  const response = await upstream.request({
    method: "POST",
    headers: { "API-Version": "2025-10", authorization: "someone else" },
    body: { query: "{ me { id } }" },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { data: { ok: 1 } });
  const [sent] = server.requests;
  assert.equal(sent.url, "/v2");
  assert.equal(sent.headers.authorization, TOKEN);
  assert.equal(sent.headers["api-version"], "2025-10");
  assert.equal(sent.headers["content-type"], "application/json");
  assert.equal(sent.headers.accept, "application/json");
  assert.deepEqual(JSON.parse(sent.body), { query: "{ me { id } }" });
  assert.equal(upstream.label, "monday.com");
});

test("tokens are checked, never echoed, and redacted from upstream text", async (t) => {
  for (const token of [undefined, "", "   ", 42]) {
    assert.throws(() => createUpstream({ source: "monday", token, env: {} }), {
      code: "INVALID_TOKEN",
      message: "A monday.com API token is required",
    });
  }
  for (const token of [
    "bad\ntoken-secret-1",
    "bäd-secret-2",
    "x".repeat(4097),
  ]) {
    assert.throws(
      () => createUpstream({ source: "monday", token, env: {} }),
      (error) =>
        error.code === "INVALID_TOKEN" &&
        !error.message.includes(token.slice(0, 8)),
    );
  }
  const server = await serve(t, (req, res) =>
    json(res, 400, { errors: [{ message: `bad token ${TOKEN} \u0007 here` }] }),
  );
  const error = await rejectsWith(client(server).request({}), "UPSTREAM_HTTP");
  assert.equal(error.status, 400);
  assert.match(error.message, /bad token \[redacted\] here/);
  const upstream = client(server);
  assert.equal(upstream.safeMessage(`a\n${TOKEN}\tb`), "a [redacted] b");
  assert.equal(upstream.safeMessage("y".repeat(300)).length, 201);
  assert.equal(
    redact(`${TOKEN}/${encodeURIComponent("a b")}`, "a b"),
    `${TOKEN}/[redacted]`,
  );
});

test("401 rejects the token at once; 403 only when configured", async (t) => {
  const server = await serve(t, (req, res, n) =>
    json(res, n === 1 ? 401 : 403, { errors: ["Not Authenticated"] }),
  );
  const invalid = await rejectsWith(
    client(server).request({}),
    "INVALID_TOKEN",
  );
  assert.equal(invalid.status, 401);
  await rejectsWith(client(server).request({}), "UPSTREAM_HTTP");
  const strict = client(server, { tokenRejectedStatuses: [401, 403] });
  await rejectsWith(strict.request({}), "INVALID_TOKEN");
  assert.equal(server.requests.length, 3, "no retries");
});

test("redirects are refused, never followed", async (t) => {
  const server = await serve(t, (req, res) => {
    res.writeHead(302, { Location: "/elsewhere" });
    res.end();
  });
  await rejectsWith(client(server).request({}), "UPSTREAM_REDIRECT");
  assert.deepEqual(
    server.requests.map((r) => r.url),
    ["/v2"],
  );
});

test("responses are capped at 10 MiB, declared or streamed", async (t) => {
  assert.equal(UPSTREAM_DEFAULTS.maxBytes, 10 * MIB);
  const exact = JSON.stringify("a".repeat(10 * MIB - 2));
  const server = await serve(t, (req, res, n) => {
    if (n === 1) return res.end(exact);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('"');
    res.write("b".repeat(10 * MIB));
    return res.end('"');
  });
  const ok = await client(server).request({});
  assert.equal(ok.json.length, 10 * MIB - 2);
  const error = await rejectsWith(
    client(server).request({}),
    "UPSTREAM_TOO_LARGE",
  );
  assert.match(error.message, /larger than 10 MiB/);
  // A declared length over the cap is refused before any body is read
  // (this body never finishes, so reading it would time out instead).
  const declared = await serve(t, (req, res) => {
    res.writeHead(200, { "Content-Length": "200" });
    res.write("x");
  });
  const limits = { maxBytes: 100, timeoutMs: 2000 };
  const small = client(declared, { limits });
  await rejectsWith(small.request({}), "UPSTREAM_TOO_LARGE");
});

test("slow answers time out (30 s by default)", async (t) => {
  assert.equal(UPSTREAM_DEFAULTS.timeoutMs, 30_000);
  const server = await serve(t, (req, res, n) => {
    if (n === 1) return setTimeout(() => json(res, 200, {}), 400).unref();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write("{");
    return setTimeout(() => res.end("}"), 400).unref();
  });
  const fast = client(server, { limits: { timeoutMs: 60 } });
  const error = await rejectsWith(fast.request({}), "UPSTREAM_TIMEOUT");
  assert.match(error.message, /did not answer within 0\.1 s/);
  await rejectsWith(fast.request({}), "UPSTREAM_TIMEOUT");
  assert.equal(server.requests.length, 2, "timeouts are not retried");
});

test("429 waits for Retry-After or X-RateLimit-Reset, at most 5 attempts", async (t) => {
  const clock = fakeClock();
  // The second answer comes 3 s in, after the first wait.
  const date = new Date(clock.time + 8000).toUTCString();
  const replies = [
    ["Retry-After", "3"],
    ["Retry-After", date],
    ["X-RateLimit-Reset", String(Math.floor(clock.time / 1000) + 20)],
    ["Retry-After", "3600"],
  ];
  const server = await serve(t, (req, res, n) => {
    const header = replies[n - 1];
    if (!header) return json(res, 200, { ok: true });
    return json(
      res,
      429,
      { err: "Rate limit reached" },
      { [header[0]]: header[1] },
    );
  });
  const response = await client(server, { clock }).request({});
  assert.deepEqual(response.json, { ok: true });
  assert.deepEqual(clock.sleeps, [3000, 5000, 12_000, 60_000]);
  const always = await serve(t, (req, res) =>
    json(res, 429, { err: "slow down" }),
  );
  const tired = fakeClock();
  const error = await rejectsWith(
    client(always, { clock: tired }).request({}),
    "UPSTREAM_RATE_LIMITED",
  );
  assert.match(error.message, /after 5 attempts: slow down/);
  assert.equal(always.requests.length, 5);
  assert.deepEqual(tired.sleeps, [1000, 2000, 4000, 8000]);
});

test("Retry-After and X-RateLimit-Reset formats", () => {
  const now = 1_700_000_000_000;
  const headers = (entries) => new Headers(entries);
  assert.equal(headerDelaySeconds(headers({ "Retry-After": "7" }), now), 7);
  const date = new Date(now + 9000).toUTCString();
  assert.equal(headerDelaySeconds(headers({ "Retry-After": date }), now), 9);
  const epoch = String(now / 1000 + 4);
  assert.equal(
    headerDelaySeconds(headers({ "X-RateLimit-Reset": epoch }), now),
    4,
  );
  const ms = String(now + 2500);
  assert.equal(
    headerDelaySeconds(headers({ "X-RateLimit-Reset": ms }), now),
    2.5,
  );
  assert.equal(
    headerDelaySeconds(headers({ "X-RateLimit-Reset": "30" }), now),
    30,
  );
  assert.equal(
    headerDelaySeconds(headers({ "Retry-After": "soon" }), now),
    null,
  );
  assert.equal(headerDelaySeconds(headers({}), now), null);
});

test("5xx backs off exponentially; other 4xx fail at once", async (t) => {
  const server = await serve(t, (req, res, n) =>
    n <= 2 ? json(res, 503, {}) : json(res, 200, { done: n }),
  );
  const clock = fakeClock();
  assert.deepEqual((await client(server, { clock }).request({})).json, {
    done: 3,
  });
  assert.deepEqual(clock.sleeps, [1000, 2000]);
  const broken = await serve(t, (req, res) =>
    json(res, 500, { message: "boom" }),
  );
  const error = await rejectsWith(client(broken).request({}), "UPSTREAM_HTTP");
  assert.equal(error.status, 500);
  assert.equal(broken.requests.length, 5);
  const bad = await serve(t, (req, res) => json(res, 400, {}));
  await rejectsWith(client(bad).request({}), "UPSTREAM_HTTP");
  assert.equal(bad.requests.length, 1);
});

test("retry hints retry successful answers", async (t) => {
  const busy = { errors: [{ message: "busy", extensions: { wait: 2 } }] };
  const server = await serve(t, (req, res, n) =>
    json(res, 200, n <= 2 ? busy : { data: n }),
  );
  const clock = fakeClock();
  let hinted = 0;
  const retryHint = ({ status, json: body }) => {
    if (status !== 200 || !body.errors) return null;
    hinted += 1;
    return {
      afterSeconds: hinted === 1 ? body.errors[0].extensions.wait : null,
    };
  };
  const response = await client(server, { clock }).request({ retryHint });
  assert.deepEqual(response.json, { data: 3 });
  assert.deepEqual(clock.sleeps, [2000, 2000], "hint, then backoff");
  const stuck = await serve(t, (req, res) => json(res, 200, busy));
  const always = () => ({ afterSeconds: 0 });
  const error = await rejectsWith(
    client(stuck).request({ retryHint: always }),
    "UPSTREAM_RATE_LIMITED",
  );
  assert.match(error.message, /busy/);
});

test("aborts stop before, during and between attempts", async (t) => {
  const server = await serve(t, (req, res, n) => {
    if (n === 1) return setTimeout(() => json(res, 200, {}), 2000).unref();
    return json(res, 503, {});
  });
  const done = new AbortController();
  done.abort();
  await rejectsWith(
    client(server, { signal: done.signal }).request({}),
    "ABORTED",
  );
  assert.equal(server.requests.length, 0);
  const during = new AbortController();
  setTimeout(() => during.abort(), 50);
  await rejectsWith(
    client(server, { signal: during.signal }).request({}),
    "ABORTED",
  );
  const between = new AbortController();
  const sleeping = createUpstream({
    source: "monday",
    token: TOKEN,
    env: server.env,
    signal: between.signal,
    limits: { baseDelayMs: 60_000 },
  });
  const started = Date.now();
  setTimeout(() => between.abort(), 100);
  await rejectsWith(sleeping.request({}), "ABORTED");
  assert.ok(Date.now() - started < 5000, "the backoff wait is cut short");
});

test("non-JSON answers and unreachable hosts are reported", async (t) => {
  const server = await serve(t, (req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html>proxy error</html>");
  });
  await rejectsWith(client(server).request({}), "UPSTREAM_BAD_JSON");
  const closed = createServer();
  await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const { port } = closed.address();
  await new Promise((resolve) => closed.close(resolve));
  const env = { MM_IMPORT_MONDAY_URL: `http://127.0.0.1:${port}/v2` };
  const error = await rejectsWith(
    client({ env }).request({}),
    "UPSTREAM_UNREACHABLE",
  );
  assert.match(error.message, /^Could not reach monday\.com \(ECONNREFUSED\)$/);
});

test("perMinute keeps a sliding minute budget", async (t) => {
  const server = await serve(t, (req, res) => json(res, 200, {}));
  const clock = fakeClock();
  const upstream = createUpstream({
    source: "clickup",
    token: TOKEN,
    env: { MM_IMPORT_CLICKUP_URL: `${server.origin}/api` },
    perMinute: 3,
    clock,
  });
  for (let n = 0; n < 5; n += 1) await upstream.request({ path: "/v2/team" });
  assert.deepEqual(clock.sleeps, [60_000]);
  assert.equal(server.requests.length, 5);
  assert.equal(server.requests[0].url, "/api/v2/team");
  assert.equal(upstream.label, "ClickUp");
});
