/**
 * Shell data for the sidebar model tests (`web-sidebar-*.test.js`), in
 * the shape `loadShellData` returns: two Spaces in sidebar order, the
 * first with two folders, Lists, docs and a form at its root and in a
 * folder; the user edits the first Space and only views the second.
 */

const board = (id, name, extra = {}) => ({
  id,
  name,
  board_kind: "public",
  my_access: "editor",
  items_count: 3,
  folderId: null,
  defaultView: "list",
  ...extra,
});
const doc = (id, title, extra = {}) => ({
  id,
  title,
  visibility: "workspace",
  my_access: "editor",
  folderId: null,
  ...extra,
});

export const WORKSPACES = Object.freeze([
  {
    id: "1",
    name: "Product",
    color: "#5b5bd6",
    kind: "open",
    my_access: "editor",
    can_manage: false,
    can_delete: false,
    folders: [
      { id: "10", name: "Q4", color: "#00c875" },
      { id: "11", name: "Ops", color: "#fdab3d" },
    ],
    boards: [
      board("100", "Roadmap", { my_access: "owner" }),
      board("101", "Sprint", { folderId: "10" }),
      board("102", "Bugs", { folderId: "10" }),
      board("103", "Launch", { defaultView: "kanban" }),
      board("104", "Lost", { folderId: "99" }),
    ],
    docs: [
      doc("200", "Vision"),
      doc("201", "Notes", { folderId: "10", visibility: "private" }),
    ],
    forms: [{ id: "300", title: "Intake", boardId: "100", folderId: null }],
  },
  {
    id: "2",
    name: "Leadership",
    color: "#d6336c",
    kind: "closed",
    my_access: "viewer",
    can_manage: false,
    can_delete: false,
    folders: [],
    boards: [board("110", "Budget", { my_access: "viewer" })],
    docs: [],
    forms: [],
  },
]);
