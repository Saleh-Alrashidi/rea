/**
 * Moving things in the sidebar (SPEC-6 §3.3), pure: what a drop, a
 * "Move up/down" or "Move to…" does, and the way back for Undo.
 *
 * A move is `{ node, place }`: `place` names the target container and
 * at most one neighbor of the node's kind there, as the server's move
 * mutations take them (the server computes positions):
 * - a board or doc: `{ spaceId, folderId (null: the Space's root),
 *   afterId?, beforeId? }` (`move_board` / `move_doc`);
 * - a folder: `{ spaceId, afterId?, beforeId? }` within its own Space
 *   (`move_folder`);
 * - a Space: `{ afterId?, beforeId? }` (`move_workspace`, admins).
 *
 * `resolveDrop` turns the row under the pointer and its band
 * (`zoneAt`) into `{ ok, move?, reason?, indicator }`. The indicator is
 * what the tree paints: `{ key, type }` with `type` "before" / "after"
 * (a line at the edge of that node, its open children included) or
 * "inside" (the container is highlighted). Refusals (`ok: false`) keep
 * the indicator, painted red with the not-allowed cursor: `no-op` (the
 * node would stay where it is), `other-space` (folders stay in their
 * Space) and `no-edit` (the user cannot edit the target Space). Whether
 * a board may leave its Space (its owner, and editor there) is the
 * server's decision: the drop goes through and a refusal shows its error.
 */

import { hasRole } from "../components/permissions.js";
import { findNode, neighborOf, siblingsOf } from "./sidebar-model.js";

const MOVABLE = new Set(["space", "folder", "board", "doc"]);

/**
 * Which band of a target row (`offset` px from its top, `height` tall)
 * the pointer is in while dragging a `dragKind` node: "before", "after"
 * or "inside" (a container takes boards and docs anywhere on its row,
 * and a Space takes folders).
 */
export function zoneAt({ dragKind, targetKind, offset, height }) {
  const half = offset < height / 2 ? "before" : "after";
  if (dragKind === "space") return half;
  if (dragKind === "folder") {
    if (targetKind === "folder") return half;
    return targetKind === "space" ? "inside" : "after";
  }
  return targetKind === "space" || targetKind === "folder" ? "inside" : half;
}

/**
 * Whether the user `me` (with `is_admin`) may drag `node`: Spaces for
 * admins, folders for the Space's editors, boards and docs for the
 * Space's editors and their owners (who may move them to another Space).
 */
export function canDrag(spaces, node, me) {
  if (!MOVABLE.has(node?.kind)) return false;
  if (node.kind === "space") return me?.is_admin === true;
  const space = spaces.find((each) => each.id === node.spaceId);
  if (hasRole(space?.record.my_access, "editor")) return true;
  return node.kind !== "folder" && node.record.my_access === "owner";
}

/** The container part of `node`'s place (its current one). */
export function containerPlace(node) {
  if (node.kind === "space") return {};
  if (node.kind === "folder") return { spaceId: node.spaceId };
  return { spaceId: node.spaceId, folderId: node.folderId ?? null };
}

/** Whether `place` leaves `node` where it is (or names it as a neighbor). */
function samePlace(spaces, node, place) {
  if (place.afterId === node.id || place.beforeId === node.id) return true;
  const here = containerPlace(node);
  if ((here.spaceId ?? null) !== (place.spaceId ?? null)) return false;
  if ((here.folderId ?? null) !== (place.folderId ?? null)) return false;
  const siblings = siblingsOf(spaces, node);
  const index = siblings.findIndex((each) => each.key === node.key);
  if (place.afterId) return siblings[index - 1]?.id === place.afterId;
  if (place.beforeId) return siblings[index + 1]?.id === place.beforeId;
  return true;
}

/** The neighbor that puts `node` last among `siblings`. */
function endOf(siblings, node) {
  const others = siblings.filter((each) => each.key !== node.key);
  return others.length > 0 ? { afterId: others.at(-1).id } : {};
}

const refusal = (reason, indicator) => ({ ok: false, reason, indicator });

/** Checks a resolved `place` and builds the result. */
function finish(spaces, { node, place, indicator }) {
  if (samePlace(spaces, node, place)) return refusal("no-op", indicator);
  return { ok: true, move: { node, place }, indicator };
}

/** A board or doc dropped on `target` (any row). */
function contentDrop(spaces, { dragged, target, zone }) {
  let container = { spaceId: target.spaceId, folderId: target.folderId };
  if (target.kind === "space")
    container = { spaceId: target.id, folderId: null };
  if (target.kind === "folder") {
    container = { spaceId: target.spaceId, folderId: target.id };
  }
  const space = spaces.find((each) => each.id === container.spaceId);
  const holder =
    container.folderId === null
      ? space
      : space.children.find((child) => child.id === container.folderId);
  if (target.kind === dragged.kind && zone !== "inside") {
    const place = { ...container };
    place[zone === "before" ? "beforeId" : "afterId"] = target.id;
    const indicator = { key: target.key, type: zone };
    if (!hasRole(space.record.my_access, "editor")) {
      return refusal("no-edit", indicator);
    }
    return finish(spaces, { node: dragged, place, indicator });
  }
  const siblings = holder.children.filter((c) => c.kind === dragged.kind);
  const place = { ...container, ...endOf(siblings, dragged) };
  const indicator = { key: holder.key, type: "inside" };
  if (!hasRole(space.record.my_access, "editor")) {
    return refusal("no-edit", indicator);
  }
  return finish(spaces, { node: dragged, place, indicator });
}

/** A folder dropped on `target`: it stays in its own Space. */
function folderDrop(spaces, { dragged, target, zone }) {
  const spaceId = target.kind === "space" ? target.id : target.spaceId;
  const space = spaces.find((each) => each.id === spaceId);
  if (spaceId !== dragged.spaceId) {
    const indicator =
      target.kind === "space" || target.kind === "folder"
        ? { key: target.key, type: target.kind === "space" ? "inside" : zone }
        : { key: space.key, type: "inside" };
    return refusal("other-space", indicator);
  }
  if (target.kind === "folder" && zone !== "inside") {
    const place = { spaceId };
    place[zone === "before" ? "beforeId" : "afterId"] = target.id;
    const indicator = { key: target.key, type: zone };
    return finish(spaces, { node: dragged, place, indicator });
  }
  if (target.kind !== "space" && target.folderId) {
    const place = { spaceId, afterId: target.folderId };
    const indicator = { key: `folder:${target.folderId}`, type: "after" };
    return finish(spaces, { node: dragged, place, indicator });
  }
  const folders = space.children.filter((child) => child.kind === "folder");
  const place = { spaceId, ...endOf(folders, dragged) };
  const last = folders.filter((each) => each.key !== dragged.key).at(-1);
  const indicator = last
    ? { key: last.key, type: "after" }
    : { key: space.key, type: "inside" };
  return finish(spaces, { node: dragged, place, indicator });
}

/** A Space dropped on `target`: before or after the Space it is in. */
function spaceDrop(spaces, { dragged, target, zone }) {
  const space =
    target.kind === "space"
      ? target
      : spaces.find((each) => each.id === target.spaceId);
  const edge = target.kind === "space" ? zone : "after";
  const place =
    edge === "before" ? { beforeId: space.id } : { afterId: space.id };
  const indicator = { key: space.key, type: edge };
  return finish(spaces, { node: dragged, place, indicator });
}

const RESOLVERS = Object.freeze({
  board: contentDrop,
  doc: contentDrop,
  folder: folderDrop,
  space: spaceDrop,
});

/**
 * What dropping the node `dragKey` on row `targetKey` in band `zone`
 * does (see the module comment), or null when either is unknown.
 */
export function resolveDrop(spaces, { dragKey, targetKey, zone }) {
  const dragged = findNode(spaces, dragKey);
  const target = findNode(spaces, targetKey);
  const resolve = dragged && RESOLVERS[dragged.kind];
  if (!resolve || !target) return null;
  if (dragged.key === target.key) {
    return refusal("no-op", { key: target.key, type: zone });
  }
  return resolve(spaces, { dragged, target, zone });
}

/**
 * Moving `key` one place up or down among its siblings (the "…" menu's
 * Move up / Move down), or null at the end of its container.
 */
export function stepMove(spaces, key, direction) {
  const node = findNode(spaces, key);
  if (!node || !MOVABLE.has(node.kind)) return null;
  const siblings = siblingsOf(spaces, node);
  const index = siblings.findIndex((each) => each.key === key);
  const up = direction === "up";
  const neighbor = siblings[index + (up ? -1 : 1)];
  if (!neighbor) return null;
  const place = { ...containerPlace(node) };
  place[up ? "beforeId" : "afterId"] = neighbor.id;
  return { node, place };
}

/** Moving a board or doc `node` to the end of another container. */
export function moveInto(spaces, node, { spaceId, folderId = null }) {
  const space = spaces.find((each) => each.id === spaceId);
  const holder =
    folderId === null
      ? space
      : space?.children.find((child) => child.id === folderId);
  if (!holder) return null;
  const siblings = holder.children.filter((c) => c.kind === node.kind);
  return { node, place: { spaceId, folderId, ...endOf(siblings, node) } };
}

/**
 * The move that puts `node` back where it is now (recorded before a
 * move, for Undo): its container and the sibling before (or after) it.
 */
export function wayBack(spaces, node) {
  return {
    node,
    place: { ...containerPlace(node), ...neighborOf(spaces, node) },
  };
}

/** The GraphQL variables of `move` (see `sidebar-data.js`). */
export function moveVariables({ node, place }) {
  const neighbors = {
    afterId: place.afterId ?? null,
    beforeId: place.beforeId ?? null,
  };
  if (node.kind === "space" || node.kind === "folder") {
    return { id: node.id, ...neighbors };
  }
  const folderId = place.folderId ?? null;
  return {
    id: node.id,
    workspaceId: place.spaceId,
    folderId,
    toRoot: folderId === null,
    ...neighbors,
  };
}
