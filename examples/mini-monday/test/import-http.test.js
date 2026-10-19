/**
 * Import routes (SPEC-4 §5, `server/routes/import.js`): who may call them
 * (session with Origin, API token with the right scope, `import_data`),
 * scan requests (JSON with a token, raw files up to 20 MiB), job reads and
 * cancels for their creator only, runs with plan errors, job limits, and
 * the token never coming back in a response or a log line.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { rawRequest, startTestServers } from "./helpers.js";
import { sampleSnapshot } from "./import-engine-fixtures.js";

const TOKEN = "eyJhbGciOiJIUzI1NiJ9.monday-secret-token-0123456789";
const JSON_TYPE = { "Content-Type": "application/json" };
const pause = () => new Promise((resolve) => setTimeout(resolve, 10));

/** Servers with stub connectors that record their calls. */
async function setup(t, scan = async () => sampleSnapshot()) {
  const calls = [];
  const stub = (source) => ({
    scan: async (args) => {
      calls.push(args);
      return { ...(await scan(args)), source: args.file?.kind ?? source };
    },
  });
  const connectors = {
    monday: stub("monday"),
    clickup: stub("clickup"),
    files: stub("csv"),
  };
  const servers = await startTestServers({ importConnectors: connectors });
  t.after(() => servers.close());
  const admin = servers.sessionFor(servers.ids.users.alex);
  const send = (
    path,
    { headers = admin, body, method = "POST", type = JSON_TYPE } = {},
  ) => {
    const init = { method, headers: { ...type, ...headers } };
    if (body !== undefined)
      init.body =
        typeof body === "string" || Buffer.isBuffer(body)
          ? body
          : JSON.stringify(body);
    return fetch(new URL(path, servers.hostUrl), init);
  };
  const scanJson = (body, headers) => send("/import/scan", { body, headers });
  const job = (id, headers = admin) =>
    send(`/import/jobs/${id}`, { method: "GET", headers, type: {} });
  return { ...servers, calls, admin, send, scanJson, job };
}

const codeOf = async (response) =>
  (await response.json()).errors[0].extensions.code;

test("only admins with import_data and the right scope can use the routes", async (t) => {
  const s = await setup(t);
  const { ids } = s;
  const scan = { source: "monday", token: TOKEN };
  for (const user of ["sam", "jordan", "chris"]) {
    const response = await s.scanJson(scan, s.sessionFor(ids.users[user]));
    assert.equal(response.status, 403, user);
    assert.equal(await codeOf(response), "FORBIDDEN");
  }
  const anonymous = await s.scanJson(scan, {});
  assert.equal(anonymous.status, 401);
  const crossSite = await s.scanJson(scan, {
    ...s.admin,
    Origin: "https://evil.example",
  });
  assert.equal(crossSite.status, 403);
  const readOnly = await s.scanJson(scan, {
    Authorization: `Bearer ${s.tokens.readOnly}`,
  });
  assert.equal(readOnly.status, 403, "scans need boards:write");
  const token = await s.scanJson(scan, {
    Authorization: `Bearer ${s.tokens.readWrite}`,
  });
  assert.equal(token.status, 202, "an admin's API token works");
  const { job_id } = await token.json();
  assert.match(job_id, /^[\w-]{22}$/);
  const read = await s.job(job_id, { Authorization: s.tokens.readOnly });
  assert.equal(read.status, 200, "reading a job needs boards:read");
  const samToken = s.tokenFor(ids.users.sam);
  for (const path of [
    `/import/jobs/${job_id}`,
    `/import/jobs/${job_id}/cancel`,
    "/import/run",
  ]) {
    const method = path.endsWith(job_id) ? "GET" : "POST";
    const response = await s.send(path, {
      method,
      headers: { Authorization: samToken },
      body: method === "POST" ? { scan_job_id: job_id } : undefined,
    });
    assert.equal(response.status, 403, path);
  }
});

test("scan requests are validated without ever echoing the token", async (t) => {
  const s = await setup(t);
  const cases = [
    [{ source: "jira", token: TOKEN }, 400, /source must be/],
    [{ source: "monday" }, 400, /token must be/],
    [{ source: "monday", token: `${TOKEN}\n` }, 400, /token must be/],
    [
      { source: "monday", token: TOKEN, url: "https://evil.example" },
      400,
      /Unknown field "url"/,
    ],
    [
      {
        source: "monday",
        token: TOKEN,
        options: { base_url: "https://evil.example" },
      },
      400,
      /Unknown option "base_url"/,
    ],
    [
      { source: "clickup", token: TOKEN, options: { limits: { items: 0 } } },
      400,
      /limits.items must be an integer from 1 to 100000/,
    ],
    [
      { source: "clickup", token: TOKEN, options: { include_docs: "yes" } },
      400,
      /include_docs must be a boolean/,
    ],
    [
      { source: "monday", token: TOKEN, options: { column_types: {} } },
      400,
      /Unknown option "column_types"/,
    ],
    [
      { source: "monday", token: TOKEN, options: { transport: { env: {} } } },
      400,
      /Unknown option "transport"/,
    ],
    [
      { source: "monday", token: TOKEN, options: { limits: { pages: 2 } } },
      400,
      /Unknown limit "pages"/,
    ],
  ];
  for (const [body, status, pattern] of cases) {
    const response = await s.scanJson(body);
    const text = await response.text();
    assert.equal(response.status, status, text);
    assert.match(JSON.parse(text).errors[0].message, pattern);
    assert.doesNotMatch(text, /monday-secret-token/);
  }
  const ok = await s.scanJson({
    source: "clickup",
    token: TOKEN,
    options: { include_comments: false, limits: { boards: 5 } },
  });
  assert.equal(ok.status, 202);
  assert.deepEqual(s.calls.at(-1).options, {
    include_comments: false,
    limits: { boards: 5 },
  });
  assert.equal(s.calls.at(-1).token, TOKEN);
  await pause();
  const { job_id } = await ok.json();
  const job = await (await s.job(job_id)).text();
  assert.doesNotMatch(job, /monday-secret-token/);
  assert.doesNotMatch(JSON.stringify(s.log.entries), /monday-secret-token/);
  const wrongType = await s.send("/import/scan", {
    body: "{}",
    type: { "Content-Type": "text/plain" },
  });
  assert.equal(wrongType.status, 415);
});

test("raw files up to 20 MiB are scanned; JSON stays under the 1 MiB limit", async (t) => {
  const s = await setup(t);
  const fileType = { "Content-Type": "application/octet-stream" };
  const upload = (body, headers = {}) =>
    s.send("/import/scan", {
      body,
      type: fileType,
      headers: {
        ...s.admin,
        "X-Import-Kind": "csv",
        "X-Import-Filename": encodeURIComponent("Tâches 2026.csv"),
        ...headers,
      },
    });
  const big = Buffer.alloc(2 * 1024 * 1024, "a");
  const response = await upload(big, {
    "X-Import-Options": JSON.stringify({
      column_types: { Due: "date" },
      limits: { items: 10 },
    }),
  });
  assert.equal(response.status, 202);
  const [call] = s.calls;
  assert.deepEqual(
    [call.file.name, call.file.kind, call.file.bytes.length],
    ["Tâches 2026.csv", "csv", big.length],
  );
  assert.deepEqual(call.options, {
    column_types: { Due: "date" },
    limits: { items: 10 },
  });
  assert.equal(call.token, undefined);
  await pause();
  const bad = [
    [{ "X-Import-Kind": "pdf" }, /X-Import-Kind/],
    [{ "X-Import-Filename": "../etc/passwd" }, /X-Import-Filename/],
    [{ "X-Import-Filename": "" }, /X-Import-Filename/],
    [
      { "X-Import-Options": "{not json" },
      /X-Import-Options must be a JSON object/,
    ],
    [
      {
        "X-Import-Options": JSON.stringify({ column_types: { A: "formula" } }),
      },
      /column_types/,
    ],
  ];
  for (const [headers, pattern] of bad) {
    const refused = await upload("a,b\n", headers);
    assert.equal(refused.status, 400);
    assert.match(await refused.text(), pattern);
  }
  assert.equal((await upload(Buffer.alloc(0))).status, 400);
  const tooBig = await upload(Buffer.alloc(20 * 1024 * 1024 + 1, "a"));
  assert.equal(tooBig.status, 413);
  assert.match(await tooBig.text(), /20 MiB/);
  const json = await s.scanJson(
    `{"source":"monday","token":"${"x".repeat(1024 * 1024)}"}`,
  );
  assert.equal(json.status, 413, "JSON bodies keep the global limit");
});

test("a streamed file over 20 MiB is cut off", async (t) => {
  const s = await setup(t);
  const chunk = Buffer.alloc(1024 * 1024, "a");
  async function* body() {
    for (let n = 0; n < 21; n += 1) yield chunk;
  }
  const response = await fetch(new URL("/import/scan", s.hostUrl), {
    method: "POST",
    duplex: "half",
    headers: {
      ...s.admin,
      "Content-Type": "application/octet-stream",
      "X-Import-Kind": "xlsx",
      "X-Import-Filename": "board.xlsx",
    },
    body: body(),
  }).catch((error) => error);
  if (response instanceof Response) assert.equal(response.status, 413);
  assert.equal(s.calls.length, 0, "the connector never ran");
});

test("jobs are read and cancelled by their creator; runs report plan errors", async (t) => {
  const s = await setup(t);
  const { ids } = s;
  const scan = await (
    await s.scanJson({ source: "monday", token: TOKEN })
  ).json();
  await pause();
  const done = await (await s.job(scan.job_id)).json();
  assert.deepEqual([done.kind, done.state], ["scan", "done"]);
  assert.equal(done.preview.workspaces.length, 2);
  s.store.updateUser(ids.users.sam, { role: "admin" });
  const otherAdmin = s.sessionFor(ids.users.sam);
  assert.equal((await s.job(scan.job_id, otherAdmin)).status, 404);
  assert.equal((await s.job("A".repeat(22))).status, 404);
  const wrongMethod = await s.send(`/import/jobs/${scan.job_id}`, { body: {} });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "GET");
  const invalid = await s.send("/import/run", {
    body: {
      scan_job_id: scan.job_id,
      plan: { users: { "u-sam": "match:99999" } },
    },
  });
  assert.equal(invalid.status, 400);
  const { errors } = await invalid.json();
  assert.deepEqual(errors[0].extensions.errors, [
    {
      path: 'plan.users["u-sam"]',
      message: "match must name an active Worklane user",
    },
  ]);
  const unknown = await s.send("/import/run", {
    body: { scan_job_id: "nope", plan: {} },
  });
  assert.equal(unknown.status, 404);
  const foreign = await s.send("/import/run", {
    headers: otherAdmin,
    body: { scan_job_id: scan.job_id, plan: {} },
  });
  assert.equal(foreign.status, 404, "another admin cannot run my scan");
  const started = await s.send("/import/run", {
    body: { scan_job_id: scan.job_id, plan: {} },
  });
  assert.equal(started.status, 202);
  const { job_id } = await started.json();
  await pause();
  const finished = await (await s.job(job_id)).json();
  assert.equal(finished.state, "done");
  assert.equal(finished.report.created.boards, 3);
  assert.equal((await (await s.job(scan.job_id)).json()).import_job_id, job_id);
  for (const plan of [{}, { users: { "u-sam": "match:99999" } }]) {
    const again = await s.send("/import/run", {
      body: { scan_job_id: scan.job_id, plan },
    });
    assert.equal(again.status, 409, "a scan is imported once");
    const [error] = (await again.json()).errors;
    assert.deepEqual(error, {
      message: "This scan was already imported",
      extensions: { import_job_id: job_id, code: "ALREADY_IMPORTED" },
    });
  }
  const cancel = await s.send(`/import/jobs/${job_id}/cancel`, { body: {} });
  assert.equal(cancel.status, 200);
  assert.equal(
    (await cancel.json()).state,
    "done",
    "a finished job stays as it was",
  );
  const notMine = await s.send(`/import/jobs/${job_id}/cancel`, {
    headers: otherAdmin,
    body: {},
  });
  assert.equal(notMine.status, 404);
});

test("running jobs are limited per admin, and cancelling ends a scan", async (t) => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const s = await setup(t, async () => {
    await gate;
    return sampleSnapshot();
  });
  const first = await s.scanJson({ source: "monday", token: TOKEN });
  assert.equal(first.status, 202);
  const busy = await s.scanJson({ source: "monday", token: TOKEN });
  assert.equal(busy.status, 429);
  assert.equal(busy.headers.get("retry-after"), "5");
  assert.match(await busy.text(), /already have an import job running/);
  const busyFile = await rawRequest(s.hostUrl, {
    method: "POST",
    path: "/import/scan",
    headers: {
      ...s.admin,
      "Content-Type": "application/octet-stream",
      "Content-Length": String(20 * 1024 * 1024),
      "X-Import-Kind": "csv",
      "X-Import-Filename": "a.csv",
    },
  });
  assert.equal(busyFile.status, 429, "refused before the upload is read");
  const { job_id } = await first.json();
  const cancelled = await s.send(`/import/jobs/${job_id}/cancel`, { body: {} });
  assert.equal((await cancelled.json()).state, "cancelled");
  assert.equal(s.calls[0].signal.aborted, true);
  release();
  await pause();
  assert.equal((await (await s.job(job_id)).json()).state, "cancelled");
  assert.equal(
    (await s.scanJson({ source: "monday", token: TOKEN })).status,
    202,
  );
});

test("GET /import/jobs lists the caller's own jobs without their data", async (t) => {
  const s = await setup(t);
  const list = (headers = s.admin) =>
    s.send("/import/jobs", { method: "GET", headers, type: {} });
  assert.deepEqual(await (await list()).json(), { jobs: [] });
  const started = await s.scanJson({ source: "clickup", token: TOKEN });
  const { job_id } = await started.json();
  for (let n = 0; n < 50; n += 1) {
    if ((await (await s.job(job_id)).json()).state !== "running") break;
    await pause();
  }
  const { jobs } = await (await list()).json();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, job_id);
  assert.equal(jobs[0].kind, "scan");
  assert.equal(jobs[0].source, "clickup");
  assert.equal(jobs[0].state, "done");
  assert.ok(!("preview" in jobs[0]), "the list holds no source data");
  assert.doesNotMatch(JSON.stringify(jobs), new RegExp(TOKEN));
  const view = await (await s.job(job_id)).json();
  assert.equal(view.source, "clickup", "job views name their source");
  const { ids } = s;
  s.store.updateUser(ids.users.sam, { role: "admin" });
  const other = await list(s.sessionFor(ids.users.sam));
  assert.deepEqual(await other.json(), { jobs: [] }, "creator only");
  const member = await list(s.sessionFor(ids.users.jordan));
  assert.equal(member.status, 403);
  const post = await s.send("/import/jobs", { method: "POST", body: {} });
  assert.equal(post.status, 405);
});
