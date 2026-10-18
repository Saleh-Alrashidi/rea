/**
 * The doc block editor: a column of plain-text `contenteditable` blocks
 * backed by the pure model in `blocks.js`. The model is the source of
 * truth; the DOM is reconciled from it by block ID (unchanged blocks keep
 * their element, caret and native undo), and every structural edit moves
 * the caret explicitly.
 *
 * Keys: Enter splits (Shift+Enter, and Enter in code, add a line break;
 * Ctrl/⌘+Enter toggles a to-do or leaves a code block), Backspace at a
 * block's start deletes an empty block, unstyles a styled one or merges
 * into the block above, Delete at the end merges the next block,
 * ArrowUp/Down/Left/Right cross block edges, "/" in an empty block opens
 * the type menu, Alt+Shift+↑/↓ moves the block and Ctrl/⌘+/ opens the
 * block's handle menu. Pasting inserts plain text only (one block per
 * line); dropping content into a block is blocked.
 *
 * ```js
 * const editor = createBlockEditor({ blocks, readOnly: false,
 *   onChange: (blocks) => autosave.change({ blocks }),
 *   onExitUp: () => title.focus(), notify: (text) => toast.info(text) });
 * container.append(editor.element);
 * ```
 */

import { h } from "../../dom.js";
import { ensureEditable, insertParagraphAfter } from "./blocks.js";
import { FULL_MESSAGE, apply, focusAt, reconcile } from "./editor-core.js";
import {
  onBeforeInput,
  onChangeEvent,
  onClick,
  onCompositionEnd,
  onInput,
  onKeydown,
  onPaste,
} from "./editor-input.js";

// --------------------------------------------------------------- public

/**
 * @param {{ blocks: object[], readOnly?: boolean,
 *   onChange?: (blocks: object[]) => void, onExitUp?: () => void,
 *   notify?: (message: string) => void }} options
 */
export function createBlockEditor(options) {
  const root = h("div", {
    class: "doc-blocks",
    role: "group",
    "aria-label": "Doc content",
  });
  const readOnly = Boolean(options.readOnly);
  const ed = {
    root,
    state: {
      blocks: readOnly ? options.blocks : ensureEditable(options.blocks),
      readOnly,
      views: new Map(),
    },
    onChange: options.onChange ?? (() => {}),
    onExitUp: options.onExitUp,
    notify: options.notify ?? (() => {}),
  };
  const listeners = {
    keydown: (event) => onKeydown(ed, event),
    beforeinput: (event) => onBeforeInput(ed, event),
    input: (event) => onInput(ed, event),
    compositionend: (event) => onCompositionEnd(ed, event),
    paste: (event) => onPaste(ed, event),
    drop: (event) => event.preventDefault(),
    change: (event) => onChangeEvent(ed, event),
    click: (event) => onClick(ed, event),
  };
  for (const [type, listener] of Object.entries(listeners)) {
    root.addEventListener(type, listener);
  }
  reconcile(ed);
  return {
    element: root,
    getBlocks: () => ed.state.blocks,
    /** Replaces the content (after a reload); the caret is not kept. */
    setBlocks(blocks) {
      ed.state.blocks = ed.state.readOnly ? blocks : ensureEditable(blocks);
      reconcile(ed);
    },
    setReadOnly(flag) {
      if (ed.state.readOnly === Boolean(flag)) return;
      ed.state.readOnly = Boolean(flag);
      if (!flag) ed.state.blocks = ensureEditable(ed.state.blocks);
      reconcile(ed);
    },
    focusStart: () => focusAt(ed, { index: 0, offset: 0 }),
    /**
     * Focuses the end of the doc; with `append`, adds an empty paragraph
     * first unless the doc already ends with one (a click below the text).
     */
    focusEnd({ append = false } = {}) {
      if (ed.state.readOnly) return;
      const { blocks } = ed.state;
      const last = blocks.at(-1);
      const endsEmpty = last?.type === "paragraph" && last.text === "";
      if (append && !endsEmpty) {
        apply(
          ed,
          insertParagraphAfter(blocks, blocks.length - 1),
          FULL_MESSAGE,
        );
        return;
      }
      focusAt(ed, { index: blocks.length - 1, offset: last?.text.length ?? 0 });
    },
  };
}
