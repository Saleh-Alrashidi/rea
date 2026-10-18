/**
 * The fields of the source step's form (`source-step.js`): the token
 * field, the scan options and limits of a token source, and the file
 * picker of a file source. Each builder records its nodes on the step's
 * record `s` (`s.tokenInput`, `s.limitInputs`, `s.fileInput`, …) so the
 * step can read and check them on submit.
 *
 * Options and limits read from and write to `s.choices` (`{ flags,
 * limits }` of this source, kept by the page between scans), so a retry
 * after a failed scan starts from the same choices. The token is never
 * part of them.
 */

import { h } from "../../dom.js";
import { icon } from "../components/icon.js";
import {
  MAX_FILE_BYTES,
  SCAN_LIMITS,
  checkFile,
  formatBytes,
} from "./sources.js";

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

function limitField(s, limit) {
  const { limits } = s.choices;
  const id = `import-limit-${limit.key}`;
  const input = h("input", {
    id,
    class: "input",
    type: "number",
    min: 1,
    max: limit.max,
    step: 1,
    inputmode: "numeric",
    value: limits[limit.key] ?? "",
    placeholder: limit.max.toLocaleString("en-US"),
    "aria-describedby": `${id}-error`,
    on: { input: (event) => (limits[limit.key] = event.currentTarget.value) },
  });
  const error = h("p", {
    class: "import-field-error",
    id: `${id}-error`,
    hidden: true,
  });
  s.limitInputs[limit.key] = { input, error };
  return h(
    "div",
    { class: "field" },
    h("label", { class: "field-label", for: id }, limit.label),
    input,
    error,
  );
}

function limitFields(s) {
  s.limitInputs = {};
  const filled = SCAN_LIMITS.some((limit) => s.choices.limits[limit.key]);
  s.limitDetails = h(
    "details",
    { class: "import-limits", open: filled },
    h("summary", null, "Scan limits"),
    h(
      "p",
      { class: "field-hint" },
      "Stop the scan early, for example to try a few boards first. Empty fields use the maximum.",
    ),
    h(
      "div",
      { class: "import-limit-grid" },
      SCAN_LIMITS.map((limit) => limitField(s, limit)),
    ),
  );
  return s.limitDetails;
}

/** The token field, the options and the limits of a token source. */
export function tokenFields(s, info) {
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
    optionChecks(info, s.choices.flags),
    limitFields(s),
  ];
}

/** Shows the picked file and why it cannot be scanned, if it cannot. */
export function showFile(s, info) {
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

/** The file picker (with a drop zone) of a file source. */
export function fileFields(s, info) {
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
