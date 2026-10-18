/**
 * In-app modal dialogs built on `<dialog>` (focus containment, Escape and
 * an inert background come from the platform). Dialogs are queued, so an
 * app cannot stack prompts on top of each other.
 */

import { h } from "../dom.js";

const MAX_MESSAGE = 1000;
const MAX_BUTTON = 40;
let queue = Promise.resolve();

function clip(text, max) {
  const value = String(text);
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Runs `show()` after earlier dialogs closed; resolves with its result. */
function enqueue(show) {
  const result = queue.then(show, show);
  queue = result.catch(() => {});
  return result;
}

/**
 * Shows `dialog` modally and resolves with `read(form)` on submit or `null`
 * on cancel/Escape. The dialog is removed afterwards and focus returns to the
 * element focused before it opened.
 */
function present(dialog, { form, read }) {
  return new Promise((resolve) => {
    const doc = globalThis.document;
    const previous = doc.activeElement;
    let result = null;
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      result = read(form);
      dialog.close();
    });
    dialog.addEventListener("close", () => {
      dialog.remove();
      if (previous?.isConnected) previous.focus();
      resolve(result);
    });
    doc.body.append(dialog);
    // showModal() focuses the element marked `autofocus`.
    dialog.showModal();
  });
}

/** `focus` picks the button focused on open: "confirm" or "cancel". */
function dialogShell(options) {
  const { title, body, confirmLabel, cancelLabel, danger, focus } = options;
  const form = h(
    "form",
    { class: "dialog-form" },
    h("h2", { class: "dialog-title" }, title),
    body,
    h(
      "div",
      { class: "dialog-actions" },
      h(
        "button",
        {
          type: "button",
          class: "btn btn-secondary",
          autofocus: focus === "cancel",
          on: { click: () => form.closest("dialog").close() },
        },
        cancelLabel,
      ),
      h(
        "button",
        {
          type: "submit",
          class: ["btn", danger ? "btn-danger" : "btn-primary"],
          autofocus: focus === "confirm",
        },
        confirmLabel,
      ),
    ),
  );
  const dialog = h("dialog", { class: "modal", "aria-label": title }, form);
  return { dialog, form };
}

/**
 * Asks the user to confirm. `source` (an app name) is shown so an embedded
 * app cannot pass its prompt off as the host's own.
 *
 * @param {{ message: string, title?: string, confirmButton?: string,
 *   cancelButton?: string, danger?: boolean, source?: string }} options
 * @returns {Promise<boolean>}
 */
export function confirmDialog(options) {
  const {
    message,
    title = "Are you sure?",
    confirmButton = "Confirm",
    cancelButton = "Cancel",
    danger = false,
    source,
  } = options;
  return enqueue(() => {
    const body = h(
      "div",
      { class: "dialog-body" },
      source
        ? h(
            "p",
            { class: "dialog-source" },
            `Message from the app “${clip(source, 80)}”`,
          )
        : null,
      h("p", { class: "dialog-message" }, clip(message, MAX_MESSAGE)),
    );
    const { dialog, form } = dialogShell({
      title,
      body,
      confirmLabel: clip(confirmButton, MAX_BUTTON),
      cancelLabel: clip(cancelButton, MAX_BUTTON),
      danger,
      // Destructive and app-originated prompts default to the safe choice.
      focus: danger || source ? "cancel" : "confirm",
    });
    return present(dialog, { form, read: () => true });
  }).then((value) => value === true);
}

function fieldControl(field, id) {
  const common = {
    id,
    name: field.name,
    required: field.required ?? false,
    autofocus: field.autofocus ?? false,
  };
  if (field.options) {
    return h(
      "select",
      { ...common, class: "input", value: field.value },
      field.options.map((option) =>
        h("option", { value: option.value }, option.label),
      ),
    );
  }
  return h("input", {
    ...common,
    class: "input",
    type: "text",
    maxlength: field.maxLength ?? 255,
    placeholder: field.placeholder ?? null,
    autocomplete: "off",
    value: field.value ?? "",
  });
}

/**
 * Shows a small form. `fields` are `{ name, label, required?, maxLength?,
 * placeholder?, value?, options?: { value, label }[], autofocus? }`.
 * Resolves with `{ [name]: trimmed string }` or null when cancelled.
 */
export function formDialog({ title, fields, submitLabel = "Save" }) {
  return enqueue(() => {
    const body = h(
      "div",
      { class: "dialog-body" },
      fields.map((field, index) => {
        const id = `dialog-field-${field.name}-${index}`;
        return h(
          "div",
          { class: "field" },
          h("label", { for: id, class: "field-label" }, field.label),
          fieldControl(field, id),
        );
      }),
    );
    const { dialog, form } = dialogShell({
      title,
      body,
      confirmLabel: submitLabel,
      cancelLabel: "Cancel",
    });
    const read = () =>
      Object.fromEntries(
        fields.map((field) => [
          field.name,
          String(form.elements.namedItem(field.name).value).trim(),
        ]),
      );
    return present(dialog, { form, read });
  });
}
