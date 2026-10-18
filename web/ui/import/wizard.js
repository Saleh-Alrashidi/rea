/**
 * The import wizard's state machine (SPEC-4 §6): which step shows, which
 * jobs it follows and what each job report does. `transition(state,
 * event)` is pure and returns the next state, or the same object when the
 * event does not apply to the current step (late or foreign job events,
 * double clicks), so the page only renders states and sends events.
 *
 * Steps: source → scanning → review → importing → done. A failed or
 * cancelled scan goes back to the source step with its message; a failed
 * import goes back to the review (the scan's result is kept on the server
 * for 30 minutes, and an import refused because it expired goes back to
 * the source step); "Import more" starts over. "Back" on the review parks
 * the scan (`parked`), so the source step can return to it; a job the page
 * lost track of (a reload) is offered as `earlier` and can be adopted.
 *
 * Events:
 *   { type: "choose", source }              pick a source card
 *   { type: "submit" } / { type: "submit-failed", error }
 *                                           a scan or import request is in
 *                                           flight / was refused
 *   { type: "scan-started", jobId, label? } the scan job runs
 *   { type: "import-started", jobId }       the import job runs
 *   { type: "job", job }                    a job view (GET or SSE event)
 *   { type: "cancel-requested" }            Cancel was pressed
 *   { type: "cancel-failed" }               the cancel request failed
 *   { type: "gone", jobId }                 the job no longer exists (404)
 *   { type: "back" }                        review → source, scan parked
 *   { type: "resume" }                      source → the parked review
 *   { type: "earlier", job }                a job of this admin from before
 *                                           (a list entry; null clears it)
 *   { type: "adopt", job }                  follow that job (its full view)
 *   { type: "reset" }                       "Import more"
 */

export const STEPS = Object.freeze([
  { id: "source", label: "Choose source" },
  { id: "scanning", label: "Scan" },
  { id: "review", label: "Review" },
  { id: "importing", label: "Import" },
  { id: "done", label: "Done" },
]);

const TERMINAL = new Set(["done", "failed", "cancelled"]);

/** The wizard before anything was chosen (or after "Import more"). */
export function initialState(source = null) {
  return {
    step: "source",
    source,
    label: null,
    pending: false,
    scanJobId: null,
    importJobId: null,
    progress: null,
    cancelling: false,
    preview: null,
    report: null,
    error: null,
    notice: null,
    parked: null,
    earlier: null,
  };
}

/** The position of `step` in STEPS (0 for unknown steps). */
export function stepIndex(step) {
  return Math.max(
    0,
    STEPS.findIndex((entry) => entry.id === step),
  );
}

export const isTerminal = (jobState) => TERMINAL.has(jobState);

/**
 * Whether `job` ended but lacks what its end shows (an SSE event carries
 * no preview or report), so the full job must be read.
 */
export function needsDetails(job) {
  if (!job || !isTerminal(job.state)) return false;
  if (job.state === "failed") return !job.error;
  if (job.kind === "scan") return job.state === "done" && !job.preview;
  return !job.report;
}

const NOT_ANSWERING =
  "The source is not answering as expected right now. Try again later.";
const FRIENDLY = Object.freeze({
  INVALID_TOKEN:
    "The token was not accepted. Copy the whole token again and check that it is still active.",
  UPSTREAM_RATE_LIMITED:
    "The source kept limiting requests. Wait a few minutes, then scan again; lower scan limits need fewer requests.",
  UPSTREAM_HTTP: NOT_ANSWERING,
  UPSTREAM_UNREACHABLE: NOT_ANSWERING,
  UPSTREAM_TIMEOUT: NOT_ANSWERING,
  UPSTREAM_BAD_JSON: NOT_ANSWERING,
  UPSTREAM_TOO_LARGE:
    "The source sent more in one answer than Worklane reads. Lower the scan limits, then scan again.",
  RATE_LIMITED:
    "A scan or import of yours is still running. Follow it or cancel it, or try again when it ends.",
});

/** The message shown for a failed request or job (`{ code, message }`). */
export function describeError(error) {
  if (!error) return "";
  const code = typeof error.code === "string" ? error.code : "";
  if (Object.hasOwn(FRIENDLY, code)) return FRIENDLY[code];
  const message = typeof error.message === "string" ? error.message : "";
  return message || "Something went wrong.";
}

/** The server's own text when `describeError` shows another, else null. */
function detailOf(error) {
  const message = typeof error?.message === "string" ? error.message : "";
  return message && message !== describeError(error) ? message : null;
}

/**
 * A refused request (an `ApiError`: `.code`, `.message`, and `.details`
 * for an invalid plan's `[{ path, message }]`) as the wizard keeps it.
 */
export function requestFailure(error) {
  return {
    code: typeof error?.code === "string" ? error.code : undefined,
    message: typeof error?.message === "string" ? error.message : undefined,
    errors: Array.isArray(error?.details) ? error.details : null,
  };
}

/** The ID of the job the wizard waits for: the scan or the import. */
export function followedJob(state) {
  if (state.step === "scanning") return state.scanJobId;
  if (state.step === "importing") return state.importJobId;
  return null;
}

const errorOf = (error) => ({
  code: typeof error?.code === "string" ? error.code : "ERROR",
  message: describeError(error),
  detail: detailOf(error),
  errors: Array.isArray(error?.errors) ? error.errors : null,
});

function scanJob(state, job) {
  const next = { ...state, progress: job.progress ?? state.progress };
  if (job.state === "done") {
    if (!job.preview) return next;
    return { ...next, step: "review", preview: job.preview, cancelling: false };
  }
  if (job.state === "failed") {
    if (!job.error) return next;
    return { ...initialState(state.source), error: errorOf(job.error) };
  }
  if (job.state === "cancelled") {
    return { ...initialState(state.source), notice: "The scan was cancelled." };
  }
  return next;
}

function importJob(state, job) {
  const next = { ...state, progress: job.progress ?? state.progress };
  if (job.state === "done" || job.state === "cancelled") {
    if (!job.report) return next;
    return { ...next, step: "done", report: job.report, cancelling: false };
  }
  if (job.state === "failed") {
    if (!job.error) return next;
    return {
      ...next,
      step: "review",
      importJobId: null,
      progress: null,
      cancelling: false,
      error: errorOf(job.error),
    };
  }
  return next;
}

function onJob(state, job) {
  if (!job || typeof job.id !== "string") return state;
  if (state.step === "scanning" && job.id === state.scanJobId) {
    return scanJob(state, job);
  }
  if (state.step === "importing" && job.id === state.importJobId) {
    return importJob(state, job);
  }
  return state;
}

const EXPIRED = Object.freeze({
  scan: "This scan is no longer available (scans are kept for 30 minutes). Scan again to continue.",
  import:
    "The server no longer has this import (it may have restarted). Check the imported boards, then scan again.",
});

/** Back to the source step because the server lost the `kind` job. */
const expired = (state, kind) => ({
  ...initialState(state.source),
  error: {
    code: "EXPIRED",
    message: EXPIRED[kind],
    detail: null,
    errors: null,
  },
});

function onGone(state, jobId) {
  if (state.step === "source") {
    // A parked scan or an earlier job that expired is no longer offered.
    if (state.parked?.scanJobId === jobId) return { ...state, parked: null };
    if (state.earlier?.id === jobId) return { ...state, earlier: null };
    return state;
  }
  const followed = jobId === state.scanJobId || jobId === state.importJobId;
  if (!followed || state.step === "done") return state;
  return expired(state, jobId === state.importJobId ? "import" : "scan");
}

/** Review → source, keeping the scan to return to (see the module comment). */
function onBack(state) {
  if (state.step !== "review" || state.pending) return state;
  const { scanJobId, preview, source, label } = state;
  return { ...initialState(source), parked: { scanJobId, preview, label } };
}

function onResume(state) {
  const { parked } = state;
  if (state.step !== "source" || state.pending || !parked) return state;
  return {
    ...initialState(state.source),
    step: "review",
    scanJobId: parked.scanJobId,
    preview: parked.preview,
    label: parked.label,
  };
}

const quiet = (state) =>
  state.step === "source" && !state.pending && state.scanJobId === null;

/** What an adopted job (its full view) opens; the same state otherwise. */
function onAdopt(state, job) {
  if (!quiet(state) || typeof job?.id !== "string") return state;
  const base = { ...initialState(job.source ?? state.source) };
  if (job.kind === "scan" && job.state === "running")
    return {
      ...base,
      step: "scanning",
      scanJobId: job.id,
      progress: job.progress,
    };
  if (job.kind === "scan" && job.state === "done" && job.preview)
    return { ...base, step: "review", scanJobId: job.id, preview: job.preview };
  if (job.kind === "import" && job.state === "running")
    return {
      ...base,
      step: "importing",
      importJobId: job.id,
      progress: job.progress,
    };
  return { ...state, earlier: null };
}

function onSubmitFailed(state, error) {
  if (!state.pending) return state;
  // `POST /import/run` answers 404 once the scan expired.
  if (state.step === "review" && error?.code === "NOT_FOUND") {
    return expired(state, "scan");
  }
  return { ...state, pending: false, error: errorOf(error) };
}

const STARTS = Object.freeze({
  "scan-started": { from: "source", to: "scanning", key: "scanJobId" },
  "import-started": { from: "review", to: "importing", key: "importJobId" },
});

function onStarted(state, event) {
  const start = STARTS[event.type];
  if (state.step !== start.from || typeof event.jobId !== "string") {
    return state;
  }
  const next = {
    ...state,
    step: start.to,
    [start.key]: event.jobId,
    pending: false,
    cancelling: false,
    progress: { phase: "starting", done: null, total: null, message: null },
    error: null,
    notice: null,
    parked: null,
    earlier: null,
  };
  if (event.label) next.label = event.label;
  return next;
}

const HANDLERS = Object.freeze({
  choose: (state, event) =>
    state.step === "source" && !state.pending
      ? { ...state, source: event.source, error: null, notice: null }
      : state,
  submit: (state) =>
    state.step === "source" || state.step === "review"
      ? { ...state, pending: true, error: null, notice: null }
      : state,
  "submit-failed": (state, event) => onSubmitFailed(state, event.error),
  "scan-started": onStarted,
  "import-started": onStarted,
  job: (state, event) => onJob(state, event.job),
  "cancel-requested": (state) =>
    state.step === "scanning" || state.step === "importing"
      ? { ...state, cancelling: true }
      : state,
  "cancel-failed": (state) =>
    state.cancelling ? { ...state, cancelling: false } : state,
  gone: (state, event) => onGone(state, event.jobId),
  back: onBack,
  resume: onResume,
  earlier: (state, event) =>
    quiet(state) ? { ...state, earlier: event.job ?? null } : state,
  adopt: (state, event) => onAdopt(state, event.job),
  reset: (state) =>
    state.step === "done" ? initialState(state.source) : state,
});

/**
 * The state after `event` (see the module comment); unknown events and
 * events that do not apply return `state` itself.
 */
export function transition(state, event) {
  const handler = Object.hasOwn(HANDLERS, event?.type)
    ? HANDLERS[event.type]
    : null;
  return handler ? handler(state, event) : state;
}
