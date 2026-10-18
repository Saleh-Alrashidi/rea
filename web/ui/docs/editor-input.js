/**
 * Block editor input: keyboard handling (Enter, Backspace, Delete, arrows,
 * "/", block moves), `beforeinput` fallbacks for virtual keyboards, typing,
 * markdown shortcuts, plain-text paste and to-do checkboxes. Handlers take
 * the editor record from `editor-core.js`.
 *
 * Undo and redo (Ctrl/⌘+Z, Ctrl/⌘+Shift+Z, Ctrl+Y, and the browser's own
 * `historyUndo`/`historyRedo` input) never reach the browser's undo stack,
 * which knows nothing of structural edits: they replay the editor's history.
 */

import {
  BLOCK_LIMITS,
  backspaceAtStart,
  hasText,
  insertParagraphAfter,
  insertPlainText,
  markdownShortcut,
  mergeWithNext,
  removeBlock,
  setBlockType,
  toggleTodo,
  updateText,
} from "./blocks.js";
import {
  caretLines,
  getOffsets,
  isCanonical,
  setCaret,
  writeText,
} from "./caret.js";
import {
  FULL_MESSAGE,
  LIMIT_MESSAGE,
  apply,
  commit,
  crossTo,
  indexOf,
  insertLineBreak,
  move,
  offsetsIn,
  openActions,
  openSlash,
  record,
  split,
  syncBlankState,
  undoRedo,
  viewAt,
} from "./editor-core.js";

// ---------------------------------------------------------------- keys

const plainKey = (event) => !event.altKey && !event.ctrlKey && !event.metaKey;
const modKey = (event) => event.ctrlKey || event.metaKey;

/** "undo", "redo" or null for a keydown. */
function historyKey(event) {
  if (!modKey(event) || event.altKey) return null;
  const key = event.key.toLowerCase();
  if (key === "z") return event.shiftKey ? "redo" : "undo";
  if (key === "y" && !event.shiftKey) return "redo";
  return null;
}

function onEnter(ed, event, index, view) {
  event.preventDefault();
  const block = ed.state.blocks[index];
  if (modKey(event)) {
    if (block.type === "todo") {
      commit(ed, toggleTodo(ed.state.blocks, index, !block.checked), null);
    } else if (block.type === "code") {
      apply(ed, insertParagraphAfter(ed.state.blocks, index), FULL_MESSAGE);
    }
    return;
  }
  if (event.shiftKey || block.type === "code") insertLineBreak(ed, index, view);
  else split(ed, index, view);
}

function onBackspace(ed, event, index, view) {
  const { start, end } = offsetsIn(view);
  if (start !== 0 || end !== 0 || !plainKey(event)) return;
  const result = backspaceAtStart(ed.state.blocks, index);
  if (!result) return;
  event.preventDefault();
  apply(ed, result);
}

function onDelete(ed, event, index, view) {
  const { start, end } = offsetsIn(view);
  const length = view.content.textContent.length;
  if (start !== length || end !== length || !plainKey(event)) return;
  const result = mergeWithNext(ed.state.blocks, index);
  if (!result) return;
  event.preventDefault();
  apply(ed, result);
}

function onArrow(ed, event, index, view) {
  const up = event.key === "ArrowUp" || event.key === "ArrowLeft";
  const delta = up ? -1 : 1;
  if (
    event.altKey &&
    event.shiftKey &&
    (event.key === "ArrowUp" || event.key === "ArrowDown")
  ) {
    event.preventDefault();
    move(ed, index, delta);
    return;
  }
  if (event.shiftKey || !plainKey(event)) return;
  const { start, end } = offsetsIn(view);
  const length = view.content.textContent.length;
  let leave;
  if (event.key === "ArrowLeft") leave = start === 0 && end === 0;
  else if (event.key === "ArrowRight")
    leave = start === length && end === length;
  else leave = caretLines(view.content)[up ? "first" : "last"];
  if (!leave) return;
  if (index + delta >= ed.state.blocks.length) return;
  event.preventDefault();
  const horizontal = event.key === "ArrowLeft" || event.key === "ArrowRight";
  crossTo(ed, index, delta, { keepColumn: !horizontal });
}

function onSlash(ed, event, index, view) {
  if (modKey(event) && !event.altKey) {
    event.preventDefault();
    openActions(ed, index);
    return;
  }
  if (!plainKey(event) || view.content.textContent !== "") return;
  event.preventDefault();
  openSlash(ed, index, view);
}

const TEXT_KEYS = {
  Enter: onEnter,
  Backspace: onBackspace,
  Delete: onDelete,
  ArrowUp: onArrow,
  ArrowDown: onArrow,
  ArrowLeft: onArrow,
  ArrowRight: onArrow,
  "/": onSlash,
};

function onDividerKey(ed, event, index) {
  const { key } = event;
  if (key === "Backspace" || key === "Delete") {
    event.preventDefault();
    apply(ed, removeBlock(ed.state.blocks, index));
  } else if (key === "Enter") {
    event.preventDefault();
    apply(ed, insertParagraphAfter(ed.state.blocks, index), FULL_MESSAGE);
  } else if (key.startsWith("Arrow")) {
    event.preventDefault();
    const delta = key === "ArrowUp" || key === "ArrowLeft" ? -1 : 1;
    if (event.altKey && event.shiftKey) move(ed, index, delta);
    else crossTo(ed, index, delta, { keepColumn: false });
  } else if (key === "/" && modKey(event)) {
    event.preventDefault();
    openActions(ed, index);
  }
}

export function onKeydown(ed, event) {
  if (ed.state.readOnly || event.isComposing || event.keyCode === 229) return;
  const history = historyKey(event);
  if (history) {
    event.preventDefault();
    undoRedo(ed, history);
    return;
  }
  const index = indexOf(ed, event.target);
  const view = viewAt(ed, index);
  if (!view || event.target !== view.content) return;
  if (view.type === "divider") {
    onDividerKey(ed, event, index);
    return;
  }
  TEXT_KEYS[event.key]?.(ed, event, index, view);
}

// --------------------------------------------------------------- input

/**
 * Fallbacks for input that arrives without a usable keydown (virtual
 * keyboards), and a guard against formatting and dropped content.
 */
export function onBeforeInput(ed, event) {
  if (ed.state.readOnly) return;
  const type = event.inputType ?? "";
  if (type === "historyUndo" || type === "historyRedo") {
    event.preventDefault();
    undoRedo(ed, type === "historyRedo" ? "redo" : "undo");
    return;
  }
  const index = indexOf(ed, event.target);
  const view = viewAt(ed, index);
  if (!view || !hasText(view.type)) return;
  if (type.startsWith("format") || type === "insertFromDrop") {
    event.preventDefault();
  } else if (type === "insertParagraph") {
    event.preventDefault();
    if (view.type === "code") insertLineBreak(ed, index, view);
    else split(ed, index, view);
  } else if (type === "insertLineBreak") {
    event.preventDefault();
    insertLineBreak(ed, index, view);
  } else if (type === "deleteContentBackward") {
    const { start, end } = offsetsIn(view);
    const result =
      start === 0 && end === 0
        ? backspaceAtStart(ed.state.blocks, index)
        : null;
    if (!result) return;
    event.preventDefault();
    apply(ed, result);
  }
}

/** Reads a block's text after typing; keeps the DOM one plain text node. */
export function onInput(ed, event) {
  const index = indexOf(ed, event.target);
  const view = viewAt(ed, index);
  if (!view || !hasText(view.type) || event.target !== view.content) return;
  let text = view.content.textContent;
  const before = ed.state.blocks[index];
  if (text !== before.text) record(ed, { kind: "typing", blockId: before.id });
  if (event.isComposing) {
    ed.state.blocks = updateText(ed.state.blocks, index, text);
    ed.onChange(ed.state.blocks);
    return;
  }
  const offsets = getOffsets(view.content);
  if (text.length > BLOCK_LIMITS.text) {
    text = text.slice(0, BLOCK_LIMITS.text);
    ed.notify(LIMIT_MESSAGE);
  }
  if (!isCanonical(view.content, text)) {
    writeText(view.content, text);
    if (offsets) setCaret(view.content, Math.min(offsets.start, text.length));
  }
  const block = { ...ed.state.blocks[index], text };
  const shortcut = markdownShortcut(block, offsets?.start ?? -1);
  ed.state.blocks = updateText(ed.state.blocks, index, text);
  if (shortcut) {
    const cleared = updateText(ed.state.blocks, index, shortcut.text);
    const result = setBlockType(cleared, index, shortcut.type);
    if (result) {
      commit(ed, result.blocks, { ...result.focus, offset: 0 });
      return;
    }
  }
  syncBlankState(ed);
  ed.onChange(ed.state.blocks);
}

export function onPaste(ed, event) {
  const index = indexOf(ed, event.target);
  const view = viewAt(ed, index);
  if (!view) return;
  // Never let the browser insert pasted markup.
  event.preventDefault();
  if (ed.state.readOnly || !hasText(view.type)) return;
  const text = event.clipboardData?.getData("text/plain") ?? "";
  if (text === "") return;
  const result = insertPlainText(ed.state.blocks, index, {
    ...offsetsIn(view),
    text,
  });
  if (!result) return;
  commit(ed, result.blocks, result.focus);
  if (result.truncated) {
    ed.notify(`Some pasted text didn’t fit. ${LIMIT_MESSAGE} ${FULL_MESSAGE}`);
  }
}

export function onChangeEvent(ed, event) {
  if (!event.target.classList.contains("block-check")) return;
  const index = indexOf(ed, event.target);
  if (index < 0 || ed.state.readOnly) return;
  commit(ed, toggleTodo(ed.state.blocks, index, event.target.checked), null);
}

export function onClick(ed, event) {
  const handle = event.target.closest?.(".block-handle");
  if (!handle || ed.state.readOnly) return;
  openActions(ed, indexOf(ed, handle));
}

export function onCompositionEnd(ed, event) {
  onInput(ed, { target: event.target, isComposing: false });
}
