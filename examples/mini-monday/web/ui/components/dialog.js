/**
 * Modal dialogs on `<dialog>`: an inert background from the platform plus
 * an explicit focus trap (Tab cycles inside), Escape and backdrop clicks
 * close (after any open popover), and focus returns to the element that
 * opened the dialog.
 *
 * `confirmDialog` and `formDialog` are queued, so an embedded app cannot
 * stack prompts on top of each other; `openDialog` (share dialog, command
 * palette, custom content) is not, so a confirmation can open above it.
 *
 * ```js
 * const dialog = openDialog({ title: "Share", content: (d) => body });
 * await dialog.closed;            // resolves with close(value)
 * await confirmDialog({ title: "Delete board?", message, danger: true });
 * await formDialog({ title: "New doc", fields: [{ name: "title",
 *   label: "Title", required: true, autofocus: true }] });
 * ```
 */

import { h } from "../../dom.js";
import { iconButton } from "./button.js";
import { choiceCards } from "./choice.js";
import { icon } from "./icon.js";
import { closePopover, isPopoverOpen } from "./popover.js";

const MAX_MESSAGE = 1000;
const MAX_BUTTON = 40;
const SIZES = new Set(["sm", "md", "lg"]);
const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])';
let queue = Promise.resolve();
let nextId = 0;

function clip(text, max) {
  const value = String(text);
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Runs `show()` after earlier queued dialogs closed; resolves with its result. */
function enqueue(show) {
  const result = queue.then(show, show);
  queue = result.catch(() => {});
  return result;
}

function trapFocus(dialog, event) {
  if (event.key !== "Tab") return;
  const items = [...dialog.querySelectorAll(FOCUSABLE)].filter(
    (node) =>
      node.offsetParent !== null || node === globalThis.document.activeElement,
  );
  if (items.length === 0) {
    event.preventDefault();
    return;
  }
  const first = items[0];
  const last = items.at(-1);
  const active = globalThis.document.activeElement;
  if (event.shiftKey && (active === first || !dialog.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

function header({ title, description, titleId, descriptionId, close }) {
  return h(
    "header",
    { class: "modal-header" },
    h(
      "div",
      { class: "modal-heading" },
      h("h2", { class: "modal-title", id: titleId }, title),
      description
        ? h("p", { class: "modal-description", id: descriptionId }, description)
        : null,
    ),
    iconButton({
      icon: "close",
      label: "Close dialog",
      className: "modal-close",
      onClick: () => close(null),
    }),
  );
}

/**
 * Opens a modal dialog.
 *
 * @param {{ title: string, description?: string,
 *   content: Node | ((dialog: object) => Node),
 *   footer?: Node | ((dialog: object) => Node) | null,
 *   size?: "sm" | "md" | "lg", className?: string,
 *   onSubmit?: (event: SubmitEvent, dialog: object) => void,
 *   onClose?: (value: unknown) => void, dismissible?: boolean }} options
 *   With `onSubmit` the content and footer are wrapped in a `<form>` so
 *   Enter submits.
 * @returns {{ element: HTMLDialogElement, body: HTMLElement,
 *   close(value?: unknown): void, closed: Promise<unknown> }}
 */
export function openDialog(options) {
  const {
    title,
    description,
    size = "md",
    onSubmit,
    dismissible = true,
  } = options;
  const id = (nextId += 1);
  const titleId = `modal-title-${id}`;
  const descriptionId = description ? `modal-description-${id}` : null;
  const doc = globalThis.document;
  const previous = doc.activeElement;
  let resolveClosed;
  const closed = new Promise((resolve) => (resolveClosed = resolve));
  let result = null;
  const element = h("dialog", {
    class: [
      "modal",
      `modal-${SIZES.has(size) ? size : "md"}`,
      options.className,
    ],
    "aria-labelledby": titleId,
    "aria-describedby": descriptionId,
  });
  const body = h("div", { class: "modal-body" });
  const handle = {
    element,
    body,
    closed,
    close(value = null) {
      result = value;
      if (element.open) element.close();
    },
  };
  const resolveNode = (node) =>
    typeof node === "function" ? node(handle) : node;
  body.append(resolveNode(options.content));
  const footerNode = resolveNode(options.footer ?? null);
  const inner = [
    header({ title, description, titleId, descriptionId, close: handle.close }),
    body,
    footerNode ? h("footer", { class: "modal-footer" }, footerNode) : null,
  ];
  const shell = onSubmit
    ? h(
        "form",
        {
          class: "modal-inner dialog-form",
          on: { submit: (event) => onSubmit(event, handle) },
        },
        inner,
      )
    : h("div", { class: "modal-inner" }, inner);
  element.append(shell);
  element.addEventListener("keydown", (event) => trapFocus(element, event));
  element.addEventListener("cancel", (event) => {
    event.preventDefault();
    if (isPopoverOpen()) closePopover();
    else if (dismissible) handle.close(null);
  });
  element.addEventListener("click", (event) => {
    // Only the backdrop area targets the dialog itself.
    if (event.target === element && dismissible) handle.close(null);
  });
  element.addEventListener("close", () => {
    element.remove();
    if (previous?.isConnected) previous.focus();
    options.onClose?.(result);
    resolveClosed(result);
  });
  doc.body.append(element);
  // showModal() focuses the first element marked `autofocus`.
  element.showModal();
  return handle;
}

function actionButtons({ confirmLabel, cancelLabel, danger, focus, close }) {
  return h(
    "div",
    { class: "dialog-actions" },
    h(
      "button",
      {
        type: "button",
        class: "btn btn-secondary",
        autofocus: focus === "cancel",
        on: { click: () => close(null) },
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
  );
}

/** Opens a queued form dialog and resolves with `read(form)` or null. */
function formShell({ title, description, body, buttons, read, size = "sm" }) {
  return enqueue(() => {
    const dialog = openDialog({
      title,
      description,
      size,
      content: body,
      footer: (handle) => actionButtons({ ...buttons, close: handle.close }),
      onSubmit(event, handle) {
        event.preventDefault();
        const form = event.currentTarget;
        if (!form.reportValidity()) return;
        handle.close({ value: read(form) });
      },
    });
    return dialog.closed.then((outcome) => outcome?.value ?? null);
  });
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
  const body = h(
    "div",
    { class: "dialog-body" },
    source
      ? h(
          "p",
          { class: "dialog-source" },
          icon("app", { size: 14 }),
          `Message from the app “${clip(source, 80)}”`,
        )
      : null,
    h("p", { class: "dialog-message" }, clip(message, MAX_MESSAGE)),
  );
  return formShell({
    title,
    body,
    read: () => true,
    buttons: {
      confirmLabel: clip(confirmButton, MAX_BUTTON),
      cancelLabel: clip(cancelButton, MAX_BUTTON),
      danger,
      // Destructive and app-originated prompts default to the safe choice.
      focus: danger || source ? "cancel" : "confirm",
    },
  }).then((value) => value === true);
}

function choiceControl(field, id) {
  return choiceCards({
    name: field.name,
    value: field.value,
    labelledBy: `${id}-label`,
    options: field.options,
    autofocus: field.autofocus,
  });
}

function fieldControl(field, id) {
  const common = {
    id,
    name: field.name,
    required: field.required ?? false,
    autofocus: field.autofocus ?? false,
    "aria-describedby": field.hint ? `${id}-hint` : null,
  };
  if (field.type === "choice") return choiceControl(field, id);
  if (field.type === "select" || field.options) {
    return h(
      "select",
      { ...common, class: "input", value: field.value },
      field.options.map((option) =>
        h("option", { value: option.value }, option.label),
      ),
    );
  }
  if (field.type === "textarea") {
    return h("textarea", {
      ...common,
      class: "input",
      rows: 3,
      maxlength: field.maxLength ?? 2000,
      placeholder: field.placeholder ?? null,
      value: field.value ?? "",
    });
  }
  return h("input", {
    ...common,
    class: "input",
    type: field.type === "email" ? "email" : "text",
    maxlength: field.maxLength ?? 255,
    placeholder: field.placeholder ?? null,
    autocomplete: "off",
    value: field.value ?? "",
  });
}

function fieldRow(field, index) {
  const id = `dialog-field-${field.name}-${index}-${(nextId += 1)}`;
  const isChoice = field.type === "choice";
  return h(
    "div",
    { class: "field" },
    isChoice
      ? h("span", { class: "field-label", id: `${id}-label` }, field.label)
      : h("label", { for: id, class: "field-label" }, field.label),
    fieldControl(field, id),
    field.hint
      ? h("p", { class: "field-hint", id: `${id}-hint` }, field.hint)
      : null,
  );
}

/**
 * Shows a small form. `fields` are `{ name, label, type?: "text" | "email" |
 * "textarea" | "select" | "choice", required?, maxLength?, placeholder?,
 * value?, hint?, options?: { value, label, description?, icon? }[],
 * autofocus? }` ("choice" renders radio cards). Resolves with
 * `{ [name]: trimmed string }` or null when cancelled.
 *
 * @returns {Promise<Record<string, string> | null>}
 */
export function formDialog({
  title,
  description,
  fields,
  submitLabel = "Save",
  size,
}) {
  const body = h("div", { class: "dialog-body" }, fields.map(fieldRow));
  const read = (form) =>
    Object.fromEntries(
      fields.map((field) => [
        field.name,
        String(form.elements.namedItem(field.name)?.value ?? "").trim(),
      ]),
    );
  return formShell({
    title,
    description,
    body,
    read,
    size,
    buttons: { confirmLabel: submitLabel, cancelLabel: "Cancel" },
  });
}
