/**
 * Choice cards: a radio group drawn as cards with an icon, a label and a
 * one-line explanation (board kind, doc visibility, workspace kind). The
 * native radio stays in the tab order and handles arrow keys; the card is
 * styled from its state through a sibling selector.
 *
 * ```js
 * choiceCards({ name: "kind", value: "public", labelledBy: "kind-label",
 *   options: [{ value: "public", label: "Main", description: "…", icon: "grid" }],
 *   onChange: (value) => … })
 * ```
 */

import { h } from "../../dom.js";
import { icon } from "./icon.js";

/**
 * @param {{ name: string, value?: string, labelledBy?: string,
 *   options: { value: string, label: string, description?: string, icon?: string }[],
 *   onChange?: (value: string) => void, disabled?: boolean,
 *   disabledReason?: string, autofocus?: boolean, className?: string,
 *   focusKey?: string }} options
 *   With `focusKey`, each radio carries `data-focus-key="<focusKey>:<value>"`.
 * @returns {HTMLElement}
 */
export function choiceCards(options) {
  const selected = options.value ?? options.options[0]?.value;
  return h(
    "div",
    {
      class: ["choice-group", options.className],
      role: "radiogroup",
      "aria-labelledby": options.labelledBy ?? null,
    },
    options.options.map((option, index) =>
      h(
        "label",
        { class: "choice", title: options.disabledReason ?? null },
        h("input", {
          class: "choice-input",
          type: "radio",
          name: options.name,
          value: option.value,
          disabled: options.disabled ?? false,
          autofocus: Boolean(options.autofocus) && index === 0,
          checked: option.value === selected,
          dataset: {
            focusKey: options.focusKey
              ? `${options.focusKey}:${option.value}`
              : null,
          },
          on: { change: () => options.onChange?.(option.value) },
        }),
        h(
          "span",
          { class: "choice-card" },
          h("span", { class: "choice-dot", "aria-hidden": "true" }),
          option.icon ? icon(option.icon, { className: "choice-icon" }) : null,
          h(
            "span",
            { class: "choice-text" },
            h("span", { class: "choice-label" }, option.label),
            option.description
              ? h("span", { class: "choice-description" }, option.description)
              : null,
          ),
        ),
      ),
    ),
  );
}
