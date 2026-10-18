/**
 * Color field: a radio group of swatches plus a native color input for a
 * custom `#rrggbb` color. Used for form accent colors and workspace colors.
 * The swatches are real radio inputs (arrow keys move between them); each
 * carries the color's name as its accessible label.
 *
 * ```js
 * colorField({ label: "Accent color", value: "#5b5bd6",
 *   onChange: (color) => save({ accent_color: color }) })
 * ```
 */

import { h } from "../../dom.js";
import { GROUP_COLORS, safeColor, textColorOn } from "../board/values.js";
import { icon } from "../components/icon.js";

/** Worklane indigo first, then the board palette. */
export const PALETTE = Object.freeze([
  { color: "#5b5bd6", name: "Worklane indigo" },
  ...GROUP_COLORS,
]);

let nextId = 0;

function swatch({ name, entry, selected, disabled, onPick }) {
  const dot = h(
    "span",
    { class: "color-swatch-dot", "aria-hidden": "true" },
    icon("check", { size: 14, className: "color-swatch-check" }),
  );
  dot.style.backgroundColor = entry.color;
  dot.style.color = textColorOn(entry.color);
  return h(
    "label",
    { class: "color-swatch", title: entry.name },
    h("input", {
      class: "color-swatch-input",
      type: "radio",
      name,
      value: entry.color,
      "aria-label": entry.name,
      checked: selected,
      disabled,
      on: { change: () => onPick(entry.color) },
    }),
    dot,
  );
}

/**
 * @param {{ label: string, value: string, onChange: (color: string) => void,
 *   colors?: { color: string, name: string }[], disabled?: boolean,
 *   disabledReason?: string, className?: string }} options
 * @returns {HTMLElement}
 */
export function colorField(options) {
  const colors = options.colors ?? PALETTE;
  const id = `color-field-${(nextId += 1)}`;
  let current = safeColor(options.value, colors[0].color).toLowerCase();
  const disabled = Boolean(options.disabled || options.disabledReason);
  const swatches = h("div", {
    class: "color-swatches",
    role: "radiogroup",
    "aria-labelledby": `${id}-label`,
  });
  const custom = h("input", {
    class: "color-custom-input",
    type: "color",
    "aria-label": `${options.label}: custom color`,
    value: current,
    disabled,
    on: {
      change: (event) => pick(event.currentTarget.value.toLowerCase()),
    },
  });

  function render() {
    swatches.replaceChildren(
      ...colors.map((entry) =>
        swatch({
          name: id,
          entry,
          selected: entry.color.toLowerCase() === current,
          disabled,
          onPick: pick,
        }),
      ),
    );
  }

  function pick(color) {
    const next = safeColor(color, current).toLowerCase();
    if (next === current) return;
    current = next;
    custom.value = next;
    render();
    options.onChange(next);
  }

  render();
  return h(
    "div",
    {
      class: ["field", "color-field", options.className],
      title: options.disabledReason ?? null,
    },
    h("span", { class: "field-label", id: `${id}-label` }, options.label),
    h(
      "div",
      { class: "color-field-row" },
      swatches,
      h(
        "label",
        { class: "color-custom", title: "Custom color" },
        custom,
        h("span", { class: "color-custom-text" }, "Custom"),
      ),
    ),
  );
}
