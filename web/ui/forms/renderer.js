/**
 * The form renderer shared by the public form page (`form-page.js`) and
 * the builder's live preview (`pages/form-builder.js`), so both show a
 * form exactly the same way. It renders a normalized definition
 * (`answers.js`): an accent-colored header, one labelled field per
 * question (status as radio chips, date and number inputs), client-side
 * required checks, a honeypot field hidden from people and assistive
 * technology (live mode only), and the confirmation screen.
 *
 * Submitting is the caller's job (`options.submit`, which resolves with a
 * `public-api.js` outcome); the renderer shows what the outcome means. In
 * preview mode nothing is sent: valid answers show the confirmation with a
 * "nothing was recorded" note.
 *
 * ```js
 * const view = renderForm(definition, { submit: (body) => submitAnswers(token, body) });
 * root.append(view.element);
 * renderForm(definition, { mode: "preview", headingLevel: 2, values: old.values() });
 * ```
 */

import { h } from "../../dom.js";
import { textColorOn } from "../board/values.js";
import { button } from "../components/button.js";
import { icon } from "../components/icon.js";
import { validateAnswers } from "./answers.js";
import { buildField, readValue, setError } from "./fields.js";

let nextId = 0;

/** What the page shows when a form can't be used (by outcome reason). */
export const FORM_MESSAGES = Object.freeze({
  unknown: {
    icon: "search",
    title: "This form isn’t available",
    text: "The link may be mistyped, or the form’s link was replaced. Ask whoever shared it for a new one.",
  },
  closed: {
    icon: "lock",
    title: "This form is closed",
    text: "It isn’t accepting responses right now.",
  },
  signin: {
    icon: "person",
    title: "Sign in to respond",
    text: "This form is only for members of the Worklane account. Sign in, then open the link again.",
  },
  rate_limited: {
    icon: "clock",
    title: "Too many responses",
    text: "Responses from this device are paused for a minute. Your answers are still here; try again shortly.",
  },
  unavailable: {
    icon: "alert",
    title: "Couldn’t reach the form",
    text: "Check your connection and try again.",
  },
});

/**
 * A message panel for `reason` (a `FORM_MESSAGES` key).
 * @param {string} reason
 * @param {{ headingLevel?: 1 | 2, action?: Node }} [options]
 */
export function formMessage(reason, { headingLevel = 1, action } = {}) {
  const info = FORM_MESSAGES[reason] ?? FORM_MESSAGES.unavailable;
  return h(
    "section",
    { class: "fr-message", role: "status" },
    h("span", { class: "fr-message-icon" }, icon(info.icon, { size: 24 })),
    h(`h${headingLevel}`, { class: "fr-message-title" }, info.title),
    h("p", { class: "fr-message-text" }, info.text),
    action ?? null,
  );
}

// --------------------------------------------------------------- state

function readValues(r) {
  return Object.fromEntries(
    [...r.fields].map(([id, field]) => [id, readValue(field)]),
  );
}

function validate(r) {
  const values = readValues(r);
  const result = validateAnswers(r.definition.questions, values);
  for (const [id, field] of r.fields) {
    // A number input holding text reports an empty value and `badInput`.
    if (field.controls[0]?.validity?.badInput && !result.errors[id]) {
      result.errors[id] = "Enter a number, like 42 or 3.5";
    }
  }
  return result;
}

function showErrors(r, errors) {
  for (const [id, field] of r.fields) setError(field, errors[id] ?? null);
}

function setSummary(r, message, tone = "danger") {
  r.summary.hidden = !message;
  r.summary.className = `banner banner-${tone} fr-summary`;
  r.summary.replaceChildren(
    ...(message ? [icon("alert"), h("span", null, message)] : []),
  );
}

function focusField(r, questionId) {
  const field = r.fields.get(questionId);
  field?.controls[0]?.focus();
}

function setBusy(r, busy) {
  r.busy = busy;
  r.submitButton.disabled = busy;
  r.submitButton.setAttribute("aria-busy", busy ? "true" : "false");
  r.submitLabel.textContent = busy ? "Sending…" : "Submit";
}

// ------------------------------------------------------------ screens

function honeypot(r) {
  const id = `${r.prefix}-website`;
  r.honeypot = h("input", {
    id,
    name: "website",
    type: "text",
    tabindex: "-1",
    autocomplete: "off",
    value: "",
  });
  // Off-screen (not display:none, which some bots skip) and removed from
  // the accessibility tree; people never see or reach it.
  return h(
    "div",
    { class: "fr-honeypot", "aria-hidden": "true" },
    h("label", { for: id }, "Leave this field empty"),
    r.honeypot,
  );
}

function formElement(r, values) {
  const { questions } = r.definition;
  r.fields = new Map(
    questions.map((question) => [
      question.id,
      buildField({
        prefix: r.prefix,
        question,
        value: values[question.id] ?? "",
      }),
    ]),
  );
  r.summary = h("div", { class: "fr-summary", role: "alert", hidden: true });
  r.submitLabel = h("span", { class: "btn-label" }, "Submit");
  r.submitButton = h(
    "button",
    { type: "submit", class: "btn btn-primary fr-submit" },
    r.submitLabel,
  );
  const preview = r.mode === "preview";
  return h(
    "form",
    {
      class: "fr-form",
      novalidate: true,
      "aria-labelledby": r.titleId,
      on: { submit: (event) => onSubmit(r, event) },
    },
    questions.some((question) => question.required)
      ? h(
          "p",
          { class: "fr-required-note" },
          "Questions marked * are required.",
        )
      : null,
    [...r.fields.values()].map((field) => field.wrapper),
    preview ? null : honeypot(r),
    r.summary,
    h(
      "div",
      { class: "fr-actions" },
      r.submitButton,
      preview
        ? h(
            "p",
            { class: "fr-preview-note" },
            icon("eye", { size: 14 }),
            "Preview: submitting here records nothing.",
          )
        : null,
    ),
  );
}

function showForm(r, values = {}) {
  r.body.replaceChildren(formElement(r, values));
}

function successScreen(r, { message, preview }) {
  const again = button({
    label: preview ? "Back to the form" : "Submit another response",
    variant: "secondary",
    onClick() {
      showForm(r, preview ? r.lastValues : {});
      [...r.fields.values()][0]?.controls[0]?.focus();
    },
  });
  return h(
    "section",
    { class: "fr-success", role: "status", tabindex: "-1" },
    h("span", { class: "fr-success-icon" }, icon("check", { size: 28 })),
    h(
      `h${r.headingLevel + 1}`,
      { class: "fr-success-title" },
      preview ? "Preview of the confirmation" : "Response sent",
    ),
    h("p", { class: "fr-success-text" }, message),
    preview
      ? h("p", { class: "fr-preview-note" }, "Nothing was recorded.")
      : null,
    again,
  );
}

function showScreen(r, screen) {
  r.body.replaceChildren(screen);
  screen.focus?.({ preventScroll: false });
}

/** Shows what a submit outcome means (see `public-api.js`). */
function applyOutcome(r, outcome) {
  if (outcome.ok) {
    const message = outcome.message || r.definition.submit_message;
    showScreen(r, successScreen(r, { message, preview: false }));
    return;
  }
  if (outcome.reason === "invalid") {
    showErrors(r, outcome.fields ?? {});
    const ids = Object.keys(outcome.fields ?? {});
    const general = (outcome.messages ?? []).join(" ");
    setSummary(r, general || "Some answers need another look.");
    if (ids.length > 0) focusField(r, ids[0]);
    return;
  }
  if (outcome.reason === "rate_limited" || outcome.reason === "unavailable") {
    const info = FORM_MESSAGES[outcome.reason];
    setSummary(r, `${info.title}. ${info.text}`, "warning");
    return;
  }
  const level = r.headingLevel + 1;
  const panel = formMessage(outcome.reason, { headingLevel: level });
  panel.tabIndex = -1;
  showScreen(r, panel);
}

async function onSubmit(r, event) {
  event.preventDefault();
  if (r.busy) return;
  const { answers, errors } = validate(r);
  showErrors(r, errors);
  const invalid = Object.keys(errors);
  if (invalid.length > 0) {
    const count =
      invalid.length === 1
        ? "1 answer needs"
        : `${invalid.length} answers need`;
    setSummary(r, `${count} attention.`);
    focusField(r, invalid[0]);
    return;
  }
  setSummary(r, null);
  if (r.mode === "preview") {
    r.lastValues = readValues(r);
    const message = r.definition.submit_message;
    showScreen(r, successScreen(r, { message, preview: true }));
    return;
  }
  setBusy(r, true);
  let outcome;
  try {
    outcome = await r.submit({ answers, website: r.honeypot.value });
  } catch {
    outcome = { ok: false, reason: "unavailable" };
  }
  setBusy(r, false);
  applyOutcome(r, outcome);
}

/**
 * Renders `definition` (normalized, see `answers.js`).
 *
 * @param {object} definition
 * @param {{ mode?: "live" | "preview", headingLevel?: 1 | 2,
 *   values?: Record<string, string>,
 *   submit?: (body: { answers: Record<string, string>, website: string })
 *     => Promise<object> }} [options]
 * @returns {{ element: HTMLElement, values(): Record<string, string> }}
 */
export function renderForm(definition, options = {}) {
  const prefix = `fr-${(nextId += 1)}`;
  const r = {
    definition,
    prefix,
    titleId: `${prefix}-title`,
    mode: options.mode === "preview" ? "preview" : "live",
    headingLevel: options.headingLevel === 2 ? 2 : 1,
    submit:
      options.submit ?? (async () => ({ ok: false, reason: "unavailable" })),
    busy: false,
    fields: new Map(),
    lastValues: {},
    body: h("div", { class: "fr-body" }),
  };
  const element = h(
    "article",
    {
      class: ["fr", r.mode === "preview" && "fr-preview"],
      "aria-labelledby": r.titleId,
    },
    h(
      "header",
      { class: "fr-header" },
      h(
        `h${r.headingLevel}`,
        { class: "fr-title", id: r.titleId },
        definition.title,
      ),
      definition.description
        ? h("p", { class: "fr-description" }, definition.description)
        : null,
    ),
    r.body,
  );
  element.style.setProperty("--fr-accent", definition.accent_color);
  element.style.setProperty(
    "--fr-accent-text",
    textColorOn(definition.accent_color),
  );
  showForm(r, options.values ?? {});
  return {
    element,
    values: () => (r.body.querySelector("form") ? readValues(r) : r.lastValues),
  };
}
