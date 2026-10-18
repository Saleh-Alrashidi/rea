/**
 * Form questions (SPEC-2 §2 `Question { id, column_id, label, help,
 * required }`): parsing `Form.questions_json`, the builder's list
 * operations and the definition a form is rendered from. Pure: no DOM and
 * no requests, so the builder, its preview and the tests share one reading.
 *
 * The rules mirror what the server validates (`server/store/forms.js`),
 * so the builder offers only changes that will be accepted:
 *
 * - the first question asks the board's `name` column; it is always
 *   required and cannot be moved or removed;
 * - each column is asked at most once, and people columns never;
 * - at most 50 questions, labels 1–200 characters, help up to 500.
 *
 * Question IDs are generated here rather than by the server, so the
 * builder's copy and the saved form always use the same IDs and an autosave
 * never has to merge server-made IDs back. The public form files answers by
 * question ID alone, and a respondent may still hold the definition from
 * before an edit, so an ID is never handed out twice: a new question gets a
 * random `q_<suffix>`, never the ID of a question removed earlier (which a
 * stale page would otherwise fill into the new question's column).
 */

import { parseStatusSettings } from "../board/values.js";

export const QUESTION_LIMITS = Object.freeze({
  questions: 50,
  label: 200,
  help: 500,
});

/** The column every form asks first (the new item's name). */
export const NAME_COLUMN = "name";
const QUESTION_ID = /^[\w-]{1,64}$/;

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readQuestion(raw) {
  if (!isPlainObject(raw)) return null;
  const { id, column_id: columnId, label } = raw;
  if (typeof id !== "string" || !QUESTION_ID.test(id)) return null;
  if (typeof columnId !== "string" || typeof label !== "string") return null;
  return {
    id,
    column_id: columnId,
    label,
    help: typeof raw.help === "string" ? raw.help : "",
    required: columnId === NAME_COLUMN || raw.required === true,
  };
}

/**
 * Parses `questions_json`.
 * @param {string} json
 * @returns {{ ok: true, value: object[] } | { ok: false, reason: string }}
 */
export function parseQuestions(json) {
  let raw;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false, reason: "The form’s questions are not valid JSON" };
  }
  if (!Array.isArray(raw)) {
    return { ok: false, reason: "The form’s questions are not a list" };
  }
  const questions = raw.map(readQuestion);
  if (questions.some((question) => question === null)) {
    return { ok: false, reason: "A question of this form is malformed" };
  }
  return { ok: true, value: questions };
}

/** 64 random bits in base 36 (at most 26 characters). */
function randomSuffix() {
  const words = globalThis.crypto.getRandomValues(new Uint32Array(2));
  return Array.from(words, (word) => word.toString(36)).join("");
}

/**
 * A new question ID, `q_<suffix>`, unused by `questions`. Random rather
 * than counted, so an ID a removed question had (and a stale public page
 * may still send) is not given to a later question. `suffix` is for tests.
 */
export function nextQuestionId(questions, suffix = randomSuffix) {
  const taken = new Set(questions.map((question) => question.id));
  let id = `q_${suffix()}`;
  while (taken.has(id)) id = `q_${suffix()}`;
  return id;
}

/** True for the fixed first question (the item name). */
export function isNameQuestion(question) {
  return question?.column_id === NAME_COLUMN;
}

/**
 * Board columns that can still be added as questions: not people, not the
 * name column (always asked first) and not asked yet; in board order.
 */
export function askableColumns(columns, questions) {
  const asked = new Set(questions.map((question) => question.column_id));
  return columns.filter(
    (column) =>
      column.type !== "people" &&
      column.id !== NAME_COLUMN &&
      !asked.has(column.id),
  );
}

/**
 * Appends a question for `column`, labelled with the column title.
 * @returns {{ ok: true, questions: object[], question: object }
 *   | { ok: false, reason: string }}
 */
export function addQuestion(questions, column) {
  if (questions.length >= QUESTION_LIMITS.questions) {
    return {
      ok: false,
      reason: `A form has at most ${QUESTION_LIMITS.questions} questions`,
    };
  }
  if (!askableColumns([column], questions).length) {
    return { ok: false, reason: "This column can’t be added as a question" };
  }
  const question = {
    id: nextQuestionId(questions),
    column_id: column.id,
    label: String(column.title).slice(0, QUESTION_LIMITS.label),
    help: "",
    required: false,
  };
  return { ok: true, questions: [...questions, question], question };
}

/** Whether the question at `index` can move by `delta` (±1). */
export function canMove(questions, index, delta) {
  const target = index + delta;
  return (
    index > 0 &&
    index < questions.length &&
    target >= 1 &&
    target < questions.length
  );
}

/** Moves the question at `index` by `delta`; the name question stays first. */
export function moveQuestion(questions, index, delta) {
  if (!canMove(questions, index, delta)) return questions;
  const next = [...questions];
  const [question] = next.splice(index, 1);
  next.splice(index + delta, 0, question);
  return next;
}

/**
 * Changes `label`, `help` and/or `required` of the question at `index`.
 * The name question stays required.
 */
export function updateQuestion(questions, index, changes) {
  const current = questions[index];
  if (!current) return questions;
  const next = { ...current };
  if (typeof changes.label === "string") next.label = changes.label;
  if (typeof changes.help === "string") next.help = changes.help;
  if (typeof changes.required === "boolean") {
    next.required = isNameQuestion(current) || changes.required;
  }
  return questions.map((question, at) => (at === index ? next : question));
}

/** Removes the question at `index` (never the name question). */
export function removeQuestion(questions, index) {
  if (index <= 0 || isNameQuestion(questions[index])) return questions;
  return questions.filter((_, at) => at !== index);
}

/**
 * The first problem that would make the server refuse `questions`, as
 * `{ index, field, message }`, or null when they can be saved. With
 * `columns`, a question whose column was removed from the board is one.
 */
export function questionsProblem(questions, columns = null) {
  if (!isNameQuestion(questions[0])) {
    return { index: 0, field: "label", message: "The name question is first" };
  }
  const known = columns && new Set(columns.map((column) => column.id));
  for (const [index, question] of questions.entries()) {
    if (known && !known.has(question.column_id)) {
      const message =
        "This column was removed from the board; remove the question";
      return { index, field: "column", message };
    }
    const label = question.label.trim();
    if (label === "") {
      return { index, field: "label", message: "Give this question a label" };
    }
    if (label.length > QUESTION_LIMITS.label) {
      const message = `Keep labels under ${QUESTION_LIMITS.label} characters`;
      return { index, field: "label", message };
    }
    if (question.help.length > QUESTION_LIMITS.help) {
      const message = `Keep help text under ${QUESTION_LIMITS.help} characters`;
      return { index, field: "help", message };
    }
  }
  return null;
}

/** `questions_json` for `update_form` (labels trimmed as the server stores them). */
export function serializeQuestions(questions) {
  return JSON.stringify(
    questions.map((question) => ({
      id: question.id,
      column_id: question.column_id,
      label: question.label.trim(),
      help: question.help,
      required: question.required,
    })),
  );
}

/** Non-empty status labels in index order (as `/f/<token>/definition`). */
function statusLabels(column) {
  return parseStatusSettings(column.settings_str).options.map(
    (option) => option.label,
  );
}

/**
 * The definition a form renders from, built from the builder's copy of the
 * form and its board's columns in the same shape the public page receives
 * from `GET /f/<token>/definition`; questions whose column was removed are
 * skipped, as the server skips them.
 *
 * @param {{ title: string, description: string | null, accent_color: string,
 *   submit_message: string | null, questions: object[] }} form
 * @param {{ id: string, title: string, type: string, settings_str: string }[]} columns
 */
export function definitionFromForm(form, columns) {
  const byId = new Map(columns.map((column) => [column.id, column]));
  return {
    title: form.title,
    description: form.description ?? null,
    accent_color: form.accent_color,
    submit_message: form.submit_message ?? null,
    questions: form.questions.flatMap((question) => {
      const column = byId.get(question.column_id);
      if (!column) return [];
      const entry = {
        id: question.id,
        label: question.label.trim() || column.title,
        help: question.help,
        required: question.required,
        type: column.type,
      };
      return column.type === "status"
        ? [{ ...entry, options: statusLabels(column) }]
        : [entry];
    }),
  };
}
