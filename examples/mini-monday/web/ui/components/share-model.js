import { boardHash, docHash, noteHash, workspaceHash } from "../../router.js";
import {
  ACCESS_ROLES,
  BOARD_KINDS,
  DOC_VISIBILITIES,
  WORKSPACE_KINDS,
  boardKind,
} from "./labels.js";

/**
 * Data of the share dialog (no DOM): the GraphQL documents for each
 * resource kind, the normalized resource and member records and the
 * invite choices. Every rule comes from the server (SPEC-2 §6): each
 * Member carries `can_remove`, `can_change_role`, `role_options`, the role
 * its grant really gives (`effective_role`) and the server's explanation
 * of the row (`reason`), and `share_candidates` lists who could be added
 * with the `canGrant` verdict (`eligible`, `reason`, `role_options`) and a
 * `note` on limits that would apply. Nothing here re-derives which roles a
 * resource accepts, who is the last owner, who may join or whose role is
 * capped.
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

const MEMBER_FIELDS = `kind id name role can_remove can_change_role role_options
    effective_role reason
    user { id name email initials color role status }
    team { id name member_count }`;

/** Candidates per request: the picker shows 8 beside up to 8 chosen. */
export const CANDIDATE_LIMIT = 16;

export const SHARE_CANDIDATES_QUERY = `query ShareCandidates($kind: ResourceKind!, $id: ID!, $query: String, $limit: Int) {
  share_candidates(resource_kind: $kind, resource_id: $id, query: $query, limit: $limit) {
    kind id name subtitle eligible reason role_options note
    user { role }
  }
}`;

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

/** Display order of access roles (highest first), from `labels.js`. */
const ROLE_ORDER = Object.keys(ACCESS_ROLES);
const byRank = (roles) => ROLE_ORDER.filter((role) => roles.includes(role));
const roleList = (value) =>
  Array.isArray(value) ? value.filter((role) => typeof role === "string") : [];

/** Normalizes one Member record with its server verdicts. */
export function normalizeMember(member) {
  return {
    kind: member.kind === "team" ? "team" : "user",
    id: String(member.id),
    name: member.name,
    role: member.role,
    email: member.user?.email ?? null,
    accountRole: member.user?.role ?? null,
    status: member.user?.status ?? null,
    color: member.user?.color ?? null,
    initials: member.user?.initials ?? null,
    memberCount: member.team?.member_count ?? null,
    canRemove: member.can_remove === true,
    canChangeRole: member.can_change_role === true,
    roleOptions: roleList(member.role_options),
    effectiveRole: member.effective_role ?? null,
    reason: member.reason ?? null,
  };
}

/** Normalizes one ShareCandidate (a picker suggestion with its verdict). */
export function normalizeCandidate(candidate) {
  return {
    kind: candidate.kind === "team" ? "team" : "user",
    id: String(candidate.id),
    name: candidate.name,
    subtitle: candidate.subtitle ?? "",
    eligible: candidate.eligible === true,
    reason: candidate.eligible === true ? null : (candidate.reason ?? null),
    note: candidate.note ?? null,
    accountRole: candidate.user?.role ?? null,
    roleOptions: roleList(candidate.role_options),
  };
}

/**
 * The roles the invite select offers: those the server accepts for every
 * selected subject, or before a selection those it accepts for any
 * suggestion on offer. Highest first.
 */
export function inviteRoles(selection, suggestions) {
  if (selection.length > 0) {
    const [first, ...rest] = selection.map((subject) => subject.roleOptions);
    return byRank(first.filter((role) => rest.every((r) => r.includes(role))));
  }
  const offered = suggestions.filter((subject) => subject.eligible);
  return byRank(offered.flatMap((subject) => subject.roleOptions));
}

/**
 * The role to preselect among `roles`: the previous choice when still
 * offered, else editor (viewer for notes), else the first.
 */
export function preferredRole(resourceKind, roles, previous = null) {
  if (previous && roles.includes(previous)) return previous;
  const wanted = resourceKind === "note" ? "viewer" : "editor";
  return roles.includes(wanted) ? wanted : (roles[0] ?? null);
}

/** The server's distinct reasons for suggestions that can't be added. */
export function ineligibleReasons(suggestions) {
  const reasons = suggestions
    .filter((subject) => !subject.eligible && subject.reason)
    .map((subject) => subject.reason);
  return [...new Set(reasons)];
}

/** The server's distinct notes on the chosen subjects (viewer accounts). */
export function selectionNotes(selection) {
  return [...new Set(selection.map((subject) => subject.note).filter(Boolean))];
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
