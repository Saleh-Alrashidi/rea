/**
 * The people picker over a remote source (`share_candidates`), on a fake
 * DOM (test/fake-dom.js) with mocked timers: a pending query never lets
 * Enter or a click add the previous query's rows, an Enter pressed while
 * it is pending adds the first eligible answer of that same query, and
 * suggestions are reported only for an open list or a typed query.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  peoplePicker,
  teamDetail,
} from "../web/ui/components/people-picker.js";
import { fire, findAll, hasClass, installFakeDom } from "./fake-dom.js";

const SEARCH_DELAY_MS = 150;
const person = (id, name, extra = {}) => ({
  kind: "user",
  id,
  name,
  subtitle: `${name.split(" ")[0].toLowerCase()}@example.test`,
  eligible: true,
  ...extra,
});
const CHRIS = person("6", "Chris Taylor", {
  eligible: false,
  reason: "Guests can only join shareable boards, docs and notes",
  accountRole: "guest",
});
const JORDAN = person("5", "Jordan Blake", { accountRole: "viewer" });
const SAM = person("2", "Sam Lee");
const INITIAL = [CHRIS, JORDAN, SAM];

/** A remote picker whose search answers only when the test says so. */
function remotePicker(t, options = {}) {
  installFakeDom(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const searches = [];
  const reports = [];
  const picker = peoplePicker({
    label: "Add people or teams",
    initial: INITIAL,
    search: (query) =>
      new Promise((resolve) => searches.push({ query, resolve })),
    onSuggestions: (shown) => reports.push(shown.map((s) => s.name)),
    ...options,
  });
  globalThis.document.body.append(picker.element);
  const [input] = findAll(picker.element, (e) => e.localName === "input");
  const [list] = findAll(
    picker.element,
    (e) => e.getAttribute("role") === "listbox",
  );
  const options_ = () =>
    findAll(list, (e) => e.getAttribute("role") === "option");
  const type = (text) => {
    input.value = text;
    fire(input, "input");
  };
  const key = (name) => fire(input, "keydown", { key: name });
  /** Lets the debounce run and answers the latest search with `list`. */
  const answer = async (results) => {
    t.mock.timers.tick(SEARCH_DELAY_MS);
    await Promise.resolve();
    searches.at(-1).resolve(results);
    // settle() runs after the source's promise chain.
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
  };
  return {
    picker,
    input,
    list,
    options: options_,
    type,
    key,
    answer,
    searches,
    reports,
  };
}

const names = (picker) => picker.selection().map((subject) => subject.name);

test("Enter before a pending search answers adds nothing, then adds that query's match", async (t) => {
  const p = remotePicker(t);
  p.input.focus();
  assert.equal(p.options().length, 3, "the first page is on offer");
  p.type("sam");
  // The previous rows stay visible, but inert.
  const stale = p.options();
  assert.equal(stale.length, 3);
  assert.ok(stale.every((row) => row.getAttribute("aria-disabled") === "true"));
  assert.ok(stale.every((row) => hasClass(row, "stale")));
  assert.equal(p.input.getAttribute("aria-activedescendant"), null);
  assert.equal(p.list.getAttribute("aria-busy"), "true");
  fire(stale[0], "click");
  p.key("Enter");
  assert.deepEqual(names(p.picker), [], "no stale row was added");
  await p.answer([SAM]);
  assert.equal(p.searches.at(-1).query, "sam");
  assert.deepEqual(names(p.picker), ["Sam Lee"], "Enter applied to the answer");
});

test("a pending Enter belongs to its query: typing on drops it", async (t) => {
  const p = remotePicker(t);
  p.input.focus();
  p.type("s");
  p.key("Enter");
  p.type("sa");
  await p.answer([SAM]);
  assert.deepEqual(names(p.picker), [], "Enter was for the query 's'");
  // Answered now: Enter adds the active row, the first eligible one.
  p.key("Enter");
  assert.deepEqual(names(p.picker), ["Sam Lee"]);
});

test("an answer starts at its first eligible row; ineligible rows are never added", async (t) => {
  const p = remotePicker(t);
  p.input.focus();
  // The first page starts with the guest, who can't be added here.
  const rows = p.options();
  assert.equal(rows[0].getAttribute("aria-disabled"), "true");
  assert.equal(p.input.getAttribute("aria-activedescendant"), rows[1].id);
  p.key("Enter");
  assert.deepEqual(names(p.picker), ["Jordan Blake"]);
  fire(rows[0], "click");
  assert.deepEqual(names(p.picker), ["Jordan Blake"]);
});

test("suggestions are reported for an open list or a typed query only", async (t) => {
  const p = remotePicker(t);
  // Built with its first page but collapsed: nothing to explain yet.
  assert.ok(p.reports.length > 0);
  assert.ok(p.reports.every((shown) => shown.length === 0));
  p.input.focus();
  assert.deepEqual(p.reports.at(-1), [
    "Chris Taylor",
    "Jordan Blake",
    "Sam Lee",
  ]);
  p.type("chr");
  assert.deepEqual(p.reports.at(-1), [], "nothing while the query is pending");
  await p.answer([CHRIS]);
  assert.deepEqual(p.reports.at(-1), ["Chris Taylor"]);
});

test("the listbox is no Tab stop; guests and viewer accounts get badges", (t) => {
  const p = remotePicker(t);
  p.input.focus();
  assert.equal(p.list.getAttribute("tabindex"), "-1");
  const badges = p
    .options()
    .map(
      (row) =>
        findAll(row, (e) => hasClass(e, "role-badge"))[0]?.textContent ?? null,
    );
  assert.deepEqual(badges, ["Guest", "Viewer", null]);
});

test("team rows pluralize their member count and never invent one", () => {
  assert.equal(teamDetail(1), "Team · 1 member");
  assert.equal(teamDetail(2), "Team · 2 members");
  assert.equal(teamDetail(null), "Team");
  assert.equal(teamDetail(undefined), "Team");
});

test("focus put back after a change leaves the list closed", (t) => {
  const p = remotePicker(t);
  p.picker.focus({ open: false });
  assert.equal(globalThis.document.activeElement, p.input);
  assert.equal(p.list.hidden, true);
  assert.equal(p.input.getAttribute("aria-expanded"), "false");
  p.input.blur();
  p.picker.focus();
  assert.equal(p.list.hidden, false, "a plain focus opens it");
});
