/**
 * Inline-editable text: an input styled as plain text that commits on Enter
 * or blur and reverts on Escape.
 */

import { h } from "../../dom.js";
import { isRebuilding } from "./focus.js";

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
          commit();
        } else if (event.key === "Escape" && input.value !== committed) {
          // Revert without letting Escape close a surrounding panel.
          event.preventDefault();
          event.stopPropagation();
          input.value = committed;
        }
      },
      blur() {
        // Removal during a re-render blurs the input; its unsaved text moves
        // to the replacement element instead of being committed here.
        if (isRebuilding(input)) return;
        commit();
      },
    },
  });

  function commit() {
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
