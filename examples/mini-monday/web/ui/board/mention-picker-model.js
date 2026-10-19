/**
 * The composer's mention picker (SPEC-6 §2.2), as a pure state machine:
 * which query the caret is in (`mentionQuery`), the rows a query offers
 * (`peopleOptions`, `taskOptions`), how keys move and pick
 * (`pickerKey`) and what a pick writes (`applyPick`). The DOM
 * (`mention-picker.js`) only draws the state and forwards events.
 *
 * - "@" at the start of a word opens the people picker: the board's
 *   assignable users, then teams, then everyone else in the directory
 *   (who cannot open the board, so a mention would reach nobody) marked
 *   "No access"; matched on name or email.
 * - "@@" opens the task picker: tasks on boards the author can open, by
 *   name, at most MAX_TASKS, with their board and status dot.
 * - ↑/↓ move (wrapping), Enter or Tab insert, Escape closes until the
 *   caret leaves that "@" (or a new one starts).
 *
 * State: `{ open, mode: "people" | "tasks" | null, start, query,
 * options, active, dismissed }`; `start` is where the "@" (or "@@")
 * begins and `dismissed` the `start` Escape closed.
 */

/** Longest query a picker follows (longer: the "@" was not a mention). */
export const MAX_QUERY = 50;
/** Rows the people picker shows. */
export const MAX_PEOPLE = 20;
/** Tasks the task picker shows (SPEC-6 §2.2). */
export const MAX_TASKS = 20;

/** What may come right before an "@" that starts a word. */
const WORD_START = /[\s([{"'“‘«]/u;

/** A closed picker. */
export const closedPicker = () => ({
  open: false,
  mode: null,
  start: -1,
  query: "",
  options: [],
  active: 0,
  dismissed: -1,
});

/**
 * The mention the caret at `caret` is typing in `text`: `{ mode, start,
 * query }` ("people" for "@query", "tasks" for "@@query"), or null. The
 * "@" must start a word, the query must not start with a space, span a
 * line break or another "@", or run longer than MAX_QUERY.
 */
export function mentionQuery(text, caret) {
  const at = text.lastIndexOf("@", caret - 1);
  if (at === -1) return null;
  const query = text.slice(at + 1, caret);
  if (query.length > MAX_QUERY || /^\s|[\r\n]/.test(query)) return null;
  const tasks = at > 0 && text[at - 1] === "@";
  const start = tasks ? at - 1 : at;
  if (start > 0 && !WORD_START.test(text[start - 1])) return null;
  return { mode: tasks ? "tasks" : "people", start, query };
}

const matches = (term, ...fields) =>
  term === "" ||
  fields.some((field) =>
    String(field ?? "")
      .toLowerCase()
      .includes(term),
  );

/**
 * The people picker's rows for `query`: `assignable` users (who can open
 * the board, with their directory record from `users`), then `teams`,
 * then the other active `users` with `noAccess`, each matched on name or
 * email, at most `limit`. Rows are
 * `{ key, kind, id, name, detail, noAccess, record }`.
 * @param {{ assignable: object[], users: object[], teams: object[],
 *   query: string, limit?: number }} options
 */
export function peopleOptions({
  assignable,
  users,
  teams,
  query,
  limit = MAX_PEOPLE,
}) {
  const term = query.trim().toLowerCase();
  const allowed = new Set(assignable.map((user) => String(user.id)));
  // The directory's record carries the email the board's list leaves out.
  const directory = new Map(users.map((user) => [String(user.id), user]));
  const person = (user, noAccess) => ({
    key: `user:${user.id}`,
    kind: "user",
    id: String(user.id),
    name: user.name,
    detail: user.email ?? user.title ?? "",
    noAccess,
    record: user,
  });
  const rows = [
    ...assignable
      .map((user) => ({ ...user, ...directory.get(String(user.id)) }))
      .filter((user) => matches(term, user.name, user.email))
      .map((user) => person(user, false)),
    ...teams
      .filter((team) => matches(term, team.name))
      .map((team) => ({
        key: `team:${team.id}`,
        kind: "team",
        id: String(team.id),
        name: team.name,
        detail: "Team",
        noAccess: false,
        record: team,
      })),
    ...users
      .filter(
        (user) =>
          user.status !== "deactivated" &&
          !allowed.has(String(user.id)) &&
          matches(term, user.name, user.email),
      )
      .map((user) => person(user, true)),
  ];
  return rows.slice(0, limit);
}

/**
 * The task picker's rows: `tasks` (`{ id, name, boardId, boardName,
 * color, statusLabel }`) as `{ key, kind: "item", id, name, detail,
 * boardId, color, statusLabel }`, at most MAX_TASKS.
 */
export function taskOptions(tasks) {
  return tasks.slice(0, MAX_TASKS).map((task) => ({
    key: `item:${task.id}`,
    kind: "item",
    id: String(task.id),
    name: task.name,
    detail: task.boardName ?? "",
    boardId: task.boardId ?? null,
    color: task.color ?? null,
    statusLabel: task.statusLabel ?? "",
    noAccess: false,
  }));
}

/**
 * The picker after the text or caret changed: open on the mention the
 * caret types (closed while Escape dismissed that "@"), keeping its rows
 * and active row while the query is the same.
 */
export function pickerForText(state, { text, caret }) {
  const found = mentionQuery(text, caret);
  if (!found) return closedPicker();
  if (found.start === state.dismissed) {
    return { ...closedPicker(), dismissed: state.dismissed };
  }
  const same =
    state.open &&
    state.mode === found.mode &&
    state.start === found.start &&
    state.query === found.query;
  if (same) return state;
  const keep = state.open && state.mode === found.mode;
  return {
    ...closedPicker(),
    open: true,
    ...found,
    options: keep ? state.options : [],
  };
}

/** The picker with `options` for its query; the active row stays in range. */
export function withOptions(state, options) {
  if (!state.open) return state;
  const active = Math.min(state.active, Math.max(0, options.length - 1));
  return { ...state, options, active };
}

/**
 * Handles `key` in the composer: `{ state, pick, handled }`. `pick` is
 * the row to insert (Enter or Tab on a row); `handled` says the key was
 * the picker's (the composer must not act on it).
 */
export function pickerKey(state, key) {
  if (!state.open) return { state, pick: null, handled: false };
  const count = state.options.length;
  if (key === "Escape") {
    return {
      state: { ...closedPicker(), dismissed: state.start },
      pick: null,
      handled: true,
    };
  }
  if (count === 0) return { state, pick: null, handled: false };
  if (key === "ArrowDown" || key === "ArrowUp") {
    const step = key === "ArrowDown" ? 1 : -1;
    const active = (state.active + step + count) % count;
    return { state: { ...state, active }, pick: null, handled: true };
  }
  if (key === "Enter" || key === "Tab") {
    return { state, pick: state.options[state.active], handled: true };
  }
  return { state, pick: null, handled: false };
}

/**
 * Writes `option` over the mention the picker follows in `text`: the
 * "@query" (or "@@query") becomes "@<name> ". Returns `{ text, caret,
 * mention }`; `mention` is the side-table entry (`mention-tokens.js`),
 * or null when `name` cannot be a token (it is then inserted as text).
 * @param {string} text
 * @param {{ state: object, option: object, name: string | null }} pick
 *   `name`: the option's name as `mentionName` shows it
 */
export function applyPick(text, { state, option, name }) {
  const typed = state.mode === "tasks" ? 2 : 1;
  const end = state.start + typed + state.query.length;
  const shown = name ?? option.name;
  const insert = `@${shown} `;
  const next = text.slice(0, state.start) + insert + text.slice(end);
  const mention =
    name === null
      ? null
      : {
          start: state.start,
          end: state.start + 1 + shown.length,
          kind: option.kind,
          id: option.id,
          name: shown,
          ...(option.kind === "item" ? { boardId: option.boardId } : {}),
        };
  return { text: next, caret: state.start + insert.length, mention };
}
