/**
 * The confirmations of deleting boards, docs, forms, folders and Spaces,
 * shared by their pages and the sidebar's "…" menus (SPEC-6 §3.3), so a
 * deletion asks the same question wherever it starts. Each returns the
 * options of `confirmDialog`.
 */

const plural = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** Deleting board `{ name }` that holds `items` items. */
export const boardDeletion = ({ name }, items) => ({
  title: "Delete board?",
  message: `“${name}” and its ${plural(items, "item")} will be deleted for everyone.`,
  confirmButton: "Delete board",
  danger: true,
});

/** Deleting doc `{ title }`. */
export const docDeletion = ({ title }) => ({
  title: "Delete this doc?",
  message: `“${title}” will be deleted for everyone with access. This can’t be undone.`,
  confirmButton: "Delete doc",
  danger: true,
});

/** Deleting form `{ title }` that created `responses` items. */
export const formDeletion = ({ title }, responses) => ({
  title: `Delete “${title}”?`,
  message: `The form and its link go away. The ${responses} items it created stay on the board.`,
  confirmButton: "Delete form",
  danger: true,
});

/** Deleting folder `{ name }`: its content moves to the Space. */
export const folderDeletion = ({ name }) => ({
  title: `Delete “${name}”?`,
  message:
    "The folder goes away. Its lists and docs move to the top of its Space; nothing in it is deleted.",
  confirmButton: "Delete folder",
  danger: true,
});

/** Deleting the (empty) Space `{ name }`. */
export const spaceDeletion = ({ name }) => ({
  title: `Delete ${name}?`,
  message:
    "The empty Space and its member list are removed. This can’t be undone.",
  confirmButton: "Delete Space",
  danger: true,
});
