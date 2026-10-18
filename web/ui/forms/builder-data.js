/**
 * GraphQL documents and loaders of the form builder (`#/forms/<id>`). This
 * module owns the shape of every builder request and turns the API's form
 * into the builder's copy once (`normalizeForm`): IDs as strings, colors
 * checked, `questions_json` parsed by `questions.js`.
 *
 * The API has no single-form query, so loading takes two requests: the
 * accessible forms' board IDs, then that board with its columns, groups and
 * forms. A form the user cannot reach is simply absent from both, exactly
 * like a deleted one, so the page shows the same "not available" view.
 */

import { prepareColumns, safeColor } from "../board/values.js";
import { DEFAULT_ACCENT } from "./answers.js";
import { parseQuestions, serializeQuestions } from "./questions.js";

const FORM_FIELDS = `fragment BuilderForm on Form {
  id title description accent_color questions_json target_group_id access
  public_url submit_message response_count updated_at
}`;

export const FORM_LOCATE_QUERY = `query FormLocate { forms { id board { id } } }`;

export const FORM_BUILDER_QUERY = `query FormBuilder($ids: [ID!]) {
  boards(ids: $ids, limit: 1) {
    id name my_access
    workspace { id name }
    columns { id title type settings_str }
    groups { id title color position }
    forms { ...BuilderForm }
  }
}
${FORM_FIELDS}`;

export const FORM_COUNT_QUERY = `query FormCount($boardId: ID) {
  forms(board_id: $boardId) { id response_count }
}`;

export const FORM_MUTATIONS = Object.freeze({
  update: `mutation UpdateForm($formId: ID!, $title: String, $description: String, $accent: String, $questions: String, $target: String, $access: FormAccess, $message: String) {
  update_form(form_id: $formId, title: $title, description: $description, accent_color: $accent, questions_json: $questions, target_group_id: $target, access: $access, submit_message: $message) { id response_count updated_at }
}`,
  regenerate: `mutation RegenerateFormLink($formId: ID!) {
  regenerate_form_link(form_id: $formId) { id public_url }
}`,
  remove: `mutation DeleteForm($formId: ID!) {
  delete_form(form_id: $formId) { id }
}`,
});

const ACCESS = new Set(["public", "account", "closed"]);

/**
 * The builder's copy of an API form, or a failure when its questions can't
 * be read (the page then refuses to edit rather than overwrite them).
 * @returns {{ ok: true, value: object } | { ok: false, reason: string }}
 */
export function normalizeForm(raw) {
  const questions = parseQuestions(raw.questions_json);
  if (!questions.ok) return questions;
  return {
    ok: true,
    value: {
      id: String(raw.id),
      title: String(raw.title ?? ""),
      description: raw.description ?? "",
      accent_color: safeColor(raw.accent_color, DEFAULT_ACCENT),
      questions: questions.value,
      target_group_id: raw.target_group_id ?? null,
      // Unknown values read as the most restrictive access.
      access: ACCESS.has(raw.access) ? raw.access : "closed",
      public_url: typeof raw.public_url === "string" ? raw.public_url : "",
      submit_message: raw.submit_message ?? "",
      response_count: Number.isSafeInteger(raw.response_count)
        ? raw.response_count
        : 0,
      updated_at: raw.updated_at ?? null,
    },
  };
}

/**
 * Loads the form and its board.
 * @param {{ request(query: string, variables?: object): Promise<object> }} api
 * @param {string} formId
 * @returns {Promise<null | { form: object, board: object }>} null when the
 *   form is missing or not accessible
 */
export async function loadFormBuilder(api, formId) {
  const located = await api.request(FORM_LOCATE_QUERY);
  const entry = located.forms.find((form) => String(form.id) === formId);
  if (!entry?.board) return null;
  const data = await api.request(FORM_BUILDER_QUERY, {
    ids: [String(entry.board.id)],
  });
  const board = data.boards[0];
  const raw = board?.forms.find((form) => String(form.id) === formId);
  if (!raw) return null;
  const form = normalizeForm(raw);
  if (!form.ok) throw new Error(form.reason);
  return {
    form: form.value,
    board: {
      id: String(board.id),
      name: board.name,
      myAccess: board.my_access,
      workspace: board.workspace
        ? { id: String(board.workspace.id), name: board.workspace.name }
        : null,
      columns: prepareColumns(board.columns),
      groups: [...board.groups].sort((a, b) => a.position - b.position),
    },
  };
}

/** The current response count of `formId` on `boardId`, or null. */
export async function loadResponseCount(api, { boardId, formId }) {
  const data = await api.request(FORM_COUNT_QUERY, { boardId });
  const form = data.forms.find((entry) => String(entry.id) === formId);
  return form ? form.response_count : null;
}

/**
 * `update_form` variables for a patch of builder fields (only the given
 * fields are sent; absent variables leave the setting unchanged). An
 * empty `target_group_id` means "the board's first group".
 */
export function updateVariables(formId, patch) {
  const variables = { formId };
  const map = {
    title: ["title", (value) => value.trim()],
    description: ["description", (value) => value],
    accent_color: ["accent", (value) => value],
    questions: ["questions", serializeQuestions],
    target_group_id: ["target", (value) => value ?? ""],
    access: ["access", (value) => value],
    submit_message: ["message", (value) => value.trim()],
  };
  for (const [field, [name, convert]] of Object.entries(map)) {
    if (Object.hasOwn(patch, field)) variables[name] = convert(patch[field]);
  }
  return variables;
}
