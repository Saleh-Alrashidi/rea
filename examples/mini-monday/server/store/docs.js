/**
 * Docs (SPEC-2 §2): block documents in a workspace with `workspace` or
 * `private` visibility, members (grants) and an optimistic `version`.
 *
 * Content writes (`updateDoc`) take `expectedVersion`; a mismatch returns
 * `{ ok: false, reason: "version_conflict", version }` and changes nothing.
 * Blocks are validated here (types, ≤ 2,000 blocks, text ≤ 10,000) and get
 * IDs (`b<n>`, unique per doc) when they arrive without one.
 */
import { LIMITS, isPlainObject } from "../input.js";
import {
  BLOCK_TYPES,
  DOC_VISIBILITIES,
  byId,
  commit,
  failure,
  invalid,
  nextId,
  optional,
  push,
  readChoice,
  readName,
  removeWhere,
  replace,
  requireCount,
  withChanges,
} from "../store-state.js";
import { targetWorkspace } from "./workspaces.js";

const BLOCK_ID = /^[\w-]{1,64}$/;
const BLOCK_KEYS = new Set(["id", "type", "text", "checked"]);

function readBlock(raw, index) {
  const where = `Block ${index + 1}`;
  if (
    !isPlainObject(raw) ||
    !Object.keys(raw).every((key) => BLOCK_KEYS.has(key))
  ) {
    invalid(`${where} must be { id?, type, text, checked? }`);
  }
  const type = readChoice(raw.type, BLOCK_TYPES, `${where} type`);
  const text = raw.text ?? "";
  if (typeof text !== "string" || text.length > LIMITS.blockText) {
    invalid(
      `${where} text must be a string of at most ${LIMITS.blockText} characters`,
    );
  }
  if (raw.checked !== undefined && typeof raw.checked !== "boolean") {
    invalid(`${where} checked must be a boolean`);
  }
  if (
    raw.id !== undefined &&
    (typeof raw.id !== "string" || !BLOCK_ID.test(raw.id))
  ) {
    invalid(`${where} id must be 1-64 letters, digits, _ or -`);
  }
  const block = { id: raw.id, type, text: type === "divider" ? "" : text };
  return type === "todo" ? { ...block, checked: raw.checked ?? false } : block;
}

/**
 * Validates `blocks` and fills in missing IDs. Returns frozen-ready block
 * records `{ id, type, text, checked? }` (`checked` only on to-dos).
 */
export function readBlocks(blocks) {
  if (!Array.isArray(blocks)) invalid("blocks must be an array");
  if (blocks.length > LIMITS.blocks)
    invalid(`A doc holds at most ${LIMITS.blocks} blocks`);
  const parsed = blocks.map(readBlock);
  const taken = new Set();
  for (const block of parsed) {
    if (block.id === undefined) continue;
    if (taken.has(block.id))
      invalid(`Duplicate block id ${JSON.stringify(block.id)}`);
    taken.add(block.id);
  }
  let counter = 1;
  return parsed.map((block) => {
    if (block.id !== undefined) return block;
    while (taken.has(`b${counter}`)) counter += 1;
    const id = `b${counter}`;
    taken.add(id);
    return { ...block, id };
  });
}

export function insertDoc(ctx, fields) {
  const { state } = ctx;
  const at = ctx.now();
  const createdBy = fields.createdBy ?? null;
  return push(state.docs, {
    id: nextId(state),
    workspace_id: fields.workspaceId,
    title: fields.title,
    visibility: fields.visibility,
    members: fields.members,
    blocks: fields.blocks,
    version: 1,
    created_by: createdBy,
    updated_by: createdBy,
    created_at: at,
    updated_at: at,
  });
}

const docEvent = (type, doc) => ({
  type,
  resource_kind: "doc",
  resource_id: doc.id,
});

export function docApi(ctx) {
  const { state } = ctx;
  const save = (doc, next, type = "doc_updated") => {
    replace(state.docs, doc, next);
    return commit(ctx, docEvent(type, next), next);
  };
  return {
    /** All docs (optionally of one workspace), in creation order. */
    listDocs: ({ workspaceId } = {}) =>
      workspaceId === undefined
        ? [...state.docs]
        : state.docs.filter((d) => d.workspace_id === workspaceId),
    getDoc: (id) => byId(state.docs, id),
    /**
     * Creates a doc in `workspaceId` (null: the first workspace) owned by
     * `creatorId`. Unknown workspace or creator → null.
     */
    createDoc({
      title,
      workspaceId = null,
      visibility = "workspace",
      creatorId = null,
      blocks = [],
    } = {}) {
      const fields = {
        title: readName(title, "Doc title"),
        visibility: readChoice(visibility, DOC_VISIBILITIES, "visibility"),
        blocks: readBlocks(blocks),
      };
      const known = creatorId === null || byId(state.users, creatorId);
      const workspace = targetWorkspace(state, workspaceId);
      if (!known || !workspace) return null;
      const members =
        creatorId === null
          ? []
          : [{ kind: "user", id: creatorId, role: "owner" }];
      const doc = insertDoc(ctx, {
        ...fields,
        workspaceId: workspace.id,
        members,
        createdBy: creatorId,
      });
      return commit(ctx, docEvent("doc_created", doc), doc);
    },
    /** Replaces the title and/or blocks when `expectedVersion` matches. */
    updateDoc(
      id,
      { expectedVersion, title, blocks } = {},
      { actorId = null } = {},
    ) {
      const doc = byId(state.docs, id);
      if (!doc) return null;
      requireCount(expectedVersion, "expectedVersion", 0);
      const changes = {
        title: optional(title, (v) => readName(v, "Doc title")),
        blocks: optional(blocks, readBlocks),
      };
      if (expectedVersion !== doc.version) {
        return failure("version_conflict", { version: doc.version });
      }
      const next = withChanges(doc, changes);
      const stamp = {
        version: doc.version + 1,
        updated_by: actorId,
        updated_at: ctx.now(),
      };
      return save(doc, { ...next, ...stamp });
    },
    /** Visibility is not content: no version bump. */
    setDocVisibility(id, visibility) {
      const doc = byId(state.docs, id);
      if (!doc) return null;
      const value = readChoice(visibility, DOC_VISIBILITIES, "visibility");
      return save(doc, { ...doc, visibility: value });
    },
    deleteDoc(id) {
      const doc = byId(state.docs, id);
      if (!doc) return null;
      removeWhere(state.docs, (record) => record === doc);
      return commit(ctx, docEvent("doc_deleted", doc), doc);
    },
  };
}
