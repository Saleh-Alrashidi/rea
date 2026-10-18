/**
 * User actions: each applies an optimistic local change, renders, runs the
 * GraphQL mutation and then re-fetches, so the server stays the source of
 * truth. Failures show a toast; the re-fetch restores the real state.
 */

import { request } from "../../api.js";
import { formHash } from "../../router.js";
import { confirmDialog, formDialog } from "../components/dialog.js";
import { BOARD_KINDS } from "../components/labels.js";
import { boardKindConfirmation } from "../components/share-model.js";
import { showError } from "../components/toast.js";
import { CREATE_MUTATIONS } from "../shell/create.js";
import { mutate } from "./board-data.js";
import {
  ADDABLE_COLUMN_TYPES,
  GROUP_COLORS,
  displayText,
  encodeValue,
  valuePayload,
} from "./values.js";

const NEW_GROUP_NAME = "New group";

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Shared helpers for every action group. */
function createKit(app) {
  const { state } = app;
  return {
    state,
    boardId: () => state.board.id,
    async run(name, variables, { optimistic, shell = false } = {}) {
      state.pendingMutations += 1;
      state.mutationSeq += 1;
      if (optimistic) {
        optimistic();
        app.render();
      }
      try {
        return await mutate(name, variables);
      } catch (error) {
        showError(error);
        return null;
      } finally {
        state.pendingMutations -= 1;
        app.refresh();
        if (shell) app.refreshShell();
      }
    },
    /** The loaded copies of an item: its board row and the card's detail. */
    copiesOf(itemId) {
      const copies = [];
      const row = state.board?.items.find((item) => item.id === itemId);
      if (row) copies.push(row);
      const detail = state.card?.detail;
      if (detail?.id === itemId) copies.push(detail);
      return copies;
    },
    /** Encodes `{ columnId: uiValue }` as `create_item.column_values`. */
    encodeValues(values) {
      const entries = Object.entries(values).map(([columnId, value]) => {
        const column = state.board.columns.find(
          (entry) => entry.id === columnId,
        );
        return [columnId, valuePayload(column, value)];
      });
      return entries.length > 0
        ? JSON.stringify(Object.fromEntries(entries))
        : null;
    },
  };
}

/** Board rename, describe, kind and delete (the shell creates boards). */
function boardActions(app, kit) {
  const { state, run } = kit;
  return {
    renameBoard(name) {
      const id = kit.boardId();
      run(
        "updateBoard",
        { boardId: id, attribute: "name", value: name },
        {
          shell: true,
          optimistic: () => (state.board.name = name),
        },
      );
    },
    describeBoard(description) {
      run(
        "updateBoard",
        {
          boardId: kit.boardId(),
          attribute: "description",
          value: description,
        },
        { optimistic: () => (state.board.description = description) },
      );
    },
    /** Changes who can see the board, after a confirmation. */
    async setBoardKind(kind) {
      const board = state.board;
      if (!Object.hasOwn(BOARD_KINDS, kind) || board.kind === kind) return;
      const confirmed = await confirmDialog(boardKindConfirmation(board, kind));
      if (!confirmed) return;
      run(
        "setBoardKind",
        { id: board.id, kind },
        { shell: true, optimistic: () => (state.board.kind = kind) },
      );
    },
    async deleteBoard() {
      const board = state.board;
      const confirmed = await confirmDialog({
        title: "Delete board?",
        message: `“${board.name}” and its ${plural(board.items.length, "item")} will be deleted for everyone.`,
        confirmButton: "Delete board",
        danger: true,
      });
      if (!confirmed) return;
      const deleted = await run(
        "deleteBoard",
        { boardId: board.id },
        { shell: true },
      );
      if (deleted) app.onBoardDeleted(board.id);
    },
  };
}

/** Group create, rename, recolor and delete. */
function groupActions(app, kit) {
  const { state, run } = kit;
  return {
    async addGroup() {
      const { color } =
        GROUP_COLORS[state.board.groups.length % GROUP_COLORS.length];
      const group = await run("createGroup", {
        boardId: kit.boardId(),
        name: NEW_GROUP_NAME,
        color,
      });
      if (group?.id) app.focusAfterRender(`group-title:${group.id}`);
    },
    renameGroup(group, title) {
      run(
        "updateGroup",
        {
          boardId: kit.boardId(),
          groupId: group.id,
          attribute: "title",
          value: title,
        },
        { optimistic: () => (group.title = title) },
      );
    },
    recolorGroup(group, color) {
      run(
        "updateGroup",
        {
          boardId: kit.boardId(),
          groupId: group.id,
          attribute: "color",
          value: color,
        },
        { optimistic: () => (group.color = color) },
      );
    },
    async deleteGroup(group) {
      const count = state.board.items.filter(
        (item) => item.groupId === group.id,
      ).length;
      const confirmed = await confirmDialog({
        title: "Delete group?",
        message: `“${group.title}” and its ${plural(count, "item")} will be deleted.`,
        confirmButton: "Delete group",
        danger: true,
      });
      if (!confirmed) return;
      run(
        "deleteGroup",
        { boardId: kit.boardId(), groupId: group.id },
        {
          optimistic() {
            const board = state.board;
            board.groups = board.groups.filter(
              (entry) => entry.id !== group.id,
            );
            board.items = board.items.filter(
              (item) => item.groupId !== group.id,
            );
          },
        },
      );
    },
  };
}

/** Column creation. */
function columnActions(kit) {
  const { run } = kit;
  return {
    async addColumn() {
      const values = await formDialog({
        title: "Add column",
        submitLabel: "Add column",
        fields: [
          {
            name: "title",
            label: "Column title",
            required: true,
            autofocus: true,
          },
          {
            name: "type",
            label: "Column type",
            value: "status",
            options: ADDABLE_COLUMN_TYPES.map(({ type, label }) => ({
              value: type,
              label,
            })),
          },
        ],
      });
      if (!values?.title) return;
      if (!ADDABLE_COLUMN_TYPES.some(({ type }) => type === values.type))
        return;
      run("createColumn", {
        boardId: kit.boardId(),
        title: values.title,
        type: values.type,
      });
    },
  };
}

/** Item create, rename, values, move, delete and updates. */
function itemActions(app, kit) {
  const { state, run } = kit;
  return {
    /**
     * Creates an item (in `groupId`, or the first group when null) with
     * optional UI `values` by column ID; resolves with the new item's ID.
     */
    async createItem({ groupId, name, values = {} }) {
      const item = await run("createItem", {
        boardId: kit.boardId(),
        groupId,
        name,
        values: kit.encodeValues(values),
      });
      return item?.id ? String(item.id) : null;
    },
    renameItem(item, name) {
      run(
        "renameItem",
        { boardId: kit.boardId(), itemId: item.id, value: name },
        {
          optimistic() {
            for (const copy of kit.copiesOf(item.id)) copy.name = name;
          },
        },
      );
    },
    setValue(item, column, value) {
      run(
        "changeValue",
        {
          boardId: kit.boardId(),
          itemId: item.id,
          columnId: column.id,
          value: encodeValue(column, value),
        },
        {
          optimistic() {
            const text = displayText(column, value, state.users);
            for (const copy of kit.copiesOf(item.id)) {
              copy.values[column.id] = value;
              copy.texts[column.id] = text;
            }
          },
        },
      );
    },
    moveItem(item, groupId) {
      const group = state.board.groups.find((entry) => entry.id === groupId);
      if (!group || item.groupId === groupId) return;
      run(
        "moveItem",
        { itemId: item.id, groupId },
        {
          optimistic() {
            for (const copy of kit.copiesOf(item.id)) copy.groupId = groupId;
          },
        },
      );
    },
    async deleteItem(item) {
      const confirmed = await confirmDialog({
        title: "Delete item?",
        message: `“${item.name}” and its updates will be deleted.`,
        confirmButton: "Delete item",
        danger: true,
      });
      if (!confirmed) return;
      app.onItemDeleted(item.id);
      run(
        "deleteItem",
        { itemId: item.id },
        {
          optimistic() {
            state.board.items = state.board.items.filter(
              (entry) => entry.id !== item.id,
            );
          },
        },
      );
    },
    addUpdate(item, body) {
      run(
        "createUpdate",
        { itemId: item.id, body },
        {
          optimistic() {
            state.card?.detail?.updates.unshift({
              id: `pending-${Date.now()}`,
              body,
              created_at: new Date().toISOString(),
              creator: state.me,
              pending: true,
            });
          },
        },
      );
    },
  };
}

/**
 * Form creation from the board's Forms view: the form belongs to this board,
 * so only its title is asked (the shell's create flow picks a board from
 * the user's workspaces, which may not include a board shared with them).
 */
function formActions(app, kit) {
  return {
    async createForm() {
      const board = kit.state.board;
      const values = await formDialog({
        title: "New form",
        submitLabel: "Create form",
        fields: [
          {
            name: "title",
            label: "Form title",
            required: true,
            autofocus: true,
            hint: `Each response becomes an item on “${board.name}”.`,
          },
        ],
      });
      if (!values?.title) return null;
      try {
        const data = await request(CREATE_MUTATIONS.form, {
          boardId: board.id,
          title: values.title,
        });
        const id = String(data.create_form.id);
        app.refreshShell();
        app.navigate(formHash(id));
        return id;
      } catch (error) {
        showError(error, "Couldn’t create the form");
        return null;
      }
    },
  };
}

/**
 * Creates the action set.
 * @param {{ state: object, render(): void, refresh(): void,
 *   refreshShell(): void, navigate(hash: string): void,
 *   focusAfterRender(focusKey: string): void,
 *   onItemDeleted(itemId: string): void,
 *   onBoardDeleted(boardId: string): void }} app
 */
export function createActions(app) {
  const kit = createKit(app);
  return {
    ...boardActions(app, kit),
    ...groupActions(app, kit),
    ...columnActions(kit),
    ...itemActions(app, kit),
    ...formActions(app, kit),
  };
}
