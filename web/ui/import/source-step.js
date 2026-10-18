/**
 * Step 1, "Choose source" (SPEC-4 §6.1): a card per source (monday.com,
 * ClickUp, CSV, monday Excel export) with a one-line explanation, then the
 * chosen source's form — where to find the token or export, the token
 * field or the file picker, the scan options — and "Scan".
 *
 * The token field is `type="password"` with `autocomplete="off"`; its
 * value is read once on submit, handed to `onScanToken` (which sends the
 * request) and cleared right after. It is never kept in state or storage.
 * Files are checked (`sources.checkFile`) before anything is sent.
 *
 * `sourceStep(props)` → `{ element, update(state), focusTarget }`; `props`
 * are `{ state, onChoose(source), onScanToken({ token, options }),
 * onScanFile({ file, kind }) }`.
 */

import { h } from "../../dom.js";
import { button } from "../components/button.js";
import { icon } from "../components/icon.js";
import {
  IMPORT_SOURCES,
  MAX_FILE_BYTES,
  SCAN_LIMITS,
  checkFile,
  formatBytes,
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

function optionChecks(info, flags) {
  if (info.options.length === 0) return null;
  return h(
    "fieldset",
    { class: "import-fieldset" },
    h("legend", { class: "field-label" }, "Include"),
    h(
      "div",
      { class: "import-checks" },
      info.options.map((option) =>
        h(
          "label",
          { class: "import-check" },
          h("input", {
            type: "checkbox",
            checked: flags[option.key] !== false,
            on: {
              change: (event) =>
                (flags[option.key] = event.currentTarget.checked),
            },
          }),
          h(
            "span",
            { class: "import-check-text" },
            h("span", null, option.label),
            h("span", { class: "field-hint" }, option.hint),
          ),
        ),
      ),
    ),
  );
}

function limitFields(limits) {
  return h(
    "details",
    { class: "import-limits" },
    h("summary", null, "Scan limits"),
    h(
      "p",
      { class: "field-hint" },
      "Stop the scan early, for example to try a few boards first. Empty fields use the maximum.",
    ),
    h(
      "div",
      { class: "import-limit-grid" },
      SCAN_LIMITS.map((limit) => {
        const id = `import-limit-${limit.key}`;
        return h(
          "div",
          { class: "field" },
          h("label", { class: "field-label", for: id }, limit.label),
          h("input", {
            id,
            class: "input",
            type: "number",
            min: 1,
            max: limit.max,
            step: 1,
            inputmode: "numeric",
            placeholder: limit.max.toLocaleString("en-US"),
            on: {
              input: (event) => (limits[limit.key] = event.currentTarget.value),
            },
          }),
        );
      }),
    ),
  );
}

function tokenFields(s, info) {
  const id = `import-token-${info.id}`;
  s.tokenInput = h("input", {
    id,
    class: "input import-token",
    type: "password",
    autocomplete: "off",
    autocapitalize: "off",
    spellcheck: "false",
    required: true,
    maxlength: 4096,
    "aria-describedby": `${id}-hint ${id}-error`,
  });
  s.tokenError = h("p", {
    class: "import-field-error",
    id: `${id}-error`,
    role: "alert",
    hidden: true,
  });
  return [
    h(
      "div",
      { class: "field" },
      h("label", { class: "field-label", for: id }, info.tokenLabel),
      s.tokenInput,
      h(
        "span",
        { class: "field-hint", id: `${id}-hint` },
        "Used once for this scan, then forgotten. Worklane never stores or shows it.",
      ),
      s.tokenError,
    ),
    optionChecks(info, s.flags),
    limitFields(s.limits),
  ];
}

function showFile(s, info) {
  const { file } = s;
  const problem = file ? checkFile(file, info.id) : null;
  s.fileStatus.replaceChildren(
    file
      ? h(
          "span",
          { class: ["import-file-name", problem && "invalid"] },
          icon(problem ? "alert" : "check", { size: 14 }),
          h("span", null, `${file.name} · ${formatBytes(file.size)}`),
        )
      : h("span", { class: "muted" }, "No file chosen"),
  );
  s.fileError.textContent = problem ?? "";
  s.fileError.hidden = !problem;
}

function fileFields(s, info) {
  const id = `import-file-${info.id}`;
  const pick = (file) => {
    s.file = file ?? null;
    showFile(s, info);
  };
  s.fileInput = h("input", {
    id,
    class: ["import-file-input", "visually-hidden"],
    type: "file",
    accept: info.accept,
    required: true,
    "aria-describedby": `${id}-status ${id}-error`,
    on: { change: (event) => pick(event.currentTarget.files?.[0]) },
  });
  s.fileStatus = h("span", { class: "import-file-status", id: `${id}-status` });
  s.fileError = h("p", {
    class: "import-field-error",
    id: `${id}-error`,
    role: "alert",
    hidden: true,
  });
  const zone = h(
    "label",
    {
      class: "import-drop",
      for: id,
      on: {
        dragover: (event) => {
          event.preventDefault();
          zone.classList.add("dragging");
        },
        dragleave: () => zone.classList.remove("dragging"),
        drop: (event) => {
          event.preventDefault();
          zone.classList.remove("dragging");
          pick(event.dataTransfer?.files?.[0]);
        },
      },
    },
    icon("inbox", { size: 24 }),
    h("span", { class: "import-drop-title" }, "Choose a file or drop it here"),
    h(
      "span",
      { class: "field-hint" },
      `${info.extensions.join(", ")} · up to ${formatBytes(MAX_FILE_BYTES)}`,
    ),
  );
  showFile(s, info);
  return [
    h(
      "div",
      { class: "field" },
      h("span", { class: "field-label" }, info.label),
      s.fileInput,
      zone,
      s.fileStatus,
      s.fileError,
    ),
  ];
}

function submit(s, info, event) {
  event.preventDefault();
  if (s.state.pending) return;
  if (info.input === "token") {
    const token = s.tokenInput.value.trim();
    s.tokenError.textContent = token ? "" : `Paste your ${info.tokenLabel}.`;
    s.tokenError.hidden = Boolean(token);
    s.tokenInput.setAttribute("aria-invalid", token ? "false" : "true");
    if (!token) {
      s.tokenInput.focus();
      return;
    }
    const options = scanOptions(info.id, { flags: s.flags, limits: s.limits });
    s.props.onScanToken({ token, options });
    // The request already holds the token: nothing else may.
    s.tokenInput.value = "";
    return;
  }
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
  s.flags = {};
  s.limits = {};
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

function drawBanner(s) {
  const { error, notice } = s.state;
  s.banner.replaceChildren(
    error
      ? messageBanner({ tone: "danger", text: error.message })
      : notice
        ? messageBanner({ tone: "info", text: notice })
        : "",
  );
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
  const s = { props, state: props.state, scanButton: null };
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
    s.formSlot.replaceChildren(sourceForm(s));
  };
  drawBanner(s);
  drawForm();
  const element = h(
    "section",
    {
      class: "import-step import-step-source",
      "aria-labelledby": "import-step-title",
    },
    heading,
    h(
      "p",
      { class: "import-step-text" },
      "Bring workspaces, boards, items, people, updates and docs into Worklane. Nothing changes in the source.",
    ),
    cards,
    s.banner,
    s.formSlot,
  );
  return {
    element,
    focusTarget: heading,
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
