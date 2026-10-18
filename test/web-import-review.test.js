/**
 * The import wizard's last steps and entry points over the fake DOM
 * (SPEC-4 §6): Import is blocked without content, warnings are grouped
 * with their places, the done step links only in-app pages and downloads
 * the warnings through a revoked Blob URL, the stepper and the board
 * badge, the icons the import data names, the `#/import` route and the
 * Admin tab that links to it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { adminTabs } from "../web/pages/admin.js";
import { APP_ROUTES, compilePattern, importHash } from "../web/router.js";
import { ICON_NAMES } from "../web/ui/components/icon.js";
import { doneStep, downloadText } from "../web/ui/import/done-step.js";
import { importBadge } from "../web/ui/import/import-badge.js";
import { createSelection } from "../web/ui/import/plan-model.js";
import { createdTiles, linkSections } from "../web/ui/import/report-model.js";
import { reviewStep } from "../web/ui/import/review-step.js";
import { IMPORT_SOURCES } from "../web/ui/import/sources.js";
import { stepper } from "../web/ui/import/step-parts.js";
import { warningsList } from "../web/ui/import/warnings-view.js";
import { initialState } from "../web/ui/import/wizard.js";
import { FakeElement, fire } from "./fake-dom.js";
import {
  $,
  $$,
  VIEW_PREVIEW as PREVIEW,
  installImportDom,
  label,
  recorder,
} from "./web-import-dom.js";

test("Import is blocked without content and shows a refused plan's paths", (t) => {
  installImportDom(t);
  const selection = createSelection(PREVIEW);
  const onImport = recorder();
  const state = { ...initialState("monday"), step: "review", preview: PREVIEW };
  const view = reviewStep({
    state,
    selection,
    people: [],
    onImport,
    onBack: recorder(),
  });
  const run = $(view.element, "button.import-run");
  assert.equal(run.getAttribute("aria-disabled"), "false");
  assert.match(
    $(view.element, "p.import-summary").textContent,
    /^Import 9 boards/,
  );
  $$(view.element, "div.import-tree-tools button")[1].click(); // Select none
  assert.equal(run.getAttribute("aria-disabled"), "true");
  run.click();
  assert.equal(onImport.calls.length, 0);
  $$(view.element, "div.import-tree-tools button")[0].click();
  run.click();
  assert.equal(onImport.calls.length, 1);
  const error = {
    message: "The import plan is not valid",
    errors: [{ path: 'plan.users["u2"]', message: "No email" }],
  };
  view.update({ ...state, error });
  assert.match(
    $(view.element, "ul.import-banner-details").textContent,
    /plan\.users\["u2"\]: No email/,
  );
});

test("warnings are grouped by code with their places and paths", (t) => {
  installImportDom(t);
  const list = warningsList({ warnings: PREVIEW.warnings, preview: PREVIEW });
  const groups = $$(list, "li.import-warning-group");
  assert.deepEqual(
    groups.map((group) => [
      $(group, "span.import-warning-title").textContent,
      $(group, "span.import-warning-count").textContent,
    ]),
    [
      ["Column as text", "2"],
      ["Truncated", "1"],
    ],
  );
  assert.equal(
    $(groups[0], "span.import-warning-place").textContent,
    "Acme › Board 0",
  );
  assert.equal(
    $(groups[0], "code.import-warning-path").textContent,
    "columns[1]",
  );
  assert.equal(
    $(groups[1], "span.import-warning-place").textContent,
    "People › Anon",
  );
  assert.match(warningsList({ warnings: [] }).textContent, /No warnings/);
});

test("the done step links what was created and downloads warnings via a revoked Blob URL", async (t) => {
  const doc = installImportDom(t);
  const urls = [];
  t.mock.method(URL, "createObjectURL", (blob) => {
    urls.push({ blob, revoked: false });
    return `blob:test/${urls.length}`;
  });
  t.mock.method(URL, "revokeObjectURL", (url) => {
    urls[Number(url.split("/").pop()) - 1].revoked = true;
  });
  const clicks = [];
  t.mock.method(FakeElement.prototype, "click", function click() {
    if (this.localName !== "a") return void fire(this, "click");
    clicks.push({
      href: this.href,
      download: this.download,
      attached: this.isConnected,
    });
  });
  downloadText("a\nb", "warnings.txt");
  assert.deepEqual(clicks, [
    { href: "blob:test/1", download: "warnings.txt", attached: true },
  ]);
  assert.equal(doc.body.childNodes.length, 0, "the link is removed");
  assert.equal(await urls[0].blob.text(), "a\nb");
  assert.equal(urls[0].blob.type, "text/plain;charset=utf-8");
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(urls[0].revoked, true);
  const onMore = recorder();
  const report = {
    created: { boards: 1, items: 2, docs: 0 },
    skipped: [],
    warnings: PREVIEW.warnings,
    links: [
      { kind: "board", id: "9", url: "#/boards/9", title: "Roadmap" },
      { kind: "board", id: "8", url: "https://evil.test/", title: "Evil" },
    ],
    cancelled: false,
  };
  const view = doneStep({ state: { report, preview: PREVIEW }, onMore });
  assert.deepEqual(
    $$(view.element, "a.import-link").map((link) => link.getAttribute("href")),
    ["#/boards/9"],
  );
  assert.equal($$(view.element, "li.import-tile").length, 8);
  const download = $$(view.element, "button").find((b) =>
    label(b).startsWith("Download"),
  );
  download.click();
  assert.equal(clicks.length, 2);
  assert.match(
    clicks[1].download,
    /^worklane-import-warnings-monday-com-account-acme-\d{4}-\d{2}-\d{2}\.txt$/,
  );
  assert.match(
    await urls[1].blob.text(),
    /\[truncated\] People › Anon \(users\[1\]\): Name cut/,
  );
  $$(view.element, "button")
    .find((b) => label(b) === "Import more")
    .click();
  assert.equal(onMore.calls.length, 1);
  assert.equal(view.focusTarget.textContent, "Import finished");
});

test("the stepper marks the current step and the board badge links safely", (t) => {
  installImportDom(t);
  const steps = $$(stepper("review"), "li");
  assert.deepEqual(
    steps.map((step) => step.getAttribute("aria-current")),
    [null, null, "step", null, null],
  );
  assert.match(steps[0].textContent, /\(done\)/);
  const linked = importBadge({
    source: "monday",
    source_url: "https://acme.monday.com/boards/1",
  });
  assert.equal(linked.localName, "a");
  assert.equal(linked.getAttribute("rel"), "noopener noreferrer");
  assert.equal(linked.getAttribute("target"), "_blank");
  assert.match(linked.textContent, /Imported from monday\.com/);
  assert.equal(
    linked.getAttribute("aria-label"),
    "Imported from monday.com, open the original board (new tab)",
  );
  const plain = importBadge({
    source: "clickup",
    source_url: "javascript:alert(1)",
  });
  assert.equal(plain.localName, "span");
  assert.equal(plain.getAttribute("href"), null);
  assert.equal(importBadge(null), null);
});

test("every icon the import data names exists", () => {
  const named = [
    ...Object.values(IMPORT_SOURCES).map((source) => source.icon),
    ...createdTiles({}).map((tile) => tile.icon),
    ...linkSections([
      { kind: "workspace", url: "#/workspaces/1" },
      { kind: "board", url: "#/boards/1" },
      { kind: "doc", url: "#/docs/1" },
    ]).map((section) => section.icon),
  ];
  assert.deepEqual(
    named.filter((name) => !ICON_NAMES.includes(name)),
    [],
  );
});

test("#/import is routed to the import page, linked from the Admin tabs for importers", async (t) => {
  installImportDom(t);
  const route = APP_ROUTES.find(([pattern]) =>
    compilePattern(pattern).regex.test("/import"),
  );
  assert.equal(route[2].name, "import");
  assert.equal(importHash(), "#/import");
  const page = await route[1]();
  assert.equal(typeof page.mount, "function");
  const hrefs = (me) =>
    $$(adminTabs(me, "import"), "a.tab").map((tab) => [
      tab.getAttribute("href"),
      tab.getAttribute("aria-current"),
    ]);
  assert.deepEqual(hrefs({ capabilities: ["manage_users", "import_data"] }), [
    ["#/admin", null],
    ["#/admin/content", null],
    ["#/import", "page"],
  ]);
  assert.deepEqual(hrefs({ capabilities: ["manage_users"] }), [
    ["#/admin", null],
    ["#/admin/content", null],
  ]);
});
