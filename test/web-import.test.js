/**
 * The import wizard's state machine and the review's mapping model
 * (SPEC-4 §6, `web/ui/import/wizard.js`, `plan-model.js`): every step and
 * job outcome, the selection and the plan it sends, which the server's
 * own `checkPlan` accepts over a real preview.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { preview } from "../server/import/engine.js";
import { checkPlan } from "../server/import/plan.js";
import { validateSnapshot } from "../server/import/snapshot.js";
import * as M from "../web/ui/import/plan-model.js";
import * as W from "../web/ui/import/wizard.js";
import { sampleSnapshot, seededStore } from "./import-engine-fixtures.js";
import { PREVIEW } from "./web-import-fixtures.js";

const SCAN = "s".repeat(22);
const IMPORT = "i".repeat(22);
const walk = (state, ...events) => events.reduce(W.transition, state);
const job = (id, kind, state, extra = {}) => ({ id, kind, state, ...extra });
const PREVIEW_STUB = { workspaces: [], users: [], targets: [], warnings: [] };
const REPORT = { created: { boards: 1 }, skipped: [], warnings: [], links: [] };

const scanning = () =>
  walk(
    W.initialState(),
    { type: "choose", source: "monday" },
    { type: "submit" },
    { type: "scan-started", jobId: SCAN },
  );
const reviewing = () =>
  W.transition(scanning(), {
    type: "job",
    job: job(SCAN, "scan", "done", { preview: PREVIEW_STUB }),
  });
const importing = () =>
  walk(
    reviewing(),
    { type: "submit" },
    { type: "import-started", jobId: IMPORT },
  );

// ------------------------------------------------------------- wizard

test("the wizard walks source, scanning, review, importing and done", () => {
  let state = W.initialState();
  assert.equal(state.step, "source");
  state = W.transition(state, { type: "choose", source: "clickup" });
  assert.equal(state.source, "clickup");
  state = W.transition(state, { type: "submit" });
  assert.equal(state.pending, true);
  state = W.transition(state, {
    type: "scan-started",
    jobId: SCAN,
    label: "a.csv",
  });
  assert.equal(state.step, "scanning");
  assert.equal(state.pending, false);
  assert.equal(state.label, "a.csv");
  assert.equal(state.progress.phase, "starting");
  assert.equal(W.followedJob(state), SCAN);
  const progress = { phase: "items", done: 1, total: 4, message: null };
  state = W.transition(state, {
    type: "job",
    job: job(SCAN, "scan", "running", { progress }),
  });
  assert.equal(state.progress, progress);
  // An SSE end carries no preview: the step waits for the full job.
  const bare = job(SCAN, "scan", "done");
  assert.equal(W.needsDetails(bare), true);
  assert.equal(
    W.transition(state, { type: "job", job: bare }).step,
    "scanning",
  );
  const full = job(SCAN, "scan", "done", { preview: PREVIEW_STUB });
  state = W.transition(state, { type: "job", job: full });
  assert.equal(state.step, "review");
  assert.equal(state.preview, PREVIEW_STUB);
  assert.equal(W.followedJob(state), null);
  state = walk(
    state,
    { type: "submit" },
    { type: "import-started", jobId: IMPORT },
  );
  assert.equal(state.step, "importing");
  assert.equal(W.followedJob(state), IMPORT);
  state = W.transition(state, {
    type: "job",
    job: job(IMPORT, "import", "done", { report: REPORT }),
  });
  assert.equal(state.step, "done");
  assert.equal(state.report, REPORT);
  state = W.transition(state, { type: "reset" });
  assert.deepEqual(state, W.initialState("clickup"));
  assert.deepEqual(
    W.STEPS.map((entry) => W.stepIndex(entry.id)),
    [0, 1, 2, 3, 4],
  );
  assert.equal(W.stepIndex("nope"), 0);
});

test("late, foreign and repeated events return the same state object", () => {
  const scan = scanning();
  const cases = [
    [scan, { type: "job", job: job(IMPORT, "import", "done") }],
    [scan, { type: "job", job: { state: "done" } }],
    [scan, { type: "scan-started", jobId: "other" }],
    [scan, { type: "choose", source: "csv" }],
    [scan, { type: "back" }],
    [scan, { type: "reset" }],
    [scan, { type: "submit-failed", error: { message: "x" } }],
    [scan, { type: "nope" }],
    [scan, null],
    [W.initialState(), { type: "scan-started", jobId: 42 }],
    [W.initialState(), { type: "cancel-requested" }],
    [W.initialState(), { type: "cancel-failed" }],
    [reviewing(), { type: "job", job: job(SCAN, "scan", "done") }],
    [importing(), { type: "submit" }],
    [
      walk(W.initialState(), { type: "submit" }),
      { type: "choose", source: "csv" },
    ],
    [walk(reviewing(), { type: "submit" }), { type: "back" }],
  ];
  for (const [state, event] of cases) {
    assert.equal(W.transition(state, event), state, JSON.stringify(event));
  }
});

test("failed and cancelled scans go back to the source step with a message", () => {
  const failed = W.transition(scanning(), {
    type: "job",
    job: job(SCAN, "scan", "failed", {
      error: { code: "INVALID_TOKEN", message: "HTTP 401" },
    }),
  });
  assert.equal(failed.step, "source");
  assert.equal(failed.source, "monday", "the chosen source stays");
  assert.equal(failed.scanJobId, null);
  assert.match(failed.error.message, /token was not accepted/);
  const waiting = W.transition(scanning(), {
    type: "job",
    job: job(SCAN, "scan", "failed"),
  });
  assert.equal(waiting.step, "scanning", "a failure without its error waits");
  const cancelled = W.transition(scanning(), {
    type: "job",
    job: job(SCAN, "scan", "cancelled"),
  });
  assert.equal(cancelled.step, "source");
  assert.equal(cancelled.notice, "The scan was cancelled.");
  const refused = walk(
    W.initialState("monday"),
    { type: "submit" },
    {
      type: "submit-failed",
      error: {
        code: "RATE_LIMITED",
        message: "You already have an import job running",
      },
    },
  );
  assert.equal(refused.pending, false);
  assert.match(
    refused.error.message,
    /^A scan or import of yours is still running/,
  );
  assert.equal(
    refused.error.detail,
    "You already have an import job running",
    "the server's own text stays as the detail",
  );
  const unreachable = W.transition(scanning(), {
    type: "job",
    job: job(SCAN, "scan", "failed", {
      error: {
        code: "UPSTREAM_RATE_LIMITED",
        message: "monday.com was still rate limiting after 5 attempts",
      },
    }),
  });
  assert.match(
    unreachable.error.message,
    /^The source kept limiting requests\. Wait a few minutes/,
  );
  assert.equal(
    unreachable.error.detail,
    "monday.com was still rate limiting after 5 attempts",
  );
  assert.equal(failed.error.detail, "HTTP 401");
  const plain = W.transition(scanning(), {
    type: "job",
    job: job(SCAN, "scan", "failed", {
      error: { code: "X", message: "Exact" },
    }),
  });
  assert.equal(plain.error.detail, null, "no detail when the text is shown");
});

test("imports that fail return to the source step; stopped ones show their report", () => {
  const failed = W.transition(importing(), {
    type: "job",
    job: job(IMPORT, "import", "failed", {
      error: { code: "IMPORT_FAILED", message: "The import failed" },
    }),
  });
  assert.equal(failed.step, "source", "its scan cannot be imported again");
  assert.deepEqual(
    [failed.source, failed.importJobId, failed.scanJobId, failed.preview],
    ["monday", null, null, null],
  );
  assert.equal(failed.error.message, "The import failed");
  const stopped = { ...REPORT, cancelled: true };
  const done = W.transition(importing(), {
    type: "job",
    job: job(IMPORT, "import", "cancelled", { report: stopped }),
  });
  assert.equal(done.step, "done");
  assert.equal(done.report, stopped);
  const invalid = walk(
    reviewing(),
    { type: "submit" },
    {
      type: "submit-failed",
      error: W.requestFailure(
        Object.assign(new Error("The import plan is not valid"), {
          code: "BAD_REQUEST",
          details: [{ path: 'plan.users["u1"]', message: "No email" }],
        }),
      ),
    },
  );
  assert.equal(invalid.step, "review");
  assert.deepEqual(invalid.error.errors, [
    { path: 'plan.users["u1"]', message: "No email" },
  ]);
});

test("a scan imported before follows that import to its report", () => {
  const refused = W.requestFailure(
    Object.assign(new Error("This scan was already imported"), {
      code: "ALREADY_IMPORTED",
      importJobId: IMPORT,
    }),
  );
  assert.equal(refused.importJobId, IMPORT);
  const following = walk(
    reviewing(),
    { type: "submit" },
    { type: "submit-failed", error: refused },
  );
  assert.deepEqual(
    [following.step, following.importJobId, following.pending, following.error],
    ["importing", IMPORT, false, null],
  );
  assert.equal(W.followedJob(following), IMPORT);
  const running = W.transition(following, {
    type: "job",
    job: job(IMPORT, "import", "running", { progress: { phase: "boards" } }),
  });
  assert.equal(running.progress.phase, "boards", "its progress shows");
  const done = W.transition(running, {
    type: "job",
    job: job(IMPORT, "import", "done", { report: REPORT }),
  });
  assert.deepEqual([done.step, done.report], ["done", REPORT]);
  const nameless = walk(
    reviewing(),
    { type: "submit" },
    {
      type: "submit-failed",
      error: {
        code: "ALREADY_IMPORTED",
        message: "Imported",
        importJobId: null,
      },
    },
  );
  assert.deepEqual(
    [nameless.step, nameless.error.message],
    ["review", "Imported"],
    "without a job to follow, the review shows the refusal",
  );
});

test("jobs the server lost and expired scans go back to the source step", () => {
  const lostScan = W.transition(scanning(), { type: "gone", jobId: SCAN });
  assert.equal(lostScan.step, "source");
  assert.equal(lostScan.error.code, "EXPIRED");
  assert.match(lostScan.error.message, /30 minutes/);
  const lostImport = W.transition(importing(), { type: "gone", jobId: IMPORT });
  assert.match(lostImport.error.message, /no longer has this import/);
  const shownReview = W.transition(reviewing(), { type: "gone", jobId: SCAN });
  assert.equal(shownReview.step, "source", "a kept review whose scan expired");
  const expired = walk(
    reviewing(),
    { type: "submit" },
    { type: "submit-failed", error: { code: "NOT_FOUND", message: "Unknown" } },
  );
  assert.equal(expired.step, "source");
  assert.match(expired.error.message, /Scan again/);
  assert.equal(
    W.transition(scanning(), { type: "gone", jobId: "x" }).step,
    "scanning",
  );
});

test("Cancel marks the job as stopping until it ends or the request fails", () => {
  const asked = W.transition(importing(), { type: "cancel-requested" });
  assert.equal(asked.cancelling, true);
  assert.equal(
    W.transition(asked, { type: "cancel-failed" }).cancelling,
    false,
  );
  const ended = W.transition(asked, {
    type: "job",
    job: job(IMPORT, "import", "done", { report: REPORT }),
  });
  assert.equal(ended.cancelling, false);
});

test("error messages, request failures and job details", () => {
  assert.equal(W.describeError(null), "");
  assert.match(
    W.describeError({ code: "INVALID_TOKEN" }),
    /Copy the whole token/,
  );
  assert.equal(W.describeError({ code: "X", message: "Exact" }), "Exact");
  assert.equal(W.describeError({ code: "X" }), "Something went wrong.");
  assert.deepEqual(
    W.requestFailure({ code: "A", message: "B", details: "no" }),
    {
      code: "A",
      message: "B",
      errors: null,
      importJobId: null,
    },
  );
  assert.equal(W.needsDetails(job(SCAN, "scan", "running")), false);
  assert.equal(W.needsDetails(job(SCAN, "scan", "failed")), true);
  assert.equal(W.needsDetails(job(SCAN, "scan", "cancelled")), false);
  assert.equal(W.needsDetails(job(IMPORT, "import", "cancelled")), true);
  assert.equal(
    W.needsDetails(job(IMPORT, "import", "done", { report: REPORT })),
    false,
  );
  assert.equal(W.isTerminal("running"), false);
});

// --------------------------------------------------------- plan model

const [ACME, ARCHIVE] = PREVIEW.workspaces;

test("the selection starts from the preview and becomes an explicit plan", () => {
  const selection = M.createSelection(PREVIEW);
  assert.deepEqual([...selection.boards], ["b1", "b3"]);
  assert.deepEqual([...selection.docs], ["d1"]);
  assert.equal(M.workspaceState(selection, ACME), "some");
  M.setWorkspace(selection, ACME, true);
  assert.equal(M.workspaceState(selection, ACME), "all");
  M.setEntry(selection, { kind: "boards", id: "b1", on: false });
  M.setAll(selection, PREVIEW, false);
  assert.equal(M.workspaceState(selection, ACME), "none");
  M.setAll(selection, PREVIEW, true);
  M.setEntry(selection, { kind: "boards", id: "b2", on: false });
  selection.targets.set("w1", "7");
  selection.users.set("u2", "invite:viewer");
  assert.deepEqual(M.toPlan(selection, PREVIEW), {
    users: { u1: "match:2", u2: "invite:viewer", u3: "skip" },
    workspace_map: { w1: "7", w2: "7" },
    include: { boards: ["b1", "b3"], docs: ["d1"] },
  });
  assert.equal(M.actionKind("match:9"), "match");
  assert.equal(M.actionKind("invite:guest"), "invite");
  assert.equal(M.actionKind(undefined), "skip");
});

test("each person's choices: the proposal first, invites need an email", () => {
  const people = [
    { id: "2", name: "Sam Lee", email: "sam@x.test", status: "active" },
    { id: "3", name: "Noa", email: null, status: "active" },
    { id: "9", name: "Morgan", email: "m@x.test", status: "deactivated" },
  ];
  const [first, invites, others] = M.userChoices(PREVIEW.users[0], people);
  assert.deepEqual(first.options, [
    { value: "match:2", label: "Match Sam Lee (sam@x.test)" },
    { value: "skip", label: "Skip (leave out)" },
  ]);
  assert.deepEqual(
    invites.options.map((option) => [option.value, Boolean(option.disabled)]),
    [
      ["invite:member", false],
      ["invite:viewer", false],
      ["invite:guest", false],
    ],
  );
  assert.deepEqual(others.options, [{ value: "match:3", label: "Noa" }]);
  const anon = M.userChoices(PREVIEW.users[2], []);
  assert.equal(anon.length, 2, "no other users, no match group");
  assert.equal(anon[0].options[0].value, "skip");
  assert.ok(anon[1].options.every((option) => option.disabled && option.title));
});

test("the people table filters, counts and sets everyone not matched", () => {
  const selection = M.createSelection(PREVIEW);
  assert.deepEqual(M.peopleCounts(PREVIEW, selection), {
    match: 1,
    invite: 0,
    skip: 2,
  });
  const changed = (action) =>
    M.applyToUnmatched(selection, PREVIEW, action).changed;
  assert.equal(changed("invite:member"), 1);
  assert.equal(selection.users.get("u3"), "skip", "no email, no invite");
  assert.equal(changed("invite:member"), 0);
  assert.equal(selection.users.get("u1"), "match:2", "matches stay");
  selection.users.set("u1", "skip");
  assert.equal(changed("invite:guest"), 2, "a dropped proposal counts too");
  M.chooseAction(selection, "u2", "invite:member");
  assert.deepEqual(
    M.applyToUnmatched(selection, PREVIEW, "invite:viewer"),
    { changed: 1, kept: 1 },
    "a choice made by hand stays",
  );
  assert.equal(selection.users.get("u2"), "invite:member");
  selection.users.set("u1", "match:2");
  const names = (options) =>
    M.filterPeople(PREVIEW, selection, options).map((user) => user.name);
  assert.deepEqual(names({ query: " NIA " }), ["Nia"]);
  assert.deepEqual(names({ query: "x.test" }), ["Sam", "Nia"]);
  assert.deepEqual(names({ show: "invite" }), ["Nia"]);
  assert.deepEqual(names({ show: "match" }), ["Sam"]);
  assert.deepEqual(names({ show: "skip" }), ["Anon"]);
  assert.equal(changed("skip"), 0, "Nia's invite was chosen by hand");
});

test("the summary sentence counts what the plan imports and where", () => {
  const selection = M.createSelection(PREVIEW);
  const summary = M.summarize(selection, PREVIEW);
  assert.equal(
    M.summaryText(summary),
    "Import 2 boards (3 items, 1 subitem and 2 updates) and 1 doc into 1 new Space and “Marketing”. People: 1 person matched and 2 skipped.",
  );
  M.setWorkspace(selection, ARCHIVE, false);
  M.setEntry(selection, { kind: "docs", id: "d1", on: false });
  selection.users.set("u2", "invite:guest");
  assert.equal(
    M.summaryText(M.summarize(selection, PREVIEW)),
    "Import 1 board (3 items, 1 subitem and 2 updates) into 1 new Space. People: 1 person matched, 1 invited and 1 skipped.",
  );
  M.setAll(selection, PREVIEW, false);
  const empty = M.summarize(selection, PREVIEW);
  assert.equal(empty.empty, true);
  assert.equal(
    M.summaryText(empty),
    "Choose at least one board or doc to import.",
  );
  assert.equal(M.joinList(["a"]), "a");
  assert.equal(M.joinList([]), "");
});

test("plans built from a real preview pass the server's plan check", async () => {
  const { store, ids } = await seededStore();
  const importerId = ids.users.alex;
  const snapshot = validateSnapshot(sampleSnapshot()).snapshot;
  const shown = preview(snapshot, { store, importerId });
  const selection = M.createSelection(shown);
  const options = { store, importerId };
  assert.deepEqual(
    checkPlan(snapshot, M.toPlan(selection, shown), options).errors,
    undefined,
  );
  // Every choice the table offers is one the server accepts.
  const people = store
    .listUsers()
    .map((user) => ({ ...user, id: String(user.id) }));
  for (const user of shown.users) {
    for (const group of M.userChoices(user, people)) {
      for (const option of group.options.filter((each) => !each.disabled)) {
        selection.users.set(user.source_id, option.value);
        const checked = checkPlan(
          snapshot,
          M.toPlan(selection, shown),
          options,
        );
        assert.ok(checked.ok, `${user.source_id} ${option.value}`);
      }
    }
    selection.users.set(user.source_id, "skip");
  }
  const [main] = shown.workspaces;
  selection.targets.set(main.source_id, String(shown.targets[0].id));
  M.setEntry(selection, {
    kind: "boards",
    id: main.boards[1].source_id,
    on: false,
  });
  const checked = checkPlan(snapshot, M.toPlan(selection, shown), options);
  assert.ok(checked.ok);
  assert.equal(
    checked.plan.targets.get(main.source_id).id,
    shown.targets[0].id,
  );
  assert.deepEqual(
    [...checked.plan.boards],
    [main.boards[0].source_id, "b-old"],
  );
});
