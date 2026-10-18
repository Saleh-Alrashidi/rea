/**
 * One block's DOM. Text blocks hold a plain-text `contenteditable` element
 * (written with `writeText`, read with `textContent`; never markup), to-dos
 * add a checkbox, lists a marker (numbers come from `listNumbers`),
 * callouts an icon, and dividers a focusable rule. Read-only views use the
 * same structure without editing or the side handle.
 *
 * Content elements are semantic: headings are `<h2>`/`<h3>` (the doc
 * title is the page's `<h1>`), quotes `<blockquote>`, code `<pre>`.
 */

import { h } from "../../dom.js";
import { icon } from "../components/icon.js";
import { blockTypeInfo } from "./blocks.js";
import { isCanonical, plainTextEditable, writeText } from "./caret.js";

const TAGS = {
  heading1: "h2",
  heading2: "h3",
  quote: "blockquote",
  code: "pre",
};

const PLACEHOLDERS = {
  paragraph: "Type “/” for commands",
  heading1: "Heading 1",
  heading2: "Heading 2",
  bulleted: "List item",
  numbered: "List item",
  todo: "To-do",
  quote: "Quote",
  code: "Code",
  callout: "Callout",
};

function handleButton() {
  return h(
    "button",
    {
      type: "button",
      class: "block-handle",
      tabindex: "-1",
      title: "Drag handle: move, turn into or delete (Ctrl+/)",
      "aria-label": "Block actions",
      "aria-haspopup": "menu",
      "aria-expanded": "false",
    },
    icon("drag", { size: 14 }),
  );
}

function dividerContent(readOnly) {
  return h(
    "div",
    {
      class: "block-content block-divider",
      tabindex: readOnly ? null : "0",
      role: readOnly ? null : "group",
      "aria-label": readOnly ? null : "Divider",
    },
    h("hr", { role: "separator" }),
  );
}

function textContent(block, readOnly) {
  const info = blockTypeInfo(block.type);
  const editable = !readOnly;
  return h(TAGS[block.type] ?? "div", {
    class: "block-content",
    contenteditable: editable ? plainTextEditable() : null,
    role: editable ? "textbox" : null,
    "aria-multiline": editable ? "true" : null,
    "aria-label": editable ? info.label : null,
    spellcheck: editable ? (block.type === "code" ? "false" : "true") : null,
    "data-placeholder": editable ? PLACEHOLDERS[block.type] : null,
  });
}

function leadingParts(block, readOnly) {
  if (block.type === "bulleted") {
    return { marker: h("span", { class: "block-marker" }, "•") };
  }
  if (block.type === "numbered") {
    return { marker: h("span", { class: "block-marker" }, "1.") };
  }
  if (block.type === "todo") {
    const checkbox = h("input", {
      type: "checkbox",
      class: "block-check",
      "aria-label": "Done",
      title: readOnly ? null : "Done (Ctrl+Enter)",
      disabled: readOnly,
    });
    return { checkbox };
  }
  if (block.type === "callout") {
    return {
      marker: h(
        "span",
        { class: "block-callout-icon", "aria-hidden": "true" },
        icon("info", { size: 18 }),
      ),
    };
  }
  return {};
}

/**
 * Builds the view of `block`.
 * @returns {{ id: string, type: string, readOnly: boolean,
 *   element: HTMLElement, content: HTMLElement, marker?: HTMLElement,
 *   checkbox?: HTMLInputElement, handle?: HTMLButtonElement }}
 */
export function createBlockView(block, { readOnly }) {
  const content =
    block.type === "divider"
      ? dividerContent(readOnly)
      : textContent(block, readOnly);
  const parts = leadingParts(block, readOnly);
  const handle = readOnly ? null : handleButton();
  const element = h(
    "div",
    {
      class: ["doc-block", `block-${block.type}`],
      dataset: { blockId: block.id },
    },
    handle ? h("div", { class: "block-gutter" }, handle) : null,
    parts.marker ?? null,
    parts.checkbox ?? null,
    content,
  );
  return {
    id: block.id,
    type: block.type,
    readOnly,
    element,
    content,
    handle,
    ...parts,
  };
}

/**
 * Brings `view` up to date with `block` (text, checked state and list
 * number). The text is rewritten only when it differs, so the caret of a
 * block being typed into stays put.
 */
export function updateBlockView(view, block, number) {
  if (block.type !== "divider") {
    const current = view.content.textContent;
    if (current !== block.text || !isCanonical(view.content, block.text)) {
      writeText(view.content, block.text);
    }
  }
  if (view.checkbox) {
    view.checkbox.checked = Boolean(block.checked);
    view.element.classList.toggle("is-checked", Boolean(block.checked));
  }
  if (block.type === "numbered" && view.marker) {
    view.marker.textContent = `${number ?? 1}.`;
  }
}
