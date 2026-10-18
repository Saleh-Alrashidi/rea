/**
 * Form definitions and answers, shared by the public form page and the
 * builder's preview (both render through `renderer.js`). Pure: no DOM.
 *
 * `normalizeDefinition` parses the untrusted JSON of
 * `GET /f/<token>/definition` once, at the boundary, into the shape the
 * renderer reads. `validateAnswers` gives the client-side checks shown
 * before a submission; the server parses every answer again with its
 * column parsers and stays the authority (`server/routes/forms.js`).
 */

import { safeColor } from "../board/values.js";

/** The server's default confirmation (`store/forms.js` SUBMIT_MESSAGE). */
export const DEFAULT_SUBMIT_MESSAGE = "Thanks! Your response was recorded.";
/** Worklane indigo, the default accent of new forms. */
export const DEFAULT_ACCENT = "#5b5bd6";
/** Answer length limits of the column parsers (name 255, text 2,000). */
export const ANSWER_LIMITS = Object.freeze({ name: 255, text: 2000 });

const QUESTION_ID = /^[\w-]{1,64}$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_TITLE = 255;
const MAX_DESCRIPTION = 2000;
const MAX_QUESTIONS = 50;

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const text = (value, max) =>
  typeof value === "string" ? value.slice(0, max) : null;

function readQuestion(raw) {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.id !== "string" || !QUESTION_ID.test(raw.id)) return null;
  if (typeof raw.label !== "string" || typeof raw.type !== "string") {
    return null;
  }
  const question = {
    id: raw.id,
    label: raw.label.slice(0, 200),
    help: text(raw.help, 500) ?? "",
    required: raw.required === true,
    type: raw.type,
  };
  if (raw.type === "status") {
    const options = Array.isArray(raw.options) ? raw.options : [];
    question.options = [
      ...new Set(
        options.filter((option) => typeof option === "string" && option),
      ),
    ];
  }
  return question;
}

/**
 * Parses a form definition (`{ title, description, accent_color,
 * submit_message, questions: [{ id, label, help, required, type,
 * options? }] }`). Questions with duplicate IDs make it malformed.
 *
 * @param {unknown} raw
 * @returns {{ ok: true, value: object } | { ok: false, reason: "malformed" }}
 */
export function normalizeDefinition(raw) {
  const malformed = { ok: false, reason: "malformed" };
  if (!isPlainObject(raw) || typeof raw.title !== "string") return malformed;
  if (!Array.isArray(raw.questions) || raw.questions.length > MAX_QUESTIONS) {
    return malformed;
  }
  const questions = raw.questions.map(readQuestion);
  if (questions.some((question) => question === null)) return malformed;
  const ids = new Set(questions.map((question) => question.id));
  if (ids.size !== questions.length) return malformed;
  const message = text(raw.submit_message, MAX_DESCRIPTION)?.trim();
  return {
    ok: true,
    value: {
      title: raw.title.slice(0, MAX_TITLE) || "Untitled form",
      description: text(raw.description, MAX_DESCRIPTION) || null,
      accent_color: safeColor(raw.accent_color, DEFAULT_ACCENT),
      submit_message: message || DEFAULT_SUBMIT_MESSAGE,
      questions,
    },
  };
}

function isRealDate(value) {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

const TYPE_CHECKS = Object.freeze({
  name: (value) =>
    value.length > ANSWER_LIMITS.name
      ? `Keep this under ${ANSWER_LIMITS.name} characters`
      : null,
  text: (value) =>
    value.length > ANSWER_LIMITS.text
      ? `Keep this under ${ANSWER_LIMITS.text} characters`
      : null,
  numbers: (value) =>
    Number.isFinite(Number(value)) ? null : "Enter a number, like 42 or 3.5",
  date: (value) => (isRealDate(value) ? null : "Pick a date"),
  status: (value, question) =>
    question.options?.includes(value) ? null : "Choose one of the options",
});

/**
 * The problem with one answer, or null. `value` is the field's text.
 * @param {{ type: string, required: boolean, options?: string[] }} question
 * @param {string} value
 * @returns {string | null}
 */
export function answerProblem(question, value) {
  const trimmed = String(value ?? "").trim();
  if (trimmed === "") {
    return question.required ? "This question is required" : null;
  }
  const check = TYPE_CHECKS[question.type] ?? TYPE_CHECKS.text;
  return check(trimmed, question);
}

/**
 * Checks every answer. Returns the answers to send (non-empty ones,
 * trimmed, keyed by question ID; empty optional answers are left out as
 * the server reads a missing answer as empty) and the problems by
 * question ID.
 *
 * @param {object[]} questions normalized definition questions
 * @param {Record<string, string>} values the fields' text by question ID
 * @returns {{ answers: Record<string, string>, errors: Record<string, string> }}
 */
export function validateAnswers(questions, values) {
  const answers = {};
  const errors = {};
  for (const question of questions) {
    const value = Object.hasOwn(values, question.id) ? values[question.id] : "";
    const problem = answerProblem(question, value);
    if (problem) errors[question.id] = problem;
    else if (String(value ?? "").trim() !== "") {
      answers[question.id] = String(value).trim();
    }
  }
  return { answers, errors };
}

/**
 * Splits a 400 response's `errors` into problems by question ID (from
 * `extensions.question_id`) and general messages.
 * @param {unknown} errors
 * @returns {{ fields: Record<string, string>, messages: string[] }}
 */
export function splitSubmitErrors(errors) {
  const fields = {};
  const messages = [];
  for (const error of Array.isArray(errors) ? errors : []) {
    const message =
      typeof error?.message === "string" && error.message
        ? error.message.slice(0, 300)
        : "This answer can’t be used";
    const id = error?.extensions?.question_id;
    if (typeof id === "string" && QUESTION_ID.test(id)) {
      fields[id] ??= message;
    } else {
      messages.push(message);
    }
  }
  return { fields, messages };
}
