/**
 * The import job registry (SPEC-4 §5, `server/import/jobs.js`): job
 * limits, creator-only access, 30-minute expiry, cancellation, connector
 * dispatch, progress publishing and keeping the source token out of
 * everything a job keeps or logs.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  JOB_TTL_MS,
  MAX_KEPT_PER_USER,
  createImportJobs,
} from "../server/import/jobs.js";
import { recordingLog } from "./helpers.js";
import { sampleSnapshot, seededStore } from "./import-engine-fixtures.js";

const TOKEN = "monday-token-0123456789abcdef";
const settled = () => new Promise((resolve) => setTimeout(resolve, 5));
/** Lets a started job reach its connector (loading it is asynchronous). */
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** A connector whose scans wait until `release()` (or their signal). */
function gatedConnector(result = sampleSnapshot) {
  const calls = [];
  const connector = {
    calls,
    scan(args) {
      return new Promise((resolve, reject) => {
        calls.push({ ...args, resolve: () => resolve(result()), reject });
        args.signal.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      });
    },
    release: (index = 0) => calls[index].resolve(),
  };
  return connector;
}

async function registry(t, { connectors, now } = {}) {
  const seeded = await seededStore();
  const published = [];
  const log = recordingLog();
  const jobs = createImportJobs({
    store: seeded.store,
    publish: (userId, payload) => published.push({ userId, ...payload }),
    connectors,
    log,
    now,
  });
  t.after(() => jobs.close());
  const admin = seeded.ids.users.alex;
  return { ...seeded, jobs, published, log, admin };
}

test("scans dispatch by source and keep the token out of the job", async (t) => {
  const monday = gatedConnector();
  const files = gatedConnector(() => ({ ...sampleSnapshot(), source: "csv" }));
  const connectors = { monday, clickup: monday, files };
  const { jobs, admin, published, store, ids } = await registry(t, {
    connectors,
  });
  const options = { include_docs: false };
  const scan = jobs.startScan({
    userId: admin,
    source: "monday",
    token: TOKEN,
    options,
  });
  await tick();
  assert.equal(scan.ok, true);
  assert.equal(monday.calls[0].token, TOKEN);
  assert.deepEqual(monday.calls[0].options, options);
  monday.calls[0].onProgress({
    phase: "boards",
    done: 1,
    total: 3,
    message: `got ${TOKEN}`,
  });
  assert.equal(jobs.get(scan.job.id, admin).progress.message, "got [redacted]");
  monday.release();
  await settled();
  const done = jobs.get(scan.job.id, admin);
  assert.equal(done.state, "done");
  assert.equal(done.preview.totals.boards, 3);
  assert.doesNotMatch(JSON.stringify(done), new RegExp(TOKEN));
  assert.doesNotMatch(JSON.stringify(published), new RegExp(TOKEN));
  const bytes = Buffer.from("Name\nA\n");
  const file = { name: "tasks.csv", kind: "csv", bytes };
  const fileScan = jobs.startScan({ userId: admin, source: "csv", file });
  await tick();
  assert.equal(fileScan.ok, true);
  assert.deepEqual(files.calls[0].file, file);
  assert.equal(files.calls[0].token, undefined);
  assert.equal(jobs.get(scan.job.id, ids.users.sam), null, "creator only");
  assert.equal(
    store.listBoards({ limit: 1000 }).length,
    4,
    "scans write nothing",
  );
});

test("the token is redacted from everything a connector returns", async (t) => {
  const leaky = {
    scan: async ({ token }) => {
      const snapshot = sampleSnapshot();
      snapshot.warnings[0].message = `Request with ${token} failed`;
      snapshot.workspaces[0].boards[0].items[0].name = `Bearer ${token}`;
      return snapshot;
    },
  };
  const connectors = { monday: leaky, clickup: leaky, files: leaky };
  const { jobs, admin } = await registry(t, { connectors });
  const scan = jobs.startScan({
    userId: admin,
    source: "monday",
    token: TOKEN,
  });
  await settled();
  const view = jobs.get(scan.job.id, admin);
  assert.equal(view.state, "done");
  assert.equal(
    view.preview.warnings[0].message,
    "Request with [redacted] failed",
  );
  assert.doesNotMatch(JSON.stringify(view), new RegExp(TOKEN));
  const run = jobs.startImport({
    userId: admin,
    scanJobId: scan.job.id,
    plan: {},
  });
  await settled();
  const report = jobs.get(run.job.id, admin).report;
  assert.doesNotMatch(JSON.stringify(report), new RegExp(TOKEN));
});

test("one running job per admin and two per server", async (t) => {
  const monday = gatedConnector();
  const connectors = { monday, clickup: monday, files: monday };
  const { jobs, admin, store, ids } = await registry(t, { connectors });
  store.updateUser(ids.users.sam, { role: "admin" });
  store.updateUser(ids.users.noa, { role: "admin" });
  const start = (userId) =>
    jobs.startScan({ userId, source: "monday", token: TOKEN });
  await tick();
  assert.equal(start(admin).ok, true);
  await tick();
  assert.deepEqual(start(admin), { ok: false, reason: "busy_user" });
  assert.equal(start(ids.users.sam).ok, true);
  assert.deepEqual(start(ids.users.noa), { ok: false, reason: "busy_server" });
  assert.equal(jobs.busyReason(ids.users.noa), "busy_server");
  monday.release(0);
  await settled();
  assert.equal(start(ids.users.noa).ok, true, "a finished job frees its slot");
});

test("scan failures keep a redacted message; unexpected ones log redacted details", async (t) => {
  const failing = {
    scan: async ({ token }) => {
      throw Object.assign(new Error(`401 for ${token}`), {
        code: "INVALID_TOKEN",
      });
    },
  };
  const broken = {
    scan: async ({ token }) => {
      throw new TypeError(`boom ${token}`);
    },
  };
  const invalid = { scan: async () => ({ source: "monday" }) };
  const connectors = { monday: failing, clickup: broken, files: invalid };
  const { jobs, admin, log } = await registry(t, { connectors });
  const first = jobs.startScan({
    userId: admin,
    source: "monday",
    token: TOKEN,
  });
  await tick();
  await settled();
  assert.deepEqual(jobs.get(first.job.id, admin).error, {
    code: "INVALID_TOKEN",
    message: "401 for [redacted]",
  });
  const second = jobs.startScan({
    userId: admin,
    source: "clickup",
    token: TOKEN,
  });
  await tick();
  await settled();
  assert.deepEqual(jobs.get(second.job.id, admin).error, {
    code: "SCAN_FAILED",
    message: "The scan failed",
  });
  const logged = JSON.stringify(log.entries);
  assert.match(logged, /boom \[redacted\]/);
  assert.doesNotMatch(logged, new RegExp(TOKEN));
  const file = { name: "x.csv", kind: "csv", bytes: Buffer.from("x") };
  const third = jobs.startScan({ userId: admin, source: "csv", file });
  await tick();
  await settled();
  const { error } = jobs.get(third.job.id, admin);
  assert.equal(error.code, "INVALID_SNAPSHOT");
  assert.equal(error.errors[0].path, "source_label");
});

test("a scan must return data of the source it was asked for", async (t) => {
  const mislabeled = { scan: async () => sampleSnapshot() };
  const connectors = {
    monday: mislabeled,
    clickup: mislabeled,
    files: mislabeled,
  };
  const { jobs, admin } = await registry(t, { connectors });
  const file = { name: "x.xlsx", kind: "xlsx", bytes: Buffer.from("x") };
  const scan = jobs.startScan({ userId: admin, source: "xlsx", file });
  await settled();
  assert.deepEqual(jobs.get(scan.job.id, admin).error, {
    code: "INVALID_SNAPSHOT",
    message: "The xlsx importer returned monday data",
  });
});

test("a connector that is missing fails the scan", async (t) => {
  const { jobs, admin } = await registry(t, { connectors: {} });
  const scan = jobs.startScan({
    userId: admin,
    source: "clickup",
    token: TOKEN,
  });
  await tick();
  await settled();
  assert.equal(
    jobs.get(scan.job.id, admin).error.code,
    "CONNECTOR_UNAVAILABLE",
  );
});

test("cancelling a scan ends it at once and aborts the connector", async (t) => {
  const monday = gatedConnector();
  const connectors = { monday, clickup: monday, files: monday };
  const { jobs, admin, published, ids } = await registry(t, { connectors });
  const scan = jobs.startScan({
    userId: admin,
    source: "monday",
    token: TOKEN,
  });
  await tick();
  assert.equal(jobs.cancel(scan.job.id, ids.users.sam), null, "creator only");
  assert.equal(jobs.cancel(scan.job.id, admin).state, "cancelled");
  assert.equal(monday.calls[0].signal.aborted, true);
  monday.release();
  await settled();
  assert.equal(
    jobs.get(scan.job.id, admin).state,
    "cancelled",
    "late results are ignored",
  );
  assert.deepEqual(
    published.map((p) => [p.userId, p.kind, p.state]),
    [
      [admin, "scan", "running"],
      [admin, "scan", "cancelled"],
    ],
  );
});

test("imports run from a finished scan of the same admin and can be cancelled", async (t) => {
  const monday = gatedConnector();
  const connectors = { monday, clickup: monday, files: monday };
  const { jobs, admin, ids, store } = await registry(t, { connectors });
  const scan = jobs.startScan({
    userId: admin,
    source: "monday",
    token: TOKEN,
  });
  await tick();
  const early = jobs.startImport({
    userId: admin,
    scanJobId: scan.job.id,
    plan: {},
  });
  assert.deepEqual(
    early,
    { ok: false, reason: "unknown_scan" },
    "not done yet",
  );
  monday.release();
  await settled();
  const bad = jobs.startImport({
    userId: admin,
    scanJobId: scan.job.id,
    plan: { users: { "u-x": "skip" } },
  });
  assert.equal(bad.reason, "invalid_plan");
  assert.equal(bad.errors[0].path, 'plan.users["u-x"]');
  store.updateUser(ids.users.sam, { role: "admin" });
  const other = jobs.startImport({
    userId: ids.users.sam,
    scanJobId: scan.job.id,
    plan: {},
  });
  assert.deepEqual(
    other,
    { ok: false, reason: "unknown_scan" },
    "creator only",
  );
  const started = jobs.startImport({
    userId: admin,
    scanJobId: scan.job.id,
    plan: {},
  });
  assert.equal(started.ok, true);
  jobs.cancel(started.job.id, admin);
  await settled();
  const job = jobs.get(started.job.id, admin);
  assert.equal(job.state, "cancelled");
  assert.equal(job.report.cancelled, true);
  assert.ok(job.report.created.boards < 3);
  const again = jobs.startImport({
    userId: admin,
    scanJobId: scan.job.id,
    plan: {},
  });
  await settled();
  assert.equal(jobs.get(again.job.id, admin).state, "done");
  assert.equal(jobs.get(again.job.id, admin).report.created.boards, 3);
});

test("finished jobs and their snapshots are discarded after 30 minutes", async (t) => {
  let at = Date.UTC(2026, 9, 18, 9);
  const monday = gatedConnector();
  const connectors = { monday, clickup: monday, files: monday };
  const { jobs, admin } = await registry(t, { connectors, now: () => at });
  const scan = jobs.startScan({
    userId: admin,
    source: "monday",
    token: TOKEN,
  });
  await tick();
  monday.release();
  await settled();
  const view = jobs.get(scan.job.id, admin);
  assert.equal(view.expires_at, new Date(at + JOB_TTL_MS).toISOString());
  at += JOB_TTL_MS - 1;
  assert.equal(jobs.get(scan.job.id, admin).state, "done");
  at += 1;
  assert.equal(jobs.get(scan.job.id, admin), null);
  const run = jobs.startImport({
    userId: admin,
    scanJobId: scan.job.id,
    plan: {},
  });
  assert.deepEqual(run, { ok: false, reason: "unknown_scan" });
});

test("each admin keeps a bounded number of finished jobs", async (t) => {
  const quick = { scan: async () => sampleSnapshot() };
  const connectors = { monday: quick, clickup: quick, files: quick };
  const { jobs, admin } = await registry(t, { connectors });
  const ids = [];
  for (let n = 0; n <= MAX_KEPT_PER_USER; n += 1) {
    ids.push(
      jobs.startScan({ userId: admin, source: "monday", token: TOKEN }).job.id,
    );
    await tick();
    await settled();
  }
  assert.equal(
    jobs.get(ids[0], admin),
    null,
    "the oldest finished job is gone",
  );
  assert.equal(jobs.get(ids[1], admin).state, "done");
});

test("progress is published at most every 250 ms; state changes always", async (t) => {
  let at = 0;
  const monday = gatedConnector();
  const connectors = { monday, clickup: monday, files: monday };
  const { jobs, admin, published } = await registry(t, {
    connectors,
    now: () => at,
  });
  jobs.startScan({ userId: admin, source: "monday", token: TOKEN });
  await tick();
  const { onProgress } = monday.calls[0];
  onProgress({ phase: "boards", done: 1 });
  at += 300;
  onProgress({ phase: "boards", done: 2 });
  onProgress({ phase: "boards", done: 3 });
  monday.release();
  await settled();
  assert.deepEqual(
    published.map((p) => [p.state, p.progress.done]),
    [
      ["running", null],
      ["running", 2],
      ["done", null],
    ],
  );
});
