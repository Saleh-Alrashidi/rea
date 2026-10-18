/**
 * Workspaces: the `workspaces` list (accessible ones only), the Workspace
 * type and its mutations, plus the "where new content goes" rule shared by
 * create_board and create_doc.
 *
 * A Workspace reached as the container of an accessible board or doc (a
 * shareable board for a guest, a doc shared into a closed workspace) shows
 * only its id, name, kind and color: description and members stay empty,
 * `my_access` reads "viewer" (the field is non-null; `can_open` is false)
 * and its boards/docs lists hold only what the caller can open anyway.
 * `can_delete` is true only for owners of an empty workspace: content the
 * caller cannot see blocks deletion too, as the store's rule says.
 */
import {
  docAccess,
  requireCapability,
  requireWorkspace,
  workspaceAccess,
} from "../access.js";
import {
  accessibleBoards,
  memberRecords,
  notFound,
  read,
  readDescription,
  readName,
  storeResult,
  viewerOf,
  wrapAll,
  write,
} from "./common.js";

const accessOf = (ctx, workspace) =>
  workspaceAccess(ctx.store, viewerOf(ctx), workspace);

/**
 * The workspace new boards and docs go to: `workspaceId`, or the default
 * (first) workspace; the caller needs editor access to it.
 */
export function requireTargetWorkspace(ctx, workspaceId) {
  const id = workspaceId ?? ctx.store.getDefaultWorkspace()?.id ?? null;
  if (id === null) notFound("Workspace", "default");
  return requireWorkspace(ctx, id, "editor");
}

const Query = wrapAll(read, {
  workspaces: (_p, _a, ctx) =>
    ctx.store
      .listWorkspaces()
      .filter((workspace) => accessOf(ctx, workspace) !== null),
});

const Workspace = {
  description: (workspace, _a, ctx) =>
    accessOf(ctx, workspace) === null ? null : workspace.description,
  members: (workspace, _a, ctx) =>
    accessOf(ctx, workspace) === null
      ? []
      : memberRecords(ctx, "workspace", workspace),
  my_access: (workspace, _a, ctx) => accessOf(ctx, workspace) ?? "viewer",
  can_manage: (workspace, _a, ctx) => accessOf(ctx, workspace) === "owner",
  can_open: (workspace, _a, ctx) => accessOf(ctx, workspace) !== null,
  can_delete: (workspace, _a, ctx) =>
    accessOf(ctx, workspace) === "owner" &&
    ctx.store.isWorkspaceEmpty(workspace.id),
  boards: (workspace, _a, ctx) =>
    accessibleBoards(ctx).filter(
      (board) => board.workspace_id === workspace.id,
    ),
  docs: (workspace, _a, ctx) => {
    const viewer = viewerOf(ctx);
    return ctx.store
      .listDocs({ workspaceId: workspace.id })
      .filter((doc) => docAccess(ctx.store, viewer, doc) !== null);
  },
};

const Mutation = wrapAll(write, {
  create_workspace(_p, args, ctx) {
    const creator = requireCapability(ctx, "create_workspace");
    const result = ctx.store.createWorkspace({
      name: readName(args.name, "Workspace name"),
      description: readDescription(args.description) ?? null,
      kind: args.kind,
      creatorId: creator.id,
    });
    return storeResult(result, () => notFound("User", creator.id));
  },
  update_workspace(_p, args, ctx) {
    const workspace = requireWorkspace(ctx, args.workspace_id, "owner");
    const changes = {
      name:
        args.name == null ? undefined : readName(args.name, "Workspace name"),
      description: readDescription(args.description),
      kind: args.kind ?? undefined,
      color: args.color ?? undefined,
    };
    const result = ctx.store.updateWorkspace(workspace.id, changes);
    return storeResult(result, () => notFound("Workspace", workspace.id));
  },
  delete_workspace(_p, args, ctx) {
    const workspace = requireWorkspace(ctx, args.workspace_id, "owner");
    const result = ctx.store.deleteWorkspace(workspace.id);
    return storeResult(result, () => notFound("Workspace", workspace.id));
  },
});

export const definition = {
  types: {
    Query: "workspaces:[Workspace!]!",
    Workspace: `id:ID! name:String! description:String kind:WorkspaceKind!
      color:String! members:[Member!]! my_access:AccessRole!
      boards:[Board!]! docs:[Doc!]! can_manage:Boolean! can_open:Boolean!
      can_delete:Boolean!`,
    Mutation: `create_workspace(name:String!,kind:WorkspaceKind="open",description:String):Workspace!
      update_workspace(workspace_id:ID!,name:String,description:String,kind:WorkspaceKind,color:String):Workspace!
      delete_workspace(workspace_id:ID!):Workspace!`,
  },
  resolvers: { Query, Mutation, Workspace },
  extras: {
    "Query.workspaces": { description: "Workspaces the caller can access." },
  },
};
