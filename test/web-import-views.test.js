/**
 * The import wizard's first steps over the fake DOM (SPEC-4 §6,
 * `web/ui/import/`): the token is a password field cleared right after
 * submit, files are refused before any request, progress is an accessible
 * bar, and the review's tree and people table change the selection.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { peopleTable } from "../web/ui/import/people-table.js";
import { createSelection } from "../web/ui/import/plan-model.js";
import { progressStep } from "../web/ui/import/progress-step.js";
import { reviewTree } from "../web/ui/import/review-tree.js";
import { MAX_FILE_BYTES } from "../web/ui/import/sources.js";
import { sourceStep } from "../web/ui/import/source-step.js";
import { initialState } from "../web/ui/import/wizard.js";
import { fire, hasClass } from "./fake-dom.js";
import {
  $,
  $$,
  VIEW_PREVIEW as PREVIEW,
  installImportDom,
  label,
  recorder,
} from "./web-import-dom.js";

test("the token is a password field, read once on submit and cleared", (t) => {
  const doc = installImportDom(t);
  const onScanToken = recorder();
  const onChoose = recorder();
  const state = { ...initialState("monday") };
  const view = sourceStep({
    state,
    onChoose,
    onScanToken,
    onScanFile: recorder(),
  });
  doc.body.append(view.element);
  assert.equal($$(view.element, "input.import-source-input").length, 4);
  fire($$(view.element, "input.import-source-input")[1], "change");
  assert.deepEqual(onChoose.calls, ["clickup"]);
  const token = $(view.element, "input.import-token");
  assert.equal(token.getAttribute("type"), "password");
  assert.equal(token.getAttribute("autocomplete"), "off");
  const form = $(view.element, "form");
  fire(form, "submit");
  assert.equal(onScanToken.calls.length, 0, "an empty token is not sent");
  assert.equal($(view.element, "p.import-field-error").hidden, false);
  assert.equal(token.getAttribute("aria-invalid"), "true");
  assert.equal(doc.activeElement, token);
  token.value = "  tok-123  ";
  const updates = $$(view.element, "label.import-check").find((check) =>
    check.textContent.startsWith("Updates"),
  );
  $(updates, "input").checked = false;
  fire($(updates, "input"), "change");
  fire(form, "submit");
  assert.deepEqual(onScanToken.calls, [
    { token: "tok-123", options: { include_updates: false } },
  ]);
  assert.equal(
    token.value,
    "",
    "cleared right after the request was handed over",
  );
  assert.equal($(view.element, "p.import-field-error").hidden, true);
  view.update({ ...state, pending: true });
  const scan = $(view.element, "button.import-scan");
  assert.equal(scan.disabled, true);
  assert.equal(label(scan), "Starting…");
  assert.equal(view.focusTarget.id, "import-step-title");
  view.update({ ...state, error: { message: "Token refused" } });
  const banner = $(view.element, "div.import-banner");
  assert.equal(banner.getAttribute("role"), "alert");
  assert.match(banner.textContent, /Token refused/);
  assert.equal(
    view.focusTarget,
    banner,
    "a failure is focused, not the heading",
  );
});

test("files over the limit or of the wrong type are refused before any request", (t) => {
  installImportDom(t);
  const onScanFile = recorder();
  const view = sourceStep({
    state: initialState("csv"),
    onChoose: recorder(),
    onScanToken: recorder(),
    onScanFile,
  });
  const input = $(view.element, "input.import-file-input");
  const error = $(view.element, "p.import-field-error");
  const form = $(view.element, "form");
  fire(form, "submit");
  assert.equal(error.textContent, "Choose a file to import.");
  fire(input, "change", {
    currentTarget: { files: [{ name: "big.csv", size: MAX_FILE_BYTES + 1 }] },
  });
  assert.equal(error.hidden, false);
  assert.match(error.textContent, /over the 20 MB limit/);
  fire(form, "submit");
  fire(input, "change", {
    currentTarget: { files: [{ name: "a.pdf", size: 10 }] },
  });
  fire(form, "submit");
  assert.equal(onScanFile.calls.length, 0);
  const file = { name: "plan.csv", size: 10 };
  const drop = $(view.element, "label.import-drop");
  fire(drop, "drop", { dataTransfer: { files: [file] } });
  assert.equal(error.hidden, true);
  fire(form, "submit");
  assert.deepEqual(onScanFile.calls, [{ file, kind: "csv" }]);
});

test("progress is a labelled bar, indeterminate until the total is known", (t) => {
  installImportDom(t);
  const onCancel = recorder();
  const state = { ...initialState("clickup"), step: "scanning" };
  const view = progressStep({ state, kind: "scan", onCancel });
  const bar = $(view.element, "div.import-bar");
  assert.equal(bar.getAttribute("role"), "progressbar");
  assert.equal(bar.getAttribute("aria-label"), "Scan progress");
  assert.ok(hasClass(bar, "indeterminate"));
  assert.equal(bar.getAttribute("aria-valuenow"), null);
  const live = $(view.element, "p[aria-live]");
  assert.equal(live.textContent, "Starting");
  view.update({
    ...state,
    progress: { phase: "items", done: 3, total: 12, message: "Reading “A”" },
  });
  assert.ok(!hasClass(bar, "indeterminate"));
  assert.equal(bar.getAttribute("aria-valuenow"), "25");
  assert.equal(
    bar.getAttribute("aria-valuetext"),
    "Reading items: 3 of 12 lists",
  );
  assert.equal($(view.element, "span.import-bar-fill").style.width, "25%");
  assert.equal(live.textContent, "Reading items");
  const cancel = $(view.element, "button.import-cancel");
  cancel.click();
  assert.equal(onCancel.calls.length, 1);
  view.update({ ...state, cancelling: true });
  assert.equal(cancel.disabled, true);
  assert.equal(label(cancel), "Stopping…");
});

test("the tree includes boards and docs per workspace and picks targets", (t) => {
  installImportDom(t);
  const selection = createSelection(PREVIEW);
  const onChange = recorder();
  const { element } = reviewTree({ preview: PREVIEW, selection, onChange });
  const workspace = $(element, "input.import-ws-check");
  assert.equal(workspace.indeterminate, true, "Board 1 starts excluded");
  const entries = $$(element, "input.import-entry-check");
  assert.equal(entries.length, 11);
  entries[1].checked = true;
  fire(entries[1], "change");
  assert.ok(selection.boards.has("b1"));
  assert.equal(workspace.checked, true);
  assert.equal(workspace.indeterminate, false);
  workspace.checked = false;
  fire(workspace, "change");
  assert.equal(selection.boards.size + selection.docs.size, 0);
  assert.ok(entries.every((box) => !box.checked));
  const target = $(element, "select.import-target");
  target.value = "7";
  fire(target, "change");
  assert.equal(selection.targets.get("w1"), "7");
  assert.equal(onChange.calls.length, 3);
  const links = $$(element, "a.import-source-link");
  assert.equal(links.length, 1, "only the https source URL is linked");
  assert.equal(links[0].getAttribute("rel"), "noopener noreferrer");
  assert.match(
    $(element, "p.import-reimport").textContent,
    /“Board 2 \(imported again\)”/,
  );
  assert.equal(
    $($(element, "p.import-reimport"), "a").getAttribute("href"),
    "#/boards/42",
  );
  const hidden = $$(element, "li.import-entry").filter((row) => row.hidden);
  assert.equal(hidden.length, 6, "long lists show 5 entries first");
  const more = $(element, "button.import-entries-toggle");
  more.click();
  assert.equal(
    $$(element, "li.import-entry").filter((row) => row.hidden).length,
    0,
  );
  assert.equal(more.getAttribute("aria-expanded"), "true");
});

test("the people table sets one action per person and for everyone unmatched", (t) => {
  installImportDom(t);
  const selection = createSelection(PREVIEW);
  const onChange = recorder();
  const people = [
    { id: "3", name: "Noa", email: "noa@x.test", status: "active" },
  ];
  const table = peopleTable({ preview: PREVIEW, selection, people, onChange });
  const selects = $$(table.element, "select.import-person-action");
  assert.deepEqual(
    selects.map((select) => select.getAttribute("aria-label")),
    ["Action for Sam", "Action for Anon"],
  );
  const anonInvites = $$(selects[1], "option").filter((o) =>
    o.value.startsWith("invite:"),
  );
  assert.ok(anonInvites.every((option) => option.hasAttribute("disabled")));
  selects[0].value = "match:3";
  fire(selects[0], "change");
  assert.equal(selection.users.get("u1"), "match:3");
  assert.equal(table.counts.textContent, "1 matched · 0 to invite · 1 skipped");
  const bulk = $(table.element, "div.import-people-bulk");
  $(bulk, "select").value = "invite:viewer";
  $(bulk, "button").click();
  assert.equal(
    selection.users.get("u1"),
    "match:3",
    "a match chosen by hand stays",
  );
  assert.equal(selection.users.get("u2"), "skip", "no email, no invite");
  assert.equal(
    $(bulk, "span.import-people-bulk-status").textContent,
    "Nothing changed.",
  );
  selects[0].value = "skip";
  fire(selects[0], "change");
  $(bulk, "button").click();
  assert.equal(selection.users.get("u1"), "skip", "set by hand, so kept");
  assert.equal(
    $(bulk, "span.import-people-bulk-status").textContent,
    "Nothing changed. 1 person you set by hand was kept.",
  );
  selection.manual.clear();
  $(bulk, "button").click();
  assert.equal(selection.users.get("u1"), "invite:viewer");
  assert.equal(
    $(bulk, "span.import-people-bulk-status").textContent,
    "1 person updated.",
  );
  assert.equal(
    $$(table.element, "select.import-person-action")[0].value,
    "invite:viewer",
    "the rows show the new choice",
  );
  assert.equal(onChange.calls.length, 5);
  const named = $(table.element, "table.import-people-table");
  assert.equal(named.getAttribute("aria-label"), "People");
  assert.equal(
    $(table.element, "div.import-people-tools select").getAttribute(
      "aria-label",
    ),
    "Show people",
  );
});

test("long people lists draw 100 rows until Show all", (t) => {
  installImportDom(t);
  const users = Array.from({ length: 130 }, (_, index) => ({
    source_id: `u${index}`,
    name: `Person ${index}`,
    email: `p${index}@x.test`,
    proposal: "skip",
    action: "skip",
    match: null,
  }));
  const preview = { ...PREVIEW, users };
  const table = peopleTable({
    preview,
    selection: createSelection(preview),
    people: [],
    onChange() {},
  });
  assert.equal($$(table.element, "tr.import-person").length, 100);
  assert.ok(
    $(table.element, "tbody").childNodes.every((row) => row.localName === "tr"),
    "only rows in the body",
  );
  const more = $(table.element, "div.import-people-foot button");
  assert.equal(label(more), "Show all 130");
  more.click();
  assert.equal($$(table.element, "tr.import-person").length, 130);
  const search = $(table.element, 'input[type="search"]');
  search.value = "nobody";
  fire(search, "input");
  assert.deepEqual(
    $$(table.element, "tbody tr").map((row) => row.textContent),
    ["No one matches."],
  );
  assert.equal(
    $(table.element, "span.import-people-status").textContent,
    "Showing 0 of 130 people",
  );
  const many = {
    ...PREVIEW,
    users: [
      ...users,
      ...users,
      ...users,
      ...users,
      ...users,
      ...users,
      ...users,
      ...users,
    ],
  };
  many.users = many.users.map((user, index) => ({
    ...user,
    source_id: `m${index}`,
  }));
  const big = peopleTable({
    preview: many,
    selection: createSelection(many),
    people: [],
    onChange() {},
  });
  assert.equal(
    $(big.element, "span.import-people-status").textContent,
    "1,040 people",
    "counts use the same grouping as the summary",
  );
  assert.equal(
    label($(big.element, "div.import-people-foot button")),
    "Show all 1,040",
  );
});
