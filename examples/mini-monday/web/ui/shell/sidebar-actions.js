/**
 * What the sidebar's menus and drags do (SPEC-6 §3.3): moves with their
 * undo toast, renames, colors, deletions with the shared confirmations
 * (`delete-confirms.js`) and new folders. Every change refreshes the
 * shell afterwards (`s.refresh()`), so the tree shows the server's
 * order; a refusal shows the server's error toast and the refresh shows
 * what is really there.
 *
 * `s` is the sidebar state (`sidebar.js`).
 */

import { docsHash, homeHash, viewHash } from "../../router.js";
import { announce } from "../components/announcer.js";
import {
  boardDeletion,
  docDeletion,
  folderDeletion,
  formDeletion,
  spaceDeletion,
} from "../components/delete-confirms.js";
import { confirmDialog, formDialog } from "../components/dialog.js";
import { hasRole } from "../components/permissions.js";
import { openPopover } from "../components/popover.js";
import { showError, showToast } from "../components/toast.js";
import { offerUndo } from "../components/undo-toast.js";
import { colorField } from "../forms/color-field.js";
import {
  createFolder,
  deleteNode,
  recolorNode,
  renameNode,
  runMove,
} from "./sidebar-data.js";
import { moveInto, wayBack } from "./sidebar-drop-model.js";
import { moveDestinations } from "./sidebar-model.js";

/** How a node is called in messages. */
const NOUNS = Object.freeze({
  space: "Space",
  folder: "folder",
  board: "list",
  doc: "doc",
  form: "form",
});

/** Opens the moved node's new container, so it stays in sight. */
function openTarget(s, { node, place }) {
  if (place.folderId) s.prefs.setExpanded(`folder:${place.folderId}`, true);
  if (place.spaceId && place.spaceId !== node.spaceId) {
    s.prefs.setExpanded(`space:${place.spaceId}`, true);
  }
}

/**
 * Runs a sidebar `move` (`sidebar-drop-model.js`); when it went through,
 * "Moved “Name”" offers Undo for 8 s (`undo-toast.js`). Resolves with
 * whether it moved.
 */
export async function performMove(s, move) {
  const back = wayBack(s.spaces, move.node);
  const label = `Moved “${move.node.name}”`;
  try {
    await runMove(move);
  } catch (error) {
    showError(error, "Couldn’t move it");
    await s.refresh();
    return false;
  }
  openTarget(s, move);
  await s.refresh();
  announce(label);
  offerUndo({
    message: label,
    async undo() {
      try {
        await runMove(back);
        announce("Move undone");
      } catch (error) {
        showError(error, "Couldn’t undo the move");
      }
      await s.refresh();
    },
  });
  return true;
}

/** "Move to…": asks where a board or doc goes, then moves it there. */
export async function moveToFlow(s, node) {
  const choices = moveDestinations(s.spaces, node, (space) =>
    hasRole(space.record.my_access, "editor"),
  );
  if (choices.length === 0) {
    showToast({ message: "There’s no other place you can move it to." });
    return;
  }
  const values = await formDialog({
    title: `Move “${node.name}”`,
    submitLabel: "Move",
    fields: [
      {
        name: "to",
        label: "Move to",
        autofocus: true,
        value: choices[0].value,
        options: choices.map(({ value, label }) => ({ value, label })),
      },
    ],
  });
  const choice = choices.find((entry) => entry.value === values?.to);
  const move = choice && moveInto(s.spaces, node, choice);
  if (move) await performMove(s, move);
}

/**
 * Ends renaming `node`: saves `name` when it is a new, non-empty name.
 * Focus returns to the node when it was in the field.
 */
export async function commitRename(s, node, name) {
  s.renaming = null;
  s.render();
  if (!name || name === node.name) return;
  try {
    await renameNode(node, name);
    announce(`Renamed to “${name}”`);
  } catch (error) {
    showError(error, "Couldn’t rename it");
  }
  await s.refresh();
}

/** "Color": a popover of swatches next to `anchor`; a pick saves. */
export function openColor(s, node, anchor) {
  let popover = null;
  const field = colorField({
    label: node.kind === "space" ? "Space color" : "Folder color",
    value: node.color,
    async onChange(color) {
      popover?.close();
      try {
        await recolorNode(node, color);
      } catch (error) {
        showError(error, "Couldn’t change the color");
      }
      await s.refresh();
    },
  });
  popover = openPopover({
    anchor: anchor.isConnected ? anchor : s.container,
    label: `${node.name} color`,
    content: () => field,
    className: "tree-color-popover",
  });
}

function confirmation(s, node) {
  if (node.kind === "space") return spaceDeletion(node);
  if (node.kind === "folder") return folderDeletion(node);
  if (node.kind === "board") {
    return boardDeletion(node, node.record.items_count ?? 0);
  }
  if (node.kind === "doc") return docDeletion({ title: node.name });
  return formDeletion({ title: node.name }, node.record.responseCount ?? 0);
}

/** Where the app goes after deleting the page it shows. */
function afterDeletion(node) {
  if (node.kind === "doc") return docsHash();
  if (node.kind === "form")
    return viewHash(node.record.boardId, { view: "forms" });
  return homeHash();
}

/** "Delete": the shared confirmation, the deletion and a refresh. */
export async function deleteFlow(s, node) {
  if (!(await confirmDialog(confirmation(s, node)))) return;
  try {
    await deleteNode(node);
  } catch (error) {
    showError(error, `Couldn’t delete the ${NOUNS[node.kind]}`);
    return;
  }
  showToast({ message: `“${node.name}” was deleted`, type: "success" });
  if (s.currentKey === node.key) s.ctx.router.navigate(afterDeletion(node));
  await s.refresh();
}

/** "+ Folder": asks for a name, creates the folder and opens it. */
export async function createFolderFlow(s, space) {
  const values = await formDialog({
    title: "New folder",
    description: `In ${space.name}`,
    submitLabel: "Create folder",
    fields: [
      { name: "name", label: "Folder name", required: true, autofocus: true },
    ],
  });
  if (!values?.name) return;
  try {
    const id = await createFolder(space.id, values.name);
    s.prefs.setExpanded(space.key, true);
    s.prefs.setExpanded(`folder:${id}`, true);
    announce(`Folder “${values.name}” created`);
  } catch (error) {
    showError(error, "Couldn’t create the folder");
  }
  await s.refresh();
}
