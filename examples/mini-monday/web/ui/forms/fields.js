/**
 * Question fields of the form renderer (`renderer.js`): one labelled
 * control per question type (name and other text as inputs, text as a
 * textarea, numbers and dates as native inputs, status as radio chips),
 * help and error text wired with `aria-describedby`, and reading a
 * field's current text. Internal to the renderer.
 */

import { h } from "../../dom.js";
import { button } from "../components/button.js";
import { icon } from "../components/icon.js";

function marker(question) {
  return question.required
    ? h("span", { class: "fr-required", "aria-hidden": "true" }, " *")
    : null;
}

function textControl(question, { id, value, required }) {
  const common = { id, class: "input fr-input", required, value };
  if (question.type === "text") {
    return h("textarea", { ...common, rows: 3, maxlength: 2000 });
  }
  if (question.type === "numbers") {
    const attrs = { type: "number", step: "any", inputmode: "decimal" };
    return h("input", { ...common, ...attrs });
  }
  if (question.type === "date") {
    return h("input", { ...common, type: "date" });
  }
  return h("input", {
    ...common,
    type: "text",
    maxlength: question.type === "name" ? 255 : 2000,
    autocomplete: "off",
  });
}

function inputField(question, ids, value) {
  const control = textControl(question, {
    id: ids.control,
    value,
    required: question.required,
  });
  const wrapper = h(
    "div",
    { class: ["fr-question", `fr-type-${question.type}`] },
    h(
      "label",
      { class: "fr-label", for: ids.control },
      question.label,
      marker(question),
    ),
    question.help
      ? h("p", { class: "fr-help", id: ids.help }, question.help)
      : null,
    control,
  );
  return { wrapper, controls: [control], described: control };
}

function chip(question, { name, option, value }) {
  return h(
    "label",
    { class: "fr-chip" },
    h("input", {
      class: "fr-chip-input",
      type: "radio",
      name,
      value: option,
      required: question.required,
      checked: option === value,
    }),
    h("span", { class: "fr-chip-text" }, option),
  );
}

function choiceField(question, ids, value) {
  const name = ids.control;
  const chips = question.options.map((option) =>
    chip(question, { name, option, value }),
  );
  const radios = chips.map((label) => label.querySelector("input"));
  const clear = question.required
    ? null
    : button({
        label: "Clear choice",
        variant: "ghost",
        size: "sm",
        className: "fr-clear",
        onClick() {
          for (const radio of radios) radio.checked = false;
          radios[0]?.focus();
        },
      });
  const wrapper = h(
    "fieldset",
    { class: ["fr-question", "fr-type-status"] },
    h("legend", { class: "fr-label" }, question.label, marker(question)),
    question.help
      ? h("p", { class: "fr-help", id: ids.help }, question.help)
      : null,
    chips.length > 0
      ? h("div", { class: "fr-chips", id: ids.control }, chips, clear)
      : h("p", { class: "fr-help" }, "There are no options to choose yet."),
  );
  return { wrapper, controls: radios, described: wrapper, radios };
}

/**
 * Builds the field of `question` holding `value`; `prefix` keeps element IDs
 * unique per rendered form.
 * @returns {{ question: object, wrapper: HTMLElement, controls: HTMLElement[],
 *   radios?: HTMLInputElement[], error: HTMLElement, ids: object }}
 */
export function buildField({ prefix, question, value }) {
  const base = `${prefix}-${question.id}`;
  const ids = {
    control: `${base}-input`,
    help: question.help ? `${base}-help` : null,
    error: `${base}-error`,
  };
  const field =
    question.type === "status"
      ? choiceField(question, ids, value)
      : inputField(question, ids, value);
  field.question = question;
  field.ids = ids;
  field.error = h("p", { class: "fr-error", id: ids.error, hidden: true });
  field.wrapper.dataset.questionId = question.id;
  field.wrapper.append(field.error);
  describe(field, false);
  return field;
}

function describe(field, withError) {
  const ids = [field.ids.help, withError ? field.ids.error : null];
  const text = ids.filter(Boolean).join(" ");
  if (text) field.described.setAttribute("aria-describedby", text);
  else field.described.removeAttribute("aria-describedby");
}

/** Shows `message` under the field (or clears it with null). */
export function setError(field, message) {
  field.error.hidden = !message;
  field.error.replaceChildren(
    ...(message ? [icon("alert", { size: 14 }), h("span", null, message)] : []),
  );
  field.wrapper.classList.toggle("has-error", Boolean(message));
  for (const control of field.controls) {
    if (message) control.setAttribute("aria-invalid", "true");
    else control.removeAttribute("aria-invalid");
  }
  describe(field, Boolean(message));
}

/** The field's current text (the checked option for status). */
export function readValue(field) {
  if (field.radios) {
    return field.radios.find((radio) => radio.checked)?.value ?? "";
  }
  return field.controls[0].value;
}
