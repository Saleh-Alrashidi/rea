/**
 * The mention token syntax (SPEC-6 §2.2, `server/mentions.js`): tokens and
 * what is no token, escapes in text and displays, the canonical form,
 * validation (unknown IDs become text, at most 50 tokens), the length a
 * body reads as, redaction for one reader (private tasks, hidden people
 * and teams), link parts (bounded, ending at invisible characters),
 * cutting imported text, and linear parsing.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_LINKS,
  MAX_MENTIONS,
  PRIVATE_TASK,
  bodyParts,
  checkMentions,
  escapeText,
  fitText,
  mentionToken,
  mentionsOf,
  parseBody,
  readLength,
  redactBody,
  serializeBody,
} from "../server/mentions.js";

const user = (id, display) => ({ kind: "user", id, display });

test("tokens name users, teams and items; anything else is text", () => {
  assert.deepEqual(
    parseBody(
      "Hi @[Sam Lee](user:2), @[Product](team:3) and @[Fix it](item:345)!",
    ),
    [
      { text: "Hi " },
      user("2", "Sam Lee"),
      { text: ", " },
      { kind: "team", id: "3", display: "Product" },
      { text: " and " },
      { kind: "item", id: "345", display: "Fix it" },
      { text: "!" },
    ],
  );
  const notTokens = [
    "@[Doc](doc:1)",
    "@[Zero](user:012)",
    "@[Long](user:12345678901234567)",
    "@[ ](user:1)",
    "@[Two\nlines](user:1)",
    "@[Open [bracket](user:1)",
    "@[Sam] (user:1)",
    "@[Sam](user:1",
    "@Sam(user:1)",
    `@[${"x".repeat(256)}](user:1)`,
  ];
  for (const text of notTokens) {
    assert.deepEqual(parseBody(text), [{ text }], text);
    assert.deepEqual(mentionsOf(text), [], text);
  }
  assert.deepEqual(parseBody(`@[${"x".repeat(255)}](user:1)`), [
    user("1", "x".repeat(255)),
  ]);
  assert.deepEqual(parseBody(""), []);
});

test("escapes: displays take \\\\, \\[ and \\]; backslash runs before a token", () => {
  assert.deepEqual(parseBody("@[A \\[b\\] \\\\ c\\d](user:1)"), [
    user("1", "A [b] \\ c\\d"),
  ]);
  // n backslashes before a token: ⌊n/2⌋ backslashes, literal when odd.
  assert.deepEqual(parseBody("\\@[Sam](user:2)"), [{ text: "@[Sam](user:2)" }]);
  assert.deepEqual(parseBody("\\\\@[Sam](user:2)"), [
    { text: "\\" },
    user("2", "Sam"),
  ]);
  assert.deepEqual(parseBody("\\\\\\@[Sam](user:2)"), [
    { text: "\\@[Sam](user:2)" },
  ]);
  // Backslashes anywhere else, and before no token, stay as written.
  const plain = "C:\\Users\\me \\@[not a token \\\\";
  assert.deepEqual(parseBody(plain), [{ text: plain }]);
});

test("escapeText and serializeBody round-trip every text", () => {
  const texts = [
    "plain text",
    "@[Sam](user:2)",
    "\\@[Sam](user:2)",
    "a\\\\@[A](team:3)b@[B](item:9)",
    "trailing \\",
    "@[x\\]y](user:1) and @[ok]",
  ];
  for (const text of texts) {
    assert.deepEqual(parseBody(escapeText(text)), [{ text }], text);
  }
  assert.equal(escapeText("no tokens \\ here"), "no tokens \\ here");
  // A text before a mention keeps its trailing backslashes.
  const segments = [
    { text: "end\\" },
    user("2", "Sam [x]"),
    { text: "@[Lit](user:3)" },
  ];
  const body = serializeBody(segments);
  assert.equal(body, "end\\\\@[Sam \\[x\\]](user:2)\\@[Lit](user:3)");
  assert.deepEqual(parseBody(body), segments);
  assert.equal(serializeBody(parseBody(body)), body, "canonical");
  assert.equal(
    mentionToken(user("4", "A\nB")),
    "@[A B](user:4)",
    "no line breaks in a display",
  );
});

test("checkMentions turns unknown mentions into text and caps tokens", () => {
  const known = (kind, id) => kind !== "user" || id !== "999";
  const body = "Hi @[Ghost](user:999) and \\\\@[Gone](user:999) @[Sam](user:2)";
  const checked = checkMentions(body, known);
  assert.deepEqual(checked.mentions, [{ kind: "user", id: "2" }]);
  assert.deepEqual(parseBody(checked.body), [
    { text: "Hi @Ghost and \\@Gone " },
    user("2", "Sam"),
  ]);
  // A display that looks like a token stays text once it is plain.
  const sneaky = checkMentions("@[@\\[S\\](user:2)](user:999)", known);
  assert.deepEqual(sneaky.mentions, []);
  assert.deepEqual(parseBody(sneaky.body), [{ text: "@@[S](user:2)" }]);
  const many = (n) => Array.from({ length: n }, () => "@[S](user:2)").join(" ");
  assert.equal(checkMentions(many(MAX_MENTIONS), known).mentions.length, 50);
  assert.equal(checkMentions(many(MAX_MENTIONS + 1), known), null);
  // Escaped (literal) tokens are text, not mentions.
  const escaped = Array.from({ length: 60 }, () => "\\@[S](user:2)").join("");
  assert.deepEqual(checkMentions(escaped, known).mentions, []);
});

test("redactBody: hidden people and teams read as text, private tasks as Private task", () => {
  const body =
    "See @[Secret plan](item:5), @[Open task](item:6), @[Noa](user:7), " +
    "@[Sam](user:8) and @[Product](team:3)";
  const sees = (kind, id) => (kind === "item" ? id === "6" : id === "8");
  const redacted = redactBody(body, sees);
  assert.deepEqual(parseBody(redacted), [
    { text: "See " },
    { kind: "item", id: "5", display: PRIVATE_TASK },
    { text: ", " },
    { kind: "item", id: "6", display: "Open task" },
    { text: ", @Noa, " },
    { kind: "user", id: "8", display: "Sam" },
    { text: " and @Product" },
  ]);
  assert.ok(!/user:7|team:3/.test(redacted), "no hidden ID");
  assert.equal(
    redactBody(body, () => true),
    body,
    "unchanged when visible",
  );
  const literal = "\\@[Secret](item:5) \\@[Noa](user:7)";
  assert.equal(
    redactBody(literal, () => false),
    literal,
    "text stays",
  );
  // A display that reads as a token stays text once redacted.
  const sneaky = mentionToken(user("7", "@[x](user:8)"));
  assert.deepEqual(parseBody(redactBody(sneaky, () => false)), [
    { text: "@@[x](user:8)" },
  ]);
});

test("readLength counts text as it reads and mentions as @<display>", () => {
  assert.equal(readLength("plain"), 5);
  assert.equal(readLength("@[Sam Lee](user:2)!"), "@Sam Lee!".length);
  // Escapes never count: an escaped token reads as written.
  assert.equal(readLength("\\@[x](user:1)"), "@[x](user:1)".length);
  assert.equal(readLength("\\\\@[x](user:1)"), "\\@x".length);
  const plain = "a\\@[b\\]](team:2) \\\\@[c](item:4)";
  assert.equal(readLength(escapeText(plain)), plain.length);
  // An unknown mention turned into text keeps the length.
  const body = "Hi @[Ghost](user:999) there";
  const checked = checkMentions(body, () => false).body;
  assert.equal(readLength(checked), readLength(body));
});

test("bodyParts splits text into text and http(s) link parts", () => {
  const render = (mention) => ({ type: mention.kind, id: mention.id });
  const text =
    "Docs: https://example.test/a_(b)). See (http://x.test/y), " +
    "https:// nope, ftp://x.test, xhttps://no.test, HTTPS://Up.test.";
  assert.deepEqual(bodyParts(`@[Sam](user:2) ${text}`, render), [
    { type: "user", id: "2" },
    { type: "text", text: " Docs: " },
    link("https://example.test/a_(b)"),
    { type: "text", text: "). See (" },
    link("http://x.test/y"),
    {
      type: "text",
      text: "), https:// nope, ftp://x.test, xhttps://no.test, ",
    },
    link("HTTPS://Up.test"),
    { type: "text", text: "." },
  ]);
  const long = `https://x.test/${"a".repeat(2100)}`;
  assert.deepEqual(bodyParts(long, render), [{ type: "text", text: long }]);
});

test("links end at bidi controls and other invisible characters", () => {
  const render = () => ({ type: "mention" });
  const stops = [
    ..."\u200E\u200F\u202A\u202B\u202C\u202D\u202E",
    ..."\u2066\u2067\u2068\u2069\u200B\u200C\u200D\u2060\uFEFF",
    ..."\u00AD\u061C\u0000\u001B\u007F\u0085\u3164\u115F",
  ];
  for (const stop of stops) {
    const text = `https://example.test/a${stop}gro.live/b`;
    const code = stop.codePointAt(0).toString(16);
    assert.deepEqual(
      bodyParts(text, render),
      [
        link("https://example.test/a"),
        { type: "text", text: `${stop}gro.live/b` },
      ],
      `U+${code}`,
    );
  }
  // Visible non-ASCII stays part of the link.
  const word = "https://example.test/caf\u00e9-\u65e5\u672c";
  assert.deepEqual(bodyParts(word, render), [link(word)]);
});

test("a body shows at most MAX_LINKS links; later URLs stay text", () => {
  const urls = Array.from(
    { length: MAX_LINKS + 5 },
    (_, n) => `https://x.test/${n}`,
  );
  const parts = bodyParts(`@[S](user:2) ${urls.join(" ")}`, () => ({
    type: "user",
  }));
  const links = parts.filter((part) => part.type === "link");
  assert.equal(links.length, MAX_LINKS);
  assert.equal(links.at(-1).url, urls[MAX_LINKS - 1]);
  assert.equal(parts.at(-1).text, ` ${urls.slice(MAX_LINKS).join(" ")}`);
});

function link(url) {
  return { type: "link", url, text: url };
}

test("fitText cuts plain text so that its escaped form fits", () => {
  assert.equal(fitText("abc", 5), "abc");
  assert.equal(fitText("abcdef", 4), "abcd");
  assert.equal(fitText("a😀b", 2), "a", "never half a surrogate pair");
  // "@[x](user:1)" needs one escape: 13 characters stored.
  assert.equal(fitText("@[x](user:1)", 13), "@[x](user:1)");
  assert.equal(fitText("@[x](user:1)z", 13), "@[x](user:1)");
  for (const max of [5, 12, 20]) {
    const text = "ab@[x](user:1)cd@[y](team:2)";
    assert.ok(escapeText(fitText(text, max)).length <= max, String(max));
  }
});

test("parsing stays linear on hostile bodies", () => {
  const bodies = [
    "@[".repeat(5000),
    `@[${"a".repeat(254)}`.repeat(40),
    "\\".repeat(9000) + "@[x](user:1)",
    `${"@[a\\[".repeat(2000)}](user:1)`,
  ];
  const started = performance.now();
  for (const body of bodies) {
    const segments = parseBody(body);
    assert.equal(parseBody(serializeBody(segments)).length, segments.length);
    escapeText(body);
    bodyParts(body, () => ({}));
  }
  assert.ok(performance.now() - started < 1000, "well under a second");
});
