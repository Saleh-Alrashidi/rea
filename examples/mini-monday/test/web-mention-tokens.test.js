/**
 * The composer's side of the mention grammar (`web/ui/board/mention-
 * tokens.js`): encoding a composer's text and side-table as a body, the
 * edit box's round trip of the author's own body, and the side-table
 * following edits. Every encoding is cross-checked against the server's
 * parser (`server/mentions.js`), which stays the only reader of stored
 * bodies for display.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { parseBody, readLength, serializeBody } from "../server/mentions.js";
import {
  bodyLength,
  decodeBody,
  draftParts,
  encodeBody,
  escapeText,
  intactMentions,
  mentionName,
  mentionToken,
  rebaseMentions,
} from "../web/ui/board/mention-tokens.js";

/** A side-table entry for `name` found at its `nth` "@name" in `text`. */
function at(text, { kind = "user", id = "2", name, nth = 0 }) {
  let start = -1;
  for (let index = 0; index <= nth; index += 1) {
    start = text.indexOf(`@${name}`, start + 1);
  }
  assert.notEqual(start, -1, name);
  return { start, end: start + 1 + name.length, kind, id, name };
}

/** What the server reads in `body`, as composer segments. */
const serverReads = (body) =>
  parseBody(body).map((segment) =>
    segment.kind
      ? { kind: segment.kind, id: segment.id, name: segment.display }
      : { text: segment.text },
  );

/** What a composer means: its text with each intact mention, merged. */
function meant(text, mentions) {
  const segments = [];
  let from = 0;
  for (const mention of intactMentions(text, mentions)) {
    if (mention.start > from) {
      segments.push({ text: text.slice(from, mention.start) });
    }
    segments.push({ kind: mention.kind, id: mention.id, name: mention.name });
    from = mention.end;
  }
  if (from < text.length) segments.push({ text: text.slice(from) });
  return segments;
}

test("picked mentions become tokens; a hand-typed @Name stays text", () => {
  const text = "Hi @Sam Lee and @Sam Lee, see @Fix login";
  const mentions = [
    at(text, { name: "Sam Lee", nth: 1, id: "2" }),
    at(text, { name: "Fix login", kind: "item", id: "345" }),
  ];
  const body = encodeBody(text, mentions);
  assert.equal(
    body,
    "Hi @Sam Lee and @[Sam Lee](user:2), see @[Fix login](item:345)",
  );
  assert.deepEqual(serverReads(body), meant(text, mentions));
  // Teams too; the body is trimmed as the server stores it.
  const team = "  @Product  ";
  const product = at(team, { name: "Product", kind: "team", id: "3" });
  assert.equal(encodeBody(team, [product]), "@[Product](team:3)");
  assert.equal(encodeBody("   ", []), "");
});

test("names and text escape exactly as the grammar reads them", () => {
  const name = "Ops [EU] \\ team";
  assert.equal(
    mentionToken({ kind: "team", id: "3", name }),
    "@[Ops \\[EU\\] \\\\ team](team:3)",
  );
  const text = `C:\\@${name}`;
  const mention = at(text, { name, kind: "team", id: "3" });
  const body = encodeBody(text, [mention]);
  // One backslash before a token is doubled so the token stays a mention.
  assert.equal(body, "C:\\\\@[Ops \\[EU\\] \\\\ team](team:3)");
  assert.deepEqual(serverReads(body), meant(text, [mention]));
  // Typed token syntax reads as typed.
  const typed = "literal @[Sam](user:2) and \\@[x](item:9)";
  assert.equal(encodeBody(typed, []), escapeText(typed));
  assert.deepEqual(serverReads(encodeBody(typed, [])), [{ text: typed }]);
  // Names that cannot be tokens are inserted as plain text.
  assert.equal(mentionName("Line\none"), "Line one");
  assert.equal(mentionName("   "), null);
  assert.equal(mentionName("x".repeat(256)), null);
  assert.equal(mentionName("x".repeat(255)), "x".repeat(255));
});

test("the edit box round trip is the server's canonical body", () => {
  const bodies = [
    "Hi @[Sam Lee](user:2), @[Product](team:3) and @[Fix it](item:345)!",
    "@[Ops \\[EU\\]](team:3)\\\\@[Sam](user:2)",
    "odd \\@[Sam](user:2) stays text",
    "three \\\\\\@[Sam](user:2) and four \\\\\\\\@[Sam](user:2)",
    "@[Doc](doc:1) @[Zero](user:012) @[ ](user:1) @[Open [b](user:1)",
    "unicode ✓ سلام @[سارة](user:7)\nline two",
    "plain text with \\ backslashes ] and [ brackets",
    "@[a](user:1)@[b](user:2)",
    "\\",
  ];
  for (const body of bodies) {
    const { text, mentions } = decodeBody(body);
    const canonical = serializeBody(parseBody(body)).trim();
    assert.equal(encodeBody(text, mentions), canonical, body);
    for (const mention of mentions) {
      assert.equal(text.slice(mention.start, mention.end), `@${mention.name}`);
    }
  }
  assert.deepEqual(decodeBody("Hi @[Ops \\[EU\\]](team:3)!"), {
    text: "Hi @Ops [EU]!",
    mentions: [{ start: 3, end: 12, kind: "team", id: "3", name: "Ops [EU]" }],
  });
  // An odd run of backslashes keeps the token as written, halved.
  assert.deepEqual(decodeBody("\\\\\\@[S](user:1)"), {
    text: "\\@[S](user:1)",
    mentions: [],
  });
});

/** A small deterministic generator (mulberry32). */
function random(seed) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = [
  "@",
  "[",
  "]",
  "(",
  ")",
  "\\",
  "user:",
  "item:7",
  "1",
  "a",
  " ",
  "\n",
  "@[x](user:1)",
  "é",
];
const NAMES = ["Sam", "A]b", "x\\", "[q", "Né"];

test("random composers encode to what the server parses", () => {
  const next = random(42);
  const pick = (list) => list[Math.floor(next() * list.length)];
  for (let round = 0; round < 400; round += 1) {
    let text = "";
    const mentions = [];
    const parts = 1 + Math.floor(next() * 8);
    for (let index = 0; index < parts; index += 1) {
      if (next() < 0.3) {
        const name = pick(NAMES);
        const start = text.length;
        text += `@${name}`;
        mentions.push({ start, end: text.length, kind: "user", id: "5", name });
      } else text += pick(PIECES);
    }
    const body = encodeBody(text, mentions);
    const trimmed = text.trim();
    const lead = text.length - text.trimStart().length;
    const shifted = mentions
      .map((m) => ({ ...m, start: m.start - lead, end: m.end - lead }))
      .filter((m) => m.start >= 0 && m.end <= trimmed.length);
    assert.deepEqual(serverReads(body), meant(trimmed, shifted), text);
    // Decoding the body gives the composer back (trimmed).
    const decoded = decodeBody(body);
    assert.equal(decoded.text, trimmed, text);
    assert.equal(encodeBody(decoded.text, decoded.mentions), body, text);
    // The length the server's limit counts is the composer's text.
    assert.equal(bodyLength(body), readLength(body), text);
    assert.equal(bodyLength(body), trimmed.length, text);
  }
});

test("the side-table follows edits and drops touched mentions", () => {
  const before = "Hi @Sam Lee!";
  const sam = at(before, { name: "Sam Lee" });
  // Typing before it moves it; after it keeps it.
  assert.deepEqual(rebaseMentions([sam], before, `Oh. ${before}`), [
    { ...sam, start: sam.start + 4, end: sam.end + 4 },
  ]);
  assert.deepEqual(rebaseMentions([sam], before, `${before} Thanks`), [sam]);
  assert.deepEqual(rebaseMentions([sam], before, "Hi @Sam Lee"), [sam]);
  // Editing inside it (or deleting it) drops it.
  assert.deepEqual(rebaseMentions([sam], before, "Hi @Sam Le!"), []);
  assert.deepEqual(rebaseMentions([sam], before, "Hi @Sxm Lee!"), []);
  assert.deepEqual(rebaseMentions([sam], before, "Hi !"), []);
  assert.deepEqual(rebaseMentions([sam], before, before), [sam]);
  // Overlapping entries keep the first.
  const text = "@Sam Lee";
  const both = [at(text, { name: "Sam Lee" }), at(text, { name: "Sam" })];
  assert.equal(intactMentions(text, both).length, 1);
});

test("draft parts show the composer before the server answers", () => {
  const text = "  Ask @Sam about @Fix  ";
  const mentions = [
    at(text, { name: "Sam", id: "2" }),
    { ...at(text, { name: "Fix", kind: "item", id: "9" }), boardId: "4" },
  ];
  assert.deepEqual(draftParts(text, mentions), [
    { type: "text", text: "Ask " },
    { type: "user", text: "Sam", id: "2" },
    { type: "text", text: " about " },
    { type: "item", text: "Fix", id: "9", boardId: "4" },
  ]);
});
