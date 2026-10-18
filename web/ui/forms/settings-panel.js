/**
 * The form builder's settings: the form's title, description and accent
 * color; who can respond (Public / Signed-in members / Closed), the group
 * new items go to and the confirmation message; and the public link with
 * copy, open and "Regenerate link", next to the response count.
 *
 * Edits are reported as patches of builder fields (`onChange(patch,
 * { immediate })`; text waits for the autosave debounce, choices save at
 * once). Access words come from `labels.js` (`FORM_ACCESS`),
 * the one mapping of `FormAccess` values to labels.
 */

import { h } from "../../dom.js";
import { boardHash, viewHash } from "../../router.js";
import { shareableFormLink } from "../board/forms-view.js";
import { FORM_ACCESS } from "../components/labels.js";
import { button, linkButton } from "../components/button.js";
import { choiceCards } from "../components/choice.js";
import { plural } from "../components/format.js";
import { icon } from "../components/icon.js";
import { DEFAULT_SUBMIT_MESSAGE } from "./answers.js";
import { colorField } from "./color-field.js";

let nextId = 0;

function field({ id, label, hint, control, error = null }) {
  return h(
    "div",
    { class: "field" },
    h("label", { class: "field-label", for: id }, label),
    control,
    error,
    hint ? h("p", { class: "field-hint", id: `${id}-hint` }, hint) : null,
  );
}

function textField(s, { name, label, value, multiline, hint, maxLength }) {
  const id = `${s.prefix}-${name}`;
  const control = h(multiline ? "textarea" : "input", {
    id,
    class: "input",
    type: multiline ? null : "text",
    rows: multiline ? 3 : null,
    maxlength: maxLength,
    value,
    placeholder: name === "submit_message" ? DEFAULT_SUBMIT_MESSAGE : null,
    disabled: s.readOnly,
    required: name === "title",
    "aria-describedby": hint ? `${id}-hint` : null,
    on: {
      input: (event) => s.onChange({ [name]: event.currentTarget.value }),
    },
  });
  const error = h("p", {
    class: "fb-field-error",
    id: `${id}-error`,
    hidden: true,
  });
  s.inputs[name] = { control, error };
  return field({ id, label, hint, control, error });
}

function detailsSection(s) {
  return section(
    "Form details",
    textField(s, {
      name: "title",
      label: "Title",
      value: s.form.title,
      maxLength: 255,
    }),
    textField(s, {
      name: "description",
      label: "Description",
      value: s.form.description,
      multiline: true,
      maxLength: 2000,
      hint: "Shown under the title. Line breaks are kept.",
    }),
    colorField({
      label: "Accent color",
      value: s.form.accent_color,
      disabled: s.readOnly,
      onChange: (color) =>
        s.onChange({ accent_color: color }, { immediate: true }),
    }),
  );
}

function groupSelect(s) {
  const id = `${s.prefix}-group`;
  const control = h(
    "select",
    {
      id,
      class: "input",
      disabled: s.readOnly,
      value: s.form.target_group_id ?? "",
      on: {
        change: (event) =>
          s.onChange(
            { target_group_id: event.currentTarget.value || null },
            { immediate: true },
          ),
      },
    },
    h("option", { value: "" }, "The board’s first group"),
    s.board.groups.map((group) =>
      h("option", { value: group.id }, group.title),
    ),
  );
  return field({
    id,
    label: "Add responses to",
    hint: "Each response becomes an item in this group.",
    control,
  });
}

function responsesSection(s) {
  const labelId = `${s.prefix}-access-label`;
  return section(
    "Responses",
    h(
      "div",
      { class: "field" },
      h("span", { class: "field-label", id: labelId }, "Who can respond"),
      choiceCards({
        name: `${s.prefix}-access`,
        value: s.form.access,
        labelledBy: labelId,
        disabled: s.readOnly,
        options: Object.entries(FORM_ACCESS).map(([value, info]) => ({
          value,
          label: info.label,
          description: `${info.description}.`,
          icon: info.icon,
        })),
        onChange: (access) => s.onChange({ access }, { immediate: true }),
      }),
    ),
    groupSelect(s),
    textField(s, {
      name: "submit_message",
      label: "Confirmation message",
      value: s.form.submit_message,
      multiline: true,
      maxLength: 2000,
      hint: "Shown after someone submits. Leave empty for the default.",
    }),
  );
}

function section(title, ...children) {
  return h(
    "section",
    { class: "panel fb-panel" },
    h(
      "div",
      { class: "panel-header" },
      h("h2", { class: "panel-title" }, title),
    ),
    h("div", { class: "panel-body fb-panel-body" }, children),
  );
}

async function copy(s, url, input) {
  try {
    await globalThis.navigator.clipboard.writeText(url);
    s.toast.success("Form link copied");
  } catch {
    input.focus();
    input.select();
    s.toast.info("Press Ctrl+C (⌘C) to copy the selected link");
  }
}

function linkRow(s) {
  const url = shareableFormLink(s.form);
  if (!url) {
    return h(
      "p",
      { class: "banner banner-info" },
      icon("lock"),
      h(
        "span",
        null,
        "This form is closed, so its link doesn’t accept responses. Choose who can respond to share it again.",
      ),
    );
  }
  const input = h("input", {
    class: "input fb-link-input",
    type: "text",
    readonly: true,
    value: url,
    "aria-label": "Public form link",
    on: { focus: (event) => event.currentTarget.select() },
  });
  const open = h(
    "a",
    {
      class: "btn btn-secondary",
      href: url,
      target: "_blank",
      rel: "noopener noreferrer",
    },
    icon("open"),
    h("span", { class: "btn-label" }, "Open"),
  );
  return h(
    "div",
    { class: "fb-link-row" },
    input,
    h(
      "div",
      { class: "fb-link-actions" },
      button({
        label: "Copy link",
        icon: "copy",
        variant: "primary",
        onClick: () => copy(s, url, input),
      }),
      open,
    ),
  );
}

function renderShare(s) {
  const count = s.form.response_count;
  s.share.replaceChildren(
    h(
      "div",
      { class: "fb-responses" },
      h("span", { class: "fb-responses-count" }, String(count)),
      h(
        "span",
        { class: "fb-responses-text" },
        count === 1 ? "response so far" : "responses so far",
      ),
      linkButton({
        label: "View items",
        icon: "table",
        size: "sm",
        variant: "ghost",
        href: boardHash(s.board.id),
      }),
    ),
    linkRow(s),
    h(
      "div",
      { class: "fb-link-footer" },
      h(
        "p",
        { class: "field-hint" },
        "Regenerating replaces the link; the old one stops working at once.",
      ),
      button({
        label: "Regenerate link",
        icon: "refresh",
        size: "sm",
        variant: "ghost",
        disabledReason: s.readOnly ? "Only editors can do this" : null,
        onClick: () => s.onRegenerate(),
      }),
    ),
  );
}

/**
 * @param {{ form: object, board: object, readOnly?: boolean, toast: object,
 *   onChange: (patch: object, options?: { immediate?: boolean }) => void,
 *   onRegenerate: () => void }} options
 * @returns {{ element: HTMLElement, update(form: object): void,
 *   showProblem(name: string, message: string | null): void }}
 */
export function createSettingsPanel(options) {
  const s = {
    ...options,
    readOnly: Boolean(options.readOnly),
    prefix: `fb-settings-${(nextId += 1)}`,
    inputs: {},
    share: h("div", { class: "fb-share" }),
  };
  renderShare(s);
  const element = h(
    "div",
    { class: "fb-settings" },
    section("Share", s.share),
    detailsSection(s),
    responsesSection(s),
    h(
      "p",
      { class: "fb-board-note" },
      icon("grid", { size: 14 }),
      "Responses go to ",
      h("a", { href: viewHash(s.board.id, { view: "forms" }) }, s.board.name),
      ` · ${plural(s.board.groups.length, "group")}`,
    ),
  );
  return {
    element,
    /** Redraws the link and response count from `form`. */
    update(form) {
      s.form = form;
      renderShare(s);
    },
    /** Shows `message` under the `name` field (null clears it). */
    showProblem(name, message) {
      const entry = s.inputs[name];
      if (!entry) return;
      const { control, error } = entry;
      error.hidden = !message;
      error.textContent = message ?? "";
      if (message) {
        control.setAttribute("aria-invalid", "true");
        control.setAttribute("aria-errormessage", error.id);
      } else {
        control.removeAttribute("aria-invalid");
        control.removeAttribute("aria-errormessage");
      }
    },
  };
}
