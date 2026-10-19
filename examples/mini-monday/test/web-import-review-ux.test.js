/**
 * The review and done steps' guidance over the fake DOM (SPEC-4 §6.3,
 * §6.5): a scan cut by a limit says so first and its warnings lead, an
 * empty scan says what to check instead of offering Import, "Skip to
 * Import" jumps past the lists, target selects name their workspace, and
 * the done step collapses long lists and repeats its actions on top.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { doneStep } from "../web/ui/import/done-step.js";
import { createSelection } from "../web/ui/import/plan-model.js";
import { reviewStep } from "../web/ui/import/review-step.js";
import { warningsList } from "../web/ui/import/warnings-view.js";
import { initialState } from "../web/ui/import/wizard.js";
import {
  $,
  $$,
  VIEW_PREVIEW as PREVIEW,
  installImportDom,
  label,
  recorder,
} from "./web-import-dom.js";

const LIMIT = {
  code: "limit_boards",
  message: "Stopped at the scan limit of 200 boards; the rest was not read",
  path: "workspaces",
};

function review(t, preview) {
  const doc = installImportDom(t);
  const state = { ...initialState("monday"), step: "review", preview };
  const view = reviewStep({
    state,
    selection: createSelection(preview),
    people: [],
    onImport: recorder(),
    onBack: recorder(),
  });
  doc.body.append(view.element);
  return { view, doc };
}

test("a scan stopped at a limit says so first; its warnings lead and are open", (t) => {
  const preview = { ...PREVIEW, warnings: [...PREVIEW.warnings, LIMIT] };
  const { view } = review(t, preview);
  assert.match(
    $(view.element, "p.import-step-text").textContent,
    /\(the scan stopped at a limit\)\.$/,
  );
  const banner = $(view.element, "div.import-banner");
  assert.ok(banner.className.includes("banner-warning"));
  assert.match(
    banner.textContent,
    /stopped at a limit.*scan limit of 200 boards/,
  );
  const groups = $$(
    warningsList({ warnings: preview.warnings, preview }),
    "details",
  );
  assert.equal(
    $(groups[0], "span.import-warning-title").textContent,
    "Limit boards",
  );
  assert.equal(groups[0].hasAttribute("open"), true, "open by default");
  assert.equal(groups[1].hasAttribute("open"), false);
  assert.equal(
    $(groups[0], "code.import-warning-code").getAttribute("aria-hidden"),
    "true",
    "the code is not read twice",
  );
  const plain = review(t, PREVIEW).view;
  assert.doesNotMatch(
    $(plain.element, "p.import-step-text").textContent,
    /limit/,
  );
  assert.equal($(plain.element, "div.import-banner"), null);
});

test("an empty scan says what to check and makes Back the way on", (t) => {
  const empty = {
    ...PREVIEW,
    totals: { workspaces: 0, boards: 0, items: 0, docs: 0, users: 0 },
    workspaces: [],
    users: [],
    warnings: [],
  };
  const { view, doc } = review(t, empty);
  assert.match(
    $(view.element, "div.import-review-empty").textContent,
    /found no boards or docs.*archived boards are skipped/,
  );
  assert.equal($(view.element, "div.import-tree-tools"), null, "no Select all");
  assert.equal($(view.element, "button.import-run").hidden, true);
  assert.equal(
    $(view.element, "p.import-summary").textContent,
    "There is nothing to import from this scan.",
  );
  const skip = $(view.element, "button.import-skip");
  assert.equal(label(skip), "Skip to Back");
  skip.click();
  assert.equal(label(doc.activeElement), "Back");
  assert.ok(doc.activeElement.className.includes("btn-primary"));
});

test("Skip to Import jumps past the lists; targets name their workspace", (t) => {
  const { view, doc } = review(t, PREVIEW);
  const skip = $(view.element, "button.import-skip");
  const kids = view.element.childNodes.filter((node) => node.localName);
  assert.equal(kids[1], skip, "right after the heading");
  skip.click();
  assert.equal(doc.activeElement, $(view.element, "button.import-run"));
  assert.equal(
    $(view.element, "select.import-target").getAttribute("aria-label"),
    "Import “Acme” into",
  );
});

test("the done step collapses long lists and repeats its actions on top", (t) => {
  installImportDom(t);
  const links = Array.from({ length: 12 }, (_, n) => ({
    kind: "board",
    id: String(n + 1),
    url: `#/boards/${n + 1}`,
    title: `A long board name number ${n + 1}`,
  }));
  const skipped = Array.from({ length: 10 }, (_, n) => ({
    kind: "board",
    name: `Board ${n}`,
    reason: "cancelled",
    path: `workspaces[0].boards[${n}]`,
  }));
  const report = {
    created: { workspaces: 1, boards: 12, items: 40, docs: 0 },
    links,
    skipped,
    warnings: [],
    cancelled: true,
  };
  const view = doneStep({
    state: {
      ...initialState("monday"),
      step: "done",
      report,
      preview: PREVIEW,
    },
    onMore: recorder(),
  });
  const shown = $$(view.element, "a.import-link").filter(
    (a) => !a.parentNode.hidden,
  );
  assert.equal(shown.length, 5, "the first five of twelve");
  assert.equal(shown[0].getAttribute("title"), "A long board name number 1");
  const toggles = $$(view.element, "button.import-entries-toggle");
  assert.deepEqual(toggles.map(label), ["Show all 12", "Show all 10"]);
  toggles[0].click();
  assert.equal(
    $$(view.element, "a.import-link").filter((a) => !a.parentNode.hidden)
      .length,
    12,
  );
  const more = $$(view.element, "button").filter(
    (b) => label(b) === "Import more",
  );
  assert.equal(more.length, 2, "under the summary and at the end");
  const tiles = $$(view.element, "li.import-tile").map(
    (tile) => $(tile, "span.stat-label").textContent,
  );
  assert.equal(tiles[0], "Space", "one Space is singular");
});
