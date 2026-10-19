import assert from "node:assert/strict";
import test from "node:test";
import { inlineInput } from "../web/ui/components/inline-edit.js";
import { fire } from "./fake-dom.js";
import { installTaskDom } from "./web-task-fixtures.js";

/** An inline input of `value` attached to the document, and its commits. */
function editor(t, value, options = {}) {
  const doc = installTaskDom(t);
  const commits = [];
  const input = inlineInput({
    value,
    label: "Minuts",
    onCommit: (next) => commits.push(next),
    ...options,
  });
  doc.body.append(input);
  return { input, commits };
}

test("focusing and leaving a multi-line value saves nothing (SPEC-5 §6)", (t) => {
  const { input, commits } = editor(t, "Line one\nLine two");
  // The input shows the value without its line break, as browsers do.
  assert.equal(input.value, "Line oneLine two");
  input.focus();
  input.blur();
  fire(input, "keydown", { key: "Enter" });
  assert.deepEqual(commits, []);
  // Escape has nothing to revert, so it may close a surrounding panel.
  const escape = fire(input, "keydown", { key: "Escape" });
  assert.equal(escape.defaultPrevented, false);
});

test("an edit never saves over a multi-line value (SPEC-5 §6)", (t) => {
  const { input, commits } = editor(t, "Line one\nLine two");
  input.focus();
  // Typing in the input edits the text without its line break.
  input.value = "Line oneLine two!";
  fire(input, "keydown", { key: "Enter" });
  input.blur();
  assert.deepEqual(commits, []);
  // The edit is undone, so the line break is not lost either.
  assert.equal(input.value, "Line oneLine two");
});

test("a real edit commits, once", (t) => {
  const { input, commits } = editor(t, "Line one");
  input.focus();
  input.value = "Line one and two";
  fire(input, "keydown", { key: "Enter" });
  input.blur();
  assert.deepEqual(commits, ["Line one and two"]);
  // Editing back to what it showed after the commit saves nothing more.
  input.focus();
  input.value = "Line one and two ";
  input.blur();
  assert.deepEqual(commits, ["Line one and two"]);
});

test("unchanged text is not trimmed into a save; Escape reverts edits", (t) => {
  const { input, commits } = editor(t, "  padded ");
  input.focus();
  input.blur();
  assert.deepEqual(commits, []);
  input.focus();
  input.value = "changed";
  const escape = fire(input, "keydown", { key: "Escape" });
  assert.equal(escape.defaultPrevented, true);
  assert.equal(input.value, "  padded ");
  input.blur();
  assert.deepEqual(commits, []);
});

test("required inputs revert a cleared value", (t) => {
  const { input, commits } = editor(t, "Agenda", { required: true });
  input.focus();
  input.value = "   ";
  input.blur();
  assert.equal(input.value, "Agenda");
  assert.deepEqual(commits, []);
});

test("text inputs follow their content's direction", (t) => {
  const { input } = editor(t, "اجتماع");
  assert.equal(input.getAttribute("dir"), "auto");
  const number = inlineInput({
    value: "3",
    label: "#",
    type: "number",
    onCommit() {},
  });
  assert.equal(number.getAttribute("dir"), null);
});
