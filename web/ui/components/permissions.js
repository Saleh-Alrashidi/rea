/**
 * Capability hints for the UI. The server (`server/access.js`) decides every
 * access question and rejects anything not allowed; the browser only reads
 * the fields the API returns — a resource's `my_access` / `can_manage` and
 * the account `role` — to hide or disable controls the user cannot use.
 *
 * Every page reads those fields through this module, so the client's view of
 * roles lives in one place. The account-level table mirrors SPEC-2 §1.1
 * (`access.can`) because the API exposes `role`, not a capability list.
 */

const RANK = Object.freeze({ viewer: 1, editor: 2, owner: 3 });

const ACCOUNT_CAPABILITIES = Object.freeze({
  admin: new Set([
    "manage_users",
    "admin_directory",
    "create_workspace",
    "create_team",
    "create_content",
    "create_note",
  ]),
  member: new Set([
    "create_workspace",
    "create_team",
    "create_content",
    "create_note",
  ]),
  viewer: new Set(["create_note"]),
  guest: new Set(["create_note"]),
});

/** Why a control is disabled, shown as its tooltip. */
export const REASONS = Object.freeze({
  viewOnly: "You have view-only access",
  notOwner: "Only owners can do this",
  noCreate: "Your account role can’t create this",
  noWorkspaceEdit: "You can’t add content to this workspace",
  admins: "Only admins can do this",
});

/** True when `myAccess` (an AccessRole or null) is at least `required`. */
export function hasRole(myAccess, required) {
  return (RANK[myAccess] ?? 0) >= (RANK[required] ?? Infinity);
}

/** True for read-only access (shows the "View only" badge). */
export function isViewOnly(myAccess) {
  return myAccess === "viewer";
}

/**
 * True when the account role of `me` grants `capability`
 * ("manage_users" | "admin_directory" | "create_workspace" | "create_team" |
 * "create_content" | "create_note"). Only active users have any, as the
 * server's `access.can` decides.
 */
export function can(me, capability) {
  if (me?.status !== "active") return false;
  return ACCOUNT_CAPABILITIES[me.role]?.has(capability) ?? false;
}

/**
 * Whether `me` may create boards, docs or forms in `workspace` (an API
 * Workspace with `my_access`): `{ ok: true }` or `{ ok: false, reason }`.
 */
export function canCreateIn(me, workspace) {
  if (!can(me, "create_content"))
    return { ok: false, reason: REASONS.noCreate };
  if (!hasRole(workspace?.my_access, "editor")) {
    return { ok: false, reason: REASONS.noWorkspaceEdit };
  }
  return { ok: true };
}
