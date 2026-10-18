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
 * the source step); "Import more" starts over.
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
 *   { type: "back" }                        review → source
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

const FRIENDLY = Object.freeze({
  INVALID_TOKEN:
    "The token was not accepted. Copy the whole token again and check that it is still active.",
});

/** The message shown for a failed request or job (`{ code, message }`). */
export function describeError(error) {
  if (!error) return "";
  const code = typeof error.code === "string" ? error.code : "";
  if (Object.hasOwn(FRIENDLY, code)) return FRIENDLY[code];
  const message = typeof error.message === "string" ? error.message : "";
  return message || "Something went wrong.";
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
  error: { code: "EXPIRED", message: EXPIRED[kind], errors: null },
});

function onGone(state, jobId) {
  const followed = jobId === state.scanJobId || jobId === state.importJobId;
  if (!followed || state.step === "source" || state.step === "done") {
    return state;
  }
  return expired(state, jobId === state.importJobId ? "import" : "scan");
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
  back: (state) =>
    state.step === "review" && !state.pending
      ? initialState(state.source)
      : state,
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
