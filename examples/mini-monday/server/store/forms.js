/**
 * Forms (SPEC-2 §2): a form belongs to a board; its questions map to board
 * columns and each submission creates an item. Questions are validated
 * here: at most 50, labels 1-200, help ≤ 500, existing non-people columns
 * of the form's board, one question per column, and the first question is
 * always the required `name` question. Question IDs (`q<n>`) are generated
 * when missing. Tokens are 16 random bytes, base64url.
 *
 * `submitForm` creates the item (activity actor null, label
 * "Form: <title>"), counts the response and notifies the board's owners.
 * Answer parsing and access checks belong to the HTTP route.
 */
import { explicitOwners } from "../access.js";
import {
  FORM_ACCESS,
  LIMITS,
  byId,
  commit,
  failure,
  invalid,
  isObject,
  nextId,
  onBoard,
  optional,
  push,
  randomToken,
  readBoolean,
  readChoice,
  readColor,
  readName,
  readText,
  removeWhere,
  replace,
  withChanges,
} from "../store-state.js";
import { notify, quoted, resourceUrl } from "./activity.js";
import { findSecret } from "./people.js";
import { addItem } from "./items.js";
import { sortedGroups } from "./boards.js";

export const FORM_COLOR = "#5b5bd6";
export const SUBMIT_MESSAGE = "Thanks! Your response was recorded.";
const QUESTION_ID = /^[\w-]{1,64}$/;
const QUESTION_KEYS = new Set(["id", "column_id", "label", "help", "required"]);
const newToken = () => randomToken(16);

function readQuestion(state, { board, raw, index }) {
  const where = `Question ${index + 1}`;
  if (
    !isObject(raw) ||
    !Object.keys(raw).every((key) => QUESTION_KEYS.has(key))
  ) {
    invalid(`${where} must be { id?, column_id, label, help?, required? }`);
  }
  const column =
    typeof raw.column_id === "string"
      ? onBoard(state.columns, board.id, raw.column_id)
      : null;
  if (!column || column.type === "people") {
    invalid(`${where} must use an existing non-people column of the board`);
  }
  if (typeof raw.label !== "string") invalid(`${where} needs a label`);
  const label = raw.label.trim();
  if (label === "" || label.length > LIMITS.label) {
    invalid(`${where} label must be 1-${LIMITS.label} characters`);
  }
  const help = readText(raw.help ?? "", `${where} help`, LIMITS.help);
  if (
    raw.id !== undefined &&
    (typeof raw.id !== "string" || !QUESTION_ID.test(raw.id))
  ) {
    invalid(`${where} id must be 1-64 letters, digits, _ or -`);
  }
  const required =
    column.type === "name" ||
    readBoolean(raw.required ?? false, `${where} required`);
  return { id: raw.id, column_id: column.id, label, help, required };
}

/** Validates questions for `board` and fills in missing IDs. */
export function readQuestions(state, board, questions) {
  if (!Array.isArray(questions)) invalid("questions must be an array");
  if (questions.length === 0 || questions.length > LIMITS.questions) {
    invalid(`A form has 1-${LIMITS.questions} questions`);
  }
  const parsed = questions.map((raw, index) =>
    readQuestion(state, { board, raw, index }),
  );
  if (parsed[0].column_id !== "name")
    invalid("The first question must be the name question");
  const columns = new Set(parsed.map((q) => q.column_id));
  if (columns.size !== parsed.length)
    invalid("Each column can be asked only once");
  const taken = new Set(
    parsed.map((q) => q.id).filter((id) => id !== undefined),
  );
  if (taken.size !== parsed.filter((q) => q.id !== undefined).length) {
    invalid("Question IDs must be unique");
  }
  let counter = 1;
  return parsed.map((question) => {
    if (question.id !== undefined) return question;
    while (taken.has(`q${counter}`)) counter += 1;
    const id = `q${counter}`;
    taken.add(id);
    return { ...question, id };
  });
}

export function insertForm(ctx, fields) {
  const { state } = ctx;
  const at = ctx.now();
  return push(state.forms, {
    id: nextId(state),
    board_id: fields.boardId,
    title: fields.title,
    description: fields.description ?? null,
    accent_color: fields.accentColor ?? FORM_COLOR,
    questions: fields.questions,
    target_group_id: fields.targetGroupId ?? null,
    access: fields.access ?? "public",
    token: newToken(),
    submit_message: fields.submitMessage ?? SUBMIT_MESSAGE,
    response_count: fields.responseCount ?? 0,
    created_by: fields.createdBy ?? null,
    created_at: at,
    updated_at: at,
  });
}

const formEvent = (type, form) => ({
  type,
  board_id: form.board_id,
  resource_kind: "form",
  resource_id: form.id,
});

function readChanges(state, form, changes) {
  const board = byId(state.boards, form.board_id);
  const target = changes.targetGroupId;
  if (
    target !== undefined &&
    target !== null &&
    !onBoard(state.groups, board.id, target)
  ) {
    invalid("target_group_id must be a group of the form's board");
  }
  return {
    title: optional(changes.title, (v) => readName(v, "Form title")),
    description: optional(changes.description, (v) =>
      readText(v, "Description"),
    ),
    accent_color: optional(changes.accentColor, (v) =>
      readColor(v, "accent_color"),
    ),
    questions: optional(changes.questions, (v) =>
      readQuestions(state, board, v),
    ),
    target_group_id: target,
    access: optional(changes.access, (v) =>
      readChoice(v, FORM_ACCESS, "access"),
    ),
    submit_message: optional(changes.submitMessage, (v) =>
      readText(v, "Submit message"),
    ),
  };
}

function submissions(ctx) {
  const { state } = ctx;
  return {
    /**
     * Records a submission: creates the item `name` with stored `values` in
     * the target group (or the first group), counts the response, logs
     * activity and notifies board owners. Closed forms → `form_closed`.
     */
    submitForm(id, { name, values = {} } = {}) {
      const form = byId(state.forms, id);
      const board = form && byId(state.boards, form.board_id);
      if (!board) return null;
      if (form.access === "closed") return failure("form_closed");
      const groups = sortedGroups(state, board.id);
      const group = byId(groups, form.target_group_id) ?? groups[0];
      if (!group)
        return failure("no_group", { message: "The board has no group" });
      const itemName = readName(name, "Name");
      const activity = {
        kind: "form_submitted",
        actorId: null,
        actorLabel: `Form: ${form.title}`,
      };
      const fields = {
        boardId: board.id,
        groupId: group.id,
        name: itemName,
        values,
        creatorId: null,
      };
      const item = addItem(ctx, fields, activity);
      const counted = { ...form, response_count: form.response_count + 1 };
      replace(state.forms, form, counted);
      notify(ctx, {
        userIds: explicitOwners(ctx.reader, "board", board),
        kind: "form_response",
        text: `New response to ${quoted(form.title)}: ${quoted(itemName)}`,
        url: resourceUrl("board", board.id, item.id),
        resource: { kind: "board", id: board.id, record: board },
      });
      const event = {
        ...formEvent("form_submitted", form),
        item_id: item.id,
        group_id: group.id,
      };
      return commit(ctx, event, item);
    },
  };
}

export function formApi(ctx) {
  const { state } = ctx;
  const save = (form, next) => {
    replace(state.forms, form, { ...next, updated_at: ctx.now() });
    return commit(
      ctx,
      formEvent("form_updated", next),
      byId(state.forms, form.id),
    );
  };
  return {
    /** All forms, or the forms of one board. */
    listForms: ({ boardId } = {}) =>
      boardId === undefined
        ? [...state.forms]
        : state.forms.filter((f) => f.board_id === boardId),
    getForm: (id) => byId(state.forms, id),
    /** The form with this public token (timing-safe comparison). */
    findFormByToken: (token) => findSecret(state.forms, "token", token),
    /** A form that starts with the required name question. */
    createForm({ boardId, title, creatorId = null } = {}) {
      const formTitle = readName(title, "Form title");
      const board = byId(state.boards, boardId);
      const name = board && onBoard(state.columns, boardId, "name");
      if (!name || (creatorId !== null && !byId(state.users, creatorId)))
        return null;
      const question = {
        id: "q1",
        column_id: "name",
        label: name.title,
        help: "",
        required: true,
      };
      const fields = {
        boardId,
        title: formTitle,
        questions: [question],
        createdBy: creatorId,
      };
      const form = insertForm(ctx, fields);
      return commit(ctx, formEvent("form_created", form), form);
    },
    /** Changes settings and questions (camelCase keys, see readChanges). */
    updateForm(id, changes = {}) {
      const form = byId(state.forms, id);
      if (!form) return null;
      return save(form, withChanges(form, readChanges(state, form, changes)));
    },
    /** A new public token; the old link stops working. */
    regenerateFormToken(id) {
      const form = byId(state.forms, id);
      return form ? save(form, { ...form, token: newToken() }) : null;
    },
    deleteForm(id) {
      const form = byId(state.forms, id);
      if (!form) return null;
      removeWhere(state.forms, (record) => record === form);
      return commit(ctx, formEvent("form_deleted", form), form);
    },
    ...submissions(ctx),
  };
}
