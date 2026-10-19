/**
 * Mention tokens on the client (SPEC-6 §2.2): the composer's side of the
 * grammar `server/mentions.js` owns. The server is the only parser of
 * stored bodies for display (`Update.body_parts`); this module only
 *
 * - ENCODES what a composer holds, its text with the side-table of
 *   inserted mentions (`{ start, end, kind, id, name, boardId? }`: the
 *   text shows "@<name>" from `start` to `end`), as a body: each intact
 *   mention becomes its token and all other text is escaped so that it
 *   reads exactly as typed (`encodeBody`);
 * - DECODES the author's own raw body (`Update.body`) back into text and
 *   a side-table for the edit box (`decodeBody`): the edit-box round
 *   trip. `encodeBody(decodeBody(body))` is the server's canonical form
 *   of `body`, and the tests cross-check both directions against
 *   `server/mentions.js` on the same strings.
 *
 * Grammar (as `server/mentions.js`):
 *
 *     token   = "@[" display "](" kind ":" id ")"   kind = user | team | item
 *     id      = 1-16 digits, no leading zero
 *     display = 1-255 characters once unescaped, not all blank, no line
 *               break; "\\", "\[", "\]" stand for "\", "[", "]"; the
 *               first unescaped "]" ends it, and an unescaped "[" before
 *               it makes it no token
 *
 * A run of n backslashes right before a well-formed token stands for
 * ⌊n/2⌋ backslashes; the token is a mention when n is even and literal
 * text when n is odd. Every other character is literal.
 *
 * The side-table follows edits (`rebaseMentions`): a mention survives
 * while its "@<name>" is untouched, and moves with the text around it.
 */

export const MENTION_KINDS = Object.freeze(["user", "team", "item"]);
/** Longest display a token may carry (the server's name limit). */
export const MAX_DISPLAY = 255;

const ESCAPABLE = new Set(["\\", "[", "]"]);
const TAIL = /\]\((user|team|item):([1-9]\d{0,15})\)/y;
const ID_PATTERN = /^[1-9]\d{0,15}$/;

// ------------------------------------------------------------- grammar

/** The well-formed token at `at` (an "@[") of `text`, else null. */
function readToken(text, at) {
  let display = "";
  let index = at + 2;
  while (index < text.length && display.length <= MAX_DISPLAY) {
    const char = text[index];
    if (char === "]") break;
    if (char === "[" || char === "\n" || char === "\r") return null;
    const next = text[index + 1];
    const escaped = char === "\\" && ESCAPABLE.has(next);
    display += escaped ? next : char;
    index += escaped ? 2 : 1;
  }
  if (display.length > MAX_DISPLAY || display.trim() === "") return null;
  TAIL.lastIndex = index;
  const match = TAIL.exec(text);
  if (match === null) return null;
  return { kind: match[1], id: match[2], display, end: TAIL.lastIndex };
}

/** How many backslashes come right before `at` in `text`, from `from` on. */
function backslashesBefore(text, from, at) {
  let start = at;
  while (start > from && text[start - 1] === "\\") start -= 1;
  return at - start;
}

/** Calls `visit(token, at)` for each well-formed token of `text`, in order. */
function eachToken(text, visit) {
  let at = text.indexOf("@[");
  while (at !== -1) {
    const token = readToken(text, at);
    if (token !== null) visit(token, at);
    at = text.indexOf("@[", token === null ? at + 2 : token.end);
  }
}

/**
 * Plain `text` as body text that reads as `text` (every well-formed token
 * in it escaped); `beforeToken`: a mention follows, so a trailing run of
 * backslashes is doubled.
 */
export function escapeText(text, beforeToken = false) {
  let out = "";
  let from = 0;
  eachToken(text, (_token, at) => {
    const run = backslashesBefore(text, from, at);
    out += text.slice(from, at) + "\\".repeat(run + 1);
    from = at;
  });
  out += text.slice(from);
  if (!beforeToken) return out;
  return out + "\\".repeat(backslashesBefore(out, 0, out.length));
}

/** The token of a mention `{ kind, id, name }`. */
export function mentionToken({ kind, id, name }) {
  const shown = name.replace(/[\r\n]+/g, " ").replace(/[\\[\]]/g, "\\$&");
  return `@[${shown}](${kind}:${id})`;
}

/**
 * The name a mention of `name` shows in the composer and its token: line
 * breaks become spaces; null when no token can carry it (blank, longer
 * than MAX_DISPLAY), so it is inserted as plain text.
 */
export function mentionName(name) {
  const shown = String(name ?? "").replace(/[\r\n]+/g, " ");
  if (shown.trim() === "" || shown.length > MAX_DISPLAY) return null;
  return shown;
}

/** Whether `kind` and `id` can form a token. */
export const isMentionTarget = (kind, id) =>
  MENTION_KINDS.includes(kind) && ID_PATTERN.test(String(id));

// ---------------------------------------------------------- side-table

/** Whether `mention` still reads "@<name>" in `text`. */
export const isIntact = (text, mention) =>
  text.slice(mention.start, mention.end) === `@${mention.name}`;

/**
 * The side-table after `before` became `after`: mentions before the
 * changed span stay, those after it move by the change in length, and
 * any the change touched are dropped (no longer intact). The changed span
 * is what remains between the longest common prefix and suffix.
 */
export function rebaseMentions(mentions, before, after) {
  if (before === after) return mentions;
  const shortest = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < shortest && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < shortest - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const changedEnd = before.length - suffix;
  const delta = after.length - before.length;
  const kept = [];
  for (const mention of mentions) {
    if (mention.end <= prefix) kept.push(mention);
    else if (mention.start >= changedEnd) {
      kept.push({
        ...mention,
        start: mention.start + delta,
        end: mention.end + delta,
      });
    }
  }
  return kept.filter((mention) => isIntact(after, mention));
}

/**
 * The intact mentions of `mentions` in `text`, in text order, without
 * overlaps (a later one overlapping an earlier one is dropped).
 */
export function intactMentions(text, mentions) {
  const ordered = mentions
    .filter((mention) => isIntact(text, mention))
    .sort((a, b) => a.start - b.start);
  const kept = [];
  for (const mention of ordered) {
    if (kept.length === 0 || mention.start >= kept.at(-1).end) {
      kept.push(mention);
    }
  }
  return kept;
}

/**
 * `text` split at its intact `mentions`: `[{ text }]` and the mentions
 * themselves, in order, without empty text.
 */
export function composerSegments(text, mentions) {
  const segments = [];
  let from = 0;
  for (const mention of intactMentions(text, mentions)) {
    if (mention.start > from) {
      segments.push({ text: text.slice(from, mention.start) });
    }
    segments.push(mention);
    from = mention.end;
  }
  if (from < text.length) segments.push({ text: text.slice(from) });
  return segments;
}

// ------------------------------------------------------ encode, decode

/**
 * The body of a composer: its text (trimmed) with each intact mention as
 * its token and the rest escaped to read as typed. A hand-typed "@Name"
 * that no pick put in the side-table stays text.
 */
export function encodeBody(text, mentions) {
  const segments = composerSegments(text, mentions);
  const body = segments
    .map((segment, index) => {
      if (segment.kind) return mentionToken(segment);
      return escapeText(segment.text, index < segments.length - 1);
    })
    .join("");
  return body.trim();
}

/**
 * The edit box of the author's own raw `body`: `{ text, mentions }`,
 * each token shown as "@<display>" with its side-table entry, and text
 * unescaped as the grammar reads it.
 */
export function decodeBody(body) {
  let text = "";
  let from = 0;
  const mentions = [];
  eachToken(body, (token, at) => {
    const run = backslashesBefore(body, from, at);
    text += body.slice(from, at - run) + "\\".repeat(Math.floor(run / 2));
    from = token.end;
    if (run % 2 === 1) {
      text += body.slice(at, token.end);
      return;
    }
    const start = text.length;
    text += `@${token.display}`;
    const { kind, id, display: name } = token;
    mentions.push({ start, end: text.length, kind, id, name });
  });
  text += body.slice(from);
  return { text, mentions };
}

/**
 * How many characters `body` reads as: its text unescaped, each mention
 * as "@<display>" (the edit box's text). The server's length limit
 * counts this (`server/mentions.js readLength`), so escapes never make a
 * body that reads as written too long.
 */
export const bodyLength = (body) => decodeBody(body).text.length;

/**
 * What a composer's text will show once posted, before the server
 * answers (an optimistic update): text parts and mention parts shaped
 * like `Update.body_parts` (links are found by the server later).
 */
export function draftParts(text, mentions) {
  const trimmed = text.trim();
  const lead = text.length - text.trimStart().length;
  const shifted = mentions.map((mention) => ({
    ...mention,
    start: mention.start - lead,
    end: mention.end - lead,
  }));
  return composerSegments(trimmed, shifted).map((segment) => {
    if (!segment.kind) return { type: "text", text: segment.text };
    const part = { type: segment.kind, text: segment.name, id: segment.id };
    if (segment.kind !== "item") return part;
    return { ...part, boardId: segment.boardId ?? null };
  });
}
