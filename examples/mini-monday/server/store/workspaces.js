/**
 * Workspaces (SPEC-2 §2): containers of boards, docs and forms. `open`
 * workspaces give every non-guest active user implicit access, `closed`
 * ones only their members (see `server/access.js`). The creator becomes
 * the first owner; members are managed through `store.share`/`unshare`.
 * A workspace can be deleted only when it holds no boards or docs.
 */
import {
  WORKSPACE_KINDS,
  byId,
  commit,
  failure,
  nextId,
  optional,
  push,
  readChoice,
  readColor,
  readName,
  readText,
  removeWhere,
  replace,
  withChanges,
} from "../store-state.js";
import { PALETTE } from "./people.js";

/**
 * The workspace new boards and docs go to: `workspaceId`, or the first
 * workspace when it is null. Unknown IDs → null.
 */
export function targetWorkspace(state, workspaceId) {
  if (workspaceId === null) return state.workspaces[0] ?? null;
  return byId(state.workspaces, workspaceId);
}

export function insertWorkspace(ctx, fields) {
  const { state } = ctx;
  const { name, description, kind, members, createdBy } = fields;
  const color =
    fields.color ?? PALETTE[state.workspaces.length % PALETTE.length];
  return push(state.workspaces, {
    id: nextId(state),
    name,
    description: description ?? null,
    kind,
    color,
    members,
    created_by: createdBy ?? null,
    created_at: ctx.now(),
  });
}

export function workspaceApi(ctx) {
  const { state } = ctx;
  const event = (type, workspace) => ({
    type,
    resource_kind: "workspace",
    resource_id: workspace.id,
  });
  return {
    listWorkspaces: () => [...state.workspaces],
    getWorkspace: (id) => byId(state.workspaces, id),
    /** Where boards and docs go without a workspace: the first workspace. */
    getDefaultWorkspace: () => targetWorkspace(state, null),
    /** Creates a workspace owned by `creatorId`; unknown creator → null. */
    createWorkspace({
      name,
      description = null,
      kind = "open",
      color,
      creatorId = null,
    } = {}) {
      const fields = {
        name: readName(name, "Workspace name"),
        description: readText(description, "Description"),
        kind: readChoice(kind, WORKSPACE_KINDS, "kind"),
        color: optional(color, (v) => readColor(v, "color")),
      };
      if (creatorId !== null && !byId(state.users, creatorId)) return null;
      const members =
        creatorId === null
          ? []
          : [{ kind: "user", id: creatorId, role: "owner" }];
      const workspace = insertWorkspace(ctx, {
        ...fields,
        members,
        createdBy: creatorId,
      });
      return commit(ctx, event("workspace_created", workspace), workspace);
    },
    updateWorkspace(id, { name, description, kind, color } = {}) {
      const workspace = byId(state.workspaces, id);
      if (!workspace) return null;
      const next = withChanges(workspace, {
        name: optional(name, (v) => readName(v, "Workspace name")),
        description: optional(description, (v) => readText(v, "Description")),
        kind: optional(kind, (v) => readChoice(v, WORKSPACE_KINDS, "kind")),
        color: optional(color, (v) => readColor(v, "color")),
      });
      replace(state.workspaces, workspace, next);
      return commit(ctx, event("workspace_updated", next), next);
    },
    /** Deletes an empty workspace; with boards or docs → `not_empty`. */
    deleteWorkspace(id) {
      const workspace = byId(state.workspaces, id);
      if (!workspace) return null;
      const holds = (r) => r.workspace_id === id;
      if (state.boards.some(holds) || state.docs.some(holds)) {
        return failure("not_empty", {
          message: "Move or delete its boards and docs first",
        });
      }
      removeWhere(state.workspaces, (record) => record === workspace);
      return commit(ctx, event("workspace_deleted", workspace), workspace);
    },
  };
}
