/**
 * Focus and typing preservation across re-renders. Interactive elements
 * carry `data-focus-key`; before a region is rebuilt its focused element is
 * recorded (with any unsaved text and the selection) and moved onto the
 * element with the same key afterwards.
 */

const EDITABLE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/**
 * Attribute set on a region while it is rebuilt. Editors check it (via
 * `isRebuilding`) so the blur caused by their removal commits nothing.
 */
export const RENDERING = "data-rendering";

/** Returns true while `element`'s region is being rebuilt. */
export function isRebuilding(element) {
  return element.closest(`[${RENDERING}]`) !== null;
}

function activeElement() {
  return globalThis.document.activeElement;
}

/** Finds the element in `root` whose `data-focus-key` equals `key`. */
export function findByFocusKey(root, key) {
  for (const node of root.querySelectorAll("[data-focus-key]")) {
    if (node.dataset.focusKey === key) return node;
  }
  return null;
}

function readSelection(element) {
  try {
    const { selectionStart, selectionEnd } = element;
    return selectionStart === null ? null : [selectionStart, selectionEnd];
  } catch {
    return null;
  }
}

/**
 * Records focus inside `container`. Returns null when focus is elsewhere,
 * `{ blocked: true }` when an editable element without a focus key, or a
 * number input with unparsable text, has focus (the region must not be
 * rebuilt), or `{ key, value?, selection? }`.
 */
export function snapshotFocus(container) {
  const active = activeElement();
  if (!active || !container.contains(active)) return null;
  // A number input holding text that is not a number reports "" as its
  // value, so its text cannot move to a new element: the region waits.
  if (active.validity?.badInput) return { blocked: true };
  const key = active.dataset?.focusKey;
  if (!key) return EDITABLE_TAGS.has(active.tagName) ? { blocked: true } : null;
  const snapshot = { key };
  const dirty =
    active.tagName !== "SELECT" &&
    typeof active.value === "string" &&
    active.value !== active.defaultValue;
  if (dirty) snapshot.value = active.value;
  snapshot.selection = readSelection(active);
  return snapshot;
}

/** Moves focus (and unsaved text) onto the re-rendered element. */
export function restoreFocus(container, snapshot) {
  if (!snapshot?.key) return;
  const target = findByFocusKey(container, snapshot.key);
  if (!target) return;
  if (snapshot.value !== undefined) target.value = snapshot.value;
  target.focus({ preventScroll: true });
  if (!snapshot.selection) return;
  try {
    target.setSelectionRange(...snapshot.selection);
  } catch {
    // Some input types (date, number) have no text selection.
  }
}
