/**
 * The doc editor's undo history (`web/ui/docs/history.js`): structural
 * edits and typing are undone in order, a markdown shortcut is undone
 * before the typing that triggered it, and the caret returns to the block
 * that changed. The browser side (Ctrl+Z after a shortcut in Chromium) is
 * covered by `scripts/e2e-roles-ux.mjs`.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { setBlockType, splitBlock, updateText } from "../web/ui/docs/blocks.js";
import {
  TYPING_PAUSE_MS,
  changedFocus,
  createHistory,
} from "../web/ui/docs/history.js";

const p = (id, text, type = "paragraph") => ({ id, type, text });
const texts = (blocks) => blocks.map((block) => `${block.type}:${block.text}`);

/** Replays the editor's recording rules over the pure model. */
function editor(blocks) {
  let clock = 0;
  const history = createHistory({ now: () => clock });
  const ed = { blocks, history };
  return {
    ed,
    wait: (ms) => (clock += ms),
    type(index, text) {
      const before = { blocks: ed.blocks, focus: null };
      history.record(before, { kind: "typing", blockId: ed.blocks[index].id });
      ed.blocks = updateText(ed.blocks, index, text);
    },
    structure(result, focus) {
      history.record({ blocks: ed.blocks, focus }, { kind: "structure" });
      ed.blocks = result.blocks;
    },
    undo() {
      const target = history.undo({ blocks: ed.blocks, focus: null });
      if (target) ed.blocks = target.blocks;
      return target;
    },
    redo() {
      const target = history.redo({ blocks: ed.blocks, focus: null });
      if (target) ed.blocks = target.blocks;
      return target;
    },
  };
}

test("undo after a markdown shortcut reverts the conversion, not other blocks", () => {
  const e = editor([p("b1", "")]);
  for (const text of ["G", "Gr", "Groceries for the offsite"]) e.type(0, text);
  const at = { start: 25, end: 25 };
  e.structure(splitBlock(e.ed.blocks, 0, at), { index: 0, offset: 25 });
  e.type(1, "-");
  e.type(1, "- ");
  // The shortcut: the typed "- " is recorded, then the type change.
  const cleared = updateText(e.ed.blocks, 1, "");
  e.structure(setBlockType(cleared, 1, "bulleted"), { index: 1, offset: 2 });
  assert.deepEqual(texts(e.ed.blocks), [
    "paragraph:Groceries for the offsite",
    "bulleted:",
  ]);
  const first = e.undo();
  assert.deepEqual(first.focus, { index: 1, offset: 2 });
  assert.deepEqual(texts(e.ed.blocks), [
    "paragraph:Groceries for the offsite",
    "paragraph:- ",
  ]);
  e.undo();
  assert.deepEqual(texts(e.ed.blocks), [
    "paragraph:Groceries for the offsite",
    "paragraph:",
  ]);
  assert.deepEqual(e.undo().focus, { index: 0, offset: 25 }, "the split");
  assert.deepEqual(texts(e.ed.blocks), ["paragraph:Groceries for the offsite"]);
  e.undo();
  assert.deepEqual(texts(e.ed.blocks), ["paragraph:"]);
  assert.equal(e.undo(), null, "nothing older");
  e.redo();
  e.redo();
  assert.deepEqual(texts(e.ed.blocks), [
    "paragraph:Groceries for the offsite",
    "paragraph:",
  ]);
});

test("typing groups until a pause, another block or a structural edit", () => {
  const e = editor([p("b1", ""), p("b2", "")]);
  e.type(0, "a");
  e.type(0, "ab");
  e.wait(TYPING_PAUSE_MS);
  e.type(0, "ab c");
  e.type(1, "x");
  e.type(0, "ab cd");
  e.undo();
  assert.deepEqual(texts(e.ed.blocks), ["paragraph:ab c", "paragraph:x"]);
  e.undo();
  assert.deepEqual(texts(e.ed.blocks), ["paragraph:ab c", "paragraph:"]);
  e.undo();
  assert.deepEqual(texts(e.ed.blocks), ["paragraph:ab", "paragraph:"]);
  e.undo();
  assert.deepEqual(texts(e.ed.blocks), ["paragraph:", "paragraph:"]);
  e.type(0, "new");
  assert.equal(e.ed.history.canRedo, false, "a new edit drops the redo list");
  const limited = createHistory({ limit: 2 });
  for (const n of [1, 2, 3]) {
    limited.record({ blocks: [p("b", String(n))] }, { kind: "structure" });
  }
  assert.equal(limited.undo({}).blocks[0].text, "3");
  assert.equal(limited.undo({}).blocks[0].text, "2");
  assert.equal(limited.undo({}), null, "only the newest entries are kept");
});

test("the caret goes to the end of the changed text", () => {
  const current = [p("b1", "Hello there"), p("b2", "Two")];
  const typedBack = [p("b1", "Hello"), p("b2", "Two")];
  assert.deepEqual(changedFocus(typedBack, current), { index: 0, offset: 5 });
  const restored = [p("b1", "Hello brave there"), p("b2", "Two")];
  assert.deepEqual(changedFocus(restored, current), { index: 0, offset: 12 });
  const same = [p("b1", "Hello there"), p("b2", "Two")];
  assert.deepEqual(changedFocus(same, current), { index: 1, offset: 3 });
  const retyped = [p("b1", "Hello there"), p("b3", "Other")];
  assert.deepEqual(changedFocus(retyped, current), { index: 1, offset: 5 });
});
