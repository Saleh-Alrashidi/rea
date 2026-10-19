/**
 * The sidebar (SPEC-6 §3.1, §3.2): where boards and docs sit (a Space,
 * and optionally one of its folders, `folder_id`) and the manual order
 * of Spaces (workspaces), folders, boards and docs (`position`, the
 * sidebar order of `positions.js`).
 *
 * Containers: Spaces form one list; folders are ordered within their
 * Space; boards and docs within their Space's root or their folder, each
 * kind on its own (`inContainer`). New records go to the end of their
 * container (`positionIn`). `assignSidebarPositions` renumbers every
 * container in its current order (the /6 → /7 upgrade and the seed).
 *
 * Moves (`moveBoard`, `moveDoc`, `moveWorkspace`; folders move in
 * `folders.js`) land right after `afterId` and/or right before
 * `beforeId`, records of the target container (`readPosition`): the
 * midpoint of the two, or the container is renumbered first. Without
 * neighbors a record keeps its place, or goes to the end of a new
 * container. A board or doc moves to `folderId` (a folder of the target
 * Space), to its Space's root (`toRoot`) or to another Space
 * (`workspaceId`: its root unless a folder of it is named);
 * `moveTarget` says where a move goes, so callers can check access
 * first. A board that changes Space takes its forms along (a form sits
 * with its board). Refusals change nothing: `not_found` (an unknown folder or Space, a neighbor
 * that is not in the target container), `invalid_folder` (a folder of
 * another Space than `workspaceId`) and `invalid_neighbor` (the record
 * itself, or `afterId` not before `beforeId`).
 *
 * Events: `board_moved` (`board_id`), `doc_moved` and `workspace_moved`
 * (`resource_kind`, `resource_id`), each with the new `workspace_id`,
 * `folder_id` and `position`; a board or doc that changed Space adds
 * `from_workspace_id`. A move that changes nothing emits nothing.
 */
import { describe, inSentence, isPlainObject } from "../input.js";
import {
  byId,
  commit,
  failure,
  invalid,
  readBoolean,
  replace,
} from "../store-state.js";
import {
  inSidebarOrder,
  positionAfter,
  renumber,
  sidebarSlot,
} from "./positions.js";

/** The records of `list` at `{ workspaceId, folderId }` (null: the root). */
export const inContainer = (list, { workspaceId, folderId = null }) =>
  list.filter(
    (record) =>
      record.workspace_id === workspaceId &&
      (record.folder_id ?? null) === folderId,
  );

/** The position of a new record of `list` in a container (`inContainer`). */
export const positionIn = (list, container) =>
  positionAfter(inContainer(list, container));

/**
 * Gives every container its positions (POSITION_SPACING apart) in its
 * current sidebar order (position, then ID).
 */
export function assignSidebarPositions(state) {
  const place = (record) =>
    `${record.workspace_id}\u0000${record.folder_id ?? ""}`;
  const lists = [
    [state.workspaces, () => ""],
    [state.folders, (folder) => folder.workspace_id],
    [state.boards, place],
    [state.docs, place],
  ];
  for (const [list, containerOf] of lists) {
    for (const records of Map.groupBy(list, containerOf).values()) {
      renumber(list, inSidebarOrder(records));
    }
  }
}

const optionalId = (value, label) => {
  if (value === null || typeof value === "string") return value;
  throw new TypeError(`${label} must be an ID string or null`);
};

/** A move request with its defaults; wrong types throw a TypeError. */
export function readMove(request) {
  if (!isPlainObject(request)) throw new TypeError("move must be an object");
  const {
    workspaceId = null,
    folderId = null,
    toRoot = false,
    afterId = null,
    beforeId = null,
  } = request;
  const move = {
    workspaceId: optionalId(workspaceId, "workspaceId"),
    folderId: optionalId(folderId, "folderId"),
    toRoot: readBoolean(toRoot, "toRoot"),
    afterId: optionalId(afterId, "afterId"),
    beforeId: optionalId(beforeId, "beforeId"),
  };
  if (move.toRoot && move.folderId !== null) {
    invalid("Give a folder or move to the Space's root, not both");
  }
  return move;
}

/** A neighbor among `siblings`: null (none), the sibling, or a failure. */
function readNeighbor({ record, siblings, id, label }) {
  if (id === null) return null;
  if (id === record.id) {
    const message = `A ${inSentence(label)} cannot be placed next to itself`;
    return failure("invalid_neighbor", { message });
  }
  const sibling = siblings.find((each) => each.id === id);
  if (sibling) return sibling;
  const message = `${label} ${describe(id)} is not in that place`;
  return failure("not_found", { message });
}

/**
 * The position `record` takes among `siblings` (the other records of its
 * target container) for `move`: `{ position, order }` (`order`: the
 * siblings to renumber first, or null) or a failure. Without neighbors it
 * keeps its position when it `stays` in its container, else it goes last.
 */
export function readPosition({ record, siblings, move, label, stays }) {
  const neighbor = (id) => readNeighbor({ record, siblings, id, label });
  const after = neighbor(move.afterId);
  if (after?.ok === false) return after;
  const before = neighbor(move.beforeId);
  if (before?.ok === false) return before;
  if (after || before) return sidebarSlot(siblings, { after, before });
  const position = stays ? record.position : positionAfter(siblings);
  return { position, order: null };
}

/** Writes `next` (the moved `record`) into `list`, renumbering first. */
export function writePlace(list, { record, next, order }) {
  if (order) renumber(list, order);
  return replace(list, record, next);
}

/** `record` with `fields` where an undefined `folder_id`/`position` is absent. */
function placed(record, { workspaceId, folderId, position }) {
  const { folder_id: _folder, position: _position, ...rest } = record;
  return {
    ...rest,
    workspace_id: workspaceId,
    ...(folderId === null ? {} : { folder_id: folderId }),
    ...(position === undefined ? {} : { position }),
  };
}

/**
 * Where a board or doc move goes: `{ workspace, folderId }` (null: the
 * Space's root) or a failure.
 */
function readTarget(state, record, move) {
  const { folderId } = move;
  const folder = folderId === null ? null : byId(state.folders, folderId);
  if (folderId !== null && !folder) {
    const message = `Folder ${describe(folderId)} was not found`;
    return failure("not_found", { message });
  }
  const workspaceId =
    move.workspaceId ?? folder?.workspace_id ?? record.workspace_id;
  const workspace = byId(state.workspaces, workspaceId);
  if (!workspace) {
    const message = `Space ${describe(workspaceId)} was not found`;
    return failure("not_found", { message });
  }
  if (folder && folder.workspace_id !== workspace.id) {
    const message = "The folder is not in that Space";
    return failure("invalid_folder", { message });
  }
  const same = workspace.id === record.workspace_id && !move.toRoot;
  const kept = same ? (record.folder_id ?? null) : null;
  return { workspace, folderId: folder?.id ?? kept };
}

const KINDS = Object.freeze({
  board: { list: "boards", label: "Board" },
  doc: { list: "docs", label: "Doc" },
});

function kindOf(kind) {
  if (!Object.hasOwn(KINDS, kind)) throw new TypeError(`Unknown kind ${kind}`);
  return KINDS[kind];
}

/**
 * The event of a moved board or doc (`kind`), now `record` and before
 * `from`: `board_moved` names its board, `doc_moved` its resource; both
 * carry the new place, and `from_workspace_id` when the Space changed (so
 * the event hub also reaches who could open it there).
 */
export function moveEvent(kind, record, from = record) {
  const where = {
    workspace_id: record.workspace_id,
    folder_id: record.folder_id ?? null,
    position: record.position ?? null,
    ...(from.workspace_id === record.workspace_id
      ? {}
      : { from_workspace_id: from.workspace_id }),
  };
  if (kind === "board") {
    return { type: "board_moved", board_id: record.id, ...where };
  }
  const resource = { resource_kind: kind, resource_id: record.id };
  return { type: `${kind}_moved`, ...resource, ...where };
}

function moveContent(ctx, { kind, id, request }) {
  const { state } = ctx;
  const { list: name, label } = kindOf(kind);
  const list = state[name];
  const record = byId(list, id);
  if (!record) return null;
  const move = readMove(request);
  const target = readTarget(state, record, move);
  if (target.ok === false) return target;
  const workspaceId = target.workspace.id;
  const { folderId } = target;
  const crosses = workspaceId !== record.workspace_id;
  const stays = !crosses && folderId === (record.folder_id ?? null);
  const others = list.filter((each) => each !== record);
  const siblings = inContainer(others, { workspaceId, folderId });
  const slot = readPosition({ record, siblings, move, label, stays });
  if (slot.ok === false) return slot;
  if (stays && slot.position === record.position) return record;
  const { position, order } = slot;
  const next = placed(record, { workspaceId, folderId, position });
  writePlace(list, { record, next, order });
  return commit(ctx, moveEvent(kind, next, record), next);
}

function moveWorkspace(ctx, id, request) {
  const { state } = ctx;
  const record = byId(state.workspaces, id);
  if (!record) return null;
  const move = readMove(request);
  const siblings = state.workspaces.filter((each) => each !== record);
  const label = "Space";
  const slot = readPosition({ record, siblings, move, label, stays: true });
  if (slot.ok === false) return slot;
  if (slot.position === record.position) return record;
  const next = { ...record, position: slot.position };
  writePlace(state.workspaces, { record, next, order: slot.order });
  const event = {
    type: "workspace_moved",
    resource_kind: "workspace",
    resource_id: id,
    position: next.position,
  };
  return commit(ctx, event, next);
}

export function sidebarApi(ctx) {
  const { state } = ctx;
  return {
    /**
     * Where moving the board or doc (`kind`) `id` with `request` (see
     * `moveBoard`) would put it: `{ workspace, folderId }`, a failure,
     * or null for an unknown record. Changes nothing.
     */
    moveTarget(kind, id, request = {}) {
      const record = byId(state[kindOf(kind).list], id);
      return record && readTarget(state, record, readMove(request));
    },
    /**
     * Moves board `id` (see the module comment): `request` is `{
     * workspaceId, folderId, toRoot, afterId, beforeId }`, all optional.
     */
    moveBoard: (id, request = {}) =>
      moveContent(ctx, { kind: "board", id, request }),
    /** Moves doc `id`, like `moveBoard`. */
    moveDoc: (id, request = {}) =>
      moveContent(ctx, { kind: "doc", id, request }),
    /** Reorders Space `id` among all Spaces (`{ afterId, beforeId }`). */
    moveWorkspace: (id, request = {}) => moveWorkspace(ctx, id, request),
  };
}
