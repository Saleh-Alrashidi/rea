// The autosave controller shared by the doc and note editors is tested in
// web-notes.test.js.
import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "../server/graphql/parse.js";
import {
  BLOCK_LIMITS,
  BLOCK_TYPES,
  backspaceAtStart,
  blocksToPlainText,
  ensureEditable,
  insertLineBreak,
  insertParagraphAfter,
  insertPlainText,
  listNumbers,
  markdownShortcut,
  mergeWithNext,
  moveBlock,
  parseBlocksJson,
  removeBlock,
  serializeBlocks,
  setBlockType,
  splitBlock,
  toggleTodo,
  updateText,
} from "../web/ui/docs/blocks.js";
import {
  DELETE_DOC_MUTATION,
  DOCS_LIST_QUERY,
  DOC_QUERY,
  UPDATE_DOC_MUTATION,
  docCapabilities,
  docWorkspaces,
  docsView,
  loadDoc,
  loadDocsList,
  saveDoc,
} from "../web/ui/docs/doc-data.js";
import { ApiError } from "../web/api.js";
import { startTestServers } from "./helpers.js";

const p = (id, text, type = "paragraph") => ({ id, type, text });
const texts = (blocks) => blocks.map((block) => `${block.type}:${block.text}`);

test("blocks_json parses defensively and serializes the stored fields", () => {
  assert.deepEqual(parseBlocksJson("not json"), []);
  assert.deepEqual(parseBlocksJson('{"id":"b1"}'), []);
  const blocks = parseBlocksJson(
    JSON.stringify([
      { id: "b1", type: "heading1", text: "Plan" },
      null,
      { id: "b1", type: "todo", text: "dup id", checked: true },
      { type: "spaceship", text: 42 },
      { id: "bad id!", type: "divider", text: "ignored" },
      { id: "b7", type: "paragraph", text: "kept", checked: true },
    ]),
  );
  assert.deepEqual(blocks, [
    { id: "b1", type: "heading1", text: "Plan" },
    { id: "b8", type: "todo", text: "dup id", checked: true },
    { id: "b9", type: "paragraph", text: "" },
    { id: "b10", type: "divider", text: "" },
    { id: "b7", type: "paragraph", text: "kept" },
  ]);
  assert.equal(new Set(blocks.map((block) => block.id)).size, blocks.length);
  const round = parseBlocksJson(serializeBlocks(blocks));
  assert.deepEqual(round, blocks);
  // Only to-dos carry `checked`; extra fields never reach the server.
  assert.deepEqual(
    JSON.parse(serializeBlocks([{ ...p("x", "a"), extra: 1 }])),
    [p("x", "a")],
  );
  assert.equal(ensureEditable([]).length, 1);
  assert.equal(BLOCK_TYPES.length, 10);
});

test("Enter splits blocks, continues lists and leaves empty list items", () => {
  const doc = [p("b1", "Hello world"), p("b2", "item", "bulleted")];
  const middle = splitBlock(doc, 0, { start: 5, end: 6 });
  assert.deepEqual(texts(middle.blocks), [
    "paragraph:Hello",
    "paragraph:world",
    "bulleted:item",
  ]);
  assert.deepEqual(middle.focus, { index: 1, offset: 0 });
  assert.equal(middle.blocks[1].id, "b3");

  const list = splitBlock(doc, 1, { start: 4, end: 4 });
  assert.deepEqual(texts(list.blocks).slice(1), ["bulleted:item", "bulleted:"]);
  const exit = splitBlock(list.blocks, 2, { start: 0, end: 0 });
  assert.deepEqual(texts(exit.blocks).at(-1), "paragraph:");
  assert.equal(exit.blocks.length, 3);

  const heading = splitBlock([p("b1", "Title", "heading1")], 0, {
    start: 5,
    end: 5,
  });
  assert.deepEqual(texts(heading.blocks), ["heading1:Title", "paragraph:"]);
  // Enter at the start of a non-empty block opens an empty block above.
  const above = splitBlock([p("b1", "Title", "heading1")], 0, {
    start: 0,
    end: 0,
  });
  assert.deepEqual(texts(above.blocks), ["paragraph:", "heading1:Title"]);
  assert.deepEqual(above.focus, { index: 1, offset: 0 });
  // A full doc refuses new blocks.
  const full = Array.from({ length: BLOCK_LIMITS.blocks }, (_, i) =>
    p(`b${i + 1}`, "x"),
  );
  assert.equal(splitBlock(full, 0, { start: 1, end: 1 }), null);
  assert.equal(doc.length, 2, "inputs are never mutated");
});

test("Backspace deletes empty blocks, unstyles, merges and removes dividers", () => {
  const doc = [
    p("b1", "One"),
    p("b2", "", "divider"),
    p("b3", "Two"),
    p("b4", "", "heading2"),
    p("b5", "Quote", "quote"),
  ];
  const empty = backspaceAtStart(doc, 3);
  assert.deepEqual(texts(empty.blocks), [
    "paragraph:One",
    "divider:",
    "paragraph:Two",
    "quote:Quote",
  ]);
  assert.deepEqual(empty.focus, { index: 2, offset: 3 });
  const unstyled = backspaceAtStart(doc, 4);
  assert.equal(unstyled.blocks[4].type, "paragraph");
  assert.equal(unstyled.blocks[4].text, "Quote");
  const divider = backspaceAtStart(doc, 2);
  assert.deepEqual(texts(divider.blocks).slice(0, 2), [
    "paragraph:One",
    "paragraph:Two",
  ]);
  const merged = backspaceAtStart(divider.blocks, 1);
  assert.deepEqual(texts(merged.blocks).slice(0, 1), ["paragraph:OneTwo"]);
  assert.deepEqual(merged.focus, { index: 0, offset: 3 });
  assert.equal(backspaceAtStart(doc, 0), null);

  const forward = mergeWithNext(doc, 0);
  assert.deepEqual(texts(forward.blocks).slice(0, 2), [
    "paragraph:One",
    "paragraph:Two",
  ]);
  assert.equal(mergeWithNext(doc, 4), null);

  const only = removeBlock([p("b1", "x", "code")], 0);
  assert.deepEqual(texts(only.blocks), ["paragraph:"]);
  const todo = toggleTodo(
    [{ ...p("b1", "t", "todo"), checked: false }],
    0,
    true,
  );
  assert.equal(todo[0].checked, true);
  assert.equal(updateText(doc, 1, "no text on dividers"), doc);
  assert.equal(updateText(doc, 0, "x".repeat(20_000))[0].text.length, 10_000);
});

test("blocks move, change type and number their lists", () => {
  const doc = [
    p("b1", "a", "numbered"),
    p("b2", "b", "numbered"),
    p("b3", "c"),
    p("b4", "d", "numbered"),
  ];
  assert.deepEqual(listNumbers(doc), [1, 2, null, 1]);
  const moved = moveBlock(doc, 2, -1);
  assert.equal(moved.index, 1);
  assert.deepEqual(listNumbers(moved.blocks), [1, null, 1, 2]);
  assert.equal(moveBlock(doc, 0, -1), null);
  assert.equal(moveBlock(doc, 3, 1), null);

  const todo = setBlockType(doc, 2, "todo");
  assert.deepEqual(todo.blocks[2], {
    id: "b3",
    type: "todo",
    text: "c",
    checked: false,
  });
  const back = setBlockType(todo.blocks, 2, "quote");
  assert.equal("checked" in back.blocks[2], false);
  const divider = setBlockType(doc, 2, "divider");
  assert.deepEqual(texts(divider.blocks).slice(2, 4), [
    "divider:",
    "paragraph:c",
  ]);
  assert.deepEqual(divider.focus, { index: 3, offset: 0 });
  const lastDivider = setBlockType([p("b1", "")], 0, "divider");
  assert.deepEqual(texts(lastDivider.blocks), ["divider:", "paragraph:"]);
  const quiet = setBlockType([p("b1", ""), p("b2", "x")], 0, "divider");
  assert.deepEqual(texts(quiet.blocks), ["divider:", "paragraph:x"]);
  assert.equal(setBlockType(doc, 0, "marquee"), null);
  const after = insertParagraphAfter(divider.blocks, 2);
  assert.equal(after.blocks[3].text, "");
});

test("paste inserts plain text, one block per line outside code", () => {
  const doc = [p("b1", "Hello world"), p("b2", "fn()", "code")];
  const single = insertPlainText(doc, 0, { start: 5, end: 5, text: ", dear" });
  assert.equal(single.blocks[0].text, "Hello, dear world");
  assert.deepEqual(single.focus, { index: 0, offset: 11 });
  const lines = insertPlainText(doc, 0, {
    start: 6,
    end: 11,
    text: "one\r\ntwo\rthree",
  });
  assert.deepEqual(texts(lines.blocks), [
    "paragraph:Hello one",
    "paragraph:two",
    "paragraph:three",
    "code:fn()",
  ]);
  assert.deepEqual(lines.focus, { index: 2, offset: 5 });
  assert.equal(new Set(lines.blocks.map((b) => b.id)).size, 4);
  const code = insertPlainText(doc, 1, { start: 4, end: 4, text: "\nx\ny" });
  assert.equal(code.blocks[1].text, "fn()\nx\ny");
  assert.equal(code.blocks.length, 2);
  const list = insertPlainText([p("b1", "", "bulleted")], 0, {
    start: 0,
    end: 0,
    text: "a\nb",
  });
  assert.deepEqual(texts(list.blocks), ["bulleted:a", "bulleted:b"]);
  const long = insertPlainText(doc, 0, {
    start: 0,
    end: 0,
    text: "x".repeat(BLOCK_LIMITS.text),
  });
  assert.equal(long.truncated, true);
  assert.equal(long.blocks[0].text.length, BLOCK_LIMITS.text);
  assert.equal(insertPlainText([p("b1", "", "divider")], 0, {}), null);
  // Shift+Enter: a line break inside the block, never a new block.
  const soft = insertLineBreak(doc, 0, { start: 5, end: 6 });
  assert.deepEqual(texts(soft.blocks), ["paragraph:Hello\nworld", "code:fn()"]);
  assert.deepEqual(soft.focus, { index: 0, offset: 6 });
  const full = [p("b1", "x".repeat(BLOCK_LIMITS.text))];
  assert.equal(insertLineBreak(full, 0, { start: 0, end: 0 }), null);
});

test("markdown shortcuts convert paragraphs only at the caret", () => {
  assert.deepEqual(markdownShortcut(p("b1", "# Plan"), 2), {
    type: "heading1",
    text: "Plan",
  });
  assert.deepEqual(markdownShortcut(p("b1", "## "), 3), {
    type: "heading2",
    text: "",
  });
  assert.equal(markdownShortcut(p("b1", "- item"), 6), null);
  assert.equal(markdownShortcut(p("b1", "- ", "quote"), 2), null);
  assert.equal(markdownShortcut(p("b1", "---"), 3).type, "divider");
  assert.equal(markdownShortcut(p("b1", "[] "), 3).type, "todo");
  assert.equal(
    blocksToPlainText([
      p("b1", "Plan", "heading1"),
      { ...p("b2", "Ship", "todo"), checked: true },
      p("b3", "a", "numbered"),
      p("b4", "", "divider"),
    ]),
    "# Plan\n[x] Ship\n1. a\n---",
  );
});

const meta = (overrides) => ({
  id: "1",
  title: "Doc",
  visibility: "workspace",
  my_access: "editor",
  updated_at: "2026-10-01T00:00:00.000Z",
  workspace: { id: "1", name: "Main" },
  created_by: { id: "1", name: "Alex" },
  updated_by: null,
  ...overrides,
});

test("docs list filters: all, mine, shared with me, workspace and search", () => {
  const docs = [
    meta({ id: "1", title: "Product vision", updated_at: "2026-10-03" }),
    meta({
      id: "2",
      title: "Launch brief",
      created_by: { id: "4" },
      updated_at: "2026-10-05",
    }),
    meta({
      id: "3",
      title: "Offsite",
      workspace: { id: "2", name: "Leadership" },
      updated_at: "2026-10-04",
    }),
  ];
  const base = { meId: "1", sharedIds: new Set(["2"]) };
  const all = docsView(docs, base);
  assert.deepEqual(
    all.rows.map((doc) => doc.id),
    ["2", "3", "1"],
  );
  assert.deepEqual(all.counts, { all: 3, mine: 2, shared: 1 });
  assert.deepEqual(
    docsView(docs, { ...base, filter: "mine" }).rows.map((doc) => doc.id),
    ["3", "1"],
  );
  assert.deepEqual(
    docsView(docs, { ...base, filter: "shared" }).rows.map((doc) => doc.id),
    ["2"],
  );
  const leadership = docsView(docs, { ...base, workspaceId: "2" });
  assert.deepEqual(leadership.counts, { all: 1, mine: 1, shared: 0 });
  assert.deepEqual(
    docsView(docs, { ...base, query: "  VISION " }).rows.map((doc) => doc.id),
    ["1"],
  );
  assert.deepEqual(
    docWorkspaces(docs).map((workspace) => workspace.name),
    ["Leadership", "Main"],
  );
  assert.deepEqual(docCapabilities({ my_access: "viewer" }), {
    edit: false,
    manage: false,
    viewOnly: true,
  });
  assert.deepEqual(docCapabilities({ my_access: "owner" }), {
    edit: true,
    manage: true,
    viewOnly: false,
  });
  assert.equal(docCapabilities(null).edit, false);
});

const DOCUMENTS = {
  DOCS_LIST_QUERY,
  DOC_QUERY,
  UPDATE_DOC_MUTATION,
  DELETE_DOC_MUTATION,
};

/**
 * `ctx.api` for a seeded user over real HTTP (a browser session): GraphQL
 * errors become the UI's own `ApiError`s.
 */
function apiAs(servers, userId) {
  const client = servers.as(userId);
  return {
    async request(query, variables = {}) {
      const { body } = await client.call(query, variables);
      if (body.errors?.length) throw new ApiError(body.errors);
      return body.data;
    },
  };
}

test("doc documents parse and validate against the real API", async (t) => {
  const servers = await startTestServers();
  t.after(() => servers.close());
  const client = servers.as(servers.ids.users.alex);
  for (const [name, source] of Object.entries(DOCUMENTS)) {
    assert.doesNotThrow(() => parse(source), name);
    // Empty variables: validation runs first, then required variables
    // fail coercion before any resolver runs.
    const { body } = await client.call(source, {});
    const codes = (body.errors ?? []).map((error) => error.extensions.code);
    assert.equal(codes.includes("GRAPHQL_VALIDATION_FAILED"), false, name);
    assert.equal(codes.includes("GRAPHQL_PARSE_FAILED"), false, name);
  }
});

test("the doc editor's load and save path works against the real API", async (t) => {
  const servers = await startTestServers();
  t.after(() => servers.close());
  const { users, docs: seeded } = servers.ids;
  const alex = apiAs(servers, users.alex);
  const { docs, sharedIds } = await loadDocsList(alex);
  assert.deepEqual(
    docs.map((doc) => doc.title).sort(),
    ["Leadership offsite", "Product vision"],
    "Alex has no access to the private Launch brief",
  );
  assert.equal(sharedIds.size, 0);
  const doc = await loadDoc(alex, seeded.vision);
  assert.deepEqual(docCapabilities(doc), {
    edit: true,
    manage: true,
    viewOnly: false,
  });
  assert.equal(doc.blocks[0].type, "heading1");
  assert.ok(doc.blocks.some((block) => block.type === "todo" && block.checked));
  // Edit with the block operations, save with expected_version.
  const split = splitBlock(doc.blocks, 1, {
    start: 0,
    end: doc.blocks[1].text.length,
  });
  const blocks = setBlockType(split.blocks, 2, "callout").blocks;
  const saved = await saveDoc(alex, {
    id: doc.id,
    changes: { title: "Product vision 2027", blocks },
    expectedVersion: doc.version,
  });
  assert.equal(saved.version, doc.version + 1);
  assert.equal(saved.updated_by.id, users.alex);
  const reloaded = await loadDoc(alex, doc.id);
  assert.deepEqual(reloaded.blocks, blocks);
  assert.equal(reloaded.title, "Product vision 2027");
  // A stale version is a conflict that names the current version.
  await assert.rejects(
    saveDoc(alex, {
      id: doc.id,
      changes: { title: "Stale" },
      expectedVersion: doc.version,
    }),
    (error) =>
      error.code === "VERSION_CONFLICT" && error.version === saved.version,
  );

  // A viewer account reads but cannot edit.
  const jordan = apiAs(servers, users.jordan);
  const asViewer = await loadDoc(jordan, doc.id);
  assert.equal(docCapabilities(asViewer).viewOnly, true);
  await assert.rejects(
    saveDoc(jordan, {
      id: doc.id,
      changes: { title: "x" },
      expectedVersion: reloaded.version,
    }),
    (error) => error.code === "FORBIDDEN",
  );
  // A guest sees only the doc shared with them; others load as missing.
  const chris = apiAs(servers, users.chris);
  const guest = await loadDocsList(chris);
  assert.deepEqual(
    guest.docs.map((entry) => entry.id),
    [seeded.brief],
  );
  assert.deepEqual([...guest.sharedIds], [seeded.brief]);
  assert.equal(await loadDoc(chris, doc.id), null);
  assert.equal(await loadDoc(chris, "999999"), null);
  assert.equal(
    docCapabilities(await loadDoc(chris, seeded.brief)).viewOnly,
    true,
  );
  await assert.rejects(
    saveDoc(chris, {
      id: doc.id,
      changes: { title: "x" },
      expectedVersion: 1,
    }),
    (error) => error.code === "NOT_FOUND",
  );
});
