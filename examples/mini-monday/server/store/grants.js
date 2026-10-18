/**
 * Sharing (SPEC-2 §1.2, §2): grants of a role to a user or team on a
 * workspace, board, doc or note, board kinds and admin ownership
 * takeovers. Every grant change is checked with `canGrant` from
 * `server/access.js` (valid roles, guest rules, deactivated users, last
 * owner), applied atomically, logged on boards and announced to the users
 * it reaches (notification kind `share`, never to the actor). Admin
 * takeovers are announced to the resource's owners.
 */
import {
  boardAccess,
  can,
  canGrant,
  explicitOwners,
  grantField,
  isGuest,
  resourceAccess,
  subjectUserIds,
} from "../access.js";
import {
  BOARD_KINDS,
  BOARD_KIND_LABELS,
  byId,
  commit,
  failure,
  invalid,
  readChoice,
  replace,
} from "../store-state.js";
import {
  actorName,
  notify,
  quoted,
  recordActivity,
  resourceUrl,
} from "./activity.js";

const COLLECTIONS = Object.freeze({
  workspace: "workspaces",
  board: "boards",
  doc: "docs",
  note: "notes",
});
const REASONS = Object.freeze({
  invalid_role: "That role is not available for this resource",
  unknown_subject: "Unknown user or team",
  deactivated: "Deactivated users cannot be given access",
  guest_not_allowed: "Guests can only join shareable boards, docs and notes",
  note_owner: "The note owner already has access",
  last_owner: "A resource always keeps at least one owner",
});

function collectionOf(resourceKind) {
  if (!Object.hasOwn(COLLECTIONS, resourceKind)) {
    invalid(
      `resource_kind must be one of ${Object.keys(COLLECTIONS).join(", ")}`,
    );
  }
  return COLLECTIONS[resourceKind];
}

const sameSubject = (grant, subject) =>
  grant.kind === subject.kind && grant.id === subject.id;

function withGrant(members, subject, role) {
  const rest = members.filter((grant) => !sameSubject(grant, subject));
  return role === null
    ? rest
    : [...rest, { kind: subject.kind, id: subject.id, role }];
}

const titleOf = (resource) => resource.name ?? resource.title;
const nameOf = (ctx, subject) => {
  const list = subject.kind === "user" ? ctx.state.users : ctx.state.teams;
  return byId(list, subject.id)?.name ?? subject.id;
};
const roleText = (ctx, subject, role) =>
  role === null ? null : `${nameOf(ctx, subject)} (${role})`;

function membersEvent(resourceKind, resource) {
  const event = {
    type: "members_changed",
    resource_kind: resourceKind,
    resource_id: resource.id,
  };
  return resourceKind === "board" ? { ...event, board_id: resource.id } : event;
}

function logMemberChange(ctx, { board, change, actorId }) {
  const { subject, from, to } = change;
  const kind =
    from === null
      ? "member_added"
      : to === null
        ? "member_removed"
        : "member_role_changed";
  recordActivity(ctx, {
    boardId: board.id,
    actorId,
    kind,
    fromText: roleText(ctx, subject, from),
    toText: roleText(ctx, subject, to),
  });
}

/**
 * Recipients of a grant grouped by the role they now really have (a
 * viewer account granted editor is told "viewer"); users without access
 * are left out.
 */
function byEffectiveRole(ctx, { resourceKind, resource, subject }) {
  const groups = new Map();
  for (const id of subjectUserIds(ctx.reader, subject)) {
    const user = byId(ctx.state.users, id);
    const role = resourceAccess(ctx.reader, user, resourceKind, resource);
    if (role === null) continue;
    groups.set(role, [...(groups.get(role) ?? []), id]);
  }
  return groups;
}

function announce(ctx, { resourceKind, resource, changes, actorId }) {
  const who = actorName(ctx, actorId) ?? "Someone";
  const title = quoted(titleOf(resource));
  for (const { subject, to } of changes) {
    if (to === null) continue;
    const target = { resourceKind, resource, subject };
    for (const [role, userIds] of byEffectiveRole(ctx, target)) {
      notify(ctx, {
        userIds,
        actorId,
        kind: "share",
        text: `${who} shared the ${resourceKind} ${title} with you (${role})`,
        url: resourceUrl(resourceKind, resource.id),
        resource: { kind: resourceKind, id: resource.id, record: resource },
      });
    }
  }
}

/** Stores `next`, logs board member changes, notifies, emits one event. */
function applyChanges(ctx, { resourceKind, resource, next, changes, actorId }) {
  const list = ctx.state[COLLECTIONS[resourceKind]];
  replace(list, resource, next);
  if (resourceKind === "board") {
    for (const change of changes)
      logMemberChange(ctx, { board: next, change, actorId });
  }
  announce(ctx, { resourceKind, resource: next, changes, actorId });
  return commit(ctx, membersEvent(resourceKind, next), next);
}

/**
 * Applies grant changes `[{ subject, role }]` to a draft of `resource`,
 * checking each with `canGrant`. Returns `{ next, changes }` or a failure.
 */
function draftChanges(ctx, { resourceKind, resource, requests }) {
  const field = grantField(resourceKind);
  let draft = resource;
  const changes = [];
  for (const { subject, role } of requests) {
    const store = ctx.reader;
    const verdict = canGrant({
      resourceKind,
      resource: draft,
      subject,
      role,
      store,
    });
    if (!verdict.ok) {
      const message = REASONS[verdict.reason] ?? verdict.reason;
      return failure(verdict.reason, { subject_id: subject.id, message });
    }
    const from =
      draft[field].find((grant) => sameSubject(grant, subject))?.role ?? null;
    if (from === role) continue;
    draft = { ...draft, [field]: withGrant(draft[field], subject, role) };
    changes.push({ subject, from, to: role });
  }
  return { next: draft, changes };
}

/**
 * Removes every grant of `subject` (a team being deleted) from every
 * resource. Boards log each removal and every changed resource queues a
 * `members_changed` event that the caller's `commit` emits after its own.
 * There is no last-owner check: team grants never count as owners.
 */
export function dropSubjectGrants(ctx, subject, { actorId = null } = {}) {
  for (const [resourceKind, name] of Object.entries(COLLECTIONS)) {
    const field = grantField(resourceKind);
    for (const record of ctx.state[name]) {
      const grant = record[field].find((entry) => sameSubject(entry, subject));
      if (!grant) continue;
      const members = withGrant(record[field], subject, null);
      const next = replace(ctx.state[name], record, {
        ...record,
        [field]: members,
      });
      if (resourceKind === "board") {
        const change = { subject, from: grant.role, to: null };
        logMemberChange(ctx, { board: next, change, actorId });
      }
      ctx.pending.push(membersEvent(resourceKind, next));
    }
  }
}

function readSubjectKind(kind) {
  return readChoice(kind, ["user", "team"], "subject_kind");
}

function shareApi(ctx) {
  const { state } = ctx;
  const find = (kind, id) => byId(state[collectionOf(kind)], id);
  const change = (resourceKind, resource, { requests, actorId }) => {
    const draft = draftChanges(ctx, { resourceKind, resource, requests });
    if (draft.ok === false) return draft;
    if (draft.changes.length === 0) return resource;
    return applyChanges(ctx, { resourceKind, resource, ...draft, actorId });
  };
  return {
    /**
     * Grants `role` to each of `subjectIds` (all or nothing). Returns the
     * updated resource, null when it is unknown, or a failure carrying the
     * `canGrant` reason and `subject_id`.
     */
    share({
      resourceKind,
      resourceId,
      subjectKind,
      subjectIds,
      role,
      actorId = null,
    }) {
      const resource = find(resourceKind, resourceId);
      if (!resource) return null;
      const kind = readSubjectKind(subjectKind);
      if (!Array.isArray(subjectIds) || subjectIds.length === 0) {
        invalid("subject_ids must list at least one subject");
      }
      if (typeof role !== "string")
        throw new TypeError("role must be a string");
      const requests = [...new Set(subjectIds)].map((id) => ({
        subject: { kind, id },
        role,
      }));
      return change(resourceKind, resource, { requests, actorId });
    },
    /** Removes a subject's grant (no-op when absent; keeps the last owner). */
    unshare({
      resourceKind,
      resourceId,
      subjectKind,
      subjectId,
      actorId = null,
    }) {
      const resource = find(resourceKind, resourceId);
      if (!resource) return null;
      const subject = { kind: readSubjectKind(subjectKind), id: subjectId };
      const field = grantField(resourceKind);
      if (!resource[field].some((grant) => sameSubject(grant, subject)))
        return resource;
      return change(resourceKind, resource, {
        requests: [{ subject, role: null }],
        actorId,
      });
    },
    /**
     * Makes the acting admin an owner of a board or doc. Non-admins →
     * `forbidden`. See `takeOwnership` for how the override stays visible.
     */
    adminTakeOwnership({ resourceKind, resourceId, actorId }) {
      if (resourceKind !== "board" && resourceKind !== "doc") {
        invalid("Only boards and docs can be taken over");
      }
      const resource = find(resourceKind, resourceId);
      if (!resource) return null;
      if (!can(byId(state.users, actorId), "admin_directory")) {
        return failure("forbidden", {
          message: "Only admins can take ownership",
        });
      }
      return takeOwnership(ctx, { resourceKind, resource, actorId });
    },
  };
}

/**
 * Adds the admin `actorId` as an owner. The override is never silent: the
 * resource's owners are notified (a record the admin cannot remove, so
 * unsharing afterwards does not erase it), and boards also log it.
 */
function takeOwnership(ctx, { resourceKind, resource, actorId }) {
  const subject = { kind: "user", id: actorId };
  const requests = [{ subject, role: "owner" }];
  const draft = draftChanges(ctx, { resourceKind, resource, requests });
  if (draft.ok === false) return draft;
  if (draft.changes.length === 0) return resource;
  const { next } = draft;
  const owners = explicitOwners(ctx.reader, resourceKind, resource);
  replace(ctx.state[COLLECTIONS[resourceKind]], resource, next);
  if (resourceKind === "board") {
    const toText = roleText(ctx, subject, "owner");
    const kind = "ownership_taken";
    recordActivity(ctx, { boardId: next.id, actorId, kind, toText });
  }
  const who = actorName(ctx, actorId) ?? "An admin";
  notify(ctx, {
    userIds: owners,
    actorId,
    kind: "share",
    text: `${who} (admin) took ownership of the ${resourceKind} ${quoted(titleOf(next))}`,
    url: resourceUrl(resourceKind, next.id),
    resource: { kind: resourceKind, id: next.id, record: next },
  });
  return commit(ctx, membersEvent(resourceKind, next), next);
}

/**
 * True when the change from `board` to `next` would take away all access
 * of the user making it (an admin's implicit ownership of a Main board, a
 * guest's grant), which would report a committed change as inaccessible.
 */
function locksOut(ctx, { board, next, actorId }) {
  const actor = byId(ctx.state.users, actorId);
  if (!actor) return false;
  const before = boardAccess(ctx.reader, actor, board);
  return before !== null && boardAccess(ctx.reader, actor, next) === null;
}

function boardKindApi(ctx) {
  const { state } = ctx;
  return {
    /**
     * Changes a board's kind. Leaving "share" removes guest user grants
     * (logged as member removals); a guest that is the last owner blocks
     * it, and so does a change that would lock out the actor (`own_access`).
     */
    setBoardKind(boardId, boardKind, { actorId = null } = {}) {
      const board = byId(state.boards, boardId);
      if (!board) return null;
      readChoice(boardKind, BOARD_KINDS, "board_kind");
      if (board.board_kind === boardKind) return board;
      const guests =
        boardKind === "share"
          ? []
          : board.members.filter(
              (g) => g.kind === "user" && isGuest(byId(state.users, g.id)),
            );
      const requests = guests.map((g) => ({
        subject: { kind: "user", id: g.id },
        role: null,
      }));
      const draft = draftChanges(ctx, {
        resourceKind: "board",
        resource: board,
        requests,
      });
      if (draft.ok === false) return draft;
      const next = { ...draft.next, board_kind: boardKind };
      if (locksOut(ctx, { board, next, actorId })) {
        return failure("own_access", {
          message:
            "That kind would remove your own access; add yourself as an owner first",
        });
      }
      replace(state.boards, board, next);
      recordActivity(ctx, {
        boardId,
        actorId,
        kind: "board_kind_changed",
        fromText: BOARD_KIND_LABELS[board.board_kind],
        toText: BOARD_KIND_LABELS[boardKind],
      });
      for (const change of draft.changes)
        logMemberChange(ctx, { board: next, change, actorId });
      const event = { type: "board_kind_changed", board_id: boardId };
      return commit(
        ctx,
        { ...event, resource_kind: "board", resource_id: boardId },
        next,
      );
    },
  };
}

export function grantApi(ctx) {
  return { ...shareApi(ctx), ...boardKindApi(ctx) };
}
