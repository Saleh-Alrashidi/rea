/**
 * List view (SPEC-5 §3, ClickUp style): one collapsible group per status
 * label (or priority, assignee, board group, or none; `list-model.js`),
 * each a treegrid with a sticky column-header row, task rows with their
 * subtasks nested underneath (`list-row.js`) and a "+ Add task" row for
 * editors that creates a task with the group's value.
 *
 * Toolbar choices, collapsed groups and expanded tasks live in the
 * board's session memory (`ctx.prefs`), changed through `ctx.change`.
 * View-only users get static cells and no add or rename controls.
 *
 * Moving tasks (SPEC-6 §1.4): editors drag rows (`list-dnd.js`), select
 * them for the bulk bar (`list-bulk.js`) and move the focused row with
 * Alt+arrows or its "…" menu (`list-moves.js`); every move resolves
 * against the rendered rows (`listLayout`, `list-dnd-model.js`). Each
 * group's section carries `data-group-key`, each row `data-row-key`.
 */

import { clear, h } from "../../dom.js";
import { avatar } from "../components/avatar.js";
import { button } from "../components/button.js";
import { emptyState } from "../components/empty-state.js";
import { icon } from "../components/icon.js";
import { bulkBar } from "./list-bulk.js";
import { attachListDrag } from "./list-dnd.js";
import { listLayout } from "./list-dnd-model.js";
import { listColumns, listGroups } from "./list-model.js";
import { moveTools } from "./list-moves.js";
import { listRow } from "./list-row.js";
import { personOf, textColorOn } from "./values.js";

/** Column widths in px by cell kind (the name column takes the rest). */
const WIDTHS = Object.freeze({
  assignees: 112,
  people: 112,
  due: 104,
  date: 104,
  priority: 112,
  status: 148,
  numbers: 96,
  text: 200,
});
const DEFAULT_WIDTH = 160;
const ARROWS = new Set(["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"]);
/** How long a blur waits for the click that caused it. */
const AFTER_CLICK_MS = 500;

/** Sets the shared grid columns of `element` for the `cells` shown. */
function setGridColumns(element, cells) {
  const widths = cells.map((cell) => WIDTHS[cell.kind] ?? DEFAULT_WIDTH);
  const tracks = widths.map((width) => `${width}px`).join(" ");
  const fixed = widths.reduce((sum, width) => sum + width, 0);
  element.style.setProperty(
    "--list-columns",
    `minmax(var(--list-name-min), 1fr) ${tracks}`,
  );
  element.style.setProperty(
    "--list-min-width",
    `calc(var(--list-name-min) + ${fixed}px)`,
  );
}

const domId = (key) => `list-grid-${key.replace(/[^A-Za-z0-9_-]/g, "-")}`;

function headerRow(ctx, cells) {
  const name =
    ctx.board.columns.find((column) => column.type === "name")?.title || "Name";
  return h(
    "div",
    { role: "row", class: "list-head-row" },
    h("div", { role: "columnheader", class: "list-head list-head-name" }, name),
    cells.map((cell) =>
      h(
        "div",
        {
          role: "columnheader",
          class: ["list-head", `list-cell-${cell.kind}`],
          title: cell.column.title,
        },
        cell.column.title,
      ),
    ),
  );
}

function addRow(ctx, group) {
  const input = h("input", {
    class: "list-add-input",
    type: "text",
    maxlength: 255,
    placeholder: "Add task",
    dir: "auto",
    "aria-label": `Add task to ${group.label}`,
    autocomplete: "off",
    dataset: { focusKey: `list-add:${group.key}` },
  });
  const form = h(
    "form",
    {
      class: "list-add-form",
      on: {
        submit(event) {
          event.preventDefault();
          const name = input.value.trim();
          if (!name) return;
          input.value = "";
          ctx.actions.createItem({ ...group.create, name });
        },
      },
    },
    icon("plus", { size: 14 }),
    input,
  );
  return h(
    "div",
    { role: "row", class: "list-add-row" },
    h("div", { role: "gridcell", class: "list-cell list-add-cell" }, form),
  );
}

/**
 * Up/Down move between rows, Right/Left expand and collapse subtasks;
 * with Alt (editors), arrows move the focused row (`view.keyMove`).
 */
function onGridKeydown(view, event) {
  const { key, target } = event;
  const typing = target.matches("textarea, select, input:not([type=checkbox])");
  if (!ARROWS.has(key) || typing) return;
  const row = target.closest(".list-row");
  if (!row) return;
  if (event.altKey) {
    if (!view.caps.edit || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    view.keyMove(row.dataset.rowKey, key);
    return;
  }
  if (!target.closest(".list-name-cell")) return;
  event.preventDefault();
  if (key === "ArrowDown" || key === "ArrowUp") {
    const rows = [...event.currentTarget.querySelectorAll(".list-row")];
    const next = rows[rows.indexOf(row) + (key === "ArrowDown" ? 1 : -1)];
    next?.querySelector(".list-name")?.focus();
    return;
  }
  const expanded = row.getAttribute("aria-expanded");
  if (expanded === null) return;
  if ((expanded === "true") !== (key === "ArrowRight")) {
    row.querySelector(".list-expand")?.click();
  }
}

function groupPill(ctx, group) {
  const pill = h(
    "span",
    { class: ["list-group-pill", !group.color && "neutral"], dir: "auto" },
    group.label,
  );
  if (group.color) {
    pill.style.setProperty("--pill-color", group.color);
    pill.style.setProperty("--pill-text", textColorOn(group.color));
  }
  if (!group.personId) return pill;
  return [avatar(personOf(ctx.users, group.personId), { size: "xs" }), pill];
}

function groupHeader(ctx, { group, gridId }) {
  const { collapsed } = group;
  return h(
    "div",
    { class: "list-group-header" },
    h(
      "button",
      {
        type: "button",
        class: "icon-btn icon-btn-sm list-group-toggle",
        "aria-expanded": collapsed ? "false" : "true",
        "aria-controls": gridId,
        "aria-label": `${collapsed ? "Expand" : "Collapse"} ${group.label}`,
        dataset: { focusKey: `list-group:${group.key}` },
        on: { click: () => ctx.toggleGroup(group) },
      },
      icon(collapsed ? "chevronRight" : "chevronDown", { size: 14 }),
    ),
    groupPill(ctx, group),
    h(
      "span",
      { class: "list-group-count" },
      String(group.count),
      h(
        "span",
        { class: "visually-hidden" },
        group.count === 1 ? " task" : " tasks",
      ),
    ),
    ctx.caps.edit
      ? button({
          label: "Add task",
          icon: "plus",
          variant: "ghost",
          size: "sm",
          className: "list-group-add",
          ariaLabel: `Add task to ${group.label}`,
          dataset: { focusKey: `list-group-add:${group.key}` },
          onClick: () => ctx.startAdding(group),
        })
      : null,
  );
}

function groupBlock(ctx, { group, cells }) {
  const gridId = domId(group.key);
  const rows = group.rows.map((row) => listRow(ctx, { row, group, cells }));
  return h(
    "section",
    {
      class: [
        "list-group",
        group.collapsed && "collapsed",
        group.done && "done",
      ],
      "aria-label": group.label,
      dataset: { groupKey: group.key },
    },
    groupHeader(ctx, { group, gridId }),
    h(
      "div",
      {
        role: "treegrid",
        class: "list-grid",
        id: gridId,
        "aria-label": `${group.label} tasks`,
        hidden: group.collapsed,
        on: { keydown: (event) => onGridKeydown(ctx, event) },
      },
      headerRow(ctx, cells),
      rows,
      rows.length === 0 && !ctx.caps.edit
        ? h(
            "div",
            { role: "row", class: "list-empty-row" },
            h("div", { role: "gridcell", class: "list-cell" }, "No tasks"),
          )
        : null,
      ctx.caps.edit ? addRow(ctx, group) : null,
    ),
  );
}

function notices(ctx, { groups, searching }) {
  const { board, caps } = ctx;
  if (board.groups.length === 0) {
    return emptyState({
      icon: "list",
      title: "This board has no groups yet",
      text: caps.edit
        ? "Groups hold tasks, such as the stages or weeks of a project."
        : "Its owners haven’t added any groups or tasks.",
      action: caps.edit
        ? {
            label: "Add group",
            icon: "plus",
            onClick: () => ctx.actions.addGroup(),
          }
        : null,
    });
  }
  if (searching && groups.length === 0) {
    return emptyState({
      icon: "search",
      title: "No matching tasks",
      text: `Nothing on this board matches “${ctx.search.trim()}”.`,
      compact: true,
    });
  }
  if (board.items.length > 0) return null;
  return emptyState({
    icon: "list",
    title: "No tasks yet",
    text: caps.edit
      ? "Add the first task below."
      : "Its owners haven’t added any tasks.",
    compact: true,
  });
}

/**
 * Runs `task` after the current click (or shortly, when none comes): an
 * editor that blurs on mousedown waits, so rebuilding the view does not
 * swallow the click that moved focus (the task view's editors too).
 */
export function afterClick(task) {
  const doc = globalThis.document;
  let timer = null;
  const run = () => {
    doc.removeEventListener("click", run);
    globalThis.clearTimeout(timer);
    task();
  };
  doc.addEventListener("click", run);
  timer = globalThis.setTimeout(run, AFTER_CLICK_MS);
}

/** The context of rows and groups: `ctx` plus the view's own actions. */
function viewContext(ctx, roles) {
  return {
    ...ctx,
    roles,
    toggleGroup: (group) =>
      ctx.change((prefs) => prefs.groups.set(group.key, !group.collapsed)),
    toggleItem: (itemId, expanded) =>
      ctx.change((prefs) => prefs.expanded.set(itemId, expanded)),
    startAdding(group) {
      ctx.focusAfterRender(`list-add:${group.key}`);
      ctx.change((prefs) => prefs.groups.set(group.key, false));
    },
    startRename(key) {
      ctx.focusAfterRender(`list-name:${key}`);
      ctx.change((prefs) => (prefs.renaming = key));
    },
    /**
     * Ends renaming row `key`, then runs `save` (the rename). With
     * `refocus` (Enter or Escape) the name gets focus back now; otherwise
     * focus moved elsewhere, and the list is rebuilt only after the click
     * that moved it, so the click still reaches its target.
     */
    endRename(key, { refocus, save }) {
      if (ctx.prefs.renaming !== key) return;
      ctx.prefs.renaming = null;
      const finish = () => {
        if (save) save();
        else ctx.change(() => {});
      };
      if (!refocus) {
        afterClick(finish);
        return;
      }
      ctx.focusAfterRender(`list-open:${key}`);
      finish();
    },
  };
}

/**
 * Starts adding a task from the toolbar: opens the first group and
 * focuses its "+ Add task" input.
 * @param {object} ctx the context `renderList` takes
 */
export function addTaskFromToolbar(ctx) {
  const { roles } = listColumns(ctx.board, ctx.prefs);
  const { groups } = listGroups(ctx.board, {
    prefs: ctx.prefs,
    roles,
    users: ctx.users,
    search: "",
  });
  if (groups.length === 0) return;
  viewContext(ctx, roles).startAdding(groups[0]);
}

/**
 * Renders the List view into `container`.
 * @param {HTMLElement} container
 * @param {{ board: object, search: string, users: Map, actions: object,
 *   caps: object, prefs: object, change(mutate: (prefs: object) => void): void,
 *   focusAfterRender(focusKey: string): void,
 *   openItem(id: string): void }} ctx
 */
export function renderList(container, ctx) {
  const { roles, cells } = listColumns(ctx.board, ctx.prefs);
  const shown = cells.filter((cell) => cell.shown);
  const searching = ctx.search.trim() !== "";
  const { groups, keysOf } = listGroups(ctx.board, {
    prefs: ctx.prefs,
    roles,
    users: ctx.users,
    search: ctx.search,
  });
  const layout = listLayout(ctx.board, { groups, keysOf });
  // Deleted tasks leave the selection.
  for (const id of ctx.prefs.selected) {
    if (!layout.byId.has(id)) ctx.prefs.selected.delete(id);
  }
  const view = { ...viewContext(ctx, roles), layout };
  Object.assign(view, moveTools(view));
  const selecting = ctx.caps.edit && ctx.prefs.selected.size > 0;
  const root = h(
    "div",
    {
      class: [
        "list-view",
        !ctx.caps.edit && "readonly",
        ctx.caps.edit && "can-move",
        selecting && "selecting",
      ],
    },
    ctx.board.truncated
      ? h(
          "p",
          { class: "notice" },
          `Showing the first ${ctx.board.items.length} tasks of this board.`,
        )
      : null,
    notices(ctx, { groups, searching }),
    ctx.board.groups.length === 0
      ? null
      : groups.map((group) => groupBlock(view, { group, cells: shown })),
    bulkBar(view),
  );
  setGridColumns(root, shown);
  clear(container).append(root);
  attachListDrag(root, view);
}
