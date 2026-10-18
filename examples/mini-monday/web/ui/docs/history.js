/**
 * The block editor's undo history (no DOM). Each block is its own
 * `contenteditable` and structural edits (Enter splits, merges, markdown
 * shortcuts, type changes, moves, paste) re-render the DOM outside the
 * browser's undo stack, so native undo would replay older typing in other
 * blocks. The editor therefore handles undo and redo itself over whole-doc
 * snapshots: `{ blocks, focus }`, where `focus` is the caret
 * (`{ index, offset }`) to restore, or null to place it where the text
 * changed.
 *
 * Typing in one block within `TYPING_PAUSE_MS` of the previous keystroke
 * extends the same entry; any structural change, another block or a pause
 * starts a new one. A markdown shortcut records the typed text first, so
 * the first undo reverts only the conversion.
 *
 * ```js
 * const history = createHistory();
 * history.record({ blocks, focus }, { kind: "structure" });  // before a change
 * const target = history.undo({ blocks: now, focus: caret }); // or null
 * ```
 */

const HISTORY_LIMIT = 200;
export const TYPING_PAUSE_MS = 1000;

/**
 * @param {{ limit?: number, now?: () => number }} [options]
 */
export function createHistory({ limit = HISTORY_LIMIT, now = Date.now } = {}) {
  let past = [];
  let future = [];
  let typing = null;
  return {
    /**
     * Records `before`, the state a change is about to replace. With
     * `kind: "typing"` and the `blockId` typed into, a continuation of the
     * previous typing keeps the entry it started.
     */
    record(before, { kind, blockId = null }) {
      const at = now();
      const continues =
        kind === "typing" &&
        typing !== null &&
        typing.blockId === blockId &&
        at - typing.at < TYPING_PAUSE_MS;
      typing = kind === "typing" ? { blockId, at } : null;
      if (continues) return;
      past.push(before);
      if (past.length > limit) past = past.slice(-limit);
      future = [];
    },
    /** The state to go back to (`current` becomes redoable), or null. */
    undo(current) {
      const target = past.pop();
      if (!target) return null;
      future.push(current);
      typing = null;
      return target;
    },
    /** The state undone last (`current` becomes undoable), or null. */
    redo(current) {
      const target = future.pop();
      if (!target) return null;
      past.push(current);
      typing = null;
      return target;
    },
    /** Forgets everything (the content was replaced from the server). */
    clear() {
      past = [];
      future = [];
      typing = null;
    },
    get canUndo() {
      return past.length > 0;
    },
    get canRedo() {
      return future.length > 0;
    },
  };
}

const sameBlock = (a, b) =>
  a.id === b.id &&
  a.type === b.type &&
  a.text === b.text &&
  Boolean(a.checked) === Boolean(b.checked);

/**
 * Where the caret goes when `current` turns into `target` without a
 * recorded caret: in the first block that differs, at the end of the text
 * that changed (after re-inserted text, or where removed text was).
 */
export function changedFocus(target, current) {
  const index = target.findIndex(
    (block, at) => !current[at] || !sameBlock(block, current[at]),
  );
  if (index === -1) {
    const last = target.length - 1;
    return { index: last, offset: target[last]?.text.length ?? 0 };
  }
  const before = target[index].text;
  const after =
    current[index]?.id === target[index].id ? current[index].text : "";
  let suffix = 0;
  const limit = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < limit && before[prefix] === after[prefix]) prefix += 1;
  while (
    suffix < limit - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return { index, offset: before.length - suffix };
}
