/**
 * The form builder's question list: one card per question with its board
 * column, label, help text and a "Required" checkbox, move up/down and remove
 * buttons, and "Add question", which picks one of the board's columns that
 * can still be asked. The name question is always first, required and
 * kept. List rules come from `questions.js`; this module only draws them.
 *
 * The list owns its copy of the questions and calls `onChange(questions)`
 * after every edit; the page decides when to save.
 */

import { h } from "../../dom.js";
import { ADDABLE_COLUMN_TYPES } from "../board/values.js";
import { badge } from "../components/badge.js";
import { button, iconButton } from "../components/button.js";
import { icon } from "../components/icon.js";
import { openMenu } from "../components/menu.js";
import { REASONS } from "../components/permissions.js";
import {
  QUESTION_LIMITS,
  addQuestion,
  askableColumns,
  canMove,
  isNameQuestion,
  moveQuestion,
  removeQuestion,
  updateQuestion,
} from "./questions.js";

const TYPE_ICONS = Object.freeze({
  name: "item",
  text: "chat",
  status: "check",
  date: "calendar",
  numbers: "activity",
});

/** "Status", "Date", … ("Item name" for the name column). */
export function columnTypeLabel(type) {
  if (type === "name") return "Item name";
  return (
    ADDABLE_COLUMN_TYPES.find((entry) => entry.type === type)?.label ?? type
  );
}

function columnLine(column) {
  if (!column) {
    return h(
      "span",
      { class: "fb-question-column missing" },
      icon("alert", { size: 14 }),
      "Removed column",
    );
  }
  return h(
    "span",
    { class: "fb-question-column" },
    icon(TYPE_ICONS[column.type] ?? "more", { size: 14 }),
    h("span", { class: "fb-question-column-title" }, column.title),
    h(
      "span",
      { class: "fb-question-column-type" },
      columnTypeLabel(column.type),
    ),
  );
}

function moveReason(q, { index, delta, question }) {
  if (q.readOnly) return REASONS.viewOnly;
  if (isNameQuestion(question)) return "The name question always comes first";
  if (canMove(q.questions, index, delta)) return null;
  return delta < 0 ? "The name question stays first" : "Already last";
}

function tools(q, { index, question }) {
  const title = question.label.trim() || "question";
  const move = (delta, iconName) =>
    iconButton({
      icon: iconName,
      label: `Move “${title}” ${delta < 0 ? "up" : "down"}`,
      size: "sm",
      disabledReason: moveReason(q, { index, delta, question }),
      dataset: { focusKey: `${question.id}-${iconName}` },
      onClick: () =>
        commit(q, moveQuestion(q.questions, index, delta), {
          focus: `${question.id}-${iconName}`,
        }),
    });
  const removeReason = q.readOnly
    ? REASONS.viewOnly
    : isNameQuestion(question)
      ? "Every form asks for the item name"
      : null;
  return h(
    "div",
    { class: "fb-question-tools" },
    move(-1, "chevronUp"),
    move(1, "chevronDown"),
    iconButton({
      icon: "trash",
      label: `Remove “${title}”`,
      size: "sm",
      disabledReason: removeReason,
      onClick: () => {
        const next = q.questions[index + 1] ?? q.questions[index - 1];
        commit(q, removeQuestion(q.questions, index), {
          focus: next ? `${next.id}-label` : "add",
        });
      },
    }),
  );
}

function textInput(q, { question, index, field, label }) {
  const limit =
    field === "label" ? QUESTION_LIMITS.label : QUESTION_LIMITS.help;
  return h(
    "label",
    { class: "fb-field" },
    h("span", { class: "fb-field-label" }, label),
    h("input", {
      class: "input",
      type: "text",
      value: question[field],
      maxlength: limit,
      placeholder: field === "help" ? "Optional hint for respondents" : null,
      disabled: q.readOnly,
      required: field === "label",
      dataset: { focusKey: `${question.id}-${field}` },
      on: {
        input: (event) =>
          commit(
            q,
            updateQuestion(q.questions, index, {
              [field]: event.currentTarget.value,
            }),
          ),
      },
    }),
  );
}

function requiredToggle(q, { question, index }) {
  const name = isNameQuestion(question);
  return h(
    "label",
    {
      class: "fb-check",
      title: name ? "The name question is always required" : null,
    },
    h("input", {
      type: "checkbox",
      checked: question.required,
      disabled: q.readOnly || name,
      on: {
        change: (event) =>
          commit(
            q,
            updateQuestion(q.questions, index, {
              required: event.currentTarget.checked,
            }),
          ),
      },
    }),
    "Required",
  );
}

function questionCard(q, question, index) {
  const column = q.columns.get(question.column_id) ?? null;
  const card = h(
    "li",
    {
      class: ["fb-question", isNameQuestion(question) && "fb-question-name"],
      dataset: { questionId: question.id },
    },
    h(
      "div",
      { class: "fb-question-head" },
      h(
        "span",
        { class: "fb-question-number", "aria-hidden": "true" },
        String(index + 1),
      ),
      h(
        "div",
        { class: "fb-question-meta" },
        columnLine(column),
        isNameQuestion(question)
          ? badge("Creates the item", { tone: "primary", icon: "item" })
          : null,
      ),
      tools(q, { index, question }),
    ),
    h(
      "div",
      { class: "fb-question-fields" },
      textInput(q, { question, index, field: "label", label: "Question" }),
      textInput(q, { question, index, field: "help", label: "Help text" }),
      requiredToggle(q, { question, index }),
    ),
    h("p", { class: "fb-question-error", role: "alert", hidden: true }),
  );
  return card;
}

function addReason(q) {
  if (q.readOnly) return REASONS.viewOnly;
  if (q.questions.length >= QUESTION_LIMITS.questions) {
    return `A form has at most ${QUESTION_LIMITS.questions} questions`;
  }
  if (askableColumns([...q.columns.values()], q.questions).length === 0) {
    return "Every column that can be asked is already on the form";
  }
  return null;
}

function openAddMenu(q, anchor) {
  const columns = askableColumns([...q.columns.values()], q.questions);
  openMenu({
    anchor,
    label: "Add a question for a board column",
    placement: "bottom-start",
    items: [
      { type: "heading", label: "Ask for a board column" },
      ...columns.map((column) => ({
        label: column.title,
        hint: columnTypeLabel(column.type),
        icon: TYPE_ICONS[column.type] ?? "more",
        onSelect() {
          const result = addQuestion(q.questions, column);
          if (result.ok) {
            commit(q, result.questions, {
              focus: `${result.question.id}-label`,
            });
          }
        },
      })),
    ],
  });
}

function render(q, { focus } = {}) {
  const people = [...q.columns.values()].some(
    (column) => column.type === "people",
  );
  const reason = addReason(q);
  const add = button({
    label: "Add question",
    icon: "plus",
    variant: "secondary",
    disabledReason: reason,
    dataset: { focusKey: "add" },
    onClick: (event) => openAddMenu(q, event.currentTarget),
  });
  q.element.replaceChildren(
    h(
      "ol",
      { class: "fb-questions", "aria-label": "Questions" },
      q.questions.map((question, index) => questionCard(q, question, index)),
    ),
    h(
      "div",
      { class: "fb-add-row" },
      add,
      people
        ? h(
            "p",
            { class: "fb-add-hint" },
            icon("info", { size: 14 }),
            "People columns can’t be asked in forms.",
          )
        : null,
    ),
  );
  if (focus) {
    const targets = q.element.querySelectorAll("[data-focus-key]");
    [...targets].find((node) => node.dataset.focusKey === focus)?.focus();
  }
}

function commit(q, next, { focus } = {}) {
  if (next === q.questions) return;
  const structural =
    next.length !== q.questions.length ||
    next.some((question, index) => question.id !== q.questions[index]?.id);
  q.questions = next;
  if (structural || focus) render(q, { focus });
  q.onChange(next);
}

/**
 * @param {{ questions: object[], columns: object[], readOnly?: boolean,
 *   onChange: (questions: object[]) => void }} options
 * @returns {{ element: HTMLElement,
 *   showProblem(problem: { index: number, message: string } | null): void }}
 */
export function createQuestionList(options) {
  const q = {
    questions: options.questions,
    columns: new Map(options.columns.map((column) => [column.id, column])),
    readOnly: Boolean(options.readOnly),
    onChange: options.onChange,
    element: h("div", { class: "fb-question-list" }),
  };
  render(q);
  return {
    element: q.element,
    showProblem(problem) {
      for (const [index, card] of [
        ...q.element.querySelectorAll(".fb-question"),
      ].entries()) {
        const error = card.querySelector(".fb-question-error");
        const message = problem?.index === index ? problem.message : null;
        error.hidden = !message;
        error.textContent = message ?? "";
        card.classList.toggle("has-error", Boolean(message));
      }
    },
  };
}
