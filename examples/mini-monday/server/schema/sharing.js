/**
 * Sharing mutations for every resource kind: `share`, `unshare` and the
 * admin override `admin_take_ownership`. Managing members needs owner
 * access (`server/access.js`); grant rules (valid roles, guests, last
 * owner, deactivated users) are checked by the store with `canGrant`.
 * Subjects the caller cannot see are refused like unknown IDs.
 */
import { requireCapability, requireResource } from "../access.js";
import {
  badInput,
  memberRecords,
  notFound,
  storeResult,
  viewerOf,
  wrapAll,
  write,
} from "./common.js";
import { readSubjectIds } from "./people.js";

const LABELS = {
  workspace: "Workspace",
  board: "Board",
  doc: "Doc",
  note: "Note",
};

/** The resource of a sharing mutation; managing members needs owner. */
const managed = (ctx, args) =>
  requireResource(ctx, {
    resourceKind: args.resource_kind,
    id: args.resource_id,
    minRole: "owner",
  });

/** Maps a store result to the resource's Member list. */
function membersAfter(ctx, kind, result, id) {
  const resource = storeResult(result, () => notFound(LABELS[kind], id));
  return memberRecords(ctx.store, kind, resource);
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
    Mutation: `share(resource_kind:ResourceKind!,resource_id:ID!,subject_kind:SubjectKind!,subject_ids:[ID!]!,role:AccessRole!):[Member!]!
      unshare(resource_kind:ResourceKind!,resource_id:ID!,subject_kind:SubjectKind!,subject_id:ID!):[Member!]!
      admin_take_ownership(resource_kind:ResourceKind!,resource_id:ID!):[Member!]!`,
  },
  resolvers: { Mutation },
  extras: {
    "Mutation.admin_take_ownership": {
      description: "Admins: become an owner of a board or doc (logged).",
    },
  },
};
