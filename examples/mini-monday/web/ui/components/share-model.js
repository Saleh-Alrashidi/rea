import { boardHash, docHash, noteHash, workspaceHash } from "../../router.js";
import {
  BOARD_KINDS,
  DOC_VISIBILITIES,
  WORKSPACE_KINDS,
  boardKind,
} from "./labels.js";

/**
 * Data and rules of the share dialog (no DOM): the GraphQL documents for
 * each resource kind, the normalized resource record, the roles a resource
 * accepts, the last-owner guard and guest eligibility hints. The server
 * (`access.canGrant`) enforces all of it; these rules only keep the UI
 * from offering choices the server will refuse.
 */

/** The visibility control per resource kind (notes have none). */
export const SHARE_SETTINGS = Object.freeze({
  board: {
    table: BOARD_KINDS,
    mutation: "boardKind",
    variable: "kind",
    label: "Board type",
  },
  doc: {
    table: DOC_VISIBILITIES,
    mutation: "docVisibility",
    variable: "visibility",
    label: "Who can read it",
  },
  workspace: {
    table: WORKSPACE_KINDS,
    mutation: "workspaceKind",
    variable: "kind",
    label: "Who can join",
  },
});

const MEMBER_FIELDS = `kind id name role
    user { id name email initials color role status }
    team { id name member_count }`;

export const SHARE_QUERIES = Object.freeze({
  board: `query ShareBoard($id: ID!) {
  boards(ids: [$id], limit: 1) {
    id name url board_kind my_access
    members { ${MEMBER_FIELDS} }
  }
}`,
  doc: `query ShareDoc($id: ID!) {
  docs(ids: [$id]) {
    id title url visibility my_access
    members { ${MEMBER_FIELDS} }
  }
}`,
  workspace: `query ShareWorkspace {
  workspaces {
    id name kind my_access can_manage
    members { ${MEMBER_FIELDS} }
  }
}`,
  note: `query ShareNote {
  notes(scope: all) {
    id title my_access
    owner { id name email initials color role }
    shares { ${MEMBER_FIELDS} }
  }
}`,
});

export const SHARE_MUTATIONS = Object.freeze({
  share: `mutation ShareResource($kind: ResourceKind!, $id: ID!, $subjectKind: SubjectKind!, $subjectIds: [ID!]!, $role: AccessRole!) {
  share(resource_kind: $kind, resource_id: $id, subject_kind: $subjectKind, subject_ids: $subjectIds, role: $role) { ${MEMBER_FIELDS} }
}`,
  unshare: `mutation UnshareResource($kind: ResourceKind!, $id: ID!, $subjectKind: SubjectKind!, $subjectId: ID!) {
  unshare(resource_kind: $kind, resource_id: $id, subject_kind: $subjectKind, subject_id: $subjectId) { ${MEMBER_FIELDS} }
}`,
  boardKind: `mutation ShareSetBoardKind($id: ID!, $kind: BoardKind!) {
  set_board_kind(board_id: $id, board_kind: $kind) { id }
}`,
  docVisibility: `mutation ShareSetDocVisibility($id: ID!, $visibility: DocVisibility!) {
  set_doc_visibility(doc_id: $id, visibility: $visibility) { id }
}`,
  workspaceKind: `mutation ShareSetWorkspaceKind($id: ID!, $kind: WorkspaceKind!) {
  update_workspace(workspace_id: $id, kind: $kind) { id }
}`,
});

/** Roles a resource kind accepts (SPEC-2 §1.2 `canGrant`), highest first. */
export function roleOptions(resourceKind) {
  if (resourceKind === "note") return ["editor", "viewer"];
  if (resourceKind === "workspace") return ["owner", "editor"];
  return ["owner", "editor", "viewer"];
}

/** The default role for new members of a resource kind. */
export function defaultRole(resourceKind) {
  return resourceKind === "note" ? "viewer" : "editor";
}

/** Normalizes one Member record. */
export function normalizeMember(member) {
  return {
    kind: member.kind === "team" ? "team" : "user",
    id: String(member.id),
    name: member.name,
    role: member.role,
    email: member.user?.email ?? null,
    accountRole: member.user?.role ?? null,
    color: member.user?.color ?? null,
    initials: member.user?.initials ?? null,
    memberCount: member.team?.member_count ?? null,
  };
}

/** The in-app hash of a resource, from the router's hash builders. */
const RESOURCE_HASHES = Object.freeze({
  board: boardHash,
  doc: docHash,
  note: noteHash,
  workspace: workspaceHash,
});
const resourceHash = (kind, id) => RESOURCE_HASHES[kind](id);

/**
 * Normalizes the query result for `kind`/`id` into
 * `{ kind, id, title, hash, setting, canManage, members, owner }`, or null
 * when the resource is not in the (access-filtered) result.
 */
export function normalizeResource(kind, data, id) {
  const pick = (list) =>
    (list ?? []).find((entry) => String(entry.id) === String(id));
  const base = {
    kind,
    id: String(id),
    hash: resourceHash(kind, id),
    owner: null,
  };
  if (kind === "board") {
    const board = pick(data.boards);
    if (!board) return null;
    return {
      ...base,
      title: board.name,
      setting: board.board_kind,
      canManage: board.my_access === "owner",
      members: board.members.map(normalizeMember),
    };
  }
  if (kind === "doc") {
    const doc = pick(data.docs);
    if (!doc) return null;
    return {
      ...base,
      title: doc.title,
      setting: doc.visibility,
      canManage: doc.my_access === "owner",
      members: doc.members.map(normalizeMember),
    };
  }
  if (kind === "workspace") {
    const workspace = pick(data.workspaces);
    if (!workspace) return null;
    return {
      ...base,
      title: workspace.name,
      setting: workspace.kind,
      canManage: Boolean(workspace.can_manage),
      members: workspace.members.map(normalizeMember),
    };
  }
  const note = pick(data.notes);
  if (!note) return null;
  return {
    ...base,
    title: note.title,
    setting: null,
    canManage: note.my_access === "owner",
    owner: note.owner
      ? { ...note.owner, id: String(note.owner.id), kind: "user" }
      : null,
    members: note.shares.map(normalizeMember),
  };
}

/**
 * Why `member` cannot be removed or demoted, or null. A resource always
 * keeps at least one owner (notes keep theirs outside shares). Only people
 * count: the server never counts team owner grants (`access.keepsAnOwner`),
 * so removing a team is never blocked here and a user owner stays the last
 * one even beside owner teams. The server also discounts owners whose
 * account cannot use the role (deactivated, viewer accounts, guests off
 * Shareable boards); this guard cannot see that and leaves it to the
 * server's refusal.
 */
export function lastOwnerReason(resource, member) {
  if (resource.kind === "note" || member.role !== "owner") return null;
  if (member.kind !== "user") return null;
  const owners = resource.members.filter(
    (entry) => entry.kind === "user" && entry.role === "owner",
  );
  if (owners.length > 1) return null;
  return `This ${resource.kind} needs at least one owner. Make someone else an owner first.`;
}

/**
 * The confirmation shown before a board changes kind, the same from the
 * board header and the share dialog: what the new kind means, which guests
 * lose access (only Shareable boards keep guest grants) and, for a Main
 * board, that the workspace stops seeing it. `board` is
 * `{ name, kind, members }` (normalized members); returns the options of
 * `ctx.dialog.confirm`.
 */
export function boardKindConfirmation(board, kind) {
  const guests = board.members.filter(
    (member) => member.kind === "user" && member.accountRole === "guest",
  );
  const losing =
    board.kind === "share" && kind !== "share" && guests.length > 0;
  const lines = [boardKind(kind).description];
  if (losing) {
    const names = guests.map((guest) => guest.name).join(", ");
    lines.push(
      `Guests lose access to boards that are not Shareable: ${names}.`,
    );
  }
  if (board.kind === "public") {
    lines.push("People who aren’t members of the board will no longer see it.");
  }
  return {
    title: `Make “${board.name}” ${boardKind(kind).label}?`,
    message: lines.join(" "),
    confirmButton: "Change board type",
    danger: losing,
  };
}

/** Whether a subject may be invited to `resource`: `{ ok, reason? }`. */
export function subjectEligibility(resource, subject) {
  if (subject.kind !== "user" || subject.role !== "guest") return { ok: true };
  if (resource.kind === "workspace") {
    return { ok: false, reason: "Guests can’t join workspaces" };
  }
  if (resource.kind === "board" && resource.setting !== "share") {
    return { ok: false, reason: "Guests can join only Shareable boards" };
  }
  return { ok: true };
}

/** A hint shown under the picker for the resource's guest rules. */
export function guestHint(resource) {
  if (resource.kind === "workspace")
    return "Guests can’t join workspaces; share a Shareable board with them instead.";
  if (resource.kind === "board" && resource.setting !== "share") {
    return "Guests can join only Shareable boards. Make this board Shareable to invite them.";
  }
  return "Guests can be invited here.";
}
