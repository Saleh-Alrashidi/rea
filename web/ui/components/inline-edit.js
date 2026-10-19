/**
 * Inline-editable text: an input styled as plain text that commits on Enter
 * or blur and reverts on Escape.
 *
 * An `<input>` drops line breaks (SPEC-5 §6), so a text input never
 * saves over a value that has one (`hasLineBreak`): an edit of it is
 * reverted with a toast. Multi-line values are edited in a textarea
 * (`text-editor.js`). It commits only after a real edit: focusing and
 * leaving it compares the text with what it first showed, not with the
 * value.
 *
 * A number input whose text is not a number (`validity.badInput`, e.g. "3e")
 * reports its value as "", which must not be taken for a deliberate clear:
 * such text is never committed. Enter keeps it and shows the browser's
 * message so it can be fixed; leaving the field restores the saved value and
 * says so in a toast.
 */

import { h } from "../../dom.js";
import { isRebuilding } from "./focus.js";
import { showToast } from "./toast.js";

const LINE_BREAK = /[\r\n]/;

/** Whether `text` has a line break, which an `<input>` would drop. */
export function hasLineBreak(text) {
  return LINE_BREAK.test(String(text ?? ""));
}

/**
 * Builds an inline editor. `onCommit(next)` runs once per edit that
 * changes the value; `required` reverts empty input instead of committing
 * it.
 *
 * @param {{ value: string, label: string, onCommit(next: string): void,
 *   className?: string, maxLength?: number, required?: boolean,
 *   placeholder?: string, type?: string, focusKey?: string,
 *   trim?: boolean }} options
 * @returns {HTMLInputElement}
 */
export function inlineInput(options) {
  const {
    value,
    label,
    onCommit,
    className = "",
    maxLength = 255,
    required = false,
    placeholder = "",
    type = "text",
    focusKey,
    trim = true,
  } = options;
  let committed = value ?? "";
  const input = h("input", {
    class: ["inline-input", className],
    type,
    "aria-label": label,
    maxlength: type === "text" ? maxLength : null,
    step: type === "number" ? "any" : null,
    inputmode: type === "number" ? "decimal" : null,
    placeholder: placeholder || null,
    autocomplete: "off",
    spellcheck: type === "text" ? "true" : null,
    dir: type === "text" ? "auto" : null,
    dataset: { focusKey },
    value: committed,
    on: {
      keydown(event) {
        if (event.key === "Enter") {
          event.preventDefault();
          commit({ leaving: false });
        } else if (event.key === "Escape" && (badInput() || changed())) {
          // Revert without letting Escape close a surrounding panel.
          event.preventDefault();
          event.stopPropagation();
          restore();
        }
      },
      input() {
        input.removeAttribute("aria-invalid");
      },
      blur() {
        // Removal during a re-render blurs the input; its unsaved text moves
        // to the replacement element instead of being committed here.
        if (isRebuilding(input)) return;
        commit({ leaving: true });
      },
    },
  });

  // The text as the input shows `committed` (without its line breaks).
  let shown = input.value;
  const badInput = () => input.validity?.badInput === true;
  const changed = () => input.value !== shown;

  function restore() {
    input.value = shown;
    input.removeAttribute("aria-invalid");
  }

  function rejectBadInput(leaving) {
    if (!leaving) {
      input.setAttribute("aria-invalid", "true");
      input.reportValidity?.();
      return;
    }
    restore();
    const message = `${label}: that isn’t a number, so the value was kept`;
    showToast({ message, type: "error" });
  }

  // Saving would flatten a multi-line value: the edit is undone instead.
  function rejectLineLoss() {
    restore();
    const message = `${label} has line breaks this field can’t keep, so it wasn’t changed`;
    showToast({ message, type: "error" });
  }

  function commit({ leaving }) {
    if (badInput()) {
      rejectBadInput(leaving);
      return;
    }
    if (type === "text" && hasLineBreak(committed) && changed()) {
      rejectLineLoss();
      return;
    }
    const next = trim ? input.value.trim() : input.value;
    if (!changed() || next === committed || (required && next === "")) {
      restore();
      return;
    }
    committed = next;
    input.value = next;
    input.defaultValue = next;
    shown = input.value;
    onCommit(next);
  }

  return input;
}
