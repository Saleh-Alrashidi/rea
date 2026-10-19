/**
 * The "+" and "…" menus of the sidebar's tree rows (SPEC-6 §3.3).
 *
 * - "+" on a Space: List, Folder, Doc, Form (and the importer for those
 *   who may import); on a folder: List and Doc, created in the Space and
 *   then moved into the folder (`create.js`).
 * - "…": Rename, Color (Spaces and folders), Move up / Move down, Move
 *   to… (Lists and docs), Space settings, Add to / Remove from favorites
 *   and Delete. Controls the user cannot use stay visible, disabled with
 *   the reason; the server decides every change anyway.
 *
 * `s` is the sidebar state (`sidebar.js`).
 */

import { importHash, workspaceSettingsHash } from "../../router.js";
import { openMenu } from "../components/menu.js";
import {
  REASONS,
  can,
  canCreateIn,
  hasRole,
} from "../components/permissions.js";
import { deleteReason } from "../workspaces/workspace-data.js";
import {
  createFolderFlow,
  deleteFlow,
  moveToFlow,
  openColor,
  performMove,
} from "./sidebar-actions.js";
import { canDrag, stepMove } from "./sidebar-drop-model.js";

const OK = Object.freeze({ ok: true, reason: null });
const no = (reason) => ({ ok: false, reason });

const spaceOf = (s, node) => s.byKey.get(`space:${node.spaceId}`) ?? null;
const spaceEditor = (s, node) =>
  hasRole(spaceOf(s, node)?.record.my_access, "editor");

/** The access role the user has on a form's board. */
const formRole = (s, node) =>
  s.byKey.get(`board:${node.record.boardId}`)?.record.my_access ?? null;

/** Whether the user may rename `node`: `{ ok, reason }`. */
export function canRename(s, node) {
  if (node.kind === "space") {
    return node.record.can_manage ? OK : no(REASONS.notOwner);
  }
  if (node.kind === "folder") {
    return spaceEditor(s, node) ? OK : no(REASONS.noWorkspaceEdit);
  }
  if (node.kind === "board") {
    return node.record.my_access === "owner" ? OK : no(REASONS.notOwner);
  }
  const role = node.kind === "doc" ? node.record.my_access : formRole(s, node);
  return hasRole(role, "editor") ? OK : no(REASONS.viewOnly);
}

/** Whether the user may delete `node`: `{ ok, reason }`. */
function canDelete(s, node) {
  if (node.kind === "space") {
    const reason = deleteReason({
      canManage: node.record.can_manage,
      canDelete: node.record.can_delete,
      boards: node.record.boards,
      docs: node.record.docs,
    });
    return reason ? no(reason) : OK;
  }
  if (node.kind === "folder") return canRename(s, node);
  if (node.kind === "form") {
    return hasRole(formRole(s, node), "editor") ? OK : no(REASONS.viewOnly);
  }
  return node.record.my_access === "owner" ? OK : no(REASONS.notOwner);
}

function spacePlus(s, space) {
  const create = canCreateIn(s.ctx.me, space.record);
  const reason = create.ok ? null : create.reason;
  const board = space.record.boards.find((each) =>
    hasRole(each.my_access, "editor"),
  );
  const importer = can(s.ctx.me, "import_data");
  return [
    {
      label: "List",
      icon: "list",
      hint: "Tasks in a list, table and kanban",
      disabledReason: reason,
      onSelect: () => s.flows.board({ workspaceId: space.id, noun: "list" }),
    },
    {
      label: "Folder",
      icon: "folder",
      hint: "Group lists and docs",
      disabledReason: hasRole(space.record.my_access, "editor")
        ? null
        : REASONS.noWorkspaceEdit,
      onSelect: () => createFolderFlow(s, space),
    },
    {
      label: "Doc",
      icon: "docs",
      hint: "Specs, briefs and notes",
      disabledReason: reason,
      onSelect: () => s.flows.doc({ workspaceId: space.id }),
    },
    {
      label: "Form",
      icon: "forms",
      hint: "Collect responses into a list",
      disabledReason:
        reason ?? (board ? null : "Add a list you can edit first"),
      onSelect: () => s.flows.form({ boardId: board?.id }),
    },
    importer && { type: "separator" },
    importer && {
      label: "Import from monday.com / ClickUp",
      icon: "inbox",
      hint: "Boards, people and docs, or a spreadsheet",
      href: importHash(),
    },
  ];
}

function folderPlus(s, folder) {
  const space = spaceOf(s, folder);
  const create = canCreateIn(s.ctx.me, space?.record);
  const reason = create.ok ? null : create.reason;
  const into = { workspaceId: folder.spaceId, folderId: folder.id };
  return [
    {
      label: "List",
      icon: "list",
      hint: `In ${folder.name}`,
      disabledReason: reason,
      onSelect: () => s.flows.board({ ...into, noun: "list" }),
    },
    {
      label: "Doc",
      icon: "docs",
      hint: `In ${folder.name}`,
      disabledReason: reason,
      onSelect: () => s.flows.doc(into),
    },
  ];
}

/** The "+" menu items of `node` ([] for Lists, docs and forms). */
export function plusItems(s, node) {
  if (node.kind === "space") return spacePlus(s, node);
  if (node.kind === "folder") return folderPlus(s, node);
  return [];
}

/** Opens the "+" menu of `node` next to `anchor`. */
export function openPlusMenu(s, node, anchor) {
  openMenu({ anchor, label: `Add to ${node.name}`, items: plusItems(s, node) });
}

function moveItems(s, node) {
  const movable = canDrag(s.spaces, node, s.ctx.me);
  const step = (label, icon, direction) => {
    const move = movable ? stepMove(s.spaces, node.key, direction) : null;
    return {
      label,
      icon,
      disabled: !move,
      onSelect: () => performMove(s, move),
    };
  };
  if (node.kind === "form") return [];
  return [
    step("Move up", "chevronUp", "up"),
    step("Move down", "chevronDown", "down"),
    (node.kind === "board" || node.kind === "doc") && {
      label: "Move to…",
      icon: "arrowRight",
      disabled: !movable,
      onSelect: () => moveToFlow(s, node),
    },
  ];
}

function moreItems(s, node, anchor) {
  const rename = canRename(s, node);
  const removal = canDelete(s, node);
  const favorite = s.prefs.favorites.includes(node.key);
  const colored = node.kind === "space" || node.kind === "folder";
  return [
    {
      label: "Rename",
      icon: "edit",
      disabledReason: rename.reason,
      onSelect: () => s.startRename(node.key),
    },
    colored && {
      label: "Color",
      icon: "palette",
      disabledReason: rename.reason,
      onSelect: () => openColor(s, node, anchor),
    },
    ...moveItems(s, node),
    node.kind === "space" && {
      label: "Space settings",
      icon: "settings",
      href: workspaceSettingsHash(node.id),
    },
    {
      label: favorite ? "Remove from favorites" : "Add to favorites",
      icon: "star",
      onSelect: () => s.toggleFavorite(node.key),
    },
    { type: "separator" },
    {
      label: "Delete",
      icon: "trash",
      danger: true,
      disabledReason: removal.reason,
      onSelect: () => deleteFlow(s, node),
    },
  ];
}

/** Opens the "…" menu of `node` next to `anchor`. */
export function openMoreMenu(s, node, anchor) {
  openMenu({
    anchor,
    label: `${node.name} actions`,
    items: moreItems(s, node, anchor),
  });
}
