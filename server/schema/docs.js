/**
 * Docs: block documents in a workspace. Reads need viewer access, content
 * edits editor, visibility and deletion owner (`server/access.js`).
 * `update_doc` takes `expected_version`; a stale version fails with
 * VERSION_CONFLICT and `extensions.version` (the current version).
 */
import { docAccess, requireCapability, requireDoc } from "../access.js";
import {
  badInput,
  lookupUser,
  memberRecords,
  notFound,
  parseJson,
  pick,
  read,
  readName,
  storeResult,
  viewerOf,
  wrapAll,
  write,
} from "./common.js";
import { requireTargetWorkspace } from "./workspaces.js";

const missing = (id) => () => notFound("Doc", id);

const Query = wrapAll(read, {
  docs(_p, args, ctx) {
    const viewer = viewerOf(ctx);
    const workspaceId = args.workspace_id ?? undefined;
    const docs = ctx.store.listDocs({ workspaceId });
    return pick(docs, args.ids).filter(
      (doc) => docAccess(ctx.store, viewer, doc) !== null,
    );
  },
});

/** Parses `blocks_json` (a JSON array; the store checks each block). */
function readBlocksJson(text) {
  if (text === undefined || text === null) return undefined;
  const blocks = parseJson(text, "blocks_json");
  return Array.isArray(blocks)
    ? blocks
    : badInput("blocks_json must be a JSON array of blocks");
}

const Mutation = wrapAll(write, {
  create_doc(_p, args, ctx) {
    const creator = requireCapability(ctx, "create_content");
    const workspace = requireTargetWorkspace(ctx, args.workspace_id ?? null);
    const result = ctx.store.createDoc({
      title: readName(args.title, "Doc title"),
      workspaceId: workspace.id,
      visibility: args.visibility,
      creatorId: creator.id,
    });
    return storeResult(result, () => notFound("workspace", workspace.id));
  },
  update_doc(_p, args, ctx) {
    const doc = requireDoc(ctx, args.doc_id, "editor");
    if (args.expected_version < 0) {
      badInput("expected_version must not be negative");
    }
    const changes = {
      expectedVersion: args.expected_version,
      title: args.title == null ? undefined : readName(args.title, "Doc title"),
      blocks: readBlocksJson(args.blocks_json),
    };
    const options = { actorId: viewerOf(ctx).id };
    const result = ctx.store.updateDoc(doc.id, changes, options);
    return storeResult(result, missing(doc.id));
  },
  set_doc_visibility(_p, args, ctx) {
    const doc = requireDoc(ctx, args.doc_id, "owner");
    const result = ctx.store.setDocVisibility(doc.id, args.visibility);
    return storeResult(result, missing(doc.id));
  },
  delete_doc(_p, args, ctx) {
    const doc = requireDoc(ctx, args.doc_id, "owner");
    return storeResult(ctx.store.deleteDoc(doc.id), missing(doc.id));
  },
});

const Doc = {
  workspace: (doc, _a, { store }) => store.getWorkspace(doc.workspace_id),
  members: (doc, _a, ctx) => memberRecords(ctx, "doc", doc),
  my_access: (doc, _a, ctx) => docAccess(ctx.store, viewerOf(ctx), doc),
  blocks_json: (doc) => JSON.stringify(doc.blocks),
  created_by: (doc, _a, ctx) => lookupUser(ctx, doc.created_by),
  updated_by: (doc, _a, ctx) => lookupUser(ctx, doc.updated_by),
  url: (doc) => `#/docs/${doc.id}`,
};

export const definition = {
  types: {
    Query: "docs(ids:[ID!],workspace_id:ID):[Doc!]!",
    Doc: `id:ID! title:String! workspace:Workspace! visibility:DocVisibility!
      members:[Member!]! my_access:AccessRole! blocks_json:String!
      version:Int! created_by:User updated_by:User created_at:String!
      updated_at:String! url:String!`,
    Mutation: `create_doc(title:String!,workspace_id:ID,visibility:DocVisibility="workspace"):Doc!
      update_doc(doc_id:ID!,expected_version:Int!,title:String,blocks_json:String):Doc!
      set_doc_visibility(doc_id:ID!,visibility:DocVisibility!):Doc!
      delete_doc(doc_id:ID!):Doc!`,
  },
  resolvers: { Query, Mutation, Doc },
  extras: {
    "Query.docs": { description: "Docs the caller can access." },
  },
};
