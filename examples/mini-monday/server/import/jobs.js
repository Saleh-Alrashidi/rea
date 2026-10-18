/**
 * Import jobs (SPEC-4 §5): scans and imports that run in the background,
 * each visible only to the admin who started it.
 *
 * - A scan job calls a connector (`connectors/{monday,clickup,files}.js`,
 *   `scan({ token | file, options, signal, onProgress })` → Snapshot),
 *   validates the result and keeps the normalized snapshot with its
 *   preview. The source token is passed to the connector and nothing else:
 *   it is never stored in a job, and it is redacted from everything a job
 *   keeps (the snapshot, progress messages, error messages).
 * - An import job runs a plan over a finished scan's snapshot
 *   (`engine.run`).
 *
 * Bounds: one running job per admin and MAX_RUNNING per server; a finished
 * job (with its snapshot) is discarded JOB_TTL_MS after it ended, and each
 * admin keeps at most MAX_KEPT_PER_USER finished jobs. Progress and state
 * changes are published to the admin's `stream=me` streams as `event:
 * import` (`{ job_id, kind, state, progress }`, progress at most every
 * PROGRESS_INTERVAL_MS).
 */
import { randomBytes } from "node:crypto";
import { ImportError, preview, run } from "./engine.js";
import { checkPlan } from "./plan.js";
import { validateSnapshot } from "./snapshot.js";

export const MAX_RUNNING = 2;
export const MAX_RUNNING_PER_USER = 1;
export const JOB_TTL_MS = 30 * 60 * 1000;
export const MAX_KEPT_PER_USER = 10;
export const PROGRESS_INTERVAL_MS = 250;
const SWEEP_INTERVAL_MS = 60 * 1000;
const REDACTED = "[redacted]";
// Shorter secrets would turn ordinary text into "[redacted]".
const MIN_REDACTED_LENGTH = 8;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const MAX_MESSAGE = 500;
const MAX_PHASE = 64;
/** Connector module per scan source (`files.js` reads csv and xlsx). */
export const CONNECTOR_NAMES = Object.freeze({
  monday: "monday",
  clickup: "clickup",
  csv: "files",
  xlsx: "files",
});

/** Loads `connectors/<name>.js` (names from CONNECTOR_NAMES only). */
const loadConnector = (name) => import(`./connectors/${name}.js`);

/** `value` with every occurrence of `secret` in its strings replaced. */
export function redactDeep(value, secret) {
  if (typeof secret !== "string" || secret.length < MIN_REDACTED_LENGTH)
    return value;
  const walk = (node) => {
    if (typeof node === "string") return node.replaceAll(secret, REDACTED);
    if (Array.isArray(node)) return node.map(walk);
    if (node === null || typeof node !== "object") return node;
    return Object.fromEntries(
      Object.entries(node).map(([key, child]) => [walk(key), walk(child)]),
    );
  };
  return walk(value);
}

const shortText = (value, max, secret) =>
  typeof value === "string" ? redactDeep(value, secret).slice(0, max) : null;
const count = (value) =>
  Number.isSafeInteger(value) && value >= 0 ? value : null;

/** A connector's or the engine's progress report, bounded and redacted. */
function readProgress(raw, secret) {
  return {
    phase: shortText(raw?.phase, MAX_PHASE, secret) ?? "working",
    done: count(raw?.done),
    total: count(raw?.total),
    message: shortText(raw?.message, MAX_MESSAGE, secret),
  };
}

/** The job as its creator reads it. */
function viewOf(job) {
  const view = {
    id: job.id,
    kind: job.kind,
    state: job.state,
    progress: job.progress,
    created_at: new Date(job.createdAt).toISOString(),
    finished_at:
      job.finishedAt === null ? null : new Date(job.finishedAt).toISOString(),
    expires_at:
      job.finishedAt === null
        ? null
        : new Date(job.finishedAt + JOB_TTL_MS).toISOString(),
  };
  if (job.preview) view.preview = job.preview;
  if (job.report) view.report = job.report;
  if (job.error) view.error = job.error;
  return view;
}

/**
 * What a failed job reports: the code and message of an expected failure
 * (connector errors with a code, ImportError), else a generic one (the
 * redacted details go to the log).
 */
function failureOf(error, { secret, log, kind }) {
  const code = typeof error?.code === "string" ? error.code : "";
  if (ERROR_CODE.test(code) && !code.startsWith("ERR_")) {
    const message =
      shortText(String(error.message ?? ""), MAX_MESSAGE, secret) ?? "";
    const failure = { code, message };
    const errors = error instanceof ImportError ? error.details?.errors : null;
    return errors ? { ...failure, errors } : failure;
  }
  const detail = redactDeep(String(error?.stack ?? error), secret);
  log.error?.(`mini-monday: import ${kind} failed`, detail);
  return {
    code: `${kind.toUpperCase()}_FAILED`,
    message: `The ${kind} failed`,
  };
}

const aborted = (error, signal) =>
  signal.aborted || error?.code === "ABORTED" || error?.name === "AbortError";

/** The job table: jobs by ID, their bounds, settling and publishing. */
function createTable({ publish, log, now }) {
  const jobs = new Map();
  const lastSent = new Map();
  const running = () => [...jobs.values()].filter((j) => j.state === "running");
  const announce = (job, { force = false } = {}) => {
    const at = now();
    const last = lastSent.get(job.id) ?? Number.NEGATIVE_INFINITY;
    if (!force && at - last < PROGRESS_INTERVAL_MS) return;
    lastSent.set(job.id, at);
    const { id: job_id, kind, state, progress } = job;
    try {
      publish(job.userId, { job_id, kind, state, progress });
    } catch (error) {
      log.error?.("mini-monday: import progress could not be sent", error);
    }
  };
  const forget = (id) => {
    jobs.delete(id);
    lastSent.delete(id);
  };
  const sweep = () => {
    const at = now();
    for (const [id, job] of jobs) {
      if (job.finishedAt !== null && at - job.finishedAt >= JOB_TTL_MS)
        forget(id);
    }
  };
  return {
    jobs,
    running,
    announce,
    sweep,
    /** Ends a running job in `state` with `fields` (a no-op otherwise). */
    settle(job, state, fields = {}) {
      if (job.state !== "running") return;
      Object.assign(job, fields, {
        state,
        finishedAt: now(),
        controller: null,
      });
      announce(job, { force: true });
      const finished = [...jobs.values()].filter(
        (each) => each.userId === job.userId && each.finishedAt !== null,
      );
      for (const old of finished.slice(0, -MAX_KEPT_PER_USER)) forget(old.id);
    },
    /** "busy_user" / "busy_server" when `userId` may not start a job now. */
    busy(userId) {
      sweep();
      const active = running();
      if (active.some((job) => job.userId === userId)) return "busy_user";
      return active.length >= MAX_RUNNING ? "busy_server" : null;
    },
    add(kind, userId) {
      const job = {
        id: randomBytes(16).toString("base64url"),
        kind,
        userId,
        state: "running",
        progress: readProgress({ phase: "starting" }),
        createdAt: now(),
        finishedAt: null,
        controller: new AbortController(),
      };
      jobs.set(job.id, job);
      announce(job, { force: true });
      return job;
    },
    clear() {
      for (const job of running()) job.controller.abort();
      jobs.clear();
      lastSent.clear();
    },
  };
}

async function connectorFor(env, source) {
  const name = CONNECTOR_NAMES[source];
  const module = env.connectors
    ? env.connectors[name]
    : await loadConnector(name);
  if (typeof module?.scan === "function") return module;
  const message = `The ${source} importer is not available`;
  throw new ImportError("CONNECTOR_UNAVAILABLE", message);
}

/** Runs a scan job to its end (done, failed or cancelled). */
async function runScan(env, job, { source, secret, input, options }) {
  const { table, store, log } = env;
  const fail = (error) =>
    table.settle(job, "failed", {
      error: failureOf(error, { secret, log, kind: "scan" }),
    });
  const onProgress = (raw) => {
    if (job.state !== "running") return;
    job.progress = readProgress(raw, secret);
    table.announce(job);
  };
  const { signal } = job.controller;
  try {
    const module = await connectorFor(env, source);
    const raw = await module.scan({ ...input, options, signal, onProgress });
    if (job.state !== "running") return;
    const checked = validateSnapshot(redactDeep(raw, secret));
    if (!checked.ok) {
      const message = "The importer returned data Worklane cannot read";
      const { errors } = checked;
      return fail(new ImportError("INVALID_SNAPSHOT", message, { errors }));
    }
    // Activity labels and badges name the source, so it must be the one asked for.
    if (checked.snapshot.source !== source) {
      const message = `The ${source} importer returned ${checked.snapshot.source} data`;
      return fail(new ImportError("INVALID_SNAPSHOT", message));
    }
    const { snapshot } = checked;
    table.settle(job, "done", {
      snapshot,
      preview: preview(snapshot, { store, importerId: job.userId }),
      progress: readProgress({ phase: "done", message: "Scan finished" }),
    });
  } catch (error) {
    if (job.state !== "running") return;
    if (aborted(error, signal)) return table.settle(job, "cancelled");
    fail(error);
  }
}

/** Runs an import job to its end (done, failed or cancelled). */
async function runImport(env, job, { snapshot, plan }) {
  const { table, store, log } = env;
  const onProgress = (raw) => {
    job.progress = readProgress(raw);
    table.announce(job);
  };
  try {
    const { signal } = job.controller;
    const options = { store, importerId: job.userId, onProgress, signal, log };
    const report = await run(snapshot, plan, options);
    table.settle(job, report.cancelled ? "cancelled" : "done", { report });
  } catch (error) {
    const failure = failureOf(error, { secret: null, log, kind: "import" });
    table.settle(job, "failed", { error: failure });
  }
}

/**
 * Creates the registry. `store` is the Worklane store, `publish(userId,
 * payload)` sends an `event: import`, `connectors` overrides the
 * connector modules (`{ monday, clickup, files }`, each with `scan`), and
 * `now()` is the clock (epoch ms).
 */
export function createImportJobs({
  store,
  publish = () => {},
  connectors = null,
  log = console,
  now = () => Date.now(),
} = {}) {
  const table = createTable({ publish, log, now });
  const env = { table, store, log, connectors };
  const timer = setInterval(table.sweep, SWEEP_INTERVAL_MS);
  timer.unref?.();
  const own = (id, userId) => {
    table.sweep();
    const job = table.jobs.get(id);
    return job?.userId === userId ? job : null;
  };
  return {
    /** "busy_user" / "busy_server" when `userId` cannot start a job now. */
    busyReason: (userId) => table.busy(userId),
    /**
     * Starts a scan for `userId` of `source` ("monday" | "clickup" with
     * `token`, "csv" | "xlsx" with `file = { name, kind, bytes }`) and
     * connector `options`. → `{ ok: true, job }` (its view) or `{ ok:
     * false, reason: "busy_user" | "busy_server" }`.
     */
    startScan({ userId, source, token = null, file = null, options = {} }) {
      const reason = table.busy(userId);
      if (reason) return { ok: false, reason };
      const job = table.add("scan", userId);
      const input = token === null ? { file } : { token };
      void runScan(env, job, { source, secret: token, input, options });
      return { ok: true, job: viewOf(job) };
    },
    /**
     * Starts importing finished scan `scanJobId` of `userId` with `plan`.
     * → `{ ok: true, job }` or `{ ok: false, reason: "unknown_scan" |
     * "invalid_plan" | "busy_user" | "busy_server", errors? }`.
     */
    startImport({ userId, scanJobId, plan }) {
      const scanJob = own(scanJobId, userId);
      if (scanJob?.kind !== "scan" || scanJob.state !== "done")
        return { ok: false, reason: "unknown_scan" };
      const { snapshot } = scanJob;
      const checked = checkPlan(snapshot, plan, { store, importerId: userId });
      if (!checked.ok)
        return { ok: false, reason: "invalid_plan", errors: checked.errors };
      const reason = table.busy(userId);
      if (reason) return { ok: false, reason };
      const job = table.add("import", userId);
      void runImport(env, job, { snapshot, plan });
      return { ok: true, job: viewOf(job) };
    },
    /** The job's view for its creator, else null. */
    get(id, userId) {
      const job = own(id, userId);
      return job ? viewOf(job) : null;
    },
    /**
     * Cancels a running job of `userId`: a scan ends at once, an import
     * stops before its next board or doc. → the job's view, or null.
     */
    cancel(id, userId) {
      const job = own(id, userId);
      if (!job) return null;
      if (job.state === "running") {
        job.controller.abort();
        if (job.kind === "scan") table.settle(job, "cancelled");
      }
      return viewOf(job);
    },
    /** Aborts running jobs and forgets every job. */
    close() {
      clearInterval(timer);
      table.clear();
    },
  };
}
