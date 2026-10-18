/**
 * The doc block model (no DOM). A doc is an array of blocks
 * `{ id, type, text, checked? }` (SPEC-2 §2): `checked` exists only on
 * to-dos and dividers hold no text. Every operation is pure: it returns a
 * new array (and, for edits, where the caret goes next) and never mutates
 * its input, so the editor can hand each result to autosave as is.
 *
 * Text offsets are UTF-16 indices, the unit of `Range.toString()` and
 * `String.prototype.slice`. The limits mirror SPEC-2 §2; the server
 * (`server/store/docs.js`) validates every save again.
 *
 * ```js
 * const { blocks, focus } = splitBlock(doc.blocks, 2, { start: 4, end: 4 });
 * listNumbers(blocks)          // [null, 1, 2, null, 1] for numbered runs
 * serializeBlocks(blocks)      // the `blocks_json` of update_doc
 * ```
 */

/** SPEC-2 §2 limits. */
export const BLOCK_LIMITS = Object.freeze({ blocks: 2000, text: 10_000 });

/** Block types in menu order, with their labels and markdown shortcuts. */
export const BLOCK_TYPES = Object.freeze([
  { type: "paragraph", label: "Text", glyph: "Aa", hint: "Plain text" },
  { type: "heading1", label: "Heading 1", glyph: "H1", shortcut: "#" },
  { type: "heading2", label: "Heading 2", glyph: "H2", shortcut: "##" },
  { type: "bulleted", label: "Bulleted list", glyph: "•", shortcut: "-" },
  { type: "numbered", label: "Numbered list", glyph: "1.", shortcut: "1." },
  { type: "todo", label: "To-do", glyph: "☐", shortcut: "[]" },
  { type: "quote", label: "Quote", glyph: "“", shortcut: ">" },
  { type: "code", label: "Code", glyph: "{ }", shortcut: "```" },
  { type: "callout", label: "Callout", glyph: "!", shortcut: "!" },
  { type: "divider", label: "Divider", glyph: "—", shortcut: "---" },
]);

const TYPES = new Set(BLOCK_TYPES.map((entry) => entry.type));
/** Types whose Enter continues the same kind of block (lists). */
const CONTINUED = new Set(["bulleted", "numbered", "todo"]);
const ID_PATTERN = /^[\w-]{1,64}$/;
const GENERATED_ID = /^b(\d{1,12})$/;

/** The menu entry of `type` (paragraph for unknown types). */
export function blockTypeInfo(type) {
  return BLOCK_TYPES.find((entry) => entry.type === type) ?? BLOCK_TYPES[0];
}

/** True for block types the editor can hold. */
export const isBlockType = (type) => TYPES.has(type);

/** True when `type` holds editable text (everything but dividers). */
export const hasText = (type) => type !== "divider";

/** Builds a well-formed block record. */
function makeBlock(id, type, text = "", checked = false) {
  const block = { id, type, text: hasText(type) ? text : "" };
  return type === "todo" ? { ...block, checked: Boolean(checked) } : block;
}

/** The next free generated ID (`b<n>`, the server's own scheme). */
export function nextBlockId(blocks, taken = new Set()) {
  let max = 0;
  for (const block of blocks) {
    const match = GENERATED_ID.exec(String(block?.id ?? ""));
    if (match) max = Math.max(max, Number(match[1]));
  }
  let next = max + 1;
  while (taken.has(`b${next}`)) next += 1;
  return `b${next}`;
}

/** A new empty block of `type` with an ID unused in `blocks`. */
export function createBlock(blocks, type = "paragraph", text = "") {
  return makeBlock(nextBlockId(blocks), type, text);
}

/**
 * Parses a doc's `blocks_json`. Malformed input never throws: a non-array
 * becomes no blocks, unknown types become paragraphs, non-string text
 * becomes "", and missing or duplicate IDs get fresh ones, so whatever the
 * server stored can be shown and saved back.
 *
 * @param {string} text
 * @returns {{ id: string, type: string, text: string, checked?: boolean }[]}
 */
export function parseBlocksJson(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = [];
  }
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const blocks = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const type = TYPES.has(entry.type) ? entry.type : "paragraph";
    const value = typeof entry.text === "string" ? entry.text : "";
    const valid = typeof entry.id === "string" && ID_PATTERN.test(entry.id);
    const id =
      valid && !seen.has(entry.id) ? entry.id : nextBlockId(list, seen);
    seen.add(id);
    blocks.push(makeBlock(id, type, value, entry.checked === true));
  }
  return blocks;
}

/** The `blocks_json` text for `update_doc` (only the stored fields). */
export function serializeBlocks(blocks) {
  return JSON.stringify(
    blocks.map((block) =>
      makeBlock(block.id, block.type, block.text, block.checked),
    ),
  );
}

/** Blocks with at least one empty paragraph, so there is a place to type. */
export function ensureEditable(blocks) {
  return blocks.length > 0 ? blocks : [createBlock([], "paragraph")];
}

const replaceAt = (blocks, index, ...items) => [
  ...blocks.slice(0, index),
  ...items,
  ...blocks.slice(index + 1),
];

const clip = (text) => text.slice(0, BLOCK_LIMITS.text);

/** Replaces the text of block `index` (clipped to the limit). */
export function updateText(blocks, index, text) {
  const block = blocks[index];
  if (!block || !hasText(block.type) || block.text === text) return blocks;
  return replaceAt(blocks, index, { ...block, text: clip(text) });
}

/** Checks or unchecks the to-do at `index`. */
export function toggleTodo(blocks, index, checked) {
  const block = blocks[index];
  if (block?.type !== "todo") return blocks;
  return replaceAt(blocks, index, { ...block, checked: Boolean(checked) });
}

/**
 * Enter: splits block `index` at the selection `{ start, end }` (the
 * selected text is dropped). The new block continues lists and is a
 * paragraph otherwise. Enter on an empty list item turns it into a
 * paragraph, and Enter at the very start of a non-empty block opens an
 * empty block above it.
 *
 * @returns {{ blocks: object[], focus: { index: number, offset: number } } | null}
 *   null when the doc is full.
 */
export function splitBlock(blocks, index, { start, end }) {
  const block = blocks[index];
  if (!block) return null;
  if (block.text === "" && CONTINUED.has(block.type)) {
    const next = makeBlock(block.id, "paragraph");
    return {
      blocks: replaceAt(blocks, index, next),
      focus: { index, offset: 0 },
    };
  }
  if (blocks.length >= BLOCK_LIMITS.blocks) return null;
  const type = CONTINUED.has(block.type) ? block.type : "paragraph";
  const fresh = createBlock(blocks, type);
  if (start === 0 && end === 0 && block.text !== "") {
    return {
      blocks: replaceAt(blocks, index, fresh, block),
      focus: { index: index + 1, offset: 0 },
    };
  }
  const before = { ...block, text: block.text.slice(0, start) };
  const after = { ...fresh, text: block.text.slice(end) };
  return {
    blocks: replaceAt(blocks, index, before, after),
    focus: { index: index + 1, offset: 0 },
  };
}

/** Where the caret goes after block `index` is removed from `blocks`. */
function focusAfterRemoval(next, index) {
  if (index > 0) {
    const previous = next[index - 1];
    return { index: index - 1, offset: previous.text.length };
  }
  return { index: 0, offset: 0 };
}

/**
 * Removes block `index`. The last remaining block becomes an empty
 * paragraph instead, so a doc never loses its place to type.
 *
 * @returns {{ blocks: object[], focus: { index: number, offset: number } }}
 */
export function removeBlock(blocks, index) {
  if (!blocks[index]) return { blocks, focus: { index: 0, offset: 0 } };
  if (blocks.length === 1) {
    const only = makeBlock(blocks[0].id, "paragraph");
    return { blocks: [only], focus: { index: 0, offset: 0 } };
  }
  const next = [...blocks.slice(0, index), ...blocks.slice(index + 1)];
  return { blocks: next, focus: focusAfterRemoval(next, index) };
}

/** Appends block `from`'s text to block `into` (adjacent, into < from). */
function mergeInto(blocks, into, from) {
  const target = blocks[into];
  const source = blocks[from];
  const offset = target.text.length;
  const merged = { ...target, text: clip(target.text + source.text) };
  const next = [...blocks.slice(0, into), merged, ...blocks.slice(from + 1)];
  return { blocks: next, focus: { index: into, offset } };
}

/**
 * Backspace with the caret at the start of block `index`: an empty block
 * is deleted, a styled block becomes a paragraph (keeping its text), and a
 * paragraph merges into the block above (a divider above is removed).
 *
 * @returns {{ blocks: object[], focus: { index: number, offset: number } } | null}
 *   null when there is nothing to do (the first paragraph).
 */
export function backspaceAtStart(blocks, index) {
  const block = blocks[index];
  if (!block) return null;
  if (block.text === "" && blocks.length > 1) return removeBlock(blocks, index);
  if (block.type !== "paragraph") {
    const next = makeBlock(block.id, "paragraph", block.text);
    return {
      blocks: replaceAt(blocks, index, next),
      focus: { index, offset: 0 },
    };
  }
  const previous = blocks[index - 1];
  if (!previous) return null;
  if (!hasText(previous.type)) {
    const next = [...blocks.slice(0, index - 1), ...blocks.slice(index)];
    return { blocks: next, focus: { index: index - 1, offset: 0 } };
  }
  return mergeInto(blocks, index - 1, index);
}

/**
 * Delete with the caret at the end of block `index`: the next block's text
 * joins this one (a divider below is removed).
 *
 * @returns {{ blocks: object[], focus: { index: number, offset: number } } | null}
 */
export function mergeWithNext(blocks, index) {
  const block = blocks[index];
  const next = blocks[index + 1];
  if (!block || !next) return null;
  if (!hasText(next.type)) {
    const rest = [...blocks.slice(0, index + 1), ...blocks.slice(index + 2)];
    return { blocks: rest, focus: { index, offset: block.text.length } };
  }
  return mergeInto(blocks, index, index + 1);
}

/**
 * Moves block `index` by `delta` (−1 up, +1 down).
 * @returns {{ blocks: object[], index: number } | null} null at the edges
 */
export function moveBlock(blocks, index, delta) {
  const target = index + delta;
  if (!blocks[index] || target < 0 || target >= blocks.length) return null;
  const next = [...blocks];
  const [block] = next.splice(index, 1);
  next.splice(target, 0, block);
  return { blocks: next, index: target };
}

/**
 * Changes block `index` to `type`. To-dos gain `checked: false`, other
 * types drop it. A divider keeps no text: the block's text moves to a
 * paragraph below it, and a paragraph is added when the divider would end
 * the doc, so there is always somewhere to keep typing.
 *
 * @returns {{ blocks: object[], focus: { index: number, offset: number } } | null}
 */
export function setBlockType(blocks, index, type) {
  const block = blocks[index];
  if (!block || !TYPES.has(type)) return null;
  if (type !== "divider") {
    const next = makeBlock(block.id, type, block.text, block.checked);
    const offset = block.type === "divider" ? 0 : block.text.length;
    return { blocks: replaceAt(blocks, index, next), focus: { index, offset } };
  }
  const divider = makeBlock(block.id, "divider");
  const needsFollower = block.text !== "" || index === blocks.length - 1;
  if (!needsFollower) {
    return {
      blocks: replaceAt(blocks, index, divider),
      focus: { index: index + 1, offset: 0 },
    };
  }
  if (blocks.length >= BLOCK_LIMITS.blocks) return null;
  const follower = createBlock(blocks, "paragraph", block.text);
  return {
    blocks: replaceAt(blocks, index, divider, follower),
    focus: { index: index + 1, offset: 0 },
  };
}

/** Inserts an empty paragraph after block `index` (Enter on a divider). */
export function insertParagraphAfter(blocks, index) {
  if (blocks.length >= BLOCK_LIMITS.blocks) return null;
  const fresh = createBlock(blocks, "paragraph");
  const next = [
    ...blocks.slice(0, index + 1),
    fresh,
    ...blocks.slice(index + 1),
  ];
  return { blocks: next, focus: { index: index + 1, offset: 0 } };
}

/**
 * The displayed number of each numbered block (null for other blocks).
 * A run of consecutive numbered blocks counts from 1; any other block
 * ends the run.
 */
export function listNumbers(blocks) {
  let count = 0;
  return blocks.map((block) => {
    if (block.type !== "numbered") {
      count = 0;
      return null;
    }
    count += 1;
    return count;
  });
}

/**
 * Inserts pasted plain text into block `index` at `{ start, end }`. Line
 * breaks are normalized to "\n". A code block keeps them; elsewhere every
 * further line becomes its own block (lists continue, other blocks add
 * paragraphs). Text over the limits is dropped and reported.
 *
 * @returns {{ blocks: object[], focus: { index: number, offset: number },
 *   truncated: boolean } | null}
 */
export function insertPlainText(blocks, index, { start, end, text }) {
  const block = blocks[index];
  if (!block || !hasText(block.type)) return null;
  const clean = String(text).replace(/\r\n?/g, "\n");
  const before = block.text.slice(0, start);
  const after = block.text.slice(end);
  const lines = block.type === "code" ? [clean] : clean.split("\n");
  const room = BLOCK_LIMITS.blocks - blocks.length;
  const kept = lines.slice(0, Math.max(1, room + 1));
  let truncated = kept.length < lines.length;
  const type = CONTINUED.has(block.type) ? block.type : "paragraph";
  const added = [];
  const taken = new Set(blocks.map((entry) => entry.id));
  for (const line of kept.slice(1)) {
    const id = nextBlockId(blocks, taken);
    taken.add(id);
    added.push(makeBlock(id, type, line));
  }
  const first = { ...block, text: before + kept[0] };
  const all = [first, ...added];
  const last = all.at(-1);
  const offset = last.text.length;
  all[all.length - 1] = { ...last, text: last.text + after };
  const fitted = all.map((entry) => {
    if (entry.text.length <= BLOCK_LIMITS.text) return entry;
    truncated = true;
    return { ...entry, text: clip(entry.text) };
  });
  return {
    blocks: replaceAt(blocks, index, ...fitted),
    focus: {
      index: index + fitted.length - 1,
      offset: Math.min(offset, BLOCK_LIMITS.text),
    },
    truncated,
  };
}

/**
 * Shift+Enter (and Enter in code): a line break inside block `index` at
 * `{ start, end }`, replacing the selection.
 * @returns {{ blocks: object[], focus: { index: number, offset: number } } | null}
 */
export function insertLineBreak(blocks, index, { start, end }) {
  const block = blocks[index];
  if (!block || !hasText(block.type)) return null;
  const text = `${block.text.slice(0, start)}\n${block.text.slice(end)}`;
  if (text.length > BLOCK_LIMITS.text) return null;
  return {
    blocks: replaceAt(blocks, index, { ...block, text }),
    focus: { index, offset: start + 1 },
  };
}

const SHORTCUTS = [
  ["# ", "heading1"],
  ["## ", "heading2"],
  ["- ", "bulleted"],
  ["* ", "bulleted"],
  ["1. ", "numbered"],
  ["[] ", "todo"],
  ["[ ] ", "todo"],
  ["> ", "quote"],
  ["! ", "callout"],
  ["```", "code"],
  ["---", "divider"],
];

/**
 * Markdown-style shortcuts typed at the start of a paragraph ("# ", "- ",
 * "1. ", "[] ", "> ", "! ", "```", "---"). Returns the new type and the
 * remaining text, or null. Only paragraphs convert, and only when the caret
 * sits right after the shortcut, so editing text that merely starts with
 * "- " never changes a block.
 *
 * @param {{ type: string, text: string }} block
 * @param {number} caret the caret offset after the keystroke
 * @returns {{ type: string, text: string } | null}
 */
export function markdownShortcut(block, caret) {
  if (block?.type !== "paragraph") return null;
  for (const [prefix, type] of SHORTCUTS) {
    if (caret === prefix.length && block.text.startsWith(prefix)) {
      return { type, text: block.text.slice(prefix.length) };
    }
  }
  return null;
}

const PLAIN_PREFIX = {
  heading1: "# ",
  heading2: "## ",
  bulleted: "- ",
  quote: "> ",
  callout: "! ",
};

/**
 * The doc as plain text (one block per line, markdown-style markers), for
 * "Copy my version" after a conflict.
 */
export function blocksToPlainText(blocks) {
  const numbers = listNumbers(blocks);
  return blocks
    .map((block, index) => {
      if (block.type === "divider") return "---";
      if (block.type === "numbered") return `${numbers[index]}. ${block.text}`;
      if (block.type === "todo") {
        return `[${block.checked ? "x" : " "}] ${block.text}`;
      }
      if (block.type === "code") return `\`\`\`\n${block.text}\n\`\`\``;
      return `${PLAIN_PREFIX[block.type] ?? ""}${block.text}`;
    })
    .join("\n");
}
