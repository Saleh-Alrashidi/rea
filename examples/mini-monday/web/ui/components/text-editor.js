/**
 * Editors of text that may hold line breaks (SPEC-5 §3.4, §4.2, §6). An
 * `<input>` drops the line breaks of its value, so it may edit only text
 * without them (`inlineInput` never saves over a value that has one);
 * multi-line text is edited in a textarea. This module owns that choice:
 *
 * - `firstLine` says how a value shows on one line, and whether it is
 *   multi-line (`hasLineBreak`, `inline-edit.js`);
 * - `textEditor` is the editor of one edit (the task view's fields and
 *   the text popover): a textarea, or an input for one-line text, that
 *   saves only a changed text (`textCommit`);
 * - `textInput` edits an optional value in place where space is short
 *   (Main table cells, the board description): the inline input for
 *   one-line text, else the first line as a button that opens
 *   `textEditor` in a popover (`openTextPopover`).
 */

import { h } from "../../dom.js";
import { isRebuilding } from "./focus.js";
import { hasLineBreak, inlineInput } from "./inline-edit.js";
import { openPopover } from "./popover.js";

/** The server's limit on text values. */
export const MAX_TEXT = 2000;
/** Rows a textarea starts with (it grows with its text). */
const MIN_ROWS = 3;
const MAX_ROWS = 16;

/**
 * The first line of a text value: `more` when other non-blank lines
 * follow (shown as "…"), `multiline` when it has any line break (so it
 * is edited in a textarea, never an input).
 */
export function firstLine(text) {
  const value = String(text ?? "");
  const lines = value.split(/\r\n|\r|\n/);
  const more = lines.slice(1).some((line) => line.trim() !== "");
  return { text: lines[0], more, multiline: hasLineBreak(value) };
}

/**
 * What saving an edited text gives: `changed` only when the text differs
 * from `initial` as the editor first showed it (so leaving an editor
 * unchanged saves nothing), and the `value` to store (null when blank).
 */
export function textCommit(initial, next) {
  return {
    changed: next !== initial,
    value: next.trim() === "" ? null : next,
  };
}

function rowsFor(text) {
  const lines = String(text).split("\n").length + 1;
  return Math.min(MAX_ROWS, Math.max(MIN_ROWS, lines));
}

/** What saving `editor` (a `textEditor`) gives now (`textCommit`). */
export function editedText(editor) {
  return textCommit(editor.defaultValue, editor.value);
}

/**
 * The editor of one edit of text `value`: a textarea when the field is
 * `multiline` or the value has a line break (an input would drop it),
 * else a one-line input. Ctrl/⌘+Enter (Enter in an input) ends the edit
 * saving and Escape without (neither reaches a surrounding dialog);
 * leaving the editor ends it with `leaving`, except while its region is
 * rebuilt. `onEnd({ save, leaving, text })` runs for each of these, with
 * `text` as `editedText(editor)`: only a `changed` text is to be saved.
 * Focus may come back after `leaving`, so a consumer that ends the edit
 * there ignores what follows.
 *
 * @param {{ value: string | null, label: string,
 *   onEnd(end: { save: boolean, leaving: boolean,
 *     text: { changed: boolean, value: string | null } }): void,
 *   multiline?: boolean, className?: string, focusKey?: string,
 *   maxLength?: number }} options
 * @returns {HTMLTextAreaElement | HTMLInputElement}
 */
export function textEditor(options) {
  const { label, onEnd, focusKey } = options;
  const value = options.value ?? "";
  const multiline = options.multiline === true || hasLineBreak(value);
  const editor = h(multiline ? "textarea" : "input", {
    class: ["input", multiline ? "text-area" : "text-line", options.className],
    type: multiline ? null : "text",
    rows: multiline ? rowsFor(value) : null,
    maxlength: options.maxLength ?? MAX_TEXT,
    dir: "auto",
    spellcheck: "true",
    autocomplete: "off",
    "aria-label": label,
    dataset: { focusKey },
    value,
  });
  // The text as first shown (a textarea reads "\r\n" as "\n"): what a
  // save compares with, and what focus.js treats as not edited.
  editor.defaultValue = editor.value;
  const end = (save, leaving) =>
    onEnd({ save, leaving, text: editedText(editor) });
  editor.addEventListener("keydown", (event) => {
    const modified = event.ctrlKey || event.metaKey;
    const submit = event.key === "Enter" && (modified || !multiline);
    if (event.key !== "Escape" && !submit) return;
    event.preventDefault();
    event.stopPropagation();
    end(submit, false);
  });
  editor.addEventListener("blur", () => {
    if (!isRebuilding(editor)) end(true, true);
  });
  return editor;
}

/**
 * Opens a textarea on text `value` in a popover next to `anchor`.
 * Ctrl/⌘+Enter, a click outside and Tab away save a changed text with
 * `onCommit(next)` ("" when cleared); Escape cancels. Returns the
 * popover, or null when it was open from `anchor` (that closes it).
 *
 * @param {{ anchor: HTMLElement, value: string, label: string,
 *   onCommit(next: string): void, maxLength?: number }} options
 */
export function openTextPopover({ anchor, value, label, onCommit, maxLength }) {
  let finished = false;
  let popover = null;
  const finish = (save) => {
    if (finished) return;
    finished = true;
    const text = editedText(editor);
    if (save && text.changed) onCommit(text.value ?? "");
  };
  const editor = textEditor({
    value,
    label,
    maxLength,
    multiline: true,
    onEnd({ save, leaving }) {
      // Focus leaves as the popover closes (closing says what to do) or
      // for the popover itself, from where it may come back.
      if (leaving) return;
      if (!save) finish(false);
      popover?.close();
    },
  });
  editor.setAttribute("data-autofocus", "");
  popover = openPopover({
    anchor,
    label,
    className: "text-popover",
    content: h(
      "div",
      { class: "text-popover-body" },
      editor,
      h("p", { class: "text-popover-hint" }, "Ctrl + Enter to save"),
    ),
    onClose: (reason) => finish(reason !== "escape"),
  });
  if (!popover) return null;
  const end = editor.value.length;
  editor.setSelectionRange?.(end, end);
  return popover;
}

/**
 * The in-place editor of an optional text value where space is short:
 * the inline input (`inlineInput`, given `options`) for one-line text.
 * A multi-line value shows its first line ("…" when more follows) as a
 * button that opens the textarea popover (`openTextPopover`).
 * `onCommit(next)` gets the changed text, "" when cleared.
 *
 * @param {{ value: string | null, label: string,
 *   onCommit(next: string): void, className?: string, focusKey?: string,
 *   maxLength?: number, placeholder?: string }} options
 * @returns {HTMLInputElement | HTMLButtonElement}
 */
export function textInput(options) {
  const { value, label, onCommit, focusKey, maxLength } = options;
  if (!hasLineBreak(value)) return inlineInput(options);
  const line = firstLine(value);
  const shown = line.more ? `${line.text}…` : line.text;
  const button = h(
    "button",
    {
      type: "button",
      class: ["text-lines", options.className],
      dir: "auto",
      title: value,
      "aria-haspopup": "dialog",
      "aria-expanded": "false",
      "aria-label": `${label}: ${shown}. Edit`,
      dataset: { focusKey },
      on: {
        click: () =>
          openTextPopover({
            anchor: button,
            value,
            label,
            onCommit,
            maxLength,
          }),
      },
    },
    shown,
  );
  return button;
}
