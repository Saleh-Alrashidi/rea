/**
 * Step 1, "Choose source" (SPEC-4 §6.1): a card per source (monday.com,
 * ClickUp, CSV, monday Excel export) with a one-line explanation, then the
 * chosen source's form — where to find the token or export, the token
 * field or the file picker, the scan options (`source-fields.js`) — and
 * "Scan".
 *
 * The token field is `type="password"` with `autocomplete="off"`; its
 * value is read once on submit, handed to `onScanToken` (which sends the
 * request) and cleared right after. It is never kept in state or storage.
 * Files are checked (`sources.checkFile`) and limits (`limitProblems`)
 * before anything is sent; a refused field says why and gets focus.
 *
 * Messages sit right under the heading, where they are seen: a failed or
 * cancelled scan (the step then opens with focus on it, and a rejected
 * token marks the token field), a parked review to return to, and a job
 * from before a reload to follow or cancel.
 *
 * `sourceStep(props)` → `{ element, update(state), focusTarget }`; `props`
 * are `{ state, choices, onChoose(source), onScanToken({ token, options
 * }), onScanFile({ file, kind }), onResume(), onFollow(),
 * onCancelEarlier() }`, `choices` the page's `{ [source]: { flags, limits
 * } }`.
 */

import { h } from "../../dom.js";
import { button } from "../components/button.js";
import { icon } from "../components/icon.js";
import { fileFields, showFile, tokenFields } from "./source-fields.js";
import {
  IMPORT_SOURCES,
  checkFile,
  limitProblems,
  scanOptions,
  sourceOf,
} from "./sources.js";
import { messageBanner, stepHeading } from "./step-parts.js";

function sourceCard(s, info) {
  const input = h("input", {
    class: "import-source-input",
    type: "radio",
    name: "import-source",
    value: info.id,
    checked: s.state.source === info.id,
    disabled: s.state.pending,
    dataset: { focusKey: `source:${info.id}` },
    on: { change: () => s.props.onChoose(info.id) },
  });
  return h(
    "label",
    { class: "import-source" },
    input,
    h(
      "span",
      { class: "import-source-card" },
      h("span", { class: "import-source-icon" }, icon(info.icon, { size: 20 })),
      h(
        "span",
        { class: "import-source-text" },
        h("span", { class: "import-source-label" }, info.label),
        h("span", { class: "import-source-description" }, info.description),
      ),
      h(
        "span",
        { class: "import-source-check", "aria-hidden": "true" },
        icon("check", { size: 14 }),
      ),
    ),
  );
}

function whereHint(info) {
  return h(
    "p",
    { class: "import-where" },
    icon("info", { size: 16 }),
    h("span", null, info.where),
  );
}

/** Marks each limit field with its problem; → the first refused input. */
function markLimits(s) {
  const problems = limitProblems(s.choices.limits);
  let first = null;
  for (const [key, { input, error }] of Object.entries(s.limitInputs)) {
    const problem = problems[key] ?? "";
    error.textContent = problem;
    error.hidden = problem === "";
    input.setAttribute("aria-invalid", problem ? "true" : "false");
    first ??= problem ? input : null;
  }
  return first;
}

function submitToken(s, info) {
  const token = s.tokenInput.value.trim();
  s.tokenError.textContent = token ? "" : `Paste your ${info.tokenLabel}.`;
  s.tokenError.hidden = Boolean(token);
  s.tokenInput.setAttribute("aria-invalid", token ? "false" : "true");
  if (!token) {
    s.tokenInput.focus();
    return;
  }
  const refused = markLimits(s);
  if (refused) {
    s.limitDetails.open = true;
    refused.focus();
    return;
  }
  const options = scanOptions(info.id, s.choices);
  s.props.onScanToken({ token, options });
  // The request already holds the token: nothing else may.
  s.tokenInput.value = "";
}

function submit(s, info, event) {
  event.preventDefault();
  if (s.state.pending) return;
  if (info.input === "token") return submitToken(s, info);
  const problem = checkFile(s.file, info.id);
  if (problem) {
    showFile(s, info);
    s.fileError.textContent = problem;
    s.fileError.hidden = false;
    s.fileInput.focus();
    return;
  }
  s.props.onScanFile({ file: s.file, kind: info.kind });
}

function sourceForm(s) {
  const info = sourceOf(s.state.source);
  if (!info) {
    return h(
      "p",
      { class: "import-pick-hint muted" },
      "Pick a source to see what you need.",
    );
  }
  const all = s.props.choices ?? {};
  all[info.id] ??= { flags: {}, limits: {} };
  s.choices = all[info.id];
  s.file = null;
  s.scanLabel = info.input === "token" ? `Scan ${info.label}` : "Scan file";
  s.scanButton = button({
    label: s.scanLabel,
    icon: "search",
    variant: "primary",
    type: "submit",
    className: "import-scan",
  });
  const headingId = `import-form-${info.id}`;
  return h(
    "form",
    {
      class: "panel import-form",
      "aria-labelledby": headingId,
      novalidate: true,
      on: { submit: (event) => submit(s, info, event) },
    },
    h(
      "div",
      { class: "panel-header" },
      h(
        "h3",
        { class: "panel-title", id: headingId },
        icon(info.icon),
        info.input === "token"
          ? `Connect ${info.label}`
          : `Upload a ${info.label}`,
      ),
    ),
    h(
      "div",
      { class: "panel-body import-form-body" },
      whereHint(info),
      info.input === "token" ? tokenFields(s, info) : fileFields(s, info),
      h("div", { class: "import-actions" }, s.scanButton),
    ),
  );
}

const sourceName = (id) => sourceOf(id)?.label ?? "the source";

/** The banner of a job from before (a reload) or a parked review. */
function offerBanner(s) {
  const { earlier, parked } = s.state;
  const action = (label, onClick, variant = "secondary") =>
    button({ label, size: "sm", variant, onClick });
  if (parked) {
    return messageBanner({
      tone: "info",
      text: `Your scan of ${parked.preview?.source_label ?? "the source"} is kept for 30 minutes.`,
      actions: [action("Return to the review", s.props.onResume, "primary")],
    });
  }
  if (!earlier) return null;
  const what = earlier.kind === "import" ? "An import" : "A scan";
  const from = `${what} from ${sourceName(earlier.source)}`;
  if (earlier.state === "running") {
    return messageBanner({
      tone: "info",
      text: `${from} that you started earlier is still running.`,
      actions: [
        action("Follow it", s.props.onFollow, "primary"),
        action("Cancel it", s.props.onCancelEarlier),
      ],
    });
  }
  return messageBanner({
    tone: "info",
    text: `${from} that you started earlier is ready to review.`,
    actions: [action("Return to the review", s.props.onFollow, "primary")],
  });
}

function drawBanner(s) {
  const { error, notice } = s.state;
  s.message = error
    ? messageBanner({
        tone: "danger",
        text: error.message,
        details: error.detail ? [error.detail] : [],
      })
    : notice
      ? messageBanner({ tone: "info", text: notice })
      : null;
  s.message?.setAttribute("tabindex", "-1");
  s.banner.replaceChildren(...[s.message, offerBanner(s)].filter(Boolean));
  // A rejected token is the token field's problem.
  if (s.tokenInput && error?.code === "INVALID_TOKEN") {
    s.tokenError.textContent = error.message;
    s.tokenError.hidden = false;
    s.tokenInput.setAttribute("aria-invalid", "true");
  }
}

function drawPending(s) {
  if (!s.scanButton) return;
  const { pending } = s.state;
  s.scanButton.disabled = pending;
  s.scanButton.querySelector(".btn-label").textContent = pending
    ? "Starting…"
    : s.scanLabel;
}

/** Builds the step (see the module comment). */
export function sourceStep(props) {
  const s = { props, state: props.state, scanButton: null, message: null };
  s.banner = h("div", { class: "import-banner-slot" });
  s.formSlot = h("div", { class: "import-form-slot" });
  const heading = stepHeading("Choose what to import");
  const cards = h(
    "div",
    {
      class: "import-sources",
      role: "radiogroup",
      "aria-labelledby": "import-step-title",
    },
    Object.values(IMPORT_SOURCES).map((info) => sourceCard(s, info)),
  );
  const drawForm = () => {
    s.scanButton = null;
    s.tokenInput = null;
    s.formSlot.replaceChildren(sourceForm(s));
  };
  drawForm();
  drawBanner(s);
  const element = h(
    "section",
    {
      class: "import-step import-step-source",
      "aria-labelledby": "import-step-title",
    },
    heading,
    s.banner,
    h(
      "p",
      { class: "import-step-text" },
      "Bring Spaces, boards, items, people, updates and docs into Worklane. Nothing changes in the source.",
    ),
    cards,
    s.formSlot,
  );
  return {
    element,
    /** The failure or notice the step opened with, else the heading. */
    get focusTarget() {
      return s.message ?? heading;
    },
    update(state) {
      const changed = state.source !== s.state.source;
      s.state = state;
      for (const input of cards.querySelectorAll("input")) {
        input.disabled = state.pending;
        input.checked = input.value === state.source;
      }
      if (changed) drawForm();
      drawBanner(s);
      drawPending(s);
    },
  };
}
