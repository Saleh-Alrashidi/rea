/**
 * Capability hints for the UI. The server (`server/access.js`) decides every
 * access question and rejects anything not allowed; the browser only reads
 * the verdicts the API returns — `me.capabilities` (the caller's account
 * capabilities, from `access.can`), a resource's `my_access` /
 * `can_manage` and the Member verdicts — to hide or disable controls the
 * user cannot use. No role table is copied here.
 */

const RANK = Object.freeze({ viewer: 1, editor: 2, owner: 3 });

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
 * True when the server listed `capability` in `me.capabilities`
 * ("manage_users" | "admin_directory" | "create_workspace" | "create_team" |
 * "create_content" | "create_note"). A user record without the list (any
 * user but the caller) has none.
 */
export function can(me, capability) {
  return (
    Array.isArray(me?.capabilities) && me.capabilities.includes(capability)
  );
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
