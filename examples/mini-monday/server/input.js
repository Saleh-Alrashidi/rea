/**
 * Input rules shared by the store, the GraphQL schema, column values and
 * the HTTP routes: limits (SPEC.md, SPEC-2 §2), record ID and color
 * formats, the name rule and how messages quote caller-supplied values.
 * Each rule is defined here once; callers turn a violation into their own
 * error (a store failure, BAD_USER_INPUT, a parse result).
 */

/** Limits in characters unless stated. */
export const LIMITS = Object.freeze({
  // Names and titles of every record (trimmed).
  name: 255,
  description: 2000,
  // Text column values (SPEC.md column values).
  textValue: 2000,
  // Item update bodies (trimmed).
  updateBody: 10_000,
  blocks: 2000,
  blockText: 10_000,
  noteBody: 20_000,
  questions: 50,
  label: 200,
  help: 500,
  // Unspecified: emails share the name limit.
  email: 255,
});

/** Record IDs: decimal strings from the store's shared counter. */
export const ID_PATTERN = /^[1-9]\d{0,15}$/;
/** Colors are `#rrggbb` (either case on input). */
export const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export const isPlainObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isColor = (value) =>
  typeof value === "string" && COLOR_PATTERN.test(value);

/** The trimmed name when `value` is a valid name (1-255 characters), else null. */
export function validName(value) {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name !== "" && name.length <= LIMITS.name ? name : null;
}

/** The message for an invalid name labelled `label` ("Board name"). */
export const nameRule = (label) =>
  `${label} must be 1-${LIMITS.name} characters`;

const MAX_QUOTED_LENGTH = 40;

/** A short JSON rendering of a caller-supplied value for messages. */
export function describe(value) {
  const text = String(value);
  const shown =
    text.length > MAX_QUOTED_LENGTH
      ? `${text.slice(0, MAX_QUOTED_LENGTH)}…`
      : text;
  return JSON.stringify(shown);
}
