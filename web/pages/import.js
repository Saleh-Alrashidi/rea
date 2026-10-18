/**
 * Import (`#/import`, SPEC-4 §6): the wizard that brings a monday.com or
 * ClickUp account, a CSV file or a monday Excel export into Worklane —
 * choose source, scan, review, import, done. For users with the
 * `import_data` capability (admins); the server checks it on every
 * import route (`server/access.js`), the page only hides itself.
 *
 * The wizard's state machine is `ui/import/wizard.js`; this page sends it
 * events (user actions, job reports) and draws its steps. Jobs are
 * followed live through the `stream=me` `event: import` messages with a
 * polling fallback (`ui/import/job-watch.js`).
 *
 * The wizard of this tab lives in a module-scope session (never storage)
 * that outlives the page: coming back — the browser's Back button from an
 * imported board, say — shows the same step and follows a running job,
 * and a scan or import request still in flight when the page was left
 * lands in it. The source token is never part of it: it lives only in the
 * scan request (`ui/import/source-step.js`).
 */

import { h } from "../dom.js";
import { homeHash } from "../router.js";
import { loadDirectory } from "../ui/components/directory.js";
import { emptyState } from "../ui/components/empty-state.js";
import { pageHeader, setDocumentTitle } from "../ui/components/page-header.js";
import { can } from "../ui/components/permissions.js";
import { doneStep } from "../ui/import/done-step.js";
import {
  cancelJob,
  getJob,
  runImport,
  scanFile,
  scanWithToken,
  subscribeImportEvents,
} from "../ui/import/import-api.js";
import { watchJob } from "../ui/import/job-watch.js";
import { createSelection, toPlan } from "../ui/import/plan-model.js";
import { progressStep } from "../ui/import/progress-step.js";
import { reviewStep } from "../ui/import/review-step.js";
import { sourceStep } from "../ui/import/source-step.js";
import { formatBytes } from "../ui/import/sources.js";
import { stepper } from "../ui/import/step-parts.js";
import {
  followedJob,
  initialState,
  requestFailure,
  transition,
} from "../ui/import/wizard.js";
import { adminTabs } from "./admin.js";

/**
 * `{ state, selection, people, page }`: the wizard, the review's choices
 * (`plan-model.js`), the Worklane users offered as matches (null until
 * loaded) and the mounted page, if any.
 */
let session = null;

function adminsOnly() {
  return h(
    "div",
    { class: "page-container" },
    emptyState({
      icon: "admin",
      headingLevel: 1,
      title: "Only admins can import",
      text: "Ask an admin to bring boards from monday.com, ClickUp or a spreadsheet into Worklane.",
      action: { label: "Go to Home", icon: "home", href: homeHash() },
    }),
  );
}

/** Applies `event` to session `s` and redraws its page, if shown. */
function dispatch(s, event) {
  const previous = s.state;
  const next = transition(previous, event);
  if (next === previous) return;
  s.state = next;
  if (next.preview !== previous.preview) {
    // A new scan: new choices, and invites may have added people.
    s.selection = next.preview ? createSelection(next.preview) : null;
    s.people = null;
  }
  s.page?.render();
}

// ------------------------------------------------------------- actions

function startScan(s, request, label) {
  dispatch(s, { type: "submit" });
  request.then(
    (jobId) => dispatch(s, { type: "scan-started", jobId, label }),
    (error) =>
      dispatch(s, { type: "submit-failed", error: requestFailure(error) }),
  );
}

const actions = {
  choose: (s, source) => dispatch(s, { type: "choose", source }),
  scanToken(s, { token, options }) {
    const { source } = s.state;
    // The request holds the token from here on; the field is cleared next.
    const request = scanWithToken({ source, token, options });
    // The heading names the source already.
    startScan(s, request, null);
  },
  scanFile(s, { file, kind }) {
    const label = `${file.name} · ${formatBytes(file.size)}`;
    startScan(s, scanFile({ file, kind }), label);
  },
  cancel(s, toast) {
    const jobId = followedJob(s.state);
    if (!jobId) return;
    dispatch(s, { type: "cancel-requested" });
    cancelJob(jobId).then(
      (job) => dispatch(s, { type: "job", job }),
      (error) => {
        if (error?.status === 404) {
          dispatch(s, { type: "gone", jobId });
          return;
        }
        dispatch(s, { type: "cancel-failed" });
        toast.error(error, "Couldn’t cancel");
      },
    );
  },
  run(s) {
    const { preview, scanJobId } = s.state;
    const plan = toPlan(s.selection, preview);
    dispatch(s, { type: "submit" });
    runImport({ scanJobId, plan }).then(
      (jobId) => dispatch(s, { type: "import-started", jobId }),
      (error) =>
        dispatch(s, { type: "submit-failed", error: requestFailure(error) }),
    );
  },
  back: (s) => dispatch(s, { type: "back" }),
  more: (s) => dispatch(s, { type: "reset" }),
};

// ------------------------------------------------------------ following

/** Watches the job the wizard waits for (none, or a new one: restart). */
function follow(p) {
  const jobId = followedJob(p.s.state);
  if (p.watcher && p.watcher.jobId === jobId && !p.watcher.stopped) return;
  p.watcher?.stop();
  p.watcher = null;
  if (!jobId) return;
  const watch = watchJob({
    jobId,
    getJob,
    onJob: (job) => dispatch(p.s, { type: "job", job }),
    onGone: (id) => dispatch(p.s, { type: "gone", jobId: id }),
  });
  p.watcher = Object.assign(watch, { jobId });
}

/** A review shown again needs its scan to still exist on the server. */
function checkScan(p) {
  const { scanJobId } = p.s.state;
  getJob(scanJobId).catch((error) => {
    if (error?.status === 404) {
      dispatch(p.s, { type: "gone", jobId: scanJobId });
    }
  });
}

/** The Worklane users offered as matches (only proposals if unavailable). */
function loadPeople(p) {
  if (p.loadingPeople) return;
  p.loadingPeople = true;
  const { s } = p;
  loadDirectory({ refresh: true })
    .then(
      (directory) => directory.userList,
      () => [],
    )
    .then((people) => {
      p.loadingPeople = false;
      if (s.people === null) s.people = people;
      if (p.active) p.render();
    });
}

// ------------------------------------------------------------- drawing

function buildView(p) {
  const { s } = p;
  const { state } = s;
  if (state.step === "source") {
    return sourceStep({
      state,
      onChoose: (source) => actions.choose(s, source),
      onScanToken: (input) => actions.scanToken(s, input),
      onScanFile: (input) => actions.scanFile(s, input),
    });
  }
  if (state.step === "scanning" || state.step === "importing") {
    return progressStep({
      state,
      kind: state.step === "scanning" ? "scan" : "import",
      onCancel: () => actions.cancel(s, p.ctx.toast),
    });
  }
  if (state.step === "review") {
    return reviewStep({
      state,
      selection: s.selection,
      people: s.people,
      onImport: () => actions.run(s),
      onBack: () => actions.back(s),
    });
  }
  return doneStep({ state, onMore: () => actions.more(s) });
}

/**
 * Draws the current step: updates the shown one in place, or builds the
 * next and moves focus to its heading (not on the first draw, so the
 * page's own focus handling stays in charge on navigation).
 */
function render(p) {
  const { state } = p.s;
  follow(p);
  if (state.step === p.drawn) {
    p.view?.update?.(state);
    return;
  }
  if (state.step === "review" && p.s.people === null) {
    loadPeople(p);
    return;
  }
  const first = p.drawn === null;
  // The `import_finished` notification announces the end; the sidebar
  // lists the new workspaces after a refresh.
  if (state.step === "done" && !first) void p.ctx.refreshShell();
  p.view = buildView(p);
  p.drawn = state.step;
  p.stepperSlot.replaceChildren(stepper(state.step));
  p.body.replaceChildren(p.view.element);
  if (!first) p.view.focusTarget?.focus();
}

function loadingView() {
  return emptyState({
    icon: "inbox",
    title: "Loading the import…",
    busy: true,
  });
}

/** Page contract. */
export async function mount(container, ctx) {
  setDocumentTitle("Import");
  if (!can(ctx.me, "import_data")) {
    container.append(adminsOnly());
    return undefined;
  }
  session ??= { state: initialState(), selection: null, people: null };
  const p = {
    ctx,
    s: session,
    view: null,
    drawn: null,
    watcher: null,
    loadingPeople: false,
    active: true,
  };
  p.render = () => render(p);
  session.page = p;
  p.stepperSlot = h("div", { class: "import-stepper" });
  p.body = h("div", { class: "import-body" }, loadingView());
  const closeEvents = subscribeImportEvents((event) => p.watcher?.push(event));
  container.append(
    h(
      "div",
      { class: "page-container import-page" },
      pageHeader({
        title: "Import",
        icon: "inbox",
        subtitle:
          "Bring boards, items, people and docs from monday.com, ClickUp or a spreadsheet",
      }),
      h("div", { class: "page-toolbar" }, adminTabs(ctx.me, "import")),
      p.stepperSlot,
      p.body,
    ),
  );
  if (session.state.step === "review") checkScan(p);
  p.render();
  return () => {
    p.active = false;
    p.watcher?.stop();
    closeEvents();
    const { s } = p;
    if (s.page === p) s.page = null;
    const { step, pending } = s.state;
    // The source step holds nothing worth keeping (and never the token),
    // unless a scan request is still on its way.
    if (session === s && step === "source" && !pending) session = null;
  };
}
