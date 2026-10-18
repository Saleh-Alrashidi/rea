/**
 * Caret and selection helpers for plain-text `contenteditable` blocks.
 * Offsets count the element's text (`textContent`, UTF-16 units), the same
 * offsets the block model uses; elements other than text (a trailing
 * `<br>` that lets a final line break show) contribute nothing.
 */

const doc = () => globalThis.document;

/** The browser's best `contenteditable` value for plain text. */
let plainMode = null;
export function plainTextEditable() {
  if (plainMode) return plainMode;
  try {
    const probe = doc().createElement("div");
    probe.contentEditable = "plaintext-only";
    plainMode =
      probe.contentEditable === "plaintext-only" ? "plaintext-only" : "true";
  } catch {
    // Older engines reject the value; input handling keeps text plain.
    plainMode = "true";
  }
  return plainMode;
}

/**
 * The selection inside `element` as `{ start, end }` text offsets, or null
 * when the selection is elsewhere.
 */
export function getOffsets(element) {
  const selection = doc().getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!element.contains(range.startContainer)) return null;
  if (!element.contains(range.endContainer)) return null;
  const before = doc().createRange();
  before.selectNodeContents(element);
  before.setEnd(range.startContainer, range.startOffset);
  const start = before.toString().length;
  before.setEnd(range.endContainer, range.endOffset);
  return { start, end: before.toString().length };
}

/** The text node and offset holding text offset `offset` of `element`. */
function locate(element, offset) {
  const walker = doc().createTreeWalker(element, 4 /* SHOW_TEXT */);
  let remaining = offset;
  let last = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (remaining <= node.data.length) return { node, offset: remaining };
    remaining -= node.data.length;
    last = node;
  }
  return last
    ? { node: last, offset: last.data.length }
    : { node: element, offset: 0 };
}

/** Focuses `element` and selects text offsets `start`–`end`. */
export function setCaret(element, start, end = start) {
  element.focus({ preventScroll: true });
  const selection = doc().getSelection();
  if (!selection) return;
  const range = doc().createRange();
  const from = locate(element, start);
  const to = end === start ? from : locate(element, end);
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  selection.removeAllRanges();
  selection.addRange(range);
  scrollIntoViewIfNeeded(element);
}

function scrollIntoViewIfNeeded(element) {
  const box = element.getBoundingClientRect();
  const view = doc().documentElement.clientHeight;
  if (box.top < 64 || box.bottom > view - 24) {
    element.scrollIntoView({ block: "nearest" });
  }
}

/**
 * Writes `text` into `element` as one text node (plus a `<br>` after a
 * final line break, which browsers otherwise do not show).
 */
export function writeText(element, text) {
  element.replaceChildren();
  if (text === "") return;
  element.append(doc().createTextNode(text));
  if (text.endsWith("\n")) {
    const br = doc().createElement("br");
    br.dataset.sentinel = "";
    element.append(br);
  }
}

/** True when `element` holds exactly what `writeText(text)` produces. */
export function isCanonical(element, text) {
  const nodes = element.childNodes;
  if (text === "") return nodes.length === 0;
  const sentinel = text.endsWith("\n");
  if (nodes.length !== (sentinel ? 2 : 1)) return false;
  if (nodes[0].nodeType !== 3) return false;
  return !sentinel || nodes[1].dataset?.sentinel === "";
}

function caretRect() {
  const selection = doc().getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0).cloneRange();
  range.collapse(true);
  const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
  return rect && (rect.height > 0 || rect.top > 0) ? rect : null;
}

function contentBox(element) {
  const box = element.getBoundingClientRect();
  const style = globalThis.getComputedStyle(element);
  const lineHeight =
    Number.parseFloat(style.lineHeight) ||
    Number.parseFloat(style.fontSize) * 1.5 ||
    20;
  return {
    top: box.top + (Number.parseFloat(style.paddingTop) || 0),
    bottom: box.bottom - (Number.parseFloat(style.paddingBottom) || 0),
    lineHeight,
  };
}

/**
 * Whether the caret sits on the first and/or last visual line of
 * `element` (ArrowUp/ArrowDown leave the block from there). Falls back to
 * text offsets when the browser reports no caret rectangle.
 */
export function caretLines(element) {
  const offsets = getOffsets(element);
  const text = element.textContent;
  if (!offsets || text === "") return { first: true, last: true };
  const rect = caretRect();
  if (!rect) {
    return {
      first:
        !text.slice(0, offsets.start).includes("\n") && offsets.start === 0,
      last: offsets.end === text.length,
    };
  }
  const box = contentBox(element);
  return {
    first: rect.top - box.top < box.lineHeight * 0.6,
    last: box.bottom - rect.bottom < box.lineHeight * 0.6,
  };
}

/** The horizontal caret position, for keeping the column across blocks. */
export function caretX() {
  return caretRect()?.left ?? null;
}

function pointCaret(x, y) {
  const d = doc();
  if (typeof d.caretPositionFromPoint === "function") {
    const position = d.caretPositionFromPoint(x, y);
    return position && { node: position.offsetNode, offset: position.offset };
  }
  if (typeof d.caretRangeFromPoint === "function") {
    const range = d.caretRangeFromPoint(x, y);
    return range && { node: range.startContainer, offset: range.startOffset };
  }
  return null;
}

/**
 * Places the caret in `element` at horizontal position `x` on its first
 * (`edge` "top") or last ("bottom") line; falls back to the start or end.
 */
export function placeCaretAtX(element, x, edge) {
  const text = element.textContent;
  const fallback = edge === "top" ? 0 : text.length;
  if (x === null || text === "") {
    setCaret(element, fallback);
    return;
  }
  const box = contentBox(element);
  const y =
    edge === "top"
      ? box.top + box.lineHeight / 2
      : box.bottom - box.lineHeight / 2;
  const hit = pointCaret(x, y);
  if (!hit || !element.contains(hit.node)) {
    setCaret(element, fallback);
    return;
  }
  const before = doc().createRange();
  before.selectNodeContents(element);
  before.setEnd(hit.node, hit.offset);
  setCaret(element, before.toString().length);
}
