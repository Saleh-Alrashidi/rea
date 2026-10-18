/**
 * The importer's HTTP client (SPEC-4 §5): starting scans (a source token
 * or one file), reading and cancelling jobs, starting the import, and the
 * `event: import` messages of the user's `stream=me` stream. Requests go
 * through the app's `requestJson` (same-origin with the session cookie);
 * failures throw its `ApiError` (`.code`, `.status`, `.errors`; an invalid
 * plan's `extensions.errors` as `.details`), and a site session the gate
 * ended opens the sign-in page as everywhere else.
 *
 * The source token goes into one request body and nowhere else: it is
 * never stored, logged or kept by this module.
 */

import { ApiError, requestJson } from "../../api.js";

const SCAN_PATH = "/import/scan";
const RUN_PATH = "/import/run";
const EVENTS_PATH = "/v2/events?stream=me";
const JOB_ID = /^[\w-]{22}$/;

const isObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function jobPath(id, suffix = "") {
  if (typeof id !== "string" || !JOB_ID.test(id)) {
    throw new TypeError("Import job IDs are 22 URL-safe characters");
  }
  return `/import/jobs/${id}${suffix}`;
}

const jobIdOf = (result) => {
  if (typeof result.job_id !== "string") {
    throw new ApiError([{ message: "The server returned no job" }]);
  }
  return result.job_id;
};

/**
 * Starts a scan of monday.com or ClickUp with `token`. Resolves with the
 * job ID once the request is sent and answered; callers clear the token
 * field right after calling (the request already holds it).
 */
export async function scanWithToken({ source, token, options = {} }) {
  const body = { source, token, options };
  return jobIdOf(await requestJson(SCAN_PATH, { body }));
}

/**
 * Starts a scan of `file` (a Blob/File) as `kind` ("csv" | "xlsx"). The
 * name travels percent-encoded in `X-Import-Filename`.
 */
export async function scanFile({ file, kind, options = null }) {
  const headers = {
    "Content-Type": "application/octet-stream",
    "X-Import-Filename": encodeURIComponent(file.name),
    "X-Import-Kind": kind,
  };
  if (options && Object.keys(options).length > 0) {
    headers["X-Import-Options"] = JSON.stringify(options);
  }
  return jobIdOf(await requestJson(SCAN_PATH, { raw: file, headers }));
}

/** The job view `{ id, kind, state, progress, preview?, report?, error? }`. */
export const getJob = async (id) => requestJson(jobPath(id), { method: "GET" });

/** Cancels a running job; resolves with its view. */
export const cancelJob = async (id) => requestJson(jobPath(id, "/cancel"));

/** Starts importing scan `scanJobId` with `plan`; resolves with the job ID. */
export async function runImport({ scanJobId, plan }) {
  const body = { scan_job_id: scanJobId, plan };
  return jobIdOf(await requestJson(RUN_PATH, { body }));
}

/**
 * Subscribes to `event: import` messages (`{ job_id, kind, state,
 * progress }`) of the signed-in user. `onState(open)` reports whether
 * the stream is connected, so callers can poll while it is not. Returns
 * `close()`.
 */
export function subscribeImportEvents(onEvent, onState = () => {}) {
  const Source = globalThis.EventSource;
  if (typeof Source !== "function") {
    onState(false);
    return () => {};
  }
  const source = new Source(EVENTS_PATH);
  source.addEventListener("open", () => onState(true));
  source.addEventListener("error", () => onState(false));
  source.addEventListener("import", (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    if (isObject(payload) && typeof payload.job_id === "string") {
      onEvent(payload);
    }
  });
  return () => source.close();
}
