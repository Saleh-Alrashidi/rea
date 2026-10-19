/**
 * Mentions in update bodies (SPEC-6 §2.2). This is the only module that
 * reads or writes the token syntax: the store validates bodies with
 * `checkMentions`, notifications use `mentionsOf`, and the API renders
 * `bodyParts` (and `redactItems`) for each reader. Clients never parse
 * bodies; they send tokens and render `Update.body_parts`.
 *
 * Grammar. A body is text with mention tokens:
 *
 *     token   = "@[" display "](" kind ":" id ")"
 *     kind    = "user" | "team" | "item"
 *     id      = a record ID (1-16 digits, no leading zero)
 *     display = 1-255 characters once unescaped, not all blank, without
 *               line breaks; "\\", "\[" and "\]" stand for "\", "[" and
 *               "]", an unescaped "[" makes it no token, and the first
 *               unescaped "]" ends it (other backslashes are literal)
 *
 * In text, a run of n backslashes right before a well-formed token stands
 * for ⌊n/2⌋ backslashes, and the token is a mention when n is even and
 * literal text (as written) when n is odd. Every other character,
 * backslashes included, is literal, so text without a well-formed token
 * reads exactly as written; `escapeText` turns any plain text into a body
 * that reads as that text. Anything that is not a well-formed token (an
 * unknown kind, a bad ID, an unclosed bracket) is text.
 *
 * The display is the name the author saw (a snapshot); readers see the
 * current name of what they may see, and the snapshot otherwise. Parsing
 * is linear: a token attempt starts only at "@[" and stops at the next
 * unescaped bracket, line break or the display limit.
 */
import { LIMITS } from "./input.js";

export const MENTION_KINDS = Object.freeze(["user", "team", "item"]);
/** Mention tokens one body may hold (SPEC-6 §2.2). */
export const MAX_MENTIONS = 50;
/** The display of an item mention the reader cannot open. */
export const PRIVATE_TASK = "Private task";
/** URLs longer than this stay text (the data file's link limit). */
const MAX_LINK = 2048;

const ESCAPABLE = new Set(["\\", "[", "]"]);
const TAIL = /\]\((user|team|item):([1-9]\d{0,15})\)/y;
const LINK = /\bhttps?:\/\/[^\s<>"]+/giu;
const LINK_TRAILERS = new Set([".", ",", ";", ":", "!", "?", "'", '"']);

const isMention = (segment) => segment.kind !== undefined;

/** The well-formed token at `at` (an "@[") of `text`, else null. */
function readToken(text, at) {
  let display = "";
  let index = at + 2;
  while (index < text.length && display.length <= LIMITS.name) {
    const char = text[index];
    if (char === "]") break;
    if (char === "[" || char === "\n" || char === "\r") return null;
    const next = text[index + 1];
    const escaped = char === "\\" && ESCAPABLE.has(next);
    display += escaped ? next : char;
    index += escaped ? 2 : 1;
  }
  if (display.length > LIMITS.name || display.trim() === "") return null;
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

/**
 * Calls `visit(token, at)` for each well-formed token of `text`, in order
 * (tokens never overlap).
 */
function eachToken(text, visit) {
  let at = text.indexOf("@[");
  while (at !== -1) {
    const token = readToken(text, at);
    if (token !== null) visit(token, at);
    at = text.indexOf("@[", token === null ? at + 2 : token.end);
  }
}

/**
 * The segments of `body` in order: `{ text }` (unescaped, adjacent text
 * merged) and mentions `{ kind, id, display }`.
 */
export function parseBody(body) {
  const segments = [];
  let text = "";
  let from = 0;
  eachToken(body, (token, at) => {
    const run = backslashesBefore(body, from, at);
    text += body.slice(from, at - run) + "\\".repeat(Math.floor(run / 2));
    from = token.end;
    if (run % 2 === 1) {
      text += body.slice(at, token.end);
      return;
    }
    if (text !== "") segments.push({ text });
    segments.push({ kind: token.kind, id: token.id, display: token.display });
    text = "";
  });
  text += body.slice(from);
  if (text !== "") segments.push({ text });
  return segments;
}

/**
 * Plain `text` as body text that reads as `text`: every well-formed token
 * in it is escaped. `beforeToken`: a mention follows, so a trailing run
 * of backslashes is doubled.
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

/** The token of mention `{ kind, id, display }`. */
export function mentionToken({ kind, id, display }) {
  const shown = display.replace(/[\r\n]+/g, " ").replace(/[\\[\]]/g, "\\$&");
  return `@[${shown}](${kind}:${id})`;
}

/** Writes `segments` (as `parseBody` returns them) as a body. */
export function serializeBody(segments) {
  const merged = [];
  for (const segment of segments) {
    const last = merged.at(-1);
    if (isMention(segment) || last === undefined || isMention(last)) {
      merged.push(segment);
    } else merged[merged.length - 1] = { text: last.text + segment.text };
  }
  return merged
    .map((segment, index) => {
      if (isMention(segment)) return mentionToken(segment);
      const next = merged[index + 1];
      return escapeText(segment.text, next !== undefined);
    })
    .join("");
}

/** The mentions of a stored `body`: `[{ kind, id }]` in order. */
export const mentionsOf = (body) =>
  parseBody(body)
    .filter(isMention)
    .map(({ kind, id }) => ({ kind, id }));

/**
 * Validates the mentions of `body`: at most MAX_MENTIONS tokens (counted
 * as written), and each mention `known(kind, id)` refuses becomes plain
 * text "@<display>". Returns `{ body, mentions: [{ kind, id }] }` with the
 * body written canonically, or null when it holds too many tokens.
 */
export function checkMentions(body, known) {
  const segments = parseBody(body);
  if (segments.filter(isMention).length > MAX_MENTIONS) return null;
  const checked = segments.map((segment) =>
    !isMention(segment) || known(segment.kind, segment.id)
      ? segment
      : { text: `@${segment.display}` },
  );
  const mentions = checked
    .filter(isMention)
    .map(({ kind, id }) => ({ kind, id }));
  return { body: serializeBody(checked), mentions };
}

/**
 * `body` with the display of each item mention whose ID `canOpen(id)`
 * refuses replaced by PRIVATE_TASK (so a task name never reaches readers
 * who cannot open its board); unchanged otherwise.
 */
export function redactItems(body, canOpen) {
  if (!body.includes("](item:")) return body;
  let changed = false;
  const segments = parseBody(body).map((segment) => {
    if (segment.kind !== "item" || canOpen(segment.id)) return segment;
    changed = true;
    return { ...segment, display: PRIVATE_TASK };
  });
  return changed ? serializeBody(segments) : body;
}

/** `url` without trailing punctuation and unbalanced closing parentheses. */
function trimLink(url) {
  let opens = 0;
  let closes = 0;
  for (const char of url) {
    if (char === "(") opens += 1;
    else if (char === ")") closes += 1;
  }
  let end = url.length;
  while (end > 0) {
    const last = url[end - 1];
    if (last === ")" && closes > opens) closes -= 1;
    else if (!LINK_TRAILERS.has(last)) break;
    end -= 1;
  }
  return url.slice(0, end);
}

const isLink = (url) =>
  url.length <= MAX_LINK && URL.canParse(url) && new URL(url).hostname !== "";

/** Text parts of `text`: `{ type: "text", text }` and `{ type: "link", url }`. */
function textParts(text) {
  const parts = [];
  let from = 0;
  for (const match of text.matchAll(LINK)) {
    const url = trimLink(match[0]);
    if (!isLink(url)) continue;
    if (match.index > from)
      parts.push({ type: "text", text: text.slice(from, match.index) });
    parts.push({ type: "link", url, text: url });
    from = match.index + url.length;
  }
  if (from < text.length) parts.push({ type: "text", text: text.slice(from) });
  return parts;
}

/**
 * `body` as parts for one reader: text as `{ type: "text", text }` and
 * `{ type: "link", url, text }` (http(s) URLs in text), each mention as
 * `render({ kind, id, display })`.
 */
export const bodyParts = (body, render) =>
  parseBody(body).flatMap((segment) =>
    isMention(segment) ? [render(segment)] : textParts(segment.text),
  );

/**
 * Plain `text` cut so that its body form (`escapeText`) has at most `max`
 * characters: `text` itself when that fits, else its first `max`
 * characters, shortened further only as far as escapes need, never
 * splitting a surrogate pair (imports cut long source texts with it).
 */
export function fitText(text, max) {
  const whole = (cut) =>
    /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
  let cut = text.length > max ? whole(text.slice(0, max)) : text;
  for (let size = escapeText(cut).length; size > max;) {
    cut = whole(cut.slice(0, cut.length - (size - max)));
    size = escapeText(cut).length;
  }
  return cut;
}
