/**
 * Small pieces the import steps share: the step heading (the focus
 * target when a step opens), panels, message banners and the stepper
 * that shows where the wizard is.
 */

import { h } from "../../dom.js";
import { button } from "../components/button.js";
import { icon } from "../components/icon.js";
import { STEPS, stepIndex } from "./wizard.js";

/** Lists longer than this show SHOWN items until "Show all" is pressed. */
export const COLLAPSE_AT = 8;
const SHOWN = 5;

const TONES = Object.freeze({
  danger: { icon: "alert", role: "alert" },
  warning: { icon: "alert", role: "status" },
  info: { icon: "info", role: "status" },
  success: { icon: "check", role: "status" },
});

/**
 * A banner with an icon, `text`, optional `details` (a list of lines) and
 * `actions` (buttons). Errors are `role="alert"`, so they are announced
 * when shown.
 */
export function messageBanner({
  tone = "info",
  text,
  details = [],
  actions = [],
}) {
  const info = TONES[tone] ?? TONES.info;
  return h(
    "div",
    { class: ["banner", `banner-${tone}`, "import-banner"], role: info.role },
    icon(info.icon, { size: 16 }),
    h(
      "div",
      { class: "import-banner-text" },
      h("p", null, text),
      details.length > 0
        ? h(
            "ul",
            { class: "import-banner-details" },
            details.map((line) => h("li", null, line)),
          )
        : null,
      actions.length > 0
        ? h("div", { class: "import-banner-actions" }, actions)
        : null,
    ),
  );
}

/** The step's `<h2>`; focus moves to it when the step opens. */
export function stepHeading(text) {
  return h(
    "h2",
    { class: "import-step-title", tabindex: "-1", id: "import-step-title" },
    text,
  );
}

/**
 * `items` (list items) in a `<ul>` with `props`; a list of more than
 * COLLAPSE_AT shows the first SHOWN until "Show all N" (the hidden items
 * stay in the list, so their checkboxes still count). → `[list, toggle?]`.
 */
export function collapsibleList(items, props = {}) {
  const list = h("ul", props, items);
  if (items.length <= COLLAPSE_AT) return [list];
  const extra = items.slice(SHOWN);
  const all = `Show all ${items.length.toLocaleString("en-US")}`;
  const toggle = button({
    label: all,
    iconEnd: "chevronDown",
    size: "sm",
    variant: "ghost",
    className: "import-entries-toggle",
    onClick: () => {
      const open = toggle.getAttribute("aria-expanded") !== "true";
      for (const item of extra) item.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
      toggle.querySelector(".btn-label").textContent = open
        ? "Show fewer"
        : all;
    },
  });
  for (const item of extra) item.hidden = true;
  toggle.setAttribute("aria-expanded", "false");
  return [list, h("div", { class: "import-collapse-more" }, toggle)];
}

/** A panel with a header (title, optional count and tools) and a body. */
export function importPanel({ title, iconName, id, count, tools, body }) {
  const headingId = `${id}-title`;
  return h(
    "section",
    { class: ["panel", "import-panel"], "aria-labelledby": headingId },
    h(
      "div",
      { class: "panel-header import-panel-header" },
      h(
        "h3",
        { class: "panel-title", id: headingId },
        iconName ? icon(iconName) : null,
        h("span", null, title),
        count === undefined || count === null
          ? null
          : h("span", { class: "import-panel-count" }, count),
      ),
      tools ? h("div", { class: "import-panel-tools" }, tools) : null,
    ),
    h("div", { class: "panel-body import-panel-body" }, body),
  );
}

/** The stepper: every step, the current one with `aria-current="step"`. */
export function stepper(step) {
  const current = stepIndex(step);
  return h(
    "ol",
    { class: "import-steps", "aria-label": "Import steps" },
    STEPS.map((entry, index) =>
      h(
        "li",
        {
          class: [
            "import-steps-item",
            index < current && "complete",
            index === current && "current",
          ],
          "aria-current": index === current ? "step" : null,
        },
        h(
          "span",
          { class: "import-steps-marker", "aria-hidden": "true" },
          index < current ? icon("check", { size: 12 }) : String(index + 1),
        ),
        h("span", { class: "import-steps-label" }, entry.label),
        index < current
          ? h("span", { class: "visually-hidden" }, " (done)")
          : null,
      ),
    ),
  );
}
