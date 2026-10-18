/**
 * Creation flows shared by the sidebar "+ Add" menu, the command palette,
 * the Home quick-create tiles and the workspace page: a short dialog, the
 * mutation, a shell refresh and navigation to the new record.
 *
 * Each flow loads the workspaces and boards the user may create in at the
 * moment it opens, so the choices are never stale, and resolves with the
 * new record's ID (or null when cancelled or failed).
 *
 * ```js
 * const flows = createFlows(ctx);
 * await flows.board({ workspaceId });
 * await flows.note();
 * ```
 */

import { request } from "../../api.js";
import {
  boardHash,
  docHash,
  formHash,
  noteHash,
  workspaceHash,
} from "../../router.js";
import { mutate } from "../board/board-data.js";
import {
  BOARD_KINDS,
  DOC_VISIBILITIES,
  WORKSPACE_KINDS,
} from "../components/labels.js";
import { canCreateIn, hasRole } from "../components/permissions.js";
import { BUS_EVENTS } from "./bus.js";

export const CREATE_TARGETS_QUERY = `query CreateTargets {
  workspaces { id name my_access boards { id name my_access } }
}`;

export const CREATE_MUTATIONS = Object.freeze({
  doc: `mutation CreateDoc($title: String!, $workspaceId: ID, $visibility: DocVisibility) {
  create_doc(title: $title, workspace_id: $workspaceId, visibility: $visibility) { id }
}`,
  note: `mutation CreateNote($title: String!) {
  create_note(title: $title) { id }
}`,
  form: `mutation CreateForm($boardId: ID!, $title: String!) {
  create_form(board_id: $boardId, title: $title) { id }
}`,
  workspace: `mutation CreateWorkspace($name: String!, $kind: WorkspaceKind, $description: String) {
  create_workspace(name: $name, kind: $kind, description: $description) { id }
}`,
});

const NEW_NOTE_TITLE = "Untitled note";

const choices = (table) =>
  Object.entries(table).map(([value, info]) => ({
    value,
    label: info.label,
    description: info.description,
    icon: info.icon,
  }));

async function editableWorkspaces(ctx) {
  const data = await request(CREATE_TARGETS_QUERY);
  return data.workspaces
    .map((workspace) => ({ ...workspace, id: String(workspace.id) }))
    .filter((workspace) => canCreateIn(ctx.me, workspace).ok);
}

function workspaceField(workspaces, workspaceId) {
  const preferred = workspaces.some(
    (entry) => entry.id === String(workspaceId),
  );
  return {
    name: "workspaceId",
    label: "Workspace",
    type: "select",
    value: preferred ? String(workspaceId) : workspaces[0].id,
    options: workspaces.map((entry) => ({
      value: entry.id,
      label: entry.name,
    })),
  };
}

/** Runs `work()`, shows failures as a toast and resolves with its ID or null. */
async function attempt(ctx, work, failure) {
  try {
    const record = await work();
    return record?.id ? String(record.id) : null;
  } catch (error) {
    ctx.toast.error(error, failure);
    return null;
  }
}

function noTarget(ctx, what) {
  ctx.toast.info(`There’s no workspace where you can create a ${what}.`);
  return null;
}

async function createBoard(ctx, { workspaceId } = {}) {
  const workspaces = await editableWorkspaces(ctx);
  if (workspaces.length === 0) return noTarget(ctx, "board");
  const values = await ctx.dialog.form({
    title: "New board",
    submitLabel: "Create board",
    fields: [
      { name: "name", label: "Board name", required: true, autofocus: true },
      workspaceField(workspaces, workspaceId),
      {
        name: "kind",
        label: "Who can see it",
        type: "choice",
        value: "public",
        options: choices(BOARD_KINDS),
      },
    ],
  });
  if (!values?.name) return null;
  const id = await attempt(
    ctx,
    () =>
      mutate("createBoard", {
        name: values.name,
        workspaceId: values.workspaceId,
        kind: values.kind,
      }),
    "Couldn’t create the board",
  );
  return finish(ctx, {
    id,
    hash: id && boardHash(id),
    workspaceId: values.workspaceId,
  });
}

async function createDoc(ctx, { workspaceId } = {}) {
  const workspaces = await editableWorkspaces(ctx);
  if (workspaces.length === 0) return noTarget(ctx, "doc");
  const values = await ctx.dialog.form({
    title: "New doc",
    submitLabel: "Create doc",
    fields: [
      { name: "title", label: "Title", required: true, autofocus: true },
      workspaceField(workspaces, workspaceId),
      {
        name: "visibility",
        label: "Who can read it",
        type: "choice",
        value: "workspace",
        options: choices(DOC_VISIBILITIES),
      },
    ],
  });
  if (!values?.title) return null;
  const id = await attempt(
    ctx,
    async () => (await request(CREATE_MUTATIONS.doc, values)).create_doc,
    "Couldn’t create the doc",
  );
  return finish(ctx, {
    id,
    hash: id && docHash(id),
    workspaceId: values.workspaceId,
  });
}

async function createNote(ctx) {
  const id = await attempt(
    ctx,
    async () =>
      (await request(CREATE_MUTATIONS.note, { title: NEW_NOTE_TITLE }))
        .create_note,
    "Couldn’t create the note",
  );
  if (id) ctx.router.navigate(noteHash(id));
  return id;
}

async function createForm(ctx, { boardId } = {}) {
  const workspaces = await editableWorkspaces(ctx);
  const boards = workspaces.flatMap((workspace) =>
    workspace.boards
      .filter((board) => hasRole(board.my_access, "editor"))
      .map((board) => ({
        value: String(board.id),
        label: `${board.name} · ${workspace.name}`,
      })),
  );
  if (boards.length === 0)
    return noTarget(ctx, "form (you need a board you can edit)");
  const values = await ctx.dialog.form({
    title: "New form",
    submitLabel: "Create form",
    fields: [
      { name: "title", label: "Form title", required: true, autofocus: true },
      {
        name: "boardId",
        label: "Responses go to board",
        type: "select",
        value: boards.some((board) => board.value === String(boardId))
          ? String(boardId)
          : boards[0].value,
        options: boards,
        hint: "Each response creates an item on this board.",
      },
    ],
  });
  if (!values?.title) return null;
  const id = await attempt(
    ctx,
    async () => (await request(CREATE_MUTATIONS.form, values)).create_form,
    "Couldn’t create the form",
  );
  return finish(ctx, { id, hash: id && formHash(id) });
}

async function createWorkspace(ctx) {
  const values = await ctx.dialog.form({
    title: "New workspace",
    submitLabel: "Create workspace",
    fields: [
      {
        name: "name",
        label: "Workspace name",
        required: true,
        autofocus: true,
      },
      {
        name: "description",
        label: "Description (optional)",
        type: "textarea",
        maxLength: 2000,
      },
      {
        name: "kind",
        label: "Who can join",
        type: "choice",
        value: "open",
        options: choices(WORKSPACE_KINDS),
      },
    ],
  });
  if (!values?.name) return null;
  const variables = { ...values, description: values.description || null };
  const id = await attempt(
    ctx,
    async () =>
      (await request(CREATE_MUTATIONS.workspace, variables)).create_workspace,
    "Couldn’t create the workspace",
  );
  return finish(ctx, { id, hash: id && workspaceHash(id), workspaceId: id });
}

async function finish(ctx, { id, hash, workspaceId }) {
  if (!id) return null;
  await ctx.refreshShell();
  if (workspaceId) ctx.bus.emit(BUS_EVENTS.workspace, String(workspaceId));
  ctx.router.navigate(hash);
  return id;
}

/**
 * The creation flows bound to `ctx`.
 * @param {object} ctx the page context (see `main.js`)
 */
export function createFlows(ctx) {
  const guarded = (flow) => async (options) => {
    try {
      return await flow(ctx, options);
    } catch (error) {
      ctx.toast.error(error, "Something went wrong");
      return null;
    }
  };
  return {
    board: guarded(createBoard),
    doc: guarded(createDoc),
    note: guarded(createNote),
    form: guarded(createForm),
    workspace: guarded(createWorkspace),
  };
}
