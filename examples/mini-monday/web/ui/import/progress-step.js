/**
 * Steps 2 and 4, "Scanning" and "Importing" (SPEC-4 §6.2, §6.4): the
 * phase, a progress bar (`role="progressbar"`, indeterminate while the
 * total is unknown), the count and the connector's message, and Cancel.
 *
 * Updates arrive several times a second; `update(state)` changes the
 * existing nodes in place. A polite live region announces only phase
 * changes (`progress.progressView`), so screen readers are not flooded.
 *
 * `progressStep({ state, kind, onCancel })` → `{ element, update(state),
 * focusTarget }`.
 */

import { h } from "../../dom.js";
import { button } from "../components/button.js";
import { progressView } from "./progress.js";
import { stepHeading } from "./step-parts.js";
import { sourceOf } from "./sources.js";

const TEXT = Object.freeze({
  scan: {
    heading: (source) => `Scanning ${sourceOf(source)?.label ?? "the source"}`,
    hint: "Nothing is written to Worklane during a scan. You can leave this page and come back: the scan keeps running.",
    cancel: "Cancel scan",
    bar: "Scan progress",
  },
  import: {
    heading: () => "Importing into Worklane",
    hint: "Each board is written in one step. Stopping keeps what was already imported.",
    cancel: "Stop import",
    bar: "Import progress",
  },
});

function draw(p, state) {
  const view = progressView(state.progress, {
    kind: p.kind,
    source: state.source,
  });
  p.title.textContent = view.title;
  p.count.textContent = view.countText;
  p.message.textContent = view.message;
  p.message.hidden = view.message === "";
  const known = view.percent !== null;
  p.bar.classList.toggle("indeterminate", !known);
  p.fill.style.setProperty("width", known ? `${view.percent}%` : "");
  if (known) p.bar.setAttribute("aria-valuenow", String(view.percent));
  else p.bar.removeAttribute("aria-valuenow");
  p.bar.setAttribute("aria-valuetext", view.valueText);
  if (p.live.textContent !== view.announcement) {
    p.live.textContent = view.announcement;
  }
  const label = p.cancel.querySelector(".btn-label");
  p.cancel.disabled = state.cancelling;
  label.textContent = state.cancelling ? "Stopping…" : TEXT[p.kind].cancel;
}

/** Builds the step (see the module comment). */
export function progressStep({ state, kind, onCancel }) {
  const text = TEXT[kind];
  const p = { kind };
  const heading = stepHeading(text.heading(state.source));
  p.title = h("span", { class: "import-progress-title" });
  p.count = h("span", { class: "import-progress-count" });
  p.fill = h("span", { class: "import-bar-fill" });
  p.bar = h(
    "div",
    {
      class: "import-bar",
      role: "progressbar",
      "aria-label": text.bar,
      "aria-valuemin": "0",
      "aria-valuemax": "100",
    },
    p.fill,
  );
  p.message = h("p", { class: "import-progress-message" });
  p.live = h("p", { class: "visually-hidden", "aria-live": "polite" });
  p.cancel = button({
    label: text.cancel,
    icon: "close",
    variant: "secondary",
    className: "import-cancel",
    onClick: () => onCancel(),
  });
  const element = h(
    "section",
    {
      class: ["import-step", `import-step-${kind}`],
      "aria-labelledby": "import-step-title",
    },
    heading,
    state.label ? h("p", { class: "import-step-text" }, state.label) : null,
    h(
      "div",
      { class: "panel import-progress" },
      h("div", { class: "import-progress-head" }, p.title, p.count),
      p.bar,
      p.message,
      p.live,
      h("div", { class: "import-actions" }, p.cancel),
    ),
    h("p", { class: "field-hint import-progress-hint" }, text.hint),
  );
  draw(p, state);
  return {
    element,
    focusTarget: heading,
    update: (next) => draw(p, next),
  };
}
