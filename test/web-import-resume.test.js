/**
 * Coming back to an import (SPEC-4 §6): "Back" on the review parks the
 * scan so the source step can return to it, a job from before a reload is
 * offered and followed (`wizard.js`), and the source step shows its
 * messages first: a failure gets focus, a rejected token marks the token
 * field, scan choices survive a failed scan and limits are checked before
 * anything is sent.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { sourceStep } from "../web/ui/import/source-step.js";
import * as W from "../web/ui/import/wizard.js";
import { fire } from "./fake-dom.js";
import { $, $$, installImportDom, recorder } from "./web-import-dom.js";

const SCAN = "s".repeat(22);
const IMPORT = "i".repeat(22);
const walk = (state, ...events) => events.reduce(W.transition, state);
const job = (id, kind, state, extra = {}) => ({ id, kind, state, ...extra });
const PREVIEW_STUB = { workspaces: [], users: [], targets: [], warnings: [] };

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

test("Back parks the scan; the source step returns to it until it expires", () => {
  const back = W.transition(reviewing(), { type: "back" });
  assert.equal(back.step, "source");
  assert.equal(back.preview, null);
  assert.deepEqual(back.parked, {
    scanJobId: SCAN,
    preview: PREVIEW_STUB,
    label: null,
  });
  const resumed = W.transition(back, { type: "resume" });
  assert.equal(resumed.step, "review");
  assert.equal(resumed.scanJobId, SCAN);
  assert.equal(resumed.preview, PREVIEW_STUB, "the same preview object");
  assert.equal(resumed.parked, null);
  const lost = W.transition(back, { type: "gone", jobId: SCAN });
  assert.equal(lost.parked, null, "an expired scan is no longer offered");
  assert.equal(W.transition(lost, { type: "resume" }), lost);
  const rescanned = walk(
    back,
    { type: "submit" },
    { type: "scan-started", jobId: "n".repeat(22) },
  );
  assert.equal(rescanned.parked, null, "a new scan replaces it");
});

test("a job from before a reload is offered, then followed when adopted", () => {
  const fresh = W.initialState();
  const entry = { id: SCAN, kind: "scan", source: "clickup", state: "running" };
  const offered = W.transition(fresh, { type: "earlier", job: entry });
  assert.equal(offered.earlier, entry);
  const followed = W.transition(offered, {
    type: "adopt",
    job: { ...entry, progress: { phase: "items", done: 1, total: 3 } },
  });
  assert.equal(followed.step, "scanning");
  assert.equal(followed.scanJobId, SCAN);
  assert.equal(followed.source, "clickup");
  assert.equal(W.followedJob(followed), SCAN);
  assert.equal(followed.earlier, null);
  const review = W.transition(offered, {
    type: "adopt",
    job: { ...entry, state: "done", preview: PREVIEW_STUB },
  });
  assert.deepEqual([review.step, review.preview], ["review", PREVIEW_STUB]);
  const imp = {
    id: IMPORT,
    kind: "import",
    source: "monday",
    state: "running",
  };
  const importingAgain = W.transition(offered, { type: "adopt", job: imp });
  assert.deepEqual(
    [importingAgain.step, importingAgain.importJobId],
    ["importing", IMPORT],
  );
  const ended = W.transition(offered, {
    type: "adopt",
    job: { ...entry, state: "cancelled" },
  });
  assert.deepEqual([ended.step, ended.earlier], ["source", null]);
  assert.equal(
    W.transition(scanning(), { type: "earlier", job: entry }).earlier,
    null,
  );
  assert.equal(
    W.transition(scanning(), { type: "adopt", job: imp }).step,
    "scanning",
    "only a quiet source step adopts",
  );
  const cleared = W.transition(offered, { type: "earlier", job: null });
  assert.equal(cleared.earlier, null);
});

/** A source step for `state` with recorded callbacks and shared choices. */
function step(t, state, choices = {}) {
  const doc = installImportDom(t);
  const calls = {
    scan: recorder(),
    resume: recorder(),
    follow: recorder(),
    cancel: recorder(),
  };
  const view = sourceStep({
    state,
    choices,
    onChoose: recorder(),
    onScanToken: calls.scan,
    onScanFile: recorder(),
    onResume: () => calls.resume("resume"),
    onFollow: () => calls.follow("follow"),
    onCancelEarlier: () => calls.cancel("cancel"),
  });
  doc.body.append(view.element);
  return { view, calls, doc };
}

test("a failed scan's message comes first, is focused and marks a rejected token", (t) => {
  const error = {
    code: "INVALID_TOKEN",
    message: "The token was not accepted.",
    detail: "monday.com rejected the API token (HTTP 401)",
  };
  const { view } = step(t, { ...W.initialState("monday"), error });
  const kids = view.element.childNodes.filter((node) => node.localName);
  assert.equal(kids[0].id, "import-step-title");
  assert.ok(
    kids[1].className.includes("import-banner-slot"),
    "under the heading",
  );
  const banner = $(view.element, "div.import-banner");
  assert.equal(view.focusTarget, banner);
  assert.equal(banner.getAttribute("tabindex"), "-1");
  assert.match(banner.textContent, /HTTP 401/, "the server's detail too");
  const token = $(view.element, "input.import-token");
  assert.equal(token.getAttribute("aria-invalid"), "true");
  assert.equal(
    $(view.element, "p.import-field-error").textContent,
    "The token was not accepted.",
  );
});

test("scan choices survive a failed scan; limits are checked before a scan", (t) => {
  const choices = {};
  const first = step(t, W.initialState("monday"), choices);
  const docs = $$(first.view.element, "label.import-check").find((check) =>
    check.textContent.startsWith("Docs"),
  );
  $(docs, "input").checked = false;
  fire($(docs, "input"), "change");
  const boards = $(first.view.element, 'input[id="import-limit-boards"]');
  boards.value = "0";
  fire(boards, "input");
  $(first.view.element, "input.import-token").value = "tok-abcdefgh";
  fire($(first.view.element, "form"), "submit");
  assert.equal(first.calls.scan.calls.length, 0, "no scan with a bad limit");
  assert.equal(boards.getAttribute("aria-invalid"), "true");
  assert.equal(first.doc.activeElement, boards, "the bad limit gets focus");
  const error = $(first.view.element, 'p[id="import-limit-boards-error"]');
  assert.equal(error.hidden, false);
  assert.match(error.textContent, /whole number from 1 to 200/);
  boards.value = "200";
  fire(boards, "input");
  fire($(first.view.element, "form"), "submit");
  assert.deepEqual(first.calls.scan.calls, [
    {
      token: "tok-abcdefgh",
      options: { include_docs: false, limits: { boards: 200 } },
    },
  ]);
  assert.equal(boards.getAttribute("aria-invalid"), "false");
  // The scan failed: the step is built again from the same choices.
  const failed = { ...W.initialState("monday"), error: { message: "No" } };
  const again = step(t, failed, choices);
  const docsAgain = $$(again.view.element, "label.import-check").find((check) =>
    check.textContent.startsWith("Docs"),
  );
  assert.equal($(docsAgain, "input").checked, false, "Docs stays off");
  assert.equal(
    $(again.view.element, 'input[id="import-limit-boards"]').value,
    "200",
  );
  assert.equal(
    $(again.view.element, "details.import-limits").hasAttribute("open"),
    true,
  );
  assert.equal(
    $(again.view.element, "input.import-token").value,
    "",
    "never the token",
  );
  assert.ok(!JSON.stringify(choices).includes("tok-"), "choices hold no token");
});

test("a parked review and a job from before are offered on the source step", (t) => {
  const parked = W.transition(
    {
      ...reviewing(),
      preview: { ...PREVIEW_STUB, source_label: "monday.com account Acme" },
    },
    { type: "back" },
  );
  const { view, calls } = step(t, parked);
  const offer = $(view.element, "div.import-banner");
  assert.match(
    offer.textContent,
    /Your scan of monday\.com account Acme is kept for 30 minutes/,
  );
  $(offer, "button").click();
  assert.deepEqual(calls.resume.calls, ["resume"]);
  const running = W.transition(W.initialState(), {
    type: "earlier",
    job: { id: SCAN, kind: "scan", source: "clickup", state: "running" },
  });
  view.update(running);
  const earlier = $(view.element, "div.import-banner");
  assert.match(
    earlier.textContent,
    /A scan from ClickUp that you started earlier is still running/,
  );
  const [follow, cancel] = $$(earlier, "button");
  follow.click();
  cancel.click();
  assert.deepEqual(
    [calls.follow.calls, calls.cancel.calls],
    [["follow"], ["cancel"]],
  );
  view.update(
    W.transition(W.initialState(), {
      type: "earlier",
      job: { id: SCAN, kind: "scan", source: "monday", state: "done" },
    }),
  );
  assert.match(
    $(view.element, "div.import-banner").textContent,
    /ready to review.*Return to the review/,
  );
});
