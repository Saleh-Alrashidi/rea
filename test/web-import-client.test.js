/**
 * The import wizard's client side (SPEC-4 §5, §6): following a job with
 * live `event: import` messages and the polling fallback
 * (`web/ui/import/job-watch.js`), and the HTTP client
 * (`web/ui/import/import-api.js`) against a stubbed fetch for its request
 * shapes and against the real import routes for the whole scan → review →
 * import round trip.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { run } from "../server/import/engine.js";
import { ApiError } from "../web/api.js";
import { loadBoard } from "../web/ui/board/board-data.js";
import * as A from "../web/ui/import/import-api.js";
import { importBadgeInfo, sourceHref } from "../web/ui/import/import-badge.js";
import { watchJob } from "../web/ui/import/job-watch.js";
import { createSelection, toPlan } from "../web/ui/import/plan-model.js";
import { linkSections } from "../web/ui/import/report-model.js";
import * as W from "../web/ui/import/wizard.js";
import { startTestServers } from "./helpers.js";
import { sampleSnapshot } from "./import-engine-fixtures.js";
import { liveServer } from "./web-import-fixtures.js";

const ID = "j".repeat(22);
const flush = () => new Promise((resolve) => setImmediate(resolve));

function fakeTimers() {
  const pending = new Map();
  let next = 0;
  return {
    setTimeout(fn) {
      next += 1;
      pending.set(next, fn);
      return next;
    },
    clearTimeout: (id) => pending.delete(id),
    get size() {
      return pending.size;
    },
    async tick() {
      const due = [...pending.values()];
      pending.clear();
      for (const fn of due) fn();
      await flush();
    },
  };
}

/** A watch over scripted `getJob` answers (the last one repeats). */
function watching(answers) {
  const timers = fakeTimers();
  const seen = [];
  const gone = [];
  let reads = 0;
  const getJob = async (id) => {
    assert.equal(id, ID);
    const answer = answers[Math.min(reads, answers.length - 1)];
    reads += 1;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const watch = watchJob({
    jobId: ID,
    getJob,
    timers,
    onJob: (job) => seen.push(job),
    onGone: (id) => gone.push(id),
  });
  return { watch, timers, seen, gone, reads: () => reads };
}

const view = (state, extra = {}) => ({ id: ID, kind: "scan", state, ...extra });
const event = (state, extra = {}) => ({
  job_id: ID,
  kind: "scan",
  state,
  ...extra,
});
const notFound = () => Object.assign(new Error("gone"), { status: 404 });

test("a watch reads at once, polls while no message arrives, and stops at the end", async () => {
  const done = view("done", { preview: { workspaces: [] } });
  const w = watching([view("running"), view("running"), done]);
  await flush();
  assert.deepEqual(
    w.seen.map((job) => job.state),
    ["running"],
  );
  assert.equal(w.timers.size, 1, "a poll is due");
  await w.timers.tick();
  assert.equal(w.reads(), 2);
  await w.timers.tick();
  assert.equal(w.seen.at(-1), done);
  assert.equal(w.watch.stopped, true);
  assert.equal(w.timers.size, 0);
});

test("live messages skip the next poll; an end without details reads the job", async () => {
  const done = view("done", { preview: { workspaces: [] } });
  const w = watching([view("running"), done]);
  await flush();
  const progress = { phase: "items", done: 1, total: 2, message: null };
  w.watch.push(event("running", { progress }));
  w.watch.push({ ...event("running"), job_id: "other".padEnd(22, "x") });
  assert.deepEqual(w.seen.at(-1).progress, progress);
  await w.timers.tick();
  assert.equal(w.reads(), 1, "a message arrived, so no poll");
  w.watch.push(event("done"));
  assert.equal(w.seen.at(-1).state, "done", "the end shows at once");
  await flush();
  assert.equal(w.reads(), 2, "then the preview is read");
  assert.equal(w.seen.at(-1), done);
  assert.equal(w.watch.stopped, true);
  w.watch.push(event("running"));
  assert.equal(w.seen.at(-1), done, "nothing after the end");
});

test("a job the server lost ends the watch; other failures keep polling", async () => {
  const flaky = watching([new Error("offline"), view("running")]);
  await flush();
  assert.equal(flaky.seen.length, 0);
  await flaky.timers.tick();
  assert.equal(flaky.seen.length, 1);
  flaky.watch.stop();
  assert.equal(flaky.timers.size, 0);
  const lost = watching([notFound()]);
  await flush();
  assert.deepEqual(lost.gone, [ID]);
  assert.equal(lost.watch.stopped, true);
  assert.equal(lost.timers.size, 0);
});

// ------------------------------------------------------- request shapes

function stubFetch(t, respond) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (path, init) => {
    calls.push({ path, init });
    return respond(path, init);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

const jsonResponse = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

test("scan requests send the token once, and files with their encoded name", async (t) => {
  const calls = stubFetch(t, () => jsonResponse(202, { job_id: ID }));
  const options = { include_docs: false };
  assert.equal(
    await A.scanWithToken({ source: "monday", token: "tok-123", options }),
    ID,
  );
  const [scan] = calls;
  assert.equal(scan.path, "/import/scan");
  assert.equal(scan.init.method, "POST");
  assert.equal(scan.init.credentials, "same-origin");
  assert.equal(scan.init.cache, "no-store");
  assert.equal(scan.init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(scan.init.body), {
    source: "monday",
    token: "tok-123",
    options,
  });
  const file = new File(["a,b\n"], "Plan ✓ 2026.csv");
  await A.scanFile({ file, kind: "csv" });
  const upload = calls[1];
  assert.equal(upload.init.body, file);
  assert.deepEqual(upload.init.headers, {
    Accept: "application/json",
    "Content-Type": "application/octet-stream",
    "X-Import-Filename": "Plan%20%E2%9C%93%202026.csv",
    "X-Import-Kind": "csv",
  });
  await A.scanFile({
    file,
    kind: "csv",
    options: { column_types: { a: "text" } },
  });
  assert.equal(
    calls[2].init.headers["X-Import-Options"],
    '{"column_types":{"a":"text"}}',
  );
  await A.cancelJob(ID);
  assert.deepEqual(
    [calls[3].path, calls[3].init.method],
    [`/import/jobs/${ID}/cancel`, "POST"],
  );
});

test("refused requests throw ApiErrors with codes and plan details", async (t) => {
  const answers = [
    jsonResponse(400, {
      errors: [
        {
          message: "The import plan is not valid",
          extensions: {
            code: "BAD_REQUEST",
            errors: [{ path: "plan.users", message: "x" }],
          },
        },
      ],
    }),
    new Response("<html>oops</html>", { status: 502 }),
    jsonResponse(202, { ok: true }),
  ];
  const calls = stubFetch(t, () => answers.shift());
  const invalid = await A.runImport({ scanJobId: ID, plan: {} }).catch(
    (e) => e,
  );
  assert.ok(invalid instanceof ApiError);
  assert.equal(invalid.code, "BAD_REQUEST");
  assert.equal(invalid.status, 400);
  assert.deepEqual(invalid.details, [{ path: "plan.users", message: "x" }]);
  assert.deepEqual(W.requestFailure(invalid).errors, invalid.details);
  const html = await A.getJob(ID).catch((e) => e);
  assert.equal(html.code, "INTERNAL");
  assert.equal(html.message, "Request failed (HTTP 502)");
  const noJob = await A.scanWithToken({ source: "clickup", token: "t" }).catch(
    (e) => e,
  );
  assert.equal(noJob.message, "The server returned no job");
  assert.equal(calls.length, 3);
  for (const bad of ["../admin", "short", `${ID}/x`, 42]) {
    await assert.rejects(A.getJob(bad), TypeError);
  }
  await assert.rejects(A.cancelJob("../x"), TypeError);
  assert.equal(calls.length, 3, "malformed IDs are never requested");
});

test("import events are parsed from the user's stream", (t) => {
  const original = globalThis.EventSource;
  t.after(() => {
    globalThis.EventSource = original;
  });
  const sources = [];
  globalThis.EventSource = class {
    constructor(url) {
      this.url = url;
      this.listeners = {};
      this.closed = false;
      sources.push(this);
    }
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    }
    close() {
      this.closed = true;
    }
  };
  const received = [];
  const states = [];
  const close = A.subscribeImportEvents(
    (e) => received.push(e),
    (open) => states.push(open),
  );
  const [source] = sources;
  assert.equal(source.url, "/v2/events?stream=me");
  source.listeners.open();
  for (const data of [
    '{"job_id":"a","state":"running"}',
    "{oops",
    "[1]",
    '{"state":"x"}',
  ]) {
    source.listeners.import({ data });
  }
  source.listeners.error();
  assert.deepEqual(received, [{ job_id: "a", state: "running" }]);
  assert.deepEqual(states, [true, false]);
  close();
  assert.equal(source.closed, true);
  globalThis.EventSource = undefined;
  const offline = [];
  A.subscribeImportEvents(
    () => {},
    (open) => offline.push(open),
  )();
  assert.deepEqual(offline, [false]);
});

// --------------------------------------------------------- round trip

/** Reads `id` until it ends, as the polling fallback does. */
async function finished(id) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = await A.getJob(id);
    if (W.isTerminal(job.state)) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`job ${id} did not end`);
}

test("the wizard's requests round-trip through the real import routes", async (t) => {
  const { files } = await liveServer(t);
  const token = "monday-token-0123456789-abcdef";
  let state = W.transition(W.initialState("monday"), { type: "submit" });
  const scanId = await A.scanWithToken({
    source: "monday",
    token,
    options: { include_docs: false },
  });
  state = W.transition(state, { type: "scan-started", jobId: scanId });
  const scan = await finished(scanId);
  assert.ok(!JSON.stringify(scan).includes(token), "no token in the job");
  state = W.transition(state, { type: "job", job: scan });
  assert.equal(state.step, "review");
  const selection = createSelection(state.preview);
  selection.users.set("u-new", "invite:member");
  state = W.transition(state, { type: "submit" });
  const importId = await A.runImport({
    scanJobId: scanId,
    plan: toPlan(selection, state.preview),
  });
  state = W.transition(state, { type: "import-started", jobId: importId });
  state = W.transition(state, { type: "job", job: await finished(importId) });
  assert.equal(state.step, "done");
  assert.equal(state.report.created.users, 1);
  const boards = linkSections(state.report.links).find(
    (s) => s.kind === "board",
  );
  assert.ok(boards.links.every((link) => /^#\/boards\/\d+$/.test(link.href)));
  // A plan the server refuses comes back with its paths.
  selection.users.set("u-anon", "invite:member");
  const refused = await A.runImport({
    scanJobId: scanId,
    plan: toPlan(selection, state.preview),
  }).catch((e) => e);
  assert.equal(refused.status, 400);
  assert.deepEqual(
    refused.details.map((entry) => entry.path),
    ['plan.users["u-anon"]'],
  );
  // An unknown scan sends the wizard back to the source step.
  const review = W.transition(W.initialState("monday"), { type: "submit" });
  const gone = await A.runImport({ scanJobId: "x".repeat(22), plan: {} }).catch(
    (e) => e,
  );
  const back = W.transition(
    { ...review, step: "review" },
    { type: "submit-failed", error: W.requestFailure(gone) },
  );
  assert.equal(back.step, "source");
  // Files keep their name through the percent-encoded header.
  const fileJob = await A.scanFile({
    file: new File(["Name\nA\n"], "Q4 plan ✓.csv"),
    kind: "csv",
  });
  assert.equal((await finished(fileJob)).state, "done");
  assert.equal(files[0].name, "Q4 plan ✓.csv");
  assert.equal(files[0].bytes.toString(), "Name\nA\n");
});

test("a running job can be cancelled and a second one is refused", async (t) => {
  // The connector holds the scan open until it is aborted.
  const slow = await startTestServers({
    importConnectors: {
      monday: {
        scan: ({ signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () =>
              reject(Object.assign(new Error("stop"), { name: "AbortError" })),
            );
          }),
      },
    },
  });
  t.after(() => slow.close());
  const session = slow.sessionFor(slow.ids.users.alex);
  const original = globalThis.fetch;
  globalThis.fetch = (path, init = {}) =>
    original(new URL(path, slow.hostUrl), {
      ...init,
      headers: { ...init.headers, ...session },
    });
  t.after(() => {
    globalThis.fetch = original;
  });
  const id = await A.scanWithToken({ source: "monday", token: "tok-abcdefgh" });
  const busy = await A.scanWithToken({
    source: "monday",
    token: "tok-abcdefgh",
  }).catch((e) => e);
  assert.equal(busy.status, 429);
  const refused = W.transition(
    W.transition(W.initialState("monday"), { type: "submit" }),
    { type: "submit-failed", error: W.requestFailure(busy) },
  );
  assert.match(
    refused.error.message,
    /^A scan or import of yours is still running/,
  );
  assert.equal(refused.error.detail, "You already have an import job running");
  const cancelled = await A.cancelJob(id);
  assert.equal(cancelled.state, "cancelled");
  const state = W.transition(
    { ...W.initialState("monday"), step: "scanning", scanJobId: id },
    { type: "job", job: cancelled },
  );
  assert.equal(state.notice, "The scan was cancelled.");
});

test("an imported board loads with its source for the header badge", async (t) => {
  const { servers } = await liveServer(t);
  const importerId = servers.ids.users.alex;
  const report = await run(
    sampleSnapshot(),
    {},
    { store: servers.store, importerId },
  );
  const link = report.links.find((entry) => entry.kind === "board");
  const board = await loadBoard(String(link.id));
  assert.equal(board.import.source, "monday");
  assert.equal(board.import.imported_by.name, "Alex Rivera");
  const info = importBadgeInfo(board.import);
  assert.equal(info.label, "Imported from monday.com");
  assert.equal(info.href, sourceHref(board.import.source_url));
  assert.match(info.title, /by Alex Rivera/);
  const made = servers.store.listBoards({ limit: 500 }).find((b) => !b.import);
  assert.equal((await loadBoard(String(made.id))).import, null);
});
