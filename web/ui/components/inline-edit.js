/**
 * Inline-editable text: an input styled as plain text that commits on Enter
 * or blur and reverts on Escape.
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
 * Builds an inline editor. `onCommit(next)` runs once per changed value;
 * `required` reverts empty input instead of committing it.
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

  const badInput = () => input.validity?.badInput === true;
  const changed = () => input.value !== committed;

  function restore() {
    input.value = committed;
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
    if (required && next === "") {
      input.value = committed;
      return;
    }
    if (next === committed) {
      input.value = committed;
      return;
    }
    committed = next;
    input.value = next;
    input.defaultValue = next;
    onCommit(next);
  }

  return input;
}
