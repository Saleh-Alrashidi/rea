/**
 * The sidebar's Spaces tree (SPEC-6 §3.3), pure. Spaces are Worklane
 * workspaces; the shell data (`shell-data.js`) lists them, their folders,
 * boards, docs and forms in the server's sidebar order (position, then
 * ID), which the tree keeps: the client never computes positions.
 *
 * Nodes are `{ key, kind, id, name, record, children? }` with `key`
 * "<kind>:<id>"; a folder and every content node also carry `spaceId`,
 * content nodes `folderId` (null at the Space's root). A Space holds its
 * folders, then its folderless boards (Lists), docs and forms; a folder
 * its boards, docs and forms. Each kind is ordered on its own.
 *
 * `visibleRows` flattens the tree as the sidebar shows it: a Space is
 * expanded unless the user collapsed it, a folder collapsed unless the
 * user expanded it (`isExpanded`), and children of collapsed nodes are
 * left out.
 */

import { ITEM_VIEWS } from "../board/board-views.js";

/** The kinds of content nodes, in the order a container lists them. */
const CONTENT_KINDS = Object.freeze(["board", "doc", "form"]);
const KEY_PATTERN = /^(space|folder|board|doc|form):(\d{1,20})$/;

/** The key of a node of `kind` with `id`. */
const nodeKey = (kind, id) => `${kind}:${id}`;

/** `{ kind, id }` of a node key, or null when it is not one. */
export function parseKey(key) {
  const match = typeof key === "string" ? KEY_PATTERN.exec(key) : null;
  return match ? { kind: match[1], id: match[2] } : null;
}

const boardIcon = (board) => ITEM_VIEWS[board.defaultView]?.icon ?? "board";

function contentNode(kind, record, { spaceId, folderId }) {
  const base = { kind, id: record.id, key: nodeKey(kind, record.id) };
  const place = { spaceId, folderId, record };
  if (kind === "board") {
    return { ...base, ...place, name: record.name, icon: boardIcon(record) };
  }
  if (kind === "doc") {
    const icon = record.visibility === "private" ? "lock" : "docs";
    return { ...base, ...place, name: record.title, icon };
  }
  return { ...base, ...place, name: record.title, icon: "forms" };
}

const LISTS = Object.freeze({ board: "boards", doc: "docs", form: "forms" });

/** The content of `workspace` in `folderId` (null: its root), by kind. */
function contentIn(workspace, folderId) {
  const place = { spaceId: workspace.id, folderId };
  return CONTENT_KINDS.flatMap((kind) =>
    (workspace[LISTS[kind]] ?? [])
      .filter((record) => (record.folderId ?? null) === folderId)
      .map((record) => contentNode(kind, record, place)),
  );
}

function folderNode(workspace, folder) {
  return {
    kind: "folder",
    id: folder.id,
    key: nodeKey("folder", folder.id),
    name: folder.name,
    color: folder.color,
    spaceId: workspace.id,
    record: folder,
    children: contentIn(workspace, folder.id),
  };
}

/**
 * The Spaces tree of the shell's `workspaces` (in their order). Content
 * whose folder is not listed sits at its Space's root, so nothing the
 * user can open goes missing.
 */
export function buildSpaces(workspaces) {
  return workspaces.map((workspace) => {
    const folders = workspace.folders ?? [];
    const known = new Set(folders.map((folder) => folder.id));
    const orphan = (record) =>
      record.folderId != null && !known.has(record.folderId);
    const rooted = Object.fromEntries(
      CONTENT_KINDS.map((kind) => [
        LISTS[kind],
        (workspace[LISTS[kind]] ?? []).map((record) =>
          orphan(record) ? { ...record, folderId: null } : record,
        ),
      ]),
    );
    const space = { ...workspace, ...rooted };
    return {
      kind: "space",
      id: workspace.id,
      key: nodeKey("space", workspace.id),
      name: workspace.name,
      color: workspace.color,
      record: workspace,
      children: [
        ...folders.map((folder) => folderNode(space, folder)),
        ...contentIn(space, null),
      ],
    };
  });
}

/** Every node of `spaces`, depth first. */
export function allNodes(spaces) {
  const out = [];
  const visit = (node) => {
    out.push(node);
    for (const child of node.children ?? []) visit(child);
  };
  for (const space of spaces) visit(space);
  return out;
}

/** The node with `key`, or null. */
export const findNode = (spaces, key) =>
  allNodes(spaces).find((node) => node.key === key) ?? null;

/** Whether `node` can expand (a Space or a folder). */
const isContainer = (node) => node.kind === "space" || node.kind === "folder";

/**
 * Whether `node` is expanded: `expanded[key]` when set, else Spaces are
 * open and folders closed.
 */
export function isExpanded(expanded, node) {
  const stored = expanded?.[node.key];
  if (typeof stored === "boolean") return stored;
  return node.kind === "space";
}

/**
 * The rows the tree shows: `{ key, node, level (1-based), parentKey,
 * expanded (null for leaves), setSize, posInSet }`.
 */
export function visibleRows(spaces, expanded) {
  const rows = [];
  const visit = (nodes, level, parentKey) => {
    nodes.forEach((node, index) => {
      const open = isContainer(node) ? isExpanded(expanded, node) : null;
      rows.push({
        key: node.key,
        node,
        level,
        parentKey,
        expanded: open,
        setSize: nodes.length,
        posInSet: index + 1,
      });
      if (open) visit(node.children, level + 1, node.key);
    });
  };
  visit(spaces, 1, null);
  return rows;
}

/** The keys of `key`'s Space and folder (outermost first), or []. */
export function ancestorKeys(spaces, key) {
  for (const space of spaces) {
    if (space.key === key) return [];
    for (const child of space.children) {
      if (child.key === key) return [space.key];
      if (child.children?.some((leaf) => leaf.key === key)) {
        return [space.key, child.key];
      }
    }
  }
  return [];
}

const ROUTE_KEYS = Object.freeze({
  board: ["board", "boardId"],
  "doc-editor": ["doc", "docId"],
  "form-builder": ["form", "formId"],
  workspace: ["space", "workspaceId"],
  "workspace-settings": ["space", "workspaceId"],
});

/** The key of the node the route shows (highlighted), or null. */
export function routeKey(route) {
  const entry = route && ROUTE_KEYS[route.name];
  const id = entry && route.params?.[entry[1]];
  return id ? nodeKey(entry[0], id) : null;
}

/**
 * The nodes of `node`'s kind in its container, in order (itself
 * included): the Spaces, a Space's folders, or the boards (docs, forms)
 * of a Space's root or a folder.
 */
export function siblingsOf(spaces, node) {
  if (node.kind === "space") return spaces;
  const space = spaces.find((each) => each.id === node.spaceId);
  if (!space) return [];
  const parent =
    node.kind === "folder" || node.folderId === null
      ? space
      : space.children.find((child) => child.id === node.folderId);
  return (parent?.children ?? []).filter((each) => each.kind === node.kind);
}

/**
 * The neighbor that puts `node` back where it is: the sibling before it
 * (`afterId`), else the one after it (`beforeId`), else none (`{}`).
 */
export function neighborOf(spaces, node) {
  const siblings = siblingsOf(spaces, node);
  const index = siblings.findIndex((each) => each.key === node.key);
  if (index > 0) return { afterId: siblings[index - 1].id };
  const next = siblings[index + 1];
  return next ? { beforeId: next.id } : {};
}

/**
 * Where "Move to…" can take a board or doc `node`: `{ value, label,
 * spaceId, folderId }` for every Space root and folder of `spaces` where
 * the user can edit, except where it already is.
 */
export function moveDestinations(spaces, node, canEdit) {
  const here = `${node.spaceId}:${node.folderId ?? ""}`;
  const out = [];
  for (const space of spaces.filter((each) => canEdit(each))) {
    const add = (folder) => {
      const value = `${space.id}:${folder?.id ?? ""}`;
      if (value === here) return;
      const label = folder ? `${space.name} / ${folder.name}` : space.name;
      out.push({
        value,
        label,
        spaceId: space.id,
        folderId: folder?.id ?? null,
      });
    };
    add(null);
    for (const folder of space.children.filter((c) => c.kind === "folder")) {
      add(folder);
    }
  }
  return out;
}
