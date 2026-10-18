/**
 * The note color picker: a popover with the fixed palette as a radio
 * group (arrow keys move between colors; Enter, Space or a click picks).
 */

import { h } from "../../dom.js";
import { icon } from "../components/icon.js";
import { closePopover, openPopover } from "../components/popover.js";
import { NOTE_COLORS } from "./note-model.js";

function swatch(entry, { selected, focusable, onPick }) {
  const button = h(
    "button",
    {
      type: "button",
      class: "note-swatch",
      role: "radio",
      "aria-checked": String(selected),
      "aria-label": entry.label,
      title: entry.label,
      tabindex: focusable ? "0" : "-1",
      dataset: focusable ? { autofocus: "" } : null,
      on: { click: () => onPick(entry.value) },
    },
    selected ? icon("check", { size: 14 }) : null,
  );
  button.style.setProperty("--note-color", entry.value);
  return button;
}

function onKeydown(event) {
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[
    event.key
  ];
  if (!step) return;
  event.preventDefault();
  const swatches = [...event.currentTarget.querySelectorAll(".note-swatch")];
  const index = swatches.indexOf(globalThis.document.activeElement);
  const next = swatches[(index + step + swatches.length) % swatches.length];
  for (const entry of swatches) entry.tabIndex = entry === next ? 0 : -1;
  next.focus();
}

/**
 * Opens the palette next to `anchor`; `onSelect(color)` runs with the
 * chosen color after the popover closes.
 * @param {{ anchor: HTMLElement, value: string, onSelect(color: string): void }} options
 */
export function openColorPicker({ anchor, value, onSelect }) {
  const current = String(value ?? "").toLowerCase();
  const hasCurrent = NOTE_COLORS.some((entry) => entry.value === current);
  const onPick = (color) => {
    closePopover();
    if (color !== current) onSelect(color);
  };
  openPopover({
    anchor,
    label: "Note color",
    className: "note-color-popover",
    content: () =>
      h(
        "div",
        {
          class: "note-swatches",
          role: "radiogroup",
          "aria-label": "Note color",
          on: { keydown: onKeydown },
        },
        NOTE_COLORS.map((entry, index) =>
          swatch(entry, {
            selected: entry.value === current,
            focusable: hasCurrent ? entry.value === current : index === 0,
            onPick,
          }),
        ),
      ),
  });
}
