/**
 * Block editor core: the editor record (`ed`), DOM reconciliation by
 * block ID, caret placement and the structural operations shared by the
 * key and input handlers (`editor-input.js`). Every operation applies a
 * pure `blocks.js` result, re-renders and moves the caret explicitly, and
 * records the state it replaces in the editor's undo history
 * (`history.js`); `undoRedo` replays that history.
 */

import { openBlockActions, openSlashMenu } from "./block-menu.js";
import { createBlockView, updateBlockView } from "./block-view.js";
import {
  BLOCK_LIMITS,
  hasText,
  insertLineBreak as insertBreak,
  insertPlainText,
  listNumbers,
  moveBlock,
  removeBlock,
  setBlockType,
  splitBlock,
} from "./blocks.js";
import { caretX, getOffsets, placeCaretAtX, setCaret } from "./caret.js";
import { changedFocus } from "./history.js";

export const LIMIT_MESSAGE = `A block holds up to ${BLOCK_LIMITS.text.toLocaleString("en-US")} characters.`;
export const FULL_MESSAGE = `A doc holds up to ${BLOCK_LIMITS.blocks.toLocaleString("en-US")} blocks.`;

/** True for an empty doc: one empty paragraph. */
const isBlank = (blocks) =>
  blocks.length === 1 &&
  blocks[0].type === "paragraph" &&
  blocks[0].text === "";

// ------------------------------------------------------------ rendering

/**
 * Brings the DOM in line with `state.blocks`: unchanged blocks keep their
 * element, changed types (and read-only switches) get a new one, and only
 * out-of-place elements move. Replaced and removed elements are detached
 * last, so the insertion cursor always points at a child of the root.
 */
export function reconcile(ed) {
  const { state, root } = ed;
  const numbers = listNumbers(state.blocks);
  const keep = new Set();
  const stale = [];
  let cursor = root.firstChild;
  state.blocks.forEach((block, index) => {
    let view = state.views.get(block.id);
    if (!view || view.type !== block.type || view.readOnly !== state.readOnly) {
      if (view) stale.push(view.element);
      view = createBlockView(block, { readOnly: state.readOnly });
      state.views.set(block.id, view);
    }
    updateBlockView(view, block, numbers[index]);
    keep.add(block.id);
    if (view.element === cursor) cursor = cursor.nextSibling;
    else root.insertBefore(view.element, cursor);
  });
  for (const [id, view] of state.views) {
    if (keep.has(id)) continue;
    stale.push(view.element);
    state.views.delete(id);
  }
  for (const element of stale) element.remove();
  syncBlankState(ed);
}

export function syncBlankState(ed) {
  ed.root.classList.toggle("is-blank", isBlank(ed.state.blocks));
}

export function viewAt(ed, index) {
  const block = ed.state.blocks[index];
  return block ? ed.state.views.get(block.id) : null;
}

/** Moves the caret to `{ index, offset }`. */
export function focusAt(ed, { index, offset }) {
  const view = viewAt(ed, index);
  if (!view) return;
  if (view.type === "divider") view.content.focus({ preventScroll: false });
  else
    setCaret(view.content, Math.min(offset, view.content.textContent.length));
}

/** The caret as `{ index, offset }` when it is in a block, else null. */
function caretState(ed) {
  const active = globalThis.document?.activeElement;
  const index = indexOf(ed, active);
  const view = viewAt(ed, index);
  if (!view) return null;
  const offset = hasText(view.type)
    ? (getOffsets(view.content)?.start ?? 0)
    : 0;
  return { index, offset };
}

/** Records the current state in the undo history before a change. */
export function record(ed, { kind = "structure", blockId = null } = {}) {
  const focus = kind === "typing" ? null : caretState(ed);
  ed.history.record({ blocks: ed.state.blocks, focus }, { kind, blockId });
}

/**
 * Applies a model result: new blocks, re-render, caret, change event. The
 * replaced state is recorded for undo unless `record` is false.
 */
export function commit(ed, blocks, focus, { recordUndo = true } = {}) {
  if (recordUndo) record(ed);
  ed.state.blocks = blocks;
  reconcile(ed);
  if (focus) focusAt(ed, focus);
  ed.onChange(blocks);
}

/** Undoes (`"undo"`) or redoes (`"redo"`) the last change of the doc. */
export function undoRedo(ed, action) {
  const current = { blocks: ed.state.blocks, focus: caretState(ed) };
  const target =
    action === "redo" ? ed.history.redo(current) : ed.history.undo(current);
  if (!target) return;
  const focus = target.focus ?? changedFocus(target.blocks, ed.state.blocks);
  commit(ed, target.blocks, focus, { recordUndo: false });
}

/** Applies `{ blocks, focus }` from a model operation (null: nothing). */
export function apply(ed, result, fullMessage = null) {
  if (!result) {
    if (fullMessage) ed.notify(fullMessage);
    return false;
  }
  commit(ed, result.blocks, result.focus);
  return true;
}

/** The index of the block that holds `node`, or -1. */
export function indexOf(ed, node) {
  const element = node?.closest?.(".doc-block");
  if (!element || !ed.root.contains(element)) return -1;
  const id = element.dataset.blockId;
  return ed.state.blocks.findIndex((block) => block.id === id);
}

export function offsetsIn(view) {
  const text = view.content.textContent;
  return getOffsets(view.content) ?? { start: text.length, end: text.length };
}

// ----------------------------------------------------------- operations

export function insertLineBreak(ed, index, view) {
  apply(
    ed,
    insertBreak(ed.state.blocks, index, offsetsIn(view)),
    LIMIT_MESSAGE,
  );
}

export function split(ed, index, view) {
  apply(ed, splitBlock(ed.state.blocks, index, offsetsIn(view)), FULL_MESSAGE);
}

export function move(ed, index, delta) {
  const view = viewAt(ed, index);
  const offset = view && hasText(view.type) ? offsetsIn(view).start : 0;
  const result = moveBlock(ed.state.blocks, index, delta);
  if (!result) return;
  commit(ed, result.blocks, { index: result.index, offset });
}

/** Focuses the block next to `index` (`delta` ±1), keeping the column. */
export function crossTo(ed, index, delta, { keepColumn = true } = {}) {
  const target = index + delta;
  if (target < 0) {
    ed.onExitUp?.();
    return;
  }
  const view = viewAt(ed, target);
  if (!view) return;
  if (view.type === "divider") {
    view.content.focus();
    return;
  }
  if (!keepColumn) {
    setCaret(view.content, delta < 0 ? view.content.textContent.length : 0);
    return;
  }
  placeCaretAtX(view.content, caretX(), delta < 0 ? "bottom" : "top");
}

export function changeType(ed, index, type) {
  apply(ed, setBlockType(ed.state.blocks, index, type), FULL_MESSAGE);
}

export function openActions(ed, index) {
  const view = viewAt(ed, index);
  if (!view?.handle) return;
  openBlockActions({
    anchor: view.handle,
    current: view.type,
    canMoveUp: index > 0,
    canMoveDown: index < ed.state.blocks.length - 1,
    onMove: (delta) => move(ed, index, delta),
    onType: (type) => changeType(ed, index, type),
    onDelete: () => apply(ed, removeBlock(ed.state.blocks, index)),
    onClose() {
      if (globalThis.document.activeElement === view.handle) {
        focusAt(ed, { index, offset: 0 });
      }
    },
  });
}

export function openSlash(ed, index, view) {
  openSlashMenu({
    anchor: view.content,
    current: view.type,
    onSelect: (type) => changeType(ed, index, type),
    onDismiss() {
      // Escape keeps the typed "/" as text, like any other character.
      if (!view.content.isConnected || view.content.textContent !== "") return;
      apply(
        ed,
        insertPlainText(ed.state.blocks, index, {
          start: 0,
          end: 0,
          text: "/",
        }),
      );
    },
  });
}
