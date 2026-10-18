/**
 * Sharing for every resource kind: the `share_candidates` picker, `share`,
 * `unshare` and the admin override `admin_take_ownership`. Managing
 * members needs owner access (`server/access.js`); grant rules (valid
 * roles, guests, last owner, deactivated users) are checked by the store
 * with `canGrant`, and the candidates carry the same verdicts
 * (`access.shareVerdict`). Subjects the caller cannot see are refused like
 * unknown IDs and never offered.
 */
import {
  isCurrentMember,
  requireCapability,
  requireResource,
  shareVerdict,
  teamVisible,
} from "../access.js";
import { LIMITS } from "../input.js";
import {
  badInput,
  lookupUser,
  memberRecords,
  notFound,
  plural,
  read,
  readLimit,
  storeResult,
  viewerOf,
  visibleUsers,
  wrapAll,
  write,
} from "./common.js";
import { readSubjectIds } from "./people.js";

/** The resource of a sharing mutation; managing members needs owner. */
const managed = (ctx, args) =>
  requireResource(ctx, {
    resourceKind: args.resource_kind,
    id: args.resource_id,
    minRole: "owner",
  });

const MAX_CANDIDATES = 50;
const byName = (a, b) =>
  a.name.localeCompare(b.name, "en", { sensitivity: "base" }) ||
  Number(a.id) - Number(b.id);

/** Users (by name or email) and teams (by name) matching `term`, by name. */
function directoryMatches(ctx, term) {
  const matches = (...fields) =>
    term === "" || fields.some((field) => field.toLowerCase().includes(term));
  const viewer = viewerOf(ctx);
  const users = visibleUsers(ctx)
    .filter((user) => matches(user.name, user.email))
    .map((user) => ({
      kind: "user",
      id: user.id,
      name: user.name,
      subtitle: user.email,
    }));
  const teams = ctx.store
    .listTeams()
    .filter((team) => teamVisible(viewer, team) && matches(team.name))
    .map((team) => ({
      kind: "team",
      id: team.id,
      name: team.name,
      subtitle: plural(team.members.length, "member"),
    }));
  return [...users.sort(byName), ...teams.sort(byName)];
}

/**
 * Users and teams in the caller's directory that could be added to the
 * resource, with the `canGrant` verdict on each (SPEC-2 §6). Current
 * members (and a note's owner) are left out; owner access is required.
 * Eligible candidates come first (each group by name, users before
 * teams), so people who can't be added never crowd out those who can.
 */
function shareCandidates(_p, args, ctx) {
  const kind = args.resource_kind;
  const resource = managed(ctx, args);
  const limit = readLimit(args.limit, MAX_CANDIDATES);
  const term = (args.query ?? "").trim().toLowerCase();
  if (term.length > LIMITS.name) {
    badInput(`query must be at most ${LIMITS.name} characters`);
  }
  const eligible = [];
  const others = [];
  for (const candidate of directoryMatches(ctx, term)) {
    const subject = { kind: candidate.kind, id: candidate.id };
    if (isCurrentMember(kind, resource, subject)) continue;
    const target = { resourceKind: kind, resource, subject };
    const verdict = shareVerdict(ctx.store, target);
    const list = verdict.eligible ? eligible : others;
    if (list.length === limit) continue;
    list.push({
      ...candidate,
      eligible: verdict.eligible,
      reason: verdict.reason,
      note: verdict.note,
      role_options: verdict.roleOptions,
    });
    if (eligible.length === limit) break;
  }
  return [...eligible, ...others].slice(0, limit);
}

/** Maps a store result to the resource's Member list. */
function membersAfter(ctx, kind, result, id) {
  const resource = storeResult(result, () => notFound(kind, id));
  return memberRecords(ctx, kind, resource);
}

const Mutation = wrapAll(write, {
  share(_p, args, ctx) {
    const resource = managed(ctx, args);
    const kind = args.resource_kind;
    const subjectKind = args.subject_kind;
    const ids = readSubjectIds(ctx, {
      kind: subjectKind,
      ids: args.subject_ids,
    });
    const result = ctx.store.share({
      resourceKind: kind,
      resourceId: resource.id,
      subjectKind,
      subjectIds: ids,
      role: args.role,
      actorId: viewerOf(ctx).id,
    });
    return membersAfter(ctx, kind, result, resource.id);
  },
  unshare(_p, args, ctx) {
    const resource = managed(ctx, args);
    const kind = args.resource_kind;
    const subjectKind = args.subject_kind;
    const [subjectId] = readSubjectIds(ctx, {
      kind: subjectKind,
      ids: [args.subject_id],
    });
    const result = ctx.store.unshare({
      resourceKind: kind,
      resourceId: resource.id,
      subjectKind,
      subjectId,
      actorId: viewerOf(ctx).id,
    });
    return membersAfter(ctx, kind, result, resource.id);
  },
  admin_take_ownership(_p, args, ctx) {
    const admin = requireCapability(ctx, "admin_directory");
    const kind = args.resource_kind;
    // Checked before any lookup, so notes and workspaces reveal nothing.
    if (kind !== "board" && kind !== "doc") {
      badInput("Only boards and docs can be taken over");
    }
    const result = ctx.store.adminTakeOwnership({
      resourceKind: kind,
      resourceId: args.resource_id,
      actorId: admin.id,
    });
    return membersAfter(ctx, kind, result, args.resource_id);
  },
});

export const definition = {
  types: {
    Query:
      "share_candidates(resource_kind:ResourceKind!,resource_id:ID!,query:String,limit:Int=20):[ShareCandidate!]!",
    ShareCandidate: `kind:SubjectKind! id:ID! name:String! subtitle:String
      eligible:Boolean! reason:String role_options:[AccessRole!]! note:String
      user:User`,
    Mutation: `share(resource_kind:ResourceKind!,resource_id:ID!,subject_kind:SubjectKind!,subject_ids:[ID!]!,role:AccessRole!):[Member!]!
      unshare(resource_kind:ResourceKind!,resource_id:ID!,subject_kind:SubjectKind!,subject_id:ID!):[Member!]!
      admin_take_ownership(resource_kind:ResourceKind!,resource_id:ID!):[Member!]!`,
  },
  resolvers: {
    Query: wrapAll(read, { share_candidates: shareCandidates }),
    Mutation,
    ShareCandidate: {
      user: (candidate, _a, ctx) =>
        candidate.kind === "user" ? lookupUser(ctx, candidate.id) : null,
    },
  },
  extras: {
    "Query.share_candidates": {
      description:
        "Owners: users and teams that could be added, with eligibility, a reason when not eligible and the roles that would be accepted.",
    },
    "ShareCandidate.note": {
      description:
        "A limit that would apply once added (viewer accounts can only view).",
    },
    "Mutation.admin_take_ownership": {
      description: "Admins: become an owner of a board or doc (logged).",
    },
  },
};
