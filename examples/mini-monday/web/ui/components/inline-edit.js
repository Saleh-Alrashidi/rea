/**
 * Inline-editable text: an input styled as plain text that commits on Enter
 * or blur and reverts on Escape.
 *
 * It commits only after a real edit: what the input shows is not always
 * its value (an `<input>` drops line breaks, SPEC-5 §6), so focusing and
 * leaving it compares the text with what it first showed, not with the
 * value. Multi-line values belong in a textarea.
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

  function commit({ leaving }) {
    if (badInput()) {
      rejectBadInput(leaving);
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
