/**
 * Main table view: one block per group with a colored edge, a collapsible
 * header (inline rename, color and delete in a menu), column headers with
 * "+ add column", editable item rows, "+ Add item" per group and
 * "+ Add group" below the groups.
 *
 * Capabilities (`ctx.caps`, `capabilities.js`) shape it: view-only users
 * get static cells and no add, delete or group controls; editors see the
 * owner-only "add column" control disabled with the reason.
 */

import { clear, h } from "../../dom.js";
import { iconButton } from "../components/button.js";
import { emptyState } from "../components/empty-state.js";
import { icon } from "../components/icon.js";
import { inlineInput } from "../components/inline-edit.js";
import { openMenu } from "../components/menu.js";
import { closePopover } from "../components/popover.js";
import { cellEditor } from "./cells.js";
import { GROUP_COLORS, safeColor } from "./values.js";

const DEFAULT_GROUP_COLOR = "#579bfc";

function valueColumns(board) {
  return board.columns.filter((column) => column.type !== "name");
}

function nameColumnTitle(board) {
  return (
    board.columns.find((column) => column.type === "name")?.title || "Item"
  );
}

function colgroup(columns) {
  return h(
    "colgroup",
    null,
    h("col", { class: "col-name" }),
    columns.map((column) => h("col", { class: `col-${column.type}` })),
    h("col", { class: "col-add" }),
    h("col", { class: "col-actions" }),
  );
}

/** "Add column" for owners; disabled with the reason for editors. */
function addColumnControl(ctx) {
  const { caps } = ctx;
  if (!caps.edit) return null;
  return iconButton({
    icon: "plus",
    label: "Add column",
    className: "add-column",
    disabledReason: caps.reasons.manage,
    onClick: () => ctx.actions.addColumn(),
  });
}

function headerRow(ctx, columns) {
  return h(
    "tr",
    null,
    h("th", { scope: "col", class: "cell-name" }, nameColumnTitle(ctx.board)),
    columns.map((column) =>
      h(
        "th",
        {
          scope: "col",
          class: `cell cell-${column.type}`,
          title: column.title,
        },
        column.title,
      ),
    ),
    h("th", { class: "cell-add" }, addColumnControl(ctx)),
    h(
      "th",
      { class: "cell-actions" },
      h("span", { class: "visually-hidden" }, "Actions"),
    ),
  );
}

function nameControl(ctx, item) {
  if (!ctx.caps.edit) {
    return h("span", { class: "name-text", title: item.name }, item.name);
  }
  return inlineInput({
    value: item.name,
    label: "Item name",
    className: "name-input",
    required: true,
    focusKey: `name:${item.id}`,
    onCommit: (name) => ctx.actions.renameItem(item, name),
  });
}

function nameCell(ctx, item) {
  return h(
    "td",
    { class: "cell-name" },
    h(
      "div",
      { class: "name-cell" },
      nameControl(ctx, item),
      h(
        "button",
        {
          type: "button",
          class: "open-item",
          "aria-label": `Open ${item.name}`,
          dataset: { focusKey: `open:${item.id}` },
          on: { click: () => ctx.openItem(item.id) },
        },
        icon("open", { size: 14 }),
        h("span", null, "Open"),
      ),
    ),
  );
}

function itemRow(ctx, item, columns) {
  return h(
    "tr",
    { class: "item-row", dataset: { itemId: item.id } },
    nameCell(ctx, item),
    columns.map((column) =>
      h(
        "td",
        { class: `cell cell-${column.type}` },
        cellEditor({
          column,
          value: item.values[column.id] ?? null,
          users: ctx.users,
          itemName: item.name,
          focusKey: `cell:${item.id}:${column.id}`,
          readOnly: !ctx.caps.edit,
          onChange: (next) => ctx.actions.setValue(item, column, next),
        }),
      ),
    ),
    h("td", { class: "cell-add" }),
    h(
      "td",
      { class: "cell-actions" },
      ctx.caps.edit
        ? h(
            "button",
            {
              type: "button",
              class: "icon-btn row-delete",
              "aria-label": `Delete ${item.name}`,
              title: "Delete item",
              on: { click: () => ctx.actions.deleteItem(item) },
            },
            icon("trash"),
          )
        : null,
    ),
  );
}

/** A quiet row for an empty group that cannot be added to. */
function emptyGroupRow(columns) {
  return h(
    "tr",
    { class: "empty-group-row" },
    h("td", { class: "cell-name" }, h("span", null, "No items in this group")),
    h("td", { colspan: columns.length + 2 }),
  );
}

function addItemRow(ctx, group, columns) {
  const input = h("input", {
    class: "inline-input add-item-input",
    type: "text",
    maxlength: 255,
    placeholder: "+ Add item",
    "aria-label": `Add item to ${group.title}`,
    autocomplete: "off",
    dataset: { focusKey: `add-item:${group.id}` },
  });
  const form = h(
    "form",
    {
      class: "add-item-form",
      on: {
        submit(event) {
          event.preventDefault();
          const name = input.value.trim();
          if (!name) return;
          input.value = "";
          ctx.actions.createItem({ groupId: group.id, name });
        },
      },
    },
    input,
  );
  return h(
    "tr",
    { class: "add-item-row" },
    h("td", { class: "cell-name" }, form),
    h("td", { colspan: columns.length + 2 }),
  );
}

function colorSwatches(ctx, group) {
  return h(
    "div",
    { class: "swatch-row", role: "group", "aria-label": "Group color" },
    GROUP_COLORS.map(({ color, name }) => {
      const swatch = h(
        "button",
        {
          type: "button",
          role: "menuitemradio",
          class: "swatch",
          "aria-checked": color === group.color ? "true" : "false",
          "aria-label": name,
          title: name,
          on: {
            click() {
              closePopover();
              ctx.actions.recolorGroup(group, color);
            },
          },
        },
        color === group.color ? icon("check", { size: 12 }) : null,
      );
      swatch.style.backgroundColor = color;
      return swatch;
    }),
  );
}

function groupMenu(ctx, group, anchor, titleInput) {
  openMenu({
    anchor,
    label: `Actions for ${group.title}`,
    items: [
      {
        label: "Rename group",
        icon: "edit",
        onSelect() {
          titleInput.focus();
          titleInput.select();
        },
      },
      { type: "heading", label: "Group color" },
      colorSwatches(ctx, group),
      { type: "separator" },
      {
        label: "Delete group",
        danger: true,
        icon: "trash",
        onSelect: () => ctx.actions.deleteGroup(group),
      },
    ],
  });
}

function groupMenuButton(ctx, group, titleInput) {
  if (!ctx.caps.edit) return null;
  const menuButton = h(
    "button",
    {
      type: "button",
      class: "icon-btn group-menu",
      "aria-label": `Actions for group ${group.title}`,
      "aria-haspopup": "menu",
      "aria-expanded": "false",
      dataset: { focusKey: `group-menu:${group.id}` },
      on: { click: () => groupMenu(ctx, group, menuButton, titleInput) },
    },
    icon("more"),
  );
  return menuButton;
}

function groupTitle(ctx, group) {
  if (!ctx.caps.edit) {
    return h("h2", { class: "group-title readonly" }, group.title);
  }
  return inlineInput({
    value: group.title,
    label: "Group name",
    className: "group-title",
    required: true,
    focusKey: `group-title:${group.id}`,
    onCommit: (title) => ctx.actions.renameGroup(group, title),
  });
}

function groupHeader(ctx, { group, count, collapsed, tableId }) {
  const titleInput = groupTitle(ctx, group);
  return h(
    "div",
    { class: "group-header" },
    h(
      "button",
      {
        type: "button",
        class: "icon-btn group-toggle",
        "aria-expanded": collapsed ? "false" : "true",
        "aria-controls": tableId,
        "aria-label": `${collapsed ? "Expand" : "Collapse"} group ${group.title}`,
        dataset: { focusKey: `group-toggle:${group.id}` },
        on: { click: () => ctx.toggleGroup(group.id) },
      },
      icon(collapsed ? "chevronRight" : "chevronDown"),
    ),
    titleInput,
    h(
      "span",
      { class: "group-count" },
      `${count} ${count === 1 ? "item" : "items"}`,
    ),
    groupMenuButton(ctx, group, titleInput),
  );
}

function groupBody(ctx, { group, items, columns }) {
  const searching = ctx.search.trim() !== "";
  const rows = items.map((item) => itemRow(ctx, item, columns));
  if (rows.length === 0 && !searching && !ctx.caps.edit) {
    rows.push(emptyGroupRow(columns));
  }
  return [
    h("tbody", null, rows),
    ctx.caps.edit ? h("tfoot", null, addItemRow(ctx, group, columns)) : null,
  ];
}

function groupBlock(ctx, group, items) {
  const columns = valueColumns(ctx.board);
  const collapsed = ctx.collapsed.has(group.id);
  const tableId = `group-table-${group.id}`;
  const section = h(
    "section",
    { class: ["group", collapsed && "collapsed"], "aria-label": group.title },
    groupHeader(ctx, { group, count: items.length, collapsed, tableId }),
    h(
      "table",
      { class: "board-table", id: tableId, hidden: collapsed },
      colgroup(columns),
      h("thead", null, headerRow(ctx, columns)),
      groupBody(ctx, { group, items, columns }),
    ),
  );
  section.style.setProperty(
    "--group-color",
    safeColor(group.color, DEFAULT_GROUP_COLOR),
  );
  return section;
}

function emptySearch(search) {
  return emptyState({
    icon: "search",
    title: "No matching items",
    text: `Nothing on this board matches “${search}”.`,
    compact: true,
  });
}

function emptyBoard(ctx) {
  return emptyState({
    icon: "table",
    title: "This board has no groups yet",
    text: ctx.caps.edit
      ? "Groups hold items, such as the stages or weeks of a project."
      : "Its owners haven’t added any groups or items.",
    action: ctx.caps.edit
      ? {
          label: "Add group",
          icon: "plus",
          onClick: () => ctx.actions.addGroup(),
        }
      : null,
  });
}

function addGroupButton(ctx) {
  if (!ctx.caps.edit || ctx.board.groups.length === 0) return null;
  return h(
    "button",
    {
      type: "button",
      class: "btn btn-secondary add-group",
      dataset: { focusKey: "add-group" },
      on: { click: () => ctx.actions.addGroup() },
    },
    icon("plus"),
    h("span", null, "Add group"),
  );
}

/**
 * Renders the main table into `container`.
 * @param {HTMLElement} container
 * @param {{ board: object, items: object[], search: string, users: Map,
 *   collapsed: Set<string>, actions: object, caps: object,
 *   openItem(id: string): void, toggleGroup(id: string): void }} ctx
 */
export function renderTable(container, ctx) {
  const searching = ctx.search.trim() !== "";
  const byGroup = new Map(ctx.board.groups.map((group) => [group.id, []]));
  for (const item of ctx.items) byGroup.get(item.groupId)?.push(item);
  const groups = ctx.board.groups.filter(
    (group) => !searching || byGroup.get(group.id).length > 0,
  );
  clear(container).append(
    h(
      "div",
      { class: ["table-view", !ctx.caps.edit && "readonly"] },
      ctx.board.truncated
        ? h(
            "p",
            { class: "notice" },
            `Showing the first ${ctx.board.items.length} items of this board.`,
          )
        : null,
      ctx.board.groups.length === 0 ? emptyBoard(ctx) : null,
      searching && groups.length === 0 ? emptySearch(ctx.search) : null,
      groups.map((group) => groupBlock(ctx, group, byGroup.get(group.id))),
      addGroupButton(ctx),
    ),
  );
}
