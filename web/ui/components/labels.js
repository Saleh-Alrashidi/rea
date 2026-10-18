/**
 * Display names, icons and explanations for the API's enums (SPEC-2 §3).
 * This module is the client's only mapping from enum values to words, so
 * the sidebar, share dialog, badges and pages always describe a board kind
 * or a role the same way. Unknown values get neutral fallbacks.
 */

/**
 * The name shown for a person the viewer may not see or whose record is
 * not loaded: the same word the server uses when it redacts a name.
 */
export const SOMEONE = "Someone";

/** Board kinds: "public" is shown as "Main", "share" as "Shareable". */
export const BOARD_KINDS = Object.freeze({
  public: {
    label: "Main",
    icon: "grid",
    description: "Everyone with access to the workspace can see it.",
  },
  private: {
    label: "Private",
    icon: "lock",
    description: "Only invited members can see it. Guests can’t join.",
  },
  share: {
    label: "Shareable",
    icon: "users",
    description: "Only invited members can see it, including guests.",
  },
});

export const DOC_VISIBILITIES = Object.freeze({
  workspace: {
    label: "Workspace",
    icon: "globe",
    description: "Everyone with access to the workspace can read it.",
  },
  private: {
    label: "Private",
    icon: "lock",
    description: "Only invited members can open it.",
  },
});

export const WORKSPACE_KINDS = Object.freeze({
  open: {
    label: "Open",
    icon: "globe",
    description: "Every member of the account can join and see Main boards.",
  },
  closed: {
    label: "Closed",
    icon: "lock",
    description: "Only invited members can see the workspace.",
  },
});

/** Account roles, with the role legend used by the admin pages. */
export const ACCOUNT_ROLES = Object.freeze({
  admin: {
    label: "Admin",
    tone: "primary",
    description:
      "Manages users and roles, sees the content directory and creates anything.",
  },
  member: {
    label: "Member",
    tone: "neutral",
    description:
      "Creates workspaces, boards, docs and forms where they can edit.",
  },
  viewer: {
    label: "Viewer",
    tone: "info",
    description:
      "Views what is shared with them; can only write personal notes.",
  },
  guest: {
    label: "Guest",
    tone: "warning",
    description:
      "Joins only Shareable boards, docs and notes they are invited to.",
  },
});

/** Access roles on a resource (`viewer < editor < owner`). */
export const ACCESS_ROLES = Object.freeze({
  owner: {
    label: "Owner",
    description: "Can edit, share, change settings and delete.",
  },
  editor: { label: "Editor", description: "Can view and edit content." },
  viewer: { label: "Viewer", description: "Can view only." },
});

export const RESOURCE_KINDS = Object.freeze({
  workspace: { label: "Workspace", icon: "workspace" },
  board: { label: "Board", icon: "grid" },
  doc: { label: "Doc", icon: "docs" },
  note: { label: "Note", icon: "notes" },
  item: { label: "Item", icon: "item" },
  form: { label: "Form", icon: "forms" },
  user: { label: "Person", icon: "person" },
  team: { label: "Team", icon: "team" },
});

/** `FormAccess`: who may respond to a form (SPEC-2 §1). */
export const FORM_ACCESS = Object.freeze({
  public: {
    label: "Public",
    icon: "globe",
    tone: "success",
    description: "Anyone with the link can respond",
  },
  account: {
    label: "Signed-in members",
    icon: "users",
    tone: "info",
    description: "Only signed-in members of the account can respond",
  },
  closed: {
    label: "Closed",
    icon: "lock",
    tone: "neutral",
    description: "Not accepting responses",
  },
});

export const NOTIFICATION_KINDS = Object.freeze({
  share: { label: "Shared with you", icon: "shared", changesAccess: true },
  assign: { label: "Assigned to you", icon: "myWork" },
  update: { label: "New update", icon: "chat" },
  form_response: { label: "Form response", icon: "forms" },
  role: { label: "Role changed", icon: "admin", changesAccess: true },
});

/**
 * Whether a notification of `kind` means the user's account role or access
 * changed (a role change, a new share or takeover), so what they may see
 * and do must be loaded again.
 */
export const changesAccess = (kind) =>
  lookup(NOTIFICATION_KINDS, kind).changesAccess === true;

const FALLBACK = Object.freeze({
  label: "Unknown",
  icon: "more",
  description: "",
});

function lookup(table, value) {
  return Object.hasOwn(table, value) ? table[value] : FALLBACK;
}

export const boardKind = (kind) => lookup(BOARD_KINDS, kind);
export const docVisibility = (value) => lookup(DOC_VISIBILITIES, value);
export const workspaceKind = (kind) => lookup(WORKSPACE_KINDS, kind);
export const accountRole = (role) => lookup(ACCOUNT_ROLES, role);
export const accessRole = (role) => lookup(ACCESS_ROLES, role);
export const resourceKind = (kind) => lookup(RESOURCE_KINDS, kind);
export const notificationKind = (kind) => lookup(NOTIFICATION_KINDS, kind);
/** Unknown form access values read as "Closed", the most restrictive. */
export const formAccess = (access) =>
  Object.hasOwn(FORM_ACCESS, access) ? FORM_ACCESS[access] : FORM_ACCESS.closed;
