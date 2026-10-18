/**
 * GraphQL documents and the normalized record of the workspace pages
 * (`#/workspaces/<id>`, `#/workspaces/<id>/settings`). `workspaces` lists
 * only the workspaces the user can access, and each workspace's boards and
 * docs only the ones the user can open, so a workspace missing from the
 * list reads exactly like a deleted one.
 */

import { safeColor } from "../board/values.js";
import { normalizeMember } from "../components/share-model.js";

export const WORKSPACE_QUERY = `query WorkspacePage {
  workspaces {
    id name description kind color my_access can_manage can_delete
    members {
      kind id name role
      user { id name email initials color role status }
      team { id name member_count }
    }
    boards {
      id name description board_kind my_access items_count
      forms { id title access public_url response_count updated_at }
    }
    docs { id title visibility my_access updated_at updated_by { id name } }
  }
}`;

export const WORKSPACE_MUTATIONS = Object.freeze({
  update: `mutation UpdateWorkspace($id: ID!, $name: String, $description: String, $kind: WorkspaceKind, $color: String) {
  update_workspace(workspace_id: $id, name: $name, description: $description, kind: $kind, color: $color) { id }
}`,
  remove: `mutation DeleteWorkspace($id: ID!) {
  delete_workspace(workspace_id: $id) { id }
}`,
});

const byTitle = (key) => (a, b) =>
  a[key].localeCompare(b[key], undefined, { sensitivity: "base" });

/** The pages' copy of an API workspace. */
export function normalizeWorkspace(raw) {
  const boards = raw.boards
    .map((board) => ({ ...board, id: String(board.id) }))
    .sort(byTitle("name"));
  const forms = boards
    .flatMap((board) =>
      (board.forms ?? []).map((form) => ({
        ...form,
        id: String(form.id),
        board: { id: board.id, name: board.name, myAccess: board.my_access },
      })),
    )
    .sort(byTitle("title"));
  return {
    id: String(raw.id),
    name: raw.name,
    description: raw.description ?? "",
    kind: raw.kind === "closed" ? "closed" : "open",
    color: safeColor(raw.color, "#5b5bd6"),
    myAccess: raw.my_access,
    canManage: raw.can_manage === true,
    canDelete: raw.can_delete === true,
    members: (raw.members ?? []).map(normalizeMember),
    boards,
    docs: raw.docs
      .map((doc) => ({ ...doc, id: String(doc.id) }))
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))),
    forms,
  };
}

/**
 * Loads one workspace, or null when it is missing or not accessible.
 * @param {{ request(query: string, variables?: object): Promise<object> }} api
 * @param {string} workspaceId
 */
export async function loadWorkspace(api, workspaceId) {
  const data = await api.request(WORKSPACE_QUERY);
  const raw = data.workspaces.find(
    (workspace) => String(workspace.id) === workspaceId,
  );
  return raw ? normalizeWorkspace(raw) : null;
}

/**
 * Why the workspace can't be deleted, or null. The server's `can_delete`
 * decides (it also counts boards and docs the user can't open); the
 * visible ones only word the reason.
 */
export function deleteReason(workspace) {
  if (!workspace.canManage) return "Only workspace owners can delete it";
  if (workspace.canDelete) return null;
  const parts = [];
  if (workspace.boards.length > 0) {
    const n = workspace.boards.length;
    parts.push(`${n} ${n === 1 ? "board" : "boards"}`);
  }
  if (workspace.docs.length > 0) {
    const n = workspace.docs.length;
    parts.push(`${n} ${n === 1 ? "doc" : "docs"}`);
  }
  return parts.length > 0
    ? `Delete its ${parts.join(" and ")} first`
    : "It still holds boards or docs shared only with others";
}

/**
 * The changed settings between `workspace` and the form `values`
 * (`{ name, description, color, kind }`), as `update_workspace` variables
 * without the ID; empty when nothing changed.
 */
export function settingsChanges(workspace, values) {
  const changes = {};
  const name = values.name.trim();
  if (name !== workspace.name) changes.name = name;
  if (values.description !== workspace.description) {
    changes.description = values.description;
  }
  if (values.color.toLowerCase() !== workspace.color.toLowerCase()) {
    changes.color = values.color.toLowerCase();
  }
  if (values.kind !== workspace.kind) changes.kind = values.kind;
  return changes;
}
