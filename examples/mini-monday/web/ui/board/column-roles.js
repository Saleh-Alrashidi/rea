/**
 * The columns a board's views treat specially, found by `Column.role`
 * (SPEC-5 §1.2), never by title. Boards without roles (monday-style
 * boards, older imports) fall back to the first column of the type for
 * status, assignees and due date; the other roles have no fallback.
 */

/** Role → the column type it needs (as the server's COLUMN_ROLES). */
export const ROLE_TYPES = Object.freeze({
  status: "status",
  assignees: "people",
  due_date: "date",
  start_date: "date",
  priority: "status",
  time_estimate: "numbers",
  tags: "text",
  description: "text",
});
const FALLBACK_ROLES = new Set(["status", "assignees", "due_date"]);

/**
 * The column of each role (or null): `{ status, assignees, due_date,
 * start_date, priority, time_estimate, tags, description }`.
 * @param {object[]} columns prepared board columns
 */
export function roleColumns(columns) {
  const found = {};
  for (const [role, type] of Object.entries(ROLE_TYPES)) {
    found[role] =
      columns.find((column) => column.role === role && column.type === type) ??
      null;
  }
  const claimed = new Set(Object.values(found).filter(Boolean));
  for (const role of FALLBACK_ROLES) {
    found[role] ??=
      columns.find(
        (column) => column.type === ROLE_TYPES[role] && !claimed.has(column),
      ) ?? null;
  }
  return found;
}
