/**
 * Effective access (SPEC-2 §1.2). This is the only module that interprets
 * account roles, user status, resource grants and team membership; the
 * store, resolvers, HTTP routes and UI capability flags all ask it.
 *
 * Functions take a store-like `store` with `getUser`, `getTeam`,
 * `getWorkspace` and `getBoard` (and `getDoc`/`getNote`/`getForm` for the
 * `require*` helpers). They return an access role (`"owner"`, `"editor"`,
 * `"viewer"`) or null for no access. A deactivated user always gets null.
 *
 * Choices where the spec leaves room (recorded with the builder report):
 * - Guests never get workspace access, not even through a team grant;
 *   they reach content only through grants on share boards, docs and notes.
 * - An explicit grant replaces the implicit role (a member with a viewer
 *   grant on a public board is a viewer), except that admins are always
 *   owners of public boards in workspaces they can reach.
 * - A note owner keeps "owner" even with a viewer account (personal notes
 *   are always editable by their owner); shared roles are capped.
 * - Last-owner protection counts user owner grants that make their user
 *   an owner (active, not a viewer account, guests only where admitted);
 *   team owner grants are extra, so deleting a team never leaves a
 *   resource without an owner. Teams likewise keep an active owner.
 */
import { peopleIds } from "./column-values.js";
import { GraphQLError } from "./graphql/errors.js";

export const ROLE_RANK = Object.freeze({ viewer: 1, editor: 2, owner: 3 });
export const ACCESS_ROLES = Object.freeze(["owner", "editor", "viewer"]);
export const ACCOUNT_ROLES = Object.freeze([
  "admin",
  "member",
  "viewer",
  "guest",
]);
export const RESOURCE_KINDS = Object.freeze([
  "workspace",
  "board",
  "doc",
  "note",
]);
/** Roles a grant may carry, per resource kind. */
export const GRANT_ROLES = Object.freeze({
  workspace: Object.freeze(["owner", "editor"]),
  board: ACCESS_ROLES,
  doc: ACCESS_ROLES,
  note: Object.freeze(["editor", "viewer"]),
});

const CREATORS = ["admin", "member"];
const CAPABILITIES = Object.freeze({
  manage_users: ["admin"],
  admin_directory: ["admin"],
  create_workspace: CREATORS,
  create_team: CREATORS,
  create_content: CREATORS,
  create_note: ACCOUNT_ROLES,
});
const LABELS = Object.freeze({
  workspace: "Workspace",
  board: "Board",
  doc: "Doc",
  note: "Note",
  form: "Form",
  item: "Item",
  install: "App install",
});

const knownRole = (role) =>
  typeof role === "string" && Object.hasOwn(ROLE_RANK, role) ? role : null;
const rank = (role) => (knownRole(role) ? ROLE_RANK[role] : 0);

// ------------------------------------------------------------ primitives

/** The higher of two access roles; null-safe (unknown roles count as null). */
export function maxRole(a, b) {
  const left = knownRole(a);
  const right = knownRole(b);
  return rank(right) > rank(left) ? right : left;
}

/** Caps `role` at "viewer" for viewer accounts; null stays null. */
export function capRole(role, user) {
  const known = knownRole(role);
  if (known === null) return null;
  return user?.role === "viewer" && rank(known) > rank("viewer")
    ? "viewer"
    : known;
}

/** True when `role` is at least `minRole`. */
export function hasRole(role, minRole) {
  if (!knownRole(minRole)) throw new TypeError(`Unknown role ${minRole}`);
  return rank(role) >= rank(minRole);
}

export const isActive = (user) => user?.status === "active";
/** Account role check for display (`is_admin`); `can` also needs active. */
export const isAdmin = (user) => user?.role === "admin";
export const isGuest = (user) => user?.role === "guest";

/** "owner" | "member" | null: the user's role in `team`. */
export function teamRole(team, user) {
  const entry = team?.members?.find((member) => member.user_id === user?.id);
  return entry?.role ?? null;
}

/** Account capabilities (SPEC-2 §1.1) of an active user. */
export function can(user, capability) {
  if (!Object.hasOwn(CAPABILITIES, capability)) {
    throw new TypeError(`Unknown capability ${capability}`);
  }
  return isActive(user) && CAPABILITIES[capability].includes(user.role);
}

/** Admins and team owners (active) manage a team's name and members. */
export function canManageTeam(user, team) {
  if (!isActive(user) || !team) return false;
  return isAdmin(user) || teamRole(team, user) === "owner";
}

/** The field of a resource that holds its grants. */
export function grantField(resourceKind) {
  return resourceKind === "note" ? "shares" : "members";
}

export function membersOf(resourceKind, resource) {
  const members = resource?.[grantField(resourceKind)];
  return Array.isArray(members) ? members : [];
}

/** The highest role `user` holds through user grants and team grants. */
export function subjectGrants(store, user, members) {
  if (!user || !Array.isArray(members)) return null;
  let best = null;
  for (const grant of members) {
    const applies =
      grant.kind === "user"
        ? grant.id === user.id
        : grant.kind === "team" &&
          teamRole(store.getTeam(grant.id), user) !== null;
    if (applies) best = maxRole(best, grant.role);
  }
  return best;
}

// -------------------------------------------------------- effective access

export function workspaceAccess(store, user, workspace) {
  if (!isActive(user) || !workspace || isGuest(user)) return null;
  // Management access only; content access is decided per board and doc.
  if (isAdmin(user)) return "owner";
  const explicit = subjectGrants(store, user, workspace.members);
  const implicit = workspace.kind === "open" ? "editor" : null;
  return capRole(explicit ?? implicit, user);
}

export function boardAccess(store, user, board) {
  if (!isActive(user) || !board) return null;
  if (isGuest(user) && board.board_kind !== "share") return null;
  const explicit = subjectGrants(store, user, board.members);
  let role = explicit;
  if (board.board_kind === "public" && !isGuest(user)) {
    const workspace = store.getWorkspace(board.workspace_id);
    if (workspaceAccess(store, user, workspace) !== null) {
      role = isAdmin(user) ? "owner" : (explicit ?? "editor");
    }
  }
  return capRole(role, user);
}

export function docAccess(store, user, doc) {
  if (!isActive(user) || !doc) return null;
  const explicit = subjectGrants(store, user, doc.members);
  if (explicit !== null) return capRole(explicit, user);
  if (doc.visibility !== "workspace" || isGuest(user)) return null;
  const workspace = store.getWorkspace(doc.workspace_id);
  const reachable = workspaceAccess(store, user, workspace) !== null;
  return reachable ? capRole("editor", user) : null;
}

export function noteAccess(store, user, note) {
  if (!isActive(user) || !note) return null;
  if (note.owner_id === user.id) return "owner";
  const shared = subjectGrants(store, user, note.shares);
  // Note shares are viewer or editor; anything else is ignored.
  return shared === "owner" ? null : capRole(shared, user);
}

/** Management access to a form: the board access of its board. */
export function formAccess(store, user, form) {
  if (!form) return null;
  return boardAccess(store, user, store.getBoard(form.board_id));
}

/**
 * Access to an app install: the board access of its board. App principals
 * act as their user (SPEC-2 §1.2), so writing app storage needs editor.
 */
export function installAccess(store, user, install) {
  if (!install) return null;
  return boardAccess(store, user, store.getBoard(install.board_id));
}

const ACCESSORS = Object.freeze({
  workspace: workspaceAccess,
  board: boardAccess,
  doc: docAccess,
  note: noteAccess,
  form: formAccess,
});

/** Dispatches on `resourceKind` ("workspace" | "board" | "doc" | "note" | "form"). */
export function resourceAccess(store, user, resourceKind, resource) {
  if (!Object.hasOwn(ACCESSORS, resourceKind)) {
    throw new TypeError(`Unknown resource kind ${resourceKind}`);
  }
  return ACCESSORS[resourceKind](store, user, resource);
}

/**
 * Whether `user` may see `notification` now: it must be theirs, and the
 * resource it points at (when any) must still be accessible.
 */
export function notificationVisible(store, user, notification) {
  if (!isActive(user) || notification?.user_id !== user.id) return false;
  const kind = notification.resource_kind ?? null;
  if (kind === null) return true;
  const getters = {
    workspace: store.getWorkspace,
    board: store.getBoard,
    doc: store.getDoc,
    note: store.getNote,
  };
  const getter = getters[kind];
  if (typeof getter !== "function") return false;
  const resource = getter(notification.resource_id);
  return resourceAccess(store, user, kind, resource) !== null;
}

// -------------------------------------------------------------- directory

function addSubjects(store, ids, kind, resource) {
  for (const grant of membersOf(kind, resource)) {
    for (const id of subjectUserIds(store, grant)) ids.add(id);
  }
}

/** Adds the people assigned to items of `board` (people columns). */
function addAssignees(store, ids, board) {
  const people = store.listColumns(board.id).filter((c) => c.type === "people");
  if (people.length === 0) return;
  const limit = Number.MAX_SAFE_INTEGER;
  for (const item of store.listItems({ boardId: board.id, limit }).items) {
    for (const column of people) {
      for (const id of peopleIds(column, item.values[column.id])) ids.add(id);
    }
  }
}

function guestDirectory(store, guest) {
  const ids = new Set([guest.id]);
  for (const team of store.listTeams()) {
    if (teamRole(team, guest) === null) continue;
    for (const member of team.members) ids.add(member.user_id);
  }
  for (const board of store.listBoards({ limit: Number.MAX_SAFE_INTEGER })) {
    if (boardAccess(store, guest, board) === null) continue;
    addSubjects(store, ids, "board", board);
    addAssignees(store, ids, board);
    if (board.creator_id) ids.add(board.creator_id);
  }
  for (const doc of store.listDocs()) {
    if (docAccess(store, guest, doc) === null) continue;
    addSubjects(store, ids, "doc", doc);
    for (const id of [doc.created_by, doc.updated_by]) if (id) ids.add(id);
  }
  for (const note of store.listNotes()) {
    if (noteAccess(store, guest, note) === null) continue;
    addSubjects(store, ids, "note", note);
    ids.add(note.owner_id);
  }
  return ids;
}

/**
 * The users `viewer` may see, as a Set of IDs, or null for everyone
 * (unspecified in SPEC-2, recorded with the builder report). Active
 * non-guests see every user. Guests see themselves, the members of their
 * teams and the people on the content they can access (grants, note
 * owners, board and doc authors, people assigned to items); everyone else
 * is reported like an unknown ID wherever a user would appear. Needs a
 * full store (`list*` methods).
 */
export function visibleUserIds(store, viewer) {
  if (!isActive(viewer)) return new Set();
  return isGuest(viewer) ? guestDirectory(store, viewer) : null;
}

/** Guests see only the teams they belong to; others see every team. */
export const teamVisible = (viewer, team) =>
  Boolean(team) && (!isGuest(viewer) || teamRole(team, viewer) !== null);

// ----------------------------------------------------------------- grants

/** User IDs a subject stands for: the user, or the team's members. */
export function subjectUserIds(store, subject) {
  if (subject?.kind === "user") return [subject.id];
  const team = subject?.kind === "team" ? store.getTeam(subject.id) : null;
  return team ? team.members.map((member) => member.user_id) : [];
}

/**
 * Users who own `resource` through an explicit owner grant (user or team)
 * and whose effective access is "owner" (for form-response inboxes).
 */
export function explicitOwners(store, resourceKind, resource) {
  const candidates = membersOf(resourceKind, resource)
    .filter((grant) => grant.role === "owner")
    .flatMap((grant) => subjectUserIds(store, grant));
  return [...new Set(candidates)].filter((id) => {
    const user = store.getUser(id);
    return resourceAccess(store, user, resourceKind, resource) === "owner";
  });
}

/**
 * True when `grant` is a user owner grant that makes its user an owner of
 * `resource`: the user is active, not a viewer account (capped) and, for
 * guests, on a resource that admits them.
 */
function ownsThrough(store, { resourceKind, resource }, grant) {
  if (grant.kind !== "user" || grant.role !== "owner") return false;
  const user = store.getUser(grant.id);
  return resourceAccess(store, user, resourceKind, resource) === "owner";
}

/** Whether a resource still has an effective user owner after the change. */
function keepsAnOwner(store, { resourceKind, resource, subject, role }) {
  if (subject.kind !== "user" || role === "owner") return true;
  const target = { resourceKind, resource };
  const owners = membersOf(resourceKind, resource).filter((grant) =>
    ownsThrough(store, target, grant),
  );
  return !owners.some((grant) => grant.id === subject.id) || owners.length > 1;
}

/** Active owners of `team`: the users who manage it, besides admins. */
export function teamManagers(store, team) {
  const owners = (team?.members ?? []).filter((m) => m.role === "owner");
  return owners
    .map((member) => member.user_id)
    .filter((id) => isActive(store.getUser(id)));
}

function guestAllowed(resourceKind, resource) {
  if (resourceKind === "board") return resource.board_kind === "share";
  return resourceKind === "doc" || resourceKind === "note";
}

function subjectOf(store, subject) {
  if (subject?.kind === "user") return store.getUser(subject.id);
  if (subject?.kind === "team") return store.getTeam(subject.id);
  return null;
}

/**
 * Checks granting `role` to `subject` (`{ kind: "user" | "team", id }`) on
 * `resource`; `role: null` checks removing the subject's grant.
 * @returns {{ ok: true } | { ok: false, reason: "invalid_kind" |
 *   "not_found" | "invalid_role" | "unknown_subject" | "deactivated" |
 *   "guest_not_allowed" | "note_owner" | "last_owner" }}
 */
export function canGrant({ resourceKind, resource, subject, role, store }) {
  const reject = (reason) => ({ ok: false, reason });
  if (!Object.hasOwn(GRANT_ROLES, resourceKind)) return reject("invalid_kind");
  if (!resource) return reject("not_found");
  if (role !== null && !GRANT_ROLES[resourceKind].includes(role)) {
    return reject("invalid_role");
  }
  const record = subjectOf(store, subject);
  if (!record) return reject("unknown_subject");
  if (role !== null && subject.kind === "user") {
    if (!isActive(record)) return reject("deactivated");
    if (isGuest(record) && !guestAllowed(resourceKind, resource)) {
      return reject("guest_not_allowed");
    }
    if (resourceKind === "note" && resource.owner_id === record.id) {
      return reject("note_owner");
    }
  }
  const change = { resourceKind, resource, subject, role };
  return keepsAnOwner(store, change) ? { ok: true } : reject("last_owner");
}

// ------------------------------------------------- NOT_FOUND vs FORBIDDEN

/** A short JSON rendering of a caller-supplied value for messages. */
export const describe = (value) => {
  const text = String(value);
  return JSON.stringify(text.length > 40 ? `${text.slice(0, 40)}…` : text);
};

/** The error for a missing or inaccessible record; the two look the same. */
export function notFoundError(what, id) {
  const label = LABELS[what] ?? what;
  return new GraphQLError(`${label} ${describe(id)} was not found`, {
    code: "NOT_FOUND",
  });
}

export function forbiddenError(what, minRole) {
  const label = (LABELS[what] ?? what).toLowerCase();
  return new GraphQLError(`This needs ${minRole} access to the ${label}`, {
    code: "FORBIDDEN",
  });
}

/**
 * "ok" when `role` reaches `minRole`, "not_found" without access,
 * "forbidden" when accessible with too low a role.
 */
export function accessOutcome(role, minRole) {
  if (knownRole(role) === null) return "not_found";
  return hasRole(role, minRole) ? "ok" : "forbidden";
}

/** The active user acting in a resolver-like `ctx` ({ store, principal } or { store, user }). */
export function actingUser(ctx) {
  const user = ctx.user ?? ctx.store.getUser(ctx.principal?.userId ?? null);
  return isActive(user) ? user : null;
}

function requireRecord(ctx, { kind, id, record, minRole }) {
  const user = actingUser(ctx);
  const role = record ? resourceAccess(ctx.store, user, kind, record) : null;
  const outcome = accessOutcome(role, minRole);
  if (outcome === "not_found") throw notFoundError(kind, id);
  if (outcome === "forbidden") throw forbiddenError(kind, minRole);
  return record;
}

export function requireWorkspace(ctx, id, minRole = "viewer") {
  const record = ctx.store.getWorkspace(id);
  return requireRecord(ctx, { kind: "workspace", id, record, minRole });
}

export function requireBoard(ctx, id, minRole = "viewer") {
  const record = ctx.store.getBoard(id);
  return requireRecord(ctx, { kind: "board", id, record, minRole });
}

export function requireDoc(ctx, id, minRole = "viewer") {
  const record = ctx.store.getDoc(id);
  return requireRecord(ctx, { kind: "doc", id, record, minRole });
}

export function requireNote(ctx, id, minRole = "viewer") {
  const record = ctx.store.getNote(id);
  return requireRecord(ctx, { kind: "note", id, record, minRole });
}

/** A form, checked against the access of its board. */
export function requireForm(ctx, id, minRole = "viewer") {
  const record = ctx.store.getForm(id);
  return requireRecord(ctx, { kind: "form", id, record, minRole });
}

/** A record checked against the access of its board (NOT_FOUND as `kind`). */
function requireOnBoard(ctx, { kind, id, record, minRole }) {
  const board = record ? ctx.store.getBoard(record.board_id) : null;
  const role = boardAccess(ctx.store, actingUser(ctx), board);
  const outcome = accessOutcome(role, minRole);
  if (outcome === "not_found") throw notFoundError(kind, id);
  if (outcome === "forbidden") throw forbiddenError("board", minRole);
  return record;
}

/** An item, checked against the access of its board (NOT_FOUND as Item). */
export function requireItem(ctx, id, minRole = "viewer") {
  const record = ctx.store.getItem(id);
  return requireOnBoard(ctx, { kind: "item", id, record, minRole });
}

/** An app install, checked against the access of its board. */
export function requireInstall(ctx, id, minRole = "viewer") {
  const record = ctx.store.getInstall(id);
  return requireOnBoard(ctx, { kind: "install", id, record, minRole });
}

/** Dispatches on a `ResourceKind` (workspace | board | doc | note). */
export function requireResource(ctx, { resourceKind, id, minRole }) {
  const helpers = {
    workspace: requireWorkspace,
    board: requireBoard,
    doc: requireDoc,
    note: requireNote,
  };
  if (!Object.hasOwn(helpers, resourceKind)) {
    throw new TypeError(`Unknown resource kind ${resourceKind}`);
  }
  return helpers[resourceKind](ctx, id, minRole);
}

/** The acting user when they have `capability`, else FORBIDDEN. */
export function requireCapability(ctx, capability) {
  const user = actingUser(ctx);
  if (can(user, capability)) return user;
  throw new GraphQLError(`Your account role cannot ${capability}`, {
    code: "FORBIDDEN",
  });
}
