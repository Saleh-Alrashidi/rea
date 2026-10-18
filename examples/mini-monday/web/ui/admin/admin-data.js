/**
 * GraphQL documents and pure helpers of the Admin pages (`#/admin`,
 * `#/admin/content`). The server refuses every admin operation to
 * non-admins (`access.can(user, "manage_users" | "admin_directory")`);
 * these helpers only decide which controls to offer and why others are
 * disabled, from the same fields the API returns.
 */

import { ACCOUNT_ROLES } from "../components/labels.js";
import { REASONS, can } from "../components/permissions.js";

export const ADMIN_USERS_QUERY = `query AdminUsers {
  account { id name user_count role_counts_json }
  users(limit: 500) {
    id name email initials color role status title created_at
    teams { id name }
  }
  teams { id }
}`;

export const ADMIN_CONTENT_QUERY = `query AdminContent {
  admin_content_directory {
    kind id title privacy
    owner { id name initials color }
    workspace { id name }
  }
  boards(limit: 500) { id my_access }
  docs { id my_access }
}`;

export const ADMIN_MUTATIONS = Object.freeze({
  invite: `mutation InviteUser($name: String!, $email: String!, $role: AccountRole!, $title: String) {
  invite_user(name: $name, email: $email, role: $role, title: $title) { id name }
}`,
  setRole: `mutation SetUserRole($userId: ID!, $role: AccountRole!) {
  update_user(user_id: $userId, role: $role) { id role }
}`,
  deactivate: `mutation DeactivateUser($userId: ID!) {
  deactivate_user(user_id: $userId) { id status }
}`,
  activate: `mutation ActivateUser($userId: ID!) {
  activate_user(user_id: $userId) { id status }
}`,
  takeOwnership: `mutation TakeOwnership($kind: ResourceKind!, $id: ID!) {
  admin_take_ownership(resource_kind: $kind, resource_id: $id) { kind id role }
}`,
});

/** The `boards(limit:)` page size of the content query. */
export const CONTENT_BOARD_LIMIT = 500;

export const ROLE_ORDER = Object.freeze(["admin", "member", "viewer", "guest"]);

/** `{ admin, member, viewer, guest }` counts from `role_counts_json`. */
export function parseRoleCounts(json) {
  let raw = null;
  try {
    raw = JSON.parse(json);
  } catch {
    raw = null;
  }
  return Object.fromEntries(
    ROLE_ORDER.map((role) => {
      const value = raw?.[role];
      return [role, Number.isSafeInteger(value) && value >= 0 ? value : 0];
    }),
  );
}

const isActiveAdmin = (user) =>
  user.role === "admin" && user.status !== "deactivated";

/**
 * What `me` may do to `user` in the users table, with the reason a control
 * is disabled: `{ roleReason, statusReason }` (null when allowed). Admins
 * never act on themselves, and the last active admin keeps the role.
 *
 * @param {object} me
 * @param {object} user
 * @param {object[]} users every listed user (to find the last admin)
 */
export function userActions(me, user, users) {
  if (!can(me, "manage_users")) {
    return { roleReason: REASONS.admins, statusReason: REASONS.admins };
  }
  if (String(user.id) === String(me.id)) {
    return {
      roleReason: "You can’t change your own role",
      statusReason: "You can’t deactivate yourself",
    };
  }
  const lastAdmin =
    isActiveAdmin(user) && users.filter(isActiveAdmin).length <= 1;
  const reason = lastAdmin ? "Worklane keeps at least one active admin" : null;
  return { roleReason: reason, statusReason: reason };
}

/** Users matching `query` (name, email or title), in the API's order. */
export function filterUsers(users, query) {
  const term = String(query ?? "")
    .trim()
    .toLowerCase();
  if (!term) return users;
  return users.filter((user) =>
    [user.name, user.email, user.title].some((value) =>
      String(value ?? "")
        .toLowerCase()
        .includes(term),
    ),
  );
}

/**
 * Joins the content directory with the boards and docs the admin can open
 * (`myAccess`: their role, or null when they have none). When the boards
 * page was full, boards missing from it read `undefined` (unknown) rather
 * than "no access".
 */
export function contentRows(data) {
  const roles = (records) =>
    new Map(records.map((record) => [String(record.id), record.my_access]));
  const boards = roles(data.boards ?? []);
  const docs = roles(data.docs ?? []);
  const boardsComplete = (data.boards ?? []).length < CONTENT_BOARD_LIMIT;
  return data.admin_content_directory.map((entry) => {
    const id = String(entry.id);
    const known = entry.kind === "board" ? boards : docs;
    const complete = entry.kind === "doc" || boardsComplete;
    let myAccess = known.get(id) ?? null;
    if (!known.has(id) && !complete) myAccess = undefined;
    return { ...entry, id, myAccess };
  });
}

/** Content rows of `kind` ("all" | "board" | "doc") matching `query`. */
export function filterContent(rows, { kind = "all", query = "" } = {}) {
  const term = query.trim().toLowerCase();
  return rows.filter(
    (row) =>
      (kind === "all" || row.kind === kind) &&
      (!term ||
        [row.title, row.owner?.name, row.workspace?.name].some((value) =>
          String(value ?? "")
            .toLowerCase()
            .includes(term),
        )),
  );
}

/** Role options for selects and the invite dialog, with the legend text. */
export function roleChoices() {
  return ROLE_ORDER.map((role) => ({
    value: role,
    label: ACCOUNT_ROLES[role].label,
    description: ACCOUNT_ROLES[role].description,
  }));
}
